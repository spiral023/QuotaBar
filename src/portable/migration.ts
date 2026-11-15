import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { BackfillDayRecord } from "../reports/types";
import { normalizeModelName } from "../shared/modelNames";
import { Aggregate, LegacyTarget, aggregateKey, aggregateProviderEvents, canonicalizeLegacyRecords, compareReconciliationItems, isPlainObject, legacyTargetFromPortable, maximumLegacyTarget, reconciliationEvent, reconciliationIdentity, seedHistoricalTarget, utcDay, zeroAggregate } from "./legacyReconciliation";
import { withNamedPortableRootLock } from "./rootLock";
import {
  PORTABLE_STORE_VERSION,
  type PortableMigrationState,
  type PortableProvider,
  type PortableUsageEvent
} from "./types";
import { PortableUsageStore } from "./usageStore";

export const PORTABLE_USAGE_MIGRATION_VERSION = 1 as const;
const STATE_STATUSES = new Set(["pending", "running", "complete", "failed"]);
const STATE_KEYS = new Set([
  "schemaVersion",
  "status",
  "usageMigrationVersion",
  "storeRevision",
  "ownerId",
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
  "refresh_revision_unstable",
]);
const MIGRATION_OPERATION_ERROR = Symbol("migration-operation-error");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type MigrationStore = Pick<
  PortableUsageStore,
  "getIngestStatePath" | "recoverPending" | "reconcileLegacyDerived" | "commitIfRevision"
>;

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
  /** Ongoing refresh already owns this exact running state and must not replace it. */
  expectedOwner?: MigrationRefreshOwner;
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
  | "consumer_prewarm_failed"
  | "refresh_revision_unstable";

export type MigrationStateTransitionResult =
  | { status: "applied" }
  | { status: "already_complete" }
  | { status: "already_failed"; lastError: PortableMigrationFailureCode }
  | { status: "not_running" }
  | { status: "future_state" }
  | { status: "stale_revision"; revision: string };

export type MigrationStateExpectation =
  | { status: "complete"; storeRevision: string }
  | { status: "running"; ownerId: string; updatedAt: string };

export type MigrationRefreshOwner = Extract<MigrationStateExpectation, { status: "running" }>;
export type MigrationRefreshTransitionResult =
  | { status: "applied"; owner: MigrationRefreshOwner }
  | Exclude<MigrationStateTransitionResult, { status: "applied" }>;

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

  if (options.expectedOwner) {
    if (!migrationStateMatches(loadedState.state, options.expectedOwner)) {
      throw new Error("Portable usage migration ownership changed");
    }
  } else {
    await writeStateSafely(statePath, state("running", now));
  }
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
    reconciled = await store.reconcileLegacyDerived((current) => {
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
  // Global lock order: migration lock (held by migrateLegacyData) -> usage-store writer lock.
  const finalized = await store.commitIfRevision(reconciled.revision, () => (
    writeStateSafely(statePath, state("complete", now, reconciled.revision))
  ));
  if (finalized.status === "stale") throw new Error("Portable usage migration revision changed");
  return {
    status: "complete",
    syntheticInserted: reconciled.inserted,
    syntheticUpdated: reconciled.updated,
  };
}

export async function markMigrationRunning(
  statePath: string,
  now: () => Date = () => new Date(),
): Promise<MigrationStateTransitionResult> {
  const resolvedStatePath = path.resolve(statePath);
  return await withMigrationStateLock(resolvedStatePath, async () => {
    const loaded = await readCurrentForTransition(resolvedStatePath);
    if (loaded === "future_state") return { status: "future_state" };
    await writeStateSafely(resolvedStatePath, state("running", now));
    return { status: "applied" };
  });
}

export async function readCompleteMigrationRevision(statePath: string): Promise<string | undefined> {
  const resolvedStatePath = path.resolve(statePath);
  return await withMigrationStateLock(resolvedStatePath, async () => {
    const loaded = await readCurrentForTransition(resolvedStatePath);
    return loaded !== "future_state" && loaded.state?.status === "complete"
      ? loaded.state.storeRevision
      : undefined;
  });
}

export async function beginMigrationRefresh(
  statePath: string,
  expectedCompleteRevision: string,
  now: () => Date = () => new Date(),
): Promise<MigrationRefreshTransitionResult> {
  if (!/^[a-f0-9]{64}$/.test(expectedCompleteRevision)) {
    throw new Error("Portable migration revision is invalid");
  }
  const resolvedStatePath = path.resolve(statePath);
  return await withMigrationStateLock(resolvedStatePath, async () => {
    const loaded = await readCurrentForTransition(resolvedStatePath);
    if (loaded === "future_state") return { status: "future_state" };
    if (loaded.state?.status !== "complete" || loaded.state.storeRevision !== expectedCompleteRevision) {
      return { status: "not_running" };
    }
    const running = { ...state("running", now), ownerId: randomUUID() };
    await writeStateSafely(resolvedStatePath, running);
    return {
      status: "applied",
      owner: { status: "running", ownerId: running.ownerId, updatedAt: running.updatedAt },
    };
  });
}

export async function beginMigrationRefreshRecovery(
  statePath: string,
  now: () => Date = () => new Date(),
): Promise<MigrationRefreshTransitionResult> {
  const resolvedStatePath = path.resolve(statePath);
  return await withMigrationStateLock(resolvedStatePath, async () => {
    const loaded = await readCurrentForTransition(resolvedStatePath);
    if (loaded === "future_state") return { status: "future_state" };
    if (loaded.state?.status !== "failed" || loaded.state.lastError !== "refresh_revision_unstable") {
      return { status: "not_running" };
    }
    const running = { ...state("running", now), ownerId: randomUUID() };
    await writeStateSafely(resolvedStatePath, running);
    return {
      status: "applied",
      owner: { status: "running", ownerId: running.ownerId, updatedAt: running.updatedAt },
    };
  });
}

export async function markMigrationComplete(
  statePath: string,
  storeRevision: string,
  store: Pick<PortableUsageStore, "commitIfRevision">,
  expectationOrNow?: MigrationStateExpectation | (() => Date),
  now: () => Date = () => new Date(),
): Promise<MigrationStateTransitionResult> {
  if (!/^[a-f0-9]{64}$/.test(storeRevision)) throw new Error("Portable migration revision is invalid");
  const expectation = typeof expectationOrNow === "function" ? undefined : expectationOrNow;
  const transitionNow = typeof expectationOrNow === "function" ? expectationOrNow : now;
  const resolvedStatePath = path.resolve(statePath);
  return await withMigrationStateLock(resolvedStatePath, async () => {
    const loaded = await readCurrentForTransition(resolvedStatePath);
    if (loaded === "future_state") return { status: "future_state" };
    if (expectation && !migrationStateMatches(loaded.state, expectation)) return { status: "not_running" };
    const alreadyComplete = loaded.state?.status === "complete" && loaded.state.storeRevision === storeRevision;
    if (!alreadyComplete && loaded.state?.status !== "running") return { status: "not_running" };
    // Global lock order: migration state lock -> usage-store writer/root lock. Store operations never acquire
    // an outer migration/ingestion lock, so this order cannot form a cycle.
    const finalized = await store.commitIfRevision(storeRevision, async () => {
      if (!alreadyComplete) await writeStateSafely(resolvedStatePath, state("complete", transitionNow, storeRevision));
    });
    if (finalized.status === "stale") return { status: "stale_revision", revision: finalized.revision };
    return alreadyComplete ? { status: "already_complete" } : { status: "applied" };
  });
}

export async function markMigrationFailed(
  statePath: string,
  lastError: PortableMigrationFailureCode,
  expectationOrNow?: MigrationStateExpectation | (() => Date),
  storeOrNow?: Pick<PortableUsageStore, "commitIfRevision"> | (() => Date),
  now: () => Date = () => new Date(),
): Promise<MigrationStateTransitionResult> {
  if (!STATE_ERROR_CODES.has(lastError)) throw new Error("Portable migration failure code is invalid");
  const expectation = typeof expectationOrNow === "function" ? undefined : expectationOrNow;
  const revisionStore = typeof storeOrNow === "object" ? storeOrNow : undefined;
  const transitionNow = typeof expectationOrNow === "function"
    ? expectationOrNow
    : typeof storeOrNow === "function"
      ? storeOrNow
      : now;
  const resolvedStatePath = path.resolve(statePath);
  return await withMigrationStateLock(resolvedStatePath, async () => {
    const loaded = await readCurrentForTransition(resolvedStatePath);
    if (loaded === "future_state") return { status: "future_state" };
    if (loaded.state?.status === "failed") {
      if (!isPortableMigrationFailureCode(loaded.state.lastError)) {
        throw new Error("Portable migration state read failed");
      }
      return { status: "already_failed", lastError: loaded.state.lastError };
    }
    if (expectation && !migrationStateMatches(loaded.state, expectation)) return { status: "not_running" };
    if (loaded.state?.status !== "running"
      && !(loaded.state?.status === "complete" && lastError === "consumer_prewarm_failed")) {
      return { status: "not_running" };
    }
    if (expectation?.status === "complete") {
      if (!revisionStore) throw new Error("Portable migration failure revision store is required");
      const failed = await revisionStore.commitIfRevision(expectation.storeRevision, () => (
        writeFailedState(resolvedStatePath, lastError, transitionNow)
      ));
      return failed.status === "stale"
        ? { status: "stale_revision", revision: failed.revision }
        : { status: "applied" };
    }
    await writeFailedState(resolvedStatePath, lastError, transitionNow);
    return { status: "applied" };
  });
}

function migrationStateMatches(
  current: PortableMigrationState | undefined,
  expectation: MigrationStateExpectation,
): boolean {
  return expectation.status === "complete"
    ? current?.status === "complete" && current.storeRevision === expectation.storeRevision
    : current?.status === "running" && current.ownerId === expectation.ownerId;
}

function isPortableMigrationFailureCode(value: unknown): value is PortableMigrationFailureCode {
  return typeof value === "string" && STATE_ERROR_CODES.has(value);
}

async function withMigrationStateLock<T>(statePath: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await withNamedPortableRootLock(path.dirname(statePath), ".portable-migration.lock", operation);
  } catch (error) {
    if (error instanceof FutureMigrationStateError) throw error;
    if (error instanceof Error && (
      error.message === "Portable migration state read failed"
      || error.message === "Portable migration state write failed"
      || error.message === "Portable migration clock is invalid"
    )) throw error;
    // Lock diagnostics can contain host paths; expose only the fixed boundary category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable migration state transition failed");
  }
}

async function readCurrentForTransition(
  statePath: string,
): Promise<LoadedMigrationState | "future_state"> {
  try {
    return await readMigrationState(statePath);
  } catch (error) {
    if (error instanceof FutureMigrationStateError) return "future_state";
    throw error;
  }
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
  const validOwnerId = typeof item.ownerId === "string" && UUID_PATTERN.test(item.ownerId);
  const validStatusShape = item.status === "failed"
    ? validLastError && item.storeRevision === undefined && item.ownerId === undefined
    : item.status === "complete"
      ? validStoreRevision && item.lastError === undefined && item.ownerId === undefined
      : item.status === "running"
        ? item.storeRevision === undefined && item.lastError === undefined
          && (item.ownerId === undefined || validOwnerId)
        : item.storeRevision === undefined && item.lastError === undefined && item.ownerId === undefined;
  if (!validStatusShape) return { rewriteRequired: true };
  const rewriteRequired = Object.keys(item).some((key) => !STATE_KEYS.has(key));
  const state: PortableMigrationState = {
    schemaVersion: PORTABLE_STORE_VERSION,
    status: item.status as PortableMigrationState["status"],
    usageMigrationVersion: item.usageMigrationVersion as number,
    ...(validStoreRevision ? { storeRevision: item.storeRevision as string } : {}),
    ...(validOwnerId ? { ownerId: item.ownerId as string } : {}),
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

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isMigrationOperationError(error: unknown): error is { marker: symbol; error: unknown } {
  return Boolean(error && typeof error === "object"
    && (error as { marker?: unknown }).marker === MIGRATION_OPERATION_ERROR
    && "error" in error);
}
