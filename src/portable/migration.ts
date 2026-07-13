import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { BackfillDayRecord, BackfillPerModelEntry } from "../reports/types";
import { normalizeModelName } from "../shared/modelNames";
import { eventId, sessionKey } from "./eventIdentity";
import { withNamedPortableRootLock } from "./rootLock";
import {
  PORTABLE_STORE_VERSION,
  type PortableLegacyTarget,
  type PortableMigrationState,
  type PortableProvider,
  type PortableUsageEvent,
} from "./types";
import { PortableUsageStore } from "./usageStore";

export const PORTABLE_USAGE_MIGRATION_VERSION = 1 as const;

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "reasoningOutputTokens",
] as const;
const COMPONENT_COST_FIELDS = [
  "inputCostUSD",
  "outputCostUSD",
  "cacheCreationCostUSD",
  "cacheReadCostUSD",
] as const;
const STATE_STATUSES = new Set(["pending", "running", "complete", "failed"]);
const STATE_KEYS = new Set([
  "schemaVersion",
  "status",
  "usageMigrationVersion",
  "storeRevision",
  "lastError",
  "updatedAt",
]);
const STATE_ERROR_CODES = new Set([
  "legacy_records_invalid",
  "store_read_failed",
  "store_events_invalid",
  "store_reconciliation_failed",
  "ingestion_failed",
  "legacy_reconciliation_failed",
  "quota_migration_failed",
  "migration_completion_failed",
  "consumer_prewarm_failed",
]);
const LEGACY_RECONCILIATION_IDENTITY_NAMESPACE = "quotabar-legacy-reconciliation-event-v1";
const MIGRATION_OPERATION_ERROR = Symbol("migration-operation-error");

type TokenField = typeof TOKEN_FIELDS[number];
type ComponentCostField = typeof COMPONENT_COST_FIELDS[number];
type MigrationStore = Pick<
  PortableUsageStore,
  "getIngestStatePath" | "recoverPending" | "reconcileLegacyDerived"
>;

interface Aggregate {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningOutputTokens: number;
  effectiveCostUSD: number;
  inputCostUSD: number;
  outputCostUSD: number;
  cacheCreationCostUSD: number;
  cacheReadCostUSD: number;
}

interface LegacyTarget extends Aggregate {
  authoritativeTotalCost: boolean;
  presentCostComponents: Set<ComponentCostField>;
}

interface LoadedMigrationState {
  state?: PortableMigrationState;
  rewriteRequired: boolean;
}

class InvalidStoreEventsError extends Error {}
class FutureMigrationStateError extends Error {
  constructor() {
    super("Portable migration state is newer than this QuotaBar version");
  }
}

export interface MigrateLegacyDataOptions {
  store: PortableUsageStore;
  records: readonly BackfillDayRecord[];
  /** Must resolve exactly to migration-state.json beside the store's ingest-state.json. */
  statePath: string;
  now?: () => Date;
  failAfterState?: "running" | "events";
  /** Startup orchestration owns the final state so quota snapshots can commit first. */
  finalizeState?: boolean;
}

export interface MigrateLegacyDataResult {
  status: "complete";
  syntheticInserted: number;
  syntheticUpdated: number;
}

export interface DeferredMigrateLegacyDataResult {
  status: "running";
  storeRevision: string;
  syntheticInserted: number;
  syntheticUpdated: number;
}

export type PortableMigrationFailureCode =
  | "legacy_records_invalid"
  | "store_read_failed"
  | "store_events_invalid"
  | "store_reconciliation_failed"
  | "ingestion_failed"
  | "legacy_reconciliation_failed"
  | "quota_migration_failed"
  | "migration_completion_failed"
  | "consumer_prewarm_failed";

/**
 * Reconciles immutable legacy day aggregates against provider events already stored in the portable archive.
 * Duplicate provider/day records are rejected because treating aggregate snapshots as additive can double count.
 */
export function migrateLegacyData(
  options: MigrateLegacyDataOptions & { finalizeState: false },
): Promise<DeferredMigrateLegacyDataResult>;
export function migrateLegacyData(options: MigrateLegacyDataOptions): Promise<MigrateLegacyDataResult>;
export async function migrateLegacyData(
  options: MigrateLegacyDataOptions,
): Promise<MigrateLegacyDataResult | DeferredMigrateLegacyDataResult> {
  const store: MigrationStore = options.store;
  const expectedStatePath = expectedMigrationStatePath(store);
  const statePath = path.resolve(options.statePath);
  if (canonicalPath(statePath) !== canonicalPath(expectedStatePath)) {
    throw new Error("Portable migration state path must match the store root");
  }
  try {
    // Lock order is outer migration/ingestion lock first, then the store root lock acquired by store methods.
    // PortableUsageStore never acquires an outer named lock, so the inverse order cannot occur here.
    return await withNamedPortableRootLock(path.dirname(statePath), ".portable-migration.lock", async () => {
      try {
        return await migrateLegacyDataExclusive(options, store, statePath);
      } catch (error) {
        throw { marker: MIGRATION_OPERATION_ERROR, error };
      }
    });
  } catch (error) {
    if (isMigrationOperationError(error)) throw error.error;
    // Lock diagnostics may expose host paths; retain only the fixed boundary category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable usage migration lock failed");
  }
}

async function migrateLegacyDataExclusive(
  options: MigrateLegacyDataOptions,
  store: MigrationStore,
  statePath: string,
): Promise<MigrateLegacyDataResult | DeferredMigrateLegacyDataResult> {
  const now = options.now ?? (() => new Date());

  const loadedState = await readMigrationState(statePath);

  try {
    await store.recoverPending();
  } catch {
    throw new Error("Portable usage store recovery failed");
  }

  if (loadedState.rewriteRequired && loadedState.state) {
    await writeStateSafely(statePath, loadedState.state);
  }

  await writeStateSafely(statePath, state("running", now));
  if (options.failAfterState === "running") throw new Error("Portable usage migration interrupted");

  let records: Map<string, { date: string; provider: PortableProvider; model: string; target: LegacyTarget }>;
  try {
    records = canonicalizeLegacyRecords(options.records);
  } catch {
    await writeFailedState(statePath, "legacy_records_invalid", now);
    throw new Error("Legacy backfill records are invalid");
  }

  let reconciled;
  try {
    reconciled = await store.reconcileLegacyDerived((current, revision) => {
      void revision;
      let baseline: Map<string, Aggregate>;
      try {
        baseline = aggregateProviderEvents(current);
      } catch {
        throw new InvalidStoreEventsError();
      }
      const events: PortableUsageEvent[] = [];
      const existingLegacyById = new Map(
        current.filter(({ source }) => source === "legacy-reconciliation").map((event) => [event.id, event]),
      );
      const reconciliationItems = new Map(records);
      for (const event of existingLegacyById.values()) {
        if (!event.legacyTarget) continue;
        const item = {
          date: utcDay(event.occurredAt),
          provider: event.provider,
          model: normalizeModelName(event.model),
          target: legacyTargetFromPortable(event.legacyTarget),
        };
        if (reconciliationIdentity(item).id !== event.id) continue;
        const key = aggregateKey(item.date, item.provider, item.model);
        const incoming = reconciliationItems.get(key);
        reconciliationItems.set(key, incoming
          ? { ...incoming, target: maximumLegacyTarget(item.target, incoming.target) }
          : item);
      }
      for (const item of [...reconciliationItems.values()].sort(compareReconciliationItems)) {
        const identity = reconciliationIdentity(item);
        const existing = existingLegacyById.get(identity.id);
        const currentProvider = baseline.get(aggregateKey(item.date, item.provider, item.model)) ?? zeroAggregate();
        const historicalTarget = existing
          ? existing.legacyTarget
            ? legacyTargetFromPortable(existing.legacyTarget)
            : seedHistoricalTarget(currentProvider, existing, item.target)
          : item.target;
        const effectiveTarget = maximumLegacyTarget(historicalTarget, item.target);
        events.push(reconciliationEvent({ ...item, target: effectiveTarget }, currentProvider));
      }
      return { events, removeIds: [] };
    });
  } catch (error) {
    if (error instanceof InvalidStoreEventsError) {
      await writeFailedState(statePath, "store_events_invalid", now);
      // Builder diagnostics can contain event details; expose only the fixed boundary category.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Portable usage store events are invalid");
    }
    await writeFailedState(statePath, "store_reconciliation_failed", now);
    // Store diagnostics can contain host paths; expose only the fixed boundary category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable usage migration could not reconcile events");
  }
  if (options.failAfterState === "events") throw new Error("Portable usage migration interrupted");

  if (options.finalizeState === false) {
    return {
      status: "running",
      storeRevision: reconciled.revision,
      syntheticInserted: reconciled.inserted,
      syntheticUpdated: reconciled.updated,
    };
  }
  await writeStateSafely(statePath, state("complete", now, reconciled.revision));
  return {
    status: "complete",
    syntheticInserted: reconciled.inserted,
    syntheticUpdated: reconciled.updated,
  };
}

export async function markMigrationRunning(
  statePath: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const resolvedStatePath = path.resolve(statePath);
  await readMigrationState(resolvedStatePath);
  await writeStateSafely(resolvedStatePath, state("running", now));
}

export async function markMigrationComplete(
  statePath: string,
  storeRevision: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(storeRevision)) throw new Error("Portable migration revision is invalid");
  await writeStateSafely(path.resolve(statePath), state("complete", now, storeRevision));
}

export async function markMigrationFailed(
  statePath: string,
  lastError: PortableMigrationFailureCode,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (!STATE_ERROR_CODES.has(lastError)) throw new Error("Portable migration failure code is invalid");
  await writeFailedState(path.resolve(statePath), lastError, now);
}

function compareReconciliationItems(
  left: { date: string; provider: PortableProvider; model: string },
  right: { date: string; provider: PortableProvider; model: string },
): number {
  return compareText(
    aggregateKey(left.date, left.provider, left.model),
    aggregateKey(right.date, right.provider, right.model),
  );
}

function expectedMigrationStatePath(store: MigrationStore): string {
  let ingestStatePath: string;
  try {
    ingestStatePath = path.resolve(store.getIngestStatePath());
  } catch {
    throw new Error("Portable usage store configuration is invalid");
  }
  if (path.basename(ingestStatePath).toLowerCase() !== "ingest-state.json") {
    throw new Error("Portable usage store configuration is invalid");
  }
  return path.join(path.dirname(ingestStatePath), "migration-state.json");
}

function canonicalizeLegacyRecords(
  records: readonly BackfillDayRecord[],
): Map<string, { date: string; provider: PortableProvider; model: string; target: LegacyTarget }> {
  if (!Array.isArray(records)) throw new Error("invalid records");
  const providerDays = new Set<string>();
  const result = new Map<string, { date: string; provider: PortableProvider; model: string; target: LegacyTarget }>();
  for (const record of records) {
    validateRecord(record);
    const providerDay = JSON.stringify([record.date, record.provider]);
    if (providerDays.has(providerDay)) throw new Error("duplicate provider day");
    providerDays.add(providerDay);
    for (const model of Object.keys(record.perModel).sort(compareText)) {
      const entry = record.perModel[model];
      const normalizedModel = normalizeModelName(model);
      const key = aggregateKey(record.date, record.provider, normalizedModel);
      const existing = result.get(key);
      if (existing) {
        existing.target = mergeLegacyTargets(existing.target, legacyTarget(entry));
      } else {
        result.set(key, {
          date: record.date,
          provider: record.provider,
          model: normalizedModel,
          target: legacyTarget(entry),
        });
      }
    }
  }
  return new Map([...result].sort(([left], [right]) => compareText(left, right)));
}

function validateRecord(value: unknown): asserts value is BackfillDayRecord {
  if (!isPlainObject(value)) throw new Error("invalid record");
  const record = value as unknown as BackfillDayRecord;
  if (!isUtcDate(record.date) || (record.provider !== "claude" && record.provider !== "codex")) {
    throw new Error("invalid record identity");
  }
  for (const field of [
    "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens", "sessionCount",
  ] as const) {
    if (!isNonNegativeSafeInteger(record[field])) throw new Error("invalid record totals");
  }
  if (!isNonNegativeFinite(record.costUSD)
    || !Array.isArray(record.models)
    || record.models.some((model) => !isCanonicalName(model))
    || !isPlainObject(record.perModel)) throw new Error("invalid record fields");
  for (const [model, entry] of Object.entries(record.perModel)) {
    if (!isCanonicalName(model) || !isPlainObject(entry)) throw new Error("invalid model entry");
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ] as const) {
      if (!isNonNegativeSafeInteger(entry[field])) throw new Error("invalid model tokens");
    }
    if (!isNonNegativeFinite(entry.costUSD)) throw new Error("invalid model cost");
    for (const field of COMPONENT_COST_FIELDS) {
      if (entry[field] !== undefined && !isNonNegativeFinite(entry[field])) throw new Error("invalid component cost");
    }
  }
}

function legacyTarget(entry: BackfillPerModelEntry): LegacyTarget {
  const presentCostComponents = new Set<ComponentCostField>();
  const target: LegacyTarget = {
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    cacheReadTokens: entry.cacheReadTokens,
    reasoningOutputTokens: entry.reasoningOutputTokens,
    effectiveCostUSD: 0,
    inputCostUSD: 0,
    outputCostUSD: 0,
    cacheCreationCostUSD: 0,
    cacheReadCostUSD: 0,
    authoritativeTotalCost: false,
    presentCostComponents,
  };
  for (const field of COMPONENT_COST_FIELDS) {
    if (entry[field] !== undefined) {
      presentCostComponents.add(field);
      target[field] = entry[field] as number;
    }
  }
  const componentTotal = sumComponents(target);
  // Historical Backfill records use zero when totalCostUSD was absent. Positive totals remain authoritative;
  // otherwise component costs provide the only meaningful effective total.
  target.authoritativeTotalCost = entry.costUSD > 0 || componentTotal === 0;
  target.effectiveCostUSD = target.authoritativeTotalCost ? entry.costUSD : componentTotal;
  return target;
}

function mergeLegacyTargets(left: LegacyTarget, right: LegacyTarget): LegacyTarget {
  const merged: LegacyTarget = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    effectiveCostUSD: left.effectiveCostUSD + right.effectiveCostUSD,
    inputCostUSD: left.inputCostUSD + right.inputCostUSD,
    outputCostUSD: left.outputCostUSD + right.outputCostUSD,
    cacheCreationCostUSD: left.cacheCreationCostUSD + right.cacheCreationCostUSD,
    cacheReadCostUSD: left.cacheReadCostUSD + right.cacheReadCostUSD,
    authoritativeTotalCost: left.authoritativeTotalCost || right.authoritativeTotalCost,
    presentCostComponents: new Set([...left.presentCostComponents, ...right.presentCostComponents]),
  };
  return merged;
}

function aggregateProviderEvents(events: readonly PortableUsageEvent[]): Map<string, Aggregate> {
  const result = new Map<string, Aggregate>();
  for (const event of events) {
    const date = utcDay(event.occurredAt);
    validateBaselineEventNumbers(event);
    if (event.source === "legacy-reconciliation") continue;
    const normalizedModel = normalizeModelName(event.model);
    const key = aggregateKey(date, event.provider, normalizedModel);
    const aggregate = result.get(key) ?? zeroAggregate();
    for (const field of TOKEN_FIELDS) aggregate[field] += event[field];
    for (const field of COMPONENT_COST_FIELDS) aggregate[field] += event[field] ?? 0;
    aggregate.effectiveCostUSD += event.costUSD ?? sumEventComponents(event);
    result.set(key, aggregate);
  }
  return result;
}

function reconciliationEvent(
  item: { date: string; provider: PortableProvider; model: string; target: LegacyTarget },
  current = zeroAggregate(),
): PortableUsageEvent {
  const tokenDeltas: Record<TokenField, number> = {
    inputTokens: positiveIntegerDelta(item.target.inputTokens, current.inputTokens),
    outputTokens: positiveIntegerDelta(item.target.outputTokens, current.outputTokens),
    cacheCreationTokens: positiveIntegerDelta(item.target.cacheCreationTokens, current.cacheCreationTokens),
    cacheReadTokens: positiveIntegerDelta(item.target.cacheReadTokens, current.cacheReadTokens),
    reasoningOutputTokens: positiveIntegerDelta(
      item.target.reasoningOutputTokens,
      current.reasoningOutputTokens,
    ),
  };
  const componentDeltas = {} as Record<ComponentCostField, number>;
  for (const field of COMPONENT_COST_FIELDS) {
    componentDeltas[field] = positiveDecimalDelta(item.target[field], current[field]);
  }
  const totalCostDelta = positiveDecimalDelta(item.target.effectiveCostUSD, current.effectiveCostUSD);
  const identity = reconciliationIdentity(item);
  const occurredAt = identity.occurredAt;
  const event: PortableUsageEvent = {
    schemaVersion: PORTABLE_STORE_VERSION,
    id: identity.id,
    provider: item.provider,
    occurredAt,
    model: item.model,
    projectName: "Imported legacy data",
    sessionKey: identity.sessionKey,
    source: "legacy-reconciliation",
    synthetic: true,
    ...tokenDeltas,
    costUSD: totalCostDelta,
    inputCostUSD: componentDeltas.inputCostUSD,
    outputCostUSD: componentDeltas.outputCostUSD,
    cacheCreationCostUSD: componentDeltas.cacheCreationCostUSD,
    cacheReadCostUSD: componentDeltas.cacheReadCostUSD,
    legacyTarget: portableLegacyTarget(item.target),
  };
  return event;
}

function reconciliationIdentity(item: { date: string; provider: PortableProvider; model: string }): {
  id: string;
  occurredAt: string;
  sessionKey: string;
} {
  const session = JSON.stringify([
    LEGACY_RECONCILIATION_IDENTITY_NAMESPACE,
    item.date,
    item.provider,
    item.model,
  ]);
  const occurredAt = `${item.date}T12:00:00.000Z`;
  return {
    id: eventId({
      domain: "legacy-reconciliation-v1",
      provider: item.provider,
      occurredAt,
      model: item.model,
      session,
      ordinal: 0,
    }),
    occurredAt,
    sessionKey: sessionKey(item.provider, session),
  };
}

function portableLegacyTarget(target: LegacyTarget): PortableLegacyTarget {
  return {
    inputTokens: target.inputTokens,
    outputTokens: target.outputTokens,
    cacheCreationTokens: target.cacheCreationTokens,
    cacheReadTokens: target.cacheReadTokens,
    reasoningOutputTokens: target.reasoningOutputTokens,
    costUSD: target.effectiveCostUSD,
    inputCostUSD: target.inputCostUSD,
    outputCostUSD: target.outputCostUSD,
    cacheCreationCostUSD: target.cacheCreationCostUSD,
    cacheReadCostUSD: target.cacheReadCostUSD,
  };
}

function legacyTargetFromPortable(target: PortableLegacyTarget): LegacyTarget {
  return {
    inputTokens: target.inputTokens,
    outputTokens: target.outputTokens,
    cacheCreationTokens: target.cacheCreationTokens,
    cacheReadTokens: target.cacheReadTokens,
    reasoningOutputTokens: target.reasoningOutputTokens,
    effectiveCostUSD: target.costUSD,
    inputCostUSD: target.inputCostUSD,
    outputCostUSD: target.outputCostUSD,
    cacheCreationCostUSD: target.cacheCreationCostUSD,
    cacheReadCostUSD: target.cacheReadCostUSD,
    authoritativeTotalCost: true,
    presentCostComponents: new Set(COMPONENT_COST_FIELDS),
  };
}

function seedHistoricalTarget(
  provider: Aggregate,
  existing: PortableUsageEvent,
  incoming: LegacyTarget,
): LegacyTarget {
  const seeded: LegacyTarget = {
    inputTokens: provider.inputTokens + existing.inputTokens,
    outputTokens: provider.outputTokens + existing.outputTokens,
    cacheCreationTokens: provider.cacheCreationTokens + existing.cacheCreationTokens,
    cacheReadTokens: provider.cacheReadTokens + existing.cacheReadTokens,
    reasoningOutputTokens: provider.reasoningOutputTokens + existing.reasoningOutputTokens,
    effectiveCostUSD: provider.effectiveCostUSD + (existing.costUSD ?? sumEventComponents(existing)),
    inputCostUSD: provider.inputCostUSD + (existing.inputCostUSD ?? 0),
    outputCostUSD: provider.outputCostUSD + (existing.outputCostUSD ?? 0),
    cacheCreationCostUSD: provider.cacheCreationCostUSD + (existing.cacheCreationCostUSD ?? 0),
    cacheReadCostUSD: provider.cacheReadCostUSD + (existing.cacheReadCostUSD ?? 0),
    authoritativeTotalCost: true,
    presentCostComponents: new Set([
      ...incoming.presentCostComponents,
      ...COMPONENT_COST_FIELDS.filter((field) => existing[field] !== undefined),
    ]),
  };
  return seeded;
}

function maximumLegacyTarget(left: LegacyTarget, right: LegacyTarget): LegacyTarget {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cacheCreationTokens: Math.max(left.cacheCreationTokens, right.cacheCreationTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    reasoningOutputTokens: Math.max(left.reasoningOutputTokens, right.reasoningOutputTokens),
    effectiveCostUSD: Math.max(left.effectiveCostUSD, right.effectiveCostUSD),
    inputCostUSD: Math.max(left.inputCostUSD, right.inputCostUSD),
    outputCostUSD: Math.max(left.outputCostUSD, right.outputCostUSD),
    cacheCreationCostUSD: Math.max(left.cacheCreationCostUSD, right.cacheCreationCostUSD),
    cacheReadCostUSD: Math.max(left.cacheReadCostUSD, right.cacheReadCostUSD),
    authoritativeTotalCost: left.authoritativeTotalCost || right.authoritativeTotalCost,
    presentCostComponents: new Set([...left.presentCostComponents, ...right.presentCostComponents]),
  };
}

function zeroAggregate(): Aggregate {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningOutputTokens: 0,
    effectiveCostUSD: 0,
    inputCostUSD: 0,
    outputCostUSD: 0,
    cacheCreationCostUSD: 0,
    cacheReadCostUSD: 0,
  };
}

function aggregateKey(date: string, provider: PortableProvider, model: string): string {
  return JSON.stringify([date, provider, model]);
}

function state(
  status: PortableMigrationState["status"],
  now: () => Date,
  storeRevision?: string,
): PortableMigrationState {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Portable migration clock is invalid");
  return {
    schemaVersion: PORTABLE_STORE_VERSION,
    status,
    usageMigrationVersion: PORTABLE_USAGE_MIGRATION_VERSION,
    ...(storeRevision !== undefined ? { storeRevision } : {}),
    updatedAt: date.toISOString(),
  };
}

async function readMigrationState(statePath: string): Promise<LoadedMigrationState> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(statePath, "utf8"));
    return parseMigrationState(parsed);
  } catch (error) {
    if (error instanceof FutureMigrationStateError) throw error;
    if (isMissing(error)) return { rewriteRequired: false };
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code === "EISDIR") {
      return { rewriteRequired: true };
    }
    // State read diagnostics may contain host paths or file contents; expose only the boundary category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable migration state read failed");
  }
}

export function parseMigrationState(value: unknown): LoadedMigrationState {
  if (!isPlainObject(value)) return { rewriteRequired: true };
  const item = value as Record<string, unknown>;
  if ((typeof item.schemaVersion === "number" && item.schemaVersion > PORTABLE_STORE_VERSION)
    || (item.schemaVersion === PORTABLE_STORE_VERSION
      && typeof item.usageMigrationVersion === "number"
      && item.usageMigrationVersion > PORTABLE_USAGE_MIGRATION_VERSION)) {
    throw new FutureMigrationStateError();
  }
  if (item.schemaVersion !== PORTABLE_STORE_VERSION
    || typeof item.status !== "string" || !STATE_STATUSES.has(item.status)
    || !Number.isSafeInteger(item.usageMigrationVersion) || (item.usageMigrationVersion as number) < 0
    || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) {
    return { rewriteRequired: true };
  }
  const validLastError = typeof item.lastError === "string"
    && item.lastError.length > 0
    && STATE_ERROR_CODES.has(item.lastError);
  const validStoreRevision = typeof item.storeRevision === "string"
    && /^[a-f0-9]{64}$/.test(item.storeRevision);
  const validStatusShape = item.status === "failed"
    ? validLastError && item.storeRevision === undefined
    : item.status === "complete"
      ? validStoreRevision && item.lastError === undefined
      : item.storeRevision === undefined && item.lastError === undefined;
  if (!validStatusShape) return { rewriteRequired: true };
  const rewriteRequired = Object.keys(item).some((key) => !STATE_KEYS.has(key));
  const state: PortableMigrationState = {
    schemaVersion: PORTABLE_STORE_VERSION,
    status: item.status as PortableMigrationState["status"],
    usageMigrationVersion: item.usageMigrationVersion as number,
    ...(validStoreRevision ? { storeRevision: item.storeRevision as string } : {}),
    ...(validLastError ? { lastError: item.lastError as string } : {}),
    updatedAt: item.updatedAt,
  };
  return { state, rewriteRequired };
}

async function writeFailedState(statePath: string, lastError: string, now: () => Date): Promise<void> {
  await writeStateSafely(statePath, { ...state("failed", now), lastError });
}

async function writeStateSafely(statePath: string, value: PortableMigrationState): Promise<void> {
  try {
    await writeAtomic(statePath, `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    throw new Error("Portable migration state write failed");
  }
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await renameWithRetry(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code !== "EPERM" && code !== "EACCES") || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

function sumEventComponents(event: PortableUsageEvent): number {
  return COMPONENT_COST_FIELDS.reduce((sum, field) => sum + (event[field] ?? 0), 0);
}

function validateBaselineEventNumbers(event: PortableUsageEvent): void {
  for (const field of TOKEN_FIELDS) {
    if (!isNonNegativeFinite(event[field])) throw new Error("invalid stored token value");
  }
  if (event.costUSD !== undefined && !isNonNegativeFinite(event.costUSD)) {
    throw new Error("invalid stored total cost");
  }
  for (const field of COMPONENT_COST_FIELDS) {
    if (event[field] !== undefined && !isNonNegativeFinite(event[field])) {
      throw new Error("invalid stored component cost");
    }
  }
}

function utcDay(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid stored timestamp");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error("invalid stored timestamp");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (month < 1 || month > 12 || day < 1 || day > daysForMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    throw new Error("invalid stored timestamp");
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("invalid stored timestamp");
  return instant.toISOString().slice(0, 10);
}

function daysForMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function sumComponents(value: Pick<Aggregate, ComponentCostField> | Record<ComponentCostField, number>): number {
  return COMPONENT_COST_FIELDS.reduce((sum, field) => sum + value[field], 0);
}

function positiveIntegerDelta(target: number, current: number): number {
  return Math.max(target - current, 0);
}

function positiveDecimalDelta(target: number, current: number): number {
  const delta = Math.max(target - current, 0);
  return delta === 0 ? 0 : Number(delta.toPrecision(15));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCanonicalName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isMigrationOperationError(error: unknown): error is { marker: symbol; error: unknown } {
  return Boolean(error && typeof error === "object"
    && (error as { marker?: unknown }).marker === MIGRATION_OPERATION_ERROR
    && "error" in error);
}
