import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { BackfillDayRecord, BackfillPerModelEntry } from "../reports/types";
import { eventId, sessionKey } from "./eventIdentity";
import {
  PORTABLE_STORE_VERSION,
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
  "lastError",
  "updatedAt",
]);
const STATE_ERROR_CODES = new Set([
  "legacy_records_invalid",
  "store_read_failed",
  "store_events_invalid",
  "store_reconciliation_failed",
]);
const LEGACY_RECONCILIATION_IDENTITY_NAMESPACE = "quotabar-legacy-reconciliation-event-v1";

type TokenField = typeof TOKEN_FIELDS[number];
type ComponentCostField = typeof COMPONENT_COST_FIELDS[number];
type ReconcileResult = { inserted: number; updated: number; existing: number };
type MigrationStore = Pick<PortableUsageStore, "getIngestStatePath" | "recoverPending" | "read" | "reconcile">;

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

export interface MigrateLegacyDataOptions {
  store: PortableUsageStore;
  records: readonly BackfillDayRecord[];
  /** Must resolve exactly to migration-state.json beside the store's ingest-state.json. */
  statePath: string;
  now?: () => Date;
  failAfterState?: "running" | "events";
}

export interface MigrateLegacyDataResult {
  status: "complete";
  syntheticInserted: number;
  syntheticUpdated: number;
}

/**
 * Reconciles immutable legacy day aggregates against provider events already stored in the portable archive.
 * Duplicate provider/day records are rejected because treating aggregate snapshots as additive can double count.
 */
export async function migrateLegacyData(options: MigrateLegacyDataOptions): Promise<MigrateLegacyDataResult> {
  const store: MigrationStore = options.store;
  const expectedStatePath = expectedMigrationStatePath(store);
  const statePath = path.resolve(options.statePath);
  if (canonicalPath(statePath) !== canonicalPath(expectedStatePath)) {
    throw new Error("Portable migration state path must match the store root");
  }
  const now = options.now ?? (() => new Date());

  try {
    await store.recoverPending();
  } catch {
    throw new Error("Portable usage store recovery failed");
  }

  const loadedState = await readMigrationState(statePath);
  if (loadedState.state?.status === "complete"
    && loadedState.state.usageMigrationVersion === PORTABLE_USAGE_MIGRATION_VERSION) {
    if (loadedState.rewriteRequired) await writeStateSafely(statePath, loadedState.state);
    return completeResult();
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

  let current: PortableUsageEvent[];
  try {
    current = await store.read();
  } catch {
    await writeFailedState(statePath, "store_read_failed", now);
    throw new Error("Portable usage migration could not read the store");
  }

  let baseline: Map<string, Aggregate>;
  try {
    baseline = aggregateProviderEvents(current);
  } catch {
    await writeFailedState(statePath, "store_events_invalid", now);
    throw new Error("Portable usage store events are invalid");
  }
  const existingSynthetic = new Map(
    current
      .filter((event) => event.source === "legacy-reconciliation")
      .map((event) => [event.id, event]),
  );
  const synthetic: PortableUsageEvent[] = [];
  for (const item of records.values()) {
    const event = reconciliationEvent(item, baseline.get(aggregateKey(item.date, item.provider, item.model)));
    if (!event) continue;
    synthetic.push(preserveHistoricalMaximum(event, existingSynthetic.get(event.id)));
  }

  let reconciled: ReconcileResult = { inserted: 0, updated: 0, existing: 0 };
  if (synthetic.length > 0) {
    try {
      reconciled = await store.reconcile(synthetic);
    } catch {
      await writeFailedState(statePath, "store_reconciliation_failed", now);
      throw new Error("Portable usage migration could not reconcile events");
    }
  }
  if (options.failAfterState === "events") throw new Error("Portable usage migration interrupted");

  await writeStateSafely(statePath, state("complete", now));
  return {
    status: "complete",
    syntheticInserted: reconciled.inserted,
    syntheticUpdated: reconciled.updated,
  };
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
      const key = aggregateKey(record.date, record.provider, model);
      result.set(key, {
        date: record.date,
        provider: record.provider,
        model,
        target: legacyTarget(entry),
      });
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
    for (const field of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens"] as const) {
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
    reasoningOutputTokens: 0,
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

function aggregateProviderEvents(events: readonly PortableUsageEvent[]): Map<string, Aggregate> {
  const result = new Map<string, Aggregate>();
  for (const event of events) {
    const date = utcDay(event.occurredAt);
    validateBaselineEventNumbers(event);
    if (event.source === "legacy-reconciliation") continue;
    const key = aggregateKey(date, event.provider, event.model);
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
): PortableUsageEvent | undefined {
  const tokenDeltas: Record<TokenField, number> = {
    inputTokens: positiveIntegerDelta(item.target.inputTokens, current.inputTokens),
    outputTokens: positiveIntegerDelta(item.target.outputTokens, current.outputTokens),
    cacheCreationTokens: positiveIntegerDelta(item.target.cacheCreationTokens, current.cacheCreationTokens),
    cacheReadTokens: positiveIntegerDelta(item.target.cacheReadTokens, current.cacheReadTokens),
    reasoningOutputTokens: 0,
  };
  const componentDeltas = {} as Record<ComponentCostField, number>;
  for (const field of COMPONENT_COST_FIELDS) {
    componentDeltas[field] = positiveDecimalDelta(item.target[field], current[field]);
  }
  const totalCostDelta = positiveDecimalDelta(item.target.effectiveCostUSD, current.effectiveCostUSD);
  const hasTokens = TOKEN_FIELDS.some((field) => tokenDeltas[field] > 0);
  const hasComponents = [...item.target.presentCostComponents].some((field) => componentDeltas[field] > 0);
  if (!hasTokens && totalCostDelta === 0 && !hasComponents) return undefined;

  const identitySession = JSON.stringify([
    LEGACY_RECONCILIATION_IDENTITY_NAMESPACE,
    item.date,
    item.provider,
    item.model,
  ]);
  const occurredAt = `${item.date}T12:00:00.000Z`;
  const event: PortableUsageEvent = {
    schemaVersion: PORTABLE_STORE_VERSION,
    id: eventId({
      provider: item.provider,
      occurredAt,
      model: item.model,
      session: identitySession,
      ordinal: 0,
    }),
    provider: item.provider,
    occurredAt,
    model: item.model,
    projectName: "Imported legacy data",
    sessionKey: sessionKey(item.provider, identitySession),
    source: "legacy-reconciliation",
    synthetic: true,
    ...tokenDeltas,
  };
  for (const field of item.target.presentCostComponents) event[field] = componentDeltas[field];
  // Explicit total cost is authoritative downstream. A zero suppresses component fallback when
  // the provider already covers the effective total but the legacy component breakdown has gaps.
  if (totalCostDelta > 0 || hasComponents) {
    event.costUSD = totalCostDelta;
  }
  return event;
}

function preserveHistoricalMaximum(
  desired: PortableUsageEvent,
  existing: PortableUsageEvent | undefined,
): PortableUsageEvent {
  if (!existing || existing.source !== "legacy-reconciliation") return desired;
  const result = { ...desired };
  for (const field of TOKEN_FIELDS) result[field] = Math.max(desired[field], existing[field]);
  for (const field of ["costUSD", ...COMPONENT_COST_FIELDS] as const) {
    const maximum = Math.max(desired[field] ?? 0, existing[field] ?? 0);
    if (desired[field] !== undefined || existing[field] !== undefined) result[field] = maximum;
  }
  return result;
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

function state(status: PortableMigrationState["status"], now: () => Date): PortableMigrationState {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Portable migration clock is invalid");
  return {
    schemaVersion: PORTABLE_STORE_VERSION,
    status,
    usageMigrationVersion: PORTABLE_USAGE_MIGRATION_VERSION,
    updatedAt: date.toISOString(),
  };
}

async function readMigrationState(statePath: string): Promise<LoadedMigrationState> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(statePath, "utf8"));
    return parseMigrationState(parsed);
  } catch (error) {
    if (isMissing(error)) return { rewriteRequired: false };
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code === "EISDIR") {
      return { rewriteRequired: true };
    }
    // State read diagnostics may contain host paths or file contents; expose only the boundary category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable migration state read failed");
  }
}

function parseMigrationState(value: unknown): LoadedMigrationState {
  if (!isPlainObject(value)) return { rewriteRequired: true };
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== PORTABLE_STORE_VERSION
    || typeof item.status !== "string" || !STATE_STATUSES.has(item.status)
    || !Number.isSafeInteger(item.usageMigrationVersion) || (item.usageMigrationVersion as number) < 0
    || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) {
    return { rewriteRequired: true };
  }
  const validLastError = item.status === "failed"
    && typeof item.lastError === "string"
    && STATE_ERROR_CODES.has(item.lastError);
  const rewriteRequired = Object.keys(item).some((key) => !STATE_KEYS.has(key))
    || (item.lastError !== undefined && !validLastError);
  const state: PortableMigrationState = {
    schemaVersion: PORTABLE_STORE_VERSION,
    status: item.status as PortableMigrationState["status"],
    usageMigrationVersion: item.usageMigrationVersion as number,
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

function completeResult(): MigrateLegacyDataResult {
  return { status: "complete", syntheticInserted: 0, syntheticUpdated: 0 };
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
