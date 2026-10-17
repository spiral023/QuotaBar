import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { SnapshotEvent } from "./debugEvents";
import type { BackfillDayRecord } from "../reports/types";
import { sanitizeQuotaSnapshot } from "../portable/quotaStore";
import type {
  MigrationRefreshOwner,
  MigrationRefreshTransitionResult,
  MigrationStateExpectation,
  MigrationStateTransitionResult,
} from "../portable/migration";

export type PortablePreparationFailureStage =
  | "ingestion"
  | "legacy_reconciliation"
  | "quota_migration"
  | "migration_completion"
  | "consumer_prewarm";

interface PortableIngestionCounts {
  inserted: number;
  updated: number;
}

interface PortableLegacyMigrationCounts {
  storeRevision: string;
  syntheticInserted: number;
  syntheticUpdated: number;
}

export interface PreparePortableDataDependencies {
  beginMigration(): Promise<MigrationStateTransitionResult | void>;
  ingestProviderEvents(): Promise<PortableIngestionCounts>;
  readLegacyRecords(): Promise<readonly BackfillDayRecord[]>;
  reconcileLegacy(records: readonly BackfillDayRecord[]): Promise<PortableLegacyMigrationCounts>;
  readLegacyQuota(): Promise<readonly SnapshotEvent[]>;
  migrateQuota(snapshots: readonly SnapshotEvent[]): Promise<void>;
  completeMigration(storeRevision: string): Promise<MigrationStateTransitionResult | void>;
  failMigration(
    code: `${PortablePreparationFailureStage}_failed`,
    expectation?: MigrationStateExpectation,
  ): Promise<MigrationStateTransitionResult | void>;
  prewarmConsumers(): void | Promise<void>;
  onStageComplete?(stage: PortablePreparationFailureStage, durationMs: number, count: number): void;
}

export type PreparePortableDataResult = {
  status: "complete";
  ingested: number;
  legacyInserted: number;
  quotaSnapshots: number;
} | { status: "superseded" };

export interface RefreshPortableDataDependencies {
  readCompleteRevision(): Promise<string | undefined>;
  readStoreRevision(): Promise<string>;
  recoverRefresh(): Promise<MigrationRefreshTransitionResult>;
  ingestProviderEvents(): Promise<PortableIngestionCounts>;
  beginRefresh(expectedCompleteRevision: string): Promise<MigrationRefreshTransitionResult>;
  readLegacyRecords(): Promise<readonly BackfillDayRecord[]>;
  reconcileLegacy(
    records: readonly BackfillDayRecord[],
    owner: MigrationRefreshOwner,
  ): Promise<PortableLegacyMigrationCounts>;
  completeMigration(
    storeRevision: string,
    owner: MigrationRefreshOwner,
  ): Promise<MigrationStateTransitionResult | void>;
  failMigration(
    code: `${PortablePreparationFailureStage}_failed` | "refresh_revision_unstable",
    expectation: MigrationStateExpectation,
  ): Promise<MigrationStateTransitionResult | void>;
  refreshConsumers(): void | Promise<void>;
  onStageComplete?(stage: PortablePreparationFailureStage, durationMs: number, count: number): void;
}

export type RefreshPortableDataResult =
  | { status: "unchanged" }
  | { status: "superseded" }
  | { status: "complete"; ingested: number; legacyUpdated: number };

class RefreshRevisionUnstableError extends Error {}

/**
 * Activates portable consumers only after every persistent migration stage has committed.
 * Dependencies keep startup ordering testable and ensure thrown provider diagnostics never cross this boundary.
 */
export async function preparePortableData(
  dependencies: PreparePortableDataDependencies,
): Promise<PreparePortableDataResult> {
  const beginResult = await dependencies.beginMigration();
  if (transitionWasSuperseded(beginResult)) {
    return { status: "superseded" };
  }
  let stage: PortablePreparationFailureStage = "ingestion";
  let completedRevision: string | undefined;
  try {
    let startedAt = Date.now();
    const ingestion = await dependencies.ingestProviderEvents();
    const ingested = ingestion.inserted + ingestion.updated;
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, ingested);

    stage = "legacy_reconciliation";
    startedAt = Date.now();
    const records = await dependencies.readLegacyRecords();
    const legacy = await dependencies.reconcileLegacy(records);
    dependencies.onStageComplete?.(
      stage,
      Date.now() - startedAt,
      legacy.syntheticInserted + legacy.syntheticUpdated,
    );

    stage = "quota_migration";
    startedAt = Date.now();
    const quotaSnapshots = await dependencies.readLegacyQuota();
    await dependencies.migrateQuota(quotaSnapshots);
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, quotaSnapshots.length);

    stage = "migration_completion";
    startedAt = Date.now();
    const completionResult = await dependencies.completeMigration(legacy.storeRevision);
    if (transitionWasSuperseded(completionResult)) {
      return { status: "superseded" };
    }
    completedRevision = legacy.storeRevision;
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, 1);

    stage = "consumer_prewarm";
    startedAt = Date.now();
    await dependencies.prewarmConsumers();
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, 1);

    return {
      status: "complete",
      ingested,
      legacyInserted: legacy.syntheticInserted + legacy.syntheticUpdated,
      quotaSnapshots: quotaSnapshots.length,
    };
  } catch {
    let failureResult: MigrationStateTransitionResult | void;
    try {
      failureResult = stage === "consumer_prewarm" && completedRevision
        ? await dependencies.failMigration(`${stage}_failed`, {
          status: "complete",
          storeRevision: completedRevision,
        })
        : await dependencies.failMigration(`${stage}_failed`);
    } catch {
      throw new Error("Portable data preparation failed while recording failure state");
    }
    if (transitionWasSuperseded(failureResult)) {
      return { status: "superseded" };
    }
    if (failureResult?.status === "already_failed") {
      throw new Error(`Portable data preparation failed: ${failureResult.lastError}`);
    }
    // The original failure may contain provider data; expose only the fixed stage category.
    throw new Error(`Portable data preparation failed at ${stage}`);
  }
}

/** Reconciles changed ongoing ingestion before publishing the exact new portable store revision. */
export async function refreshPortableData(
  dependencies: RefreshPortableDataDependencies,
): Promise<RefreshPortableDataResult> {
  const previousRevision = await dependencies.readCompleteRevision();
  let stage: PortablePreparationFailureStage = "ingestion";
  let expectation: MigrationStateExpectation | undefined;
  let owner: MigrationRefreshOwner | undefined;
  if (!previousRevision) {
    const recovered = await dependencies.recoverRefresh();
    if (recovered.status !== "applied") return { status: "superseded" };
    owner = recovered.owner;
    expectation = owner;
  }
  try {
    let startedAt = Date.now();
    const ingestion = await dependencies.ingestProviderEvents();
    const ingested = ingestion.inserted + ingestion.updated;
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, ingested);
    if (owner === undefined && ingested === 0
      && await dependencies.readStoreRevision() === previousRevision) {
      return { status: "unchanged" };
    }

    if (owner === undefined) {
      const begun = await dependencies.beginRefresh(previousRevision as string);
      if (begun.status !== "applied") return { status: "superseded" };
      owner = begun.owner;
      expectation = owner;
    }

    const records = await dependencies.readLegacyRecords();
    let legacyUpdated = 0;
    let completedRevision: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      stage = "legacy_reconciliation";
      startedAt = Date.now();
      const legacy = await dependencies.reconcileLegacy(records, owner);
      const changed = legacy.syntheticInserted + legacy.syntheticUpdated;
      legacyUpdated += changed;
      dependencies.onStageComplete?.(stage, Date.now() - startedAt, changed);

      stage = "migration_completion";
      startedAt = Date.now();
      const completion = await dependencies.completeMigration(legacy.storeRevision, owner);
      if (completion?.status === "stale_revision") continue;
      if (transitionWasSuperseded(completion)) return { status: "superseded" };
      completedRevision = legacy.storeRevision;
      dependencies.onStageComplete?.(stage, Date.now() - startedAt, 1);
      break;
    }
    if (!completedRevision) {
      const failed = await dependencies.failMigration("refresh_revision_unstable", owner);
      if (transitionWasSuperseded(failed)) return { status: "superseded" };
      throw new RefreshRevisionUnstableError();
    }
    expectation = { status: "complete", storeRevision: completedRevision };

    stage = "consumer_prewarm";
    startedAt = Date.now();
    await dependencies.refreshConsumers();
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, 1);
    return { status: "complete", ingested, legacyUpdated };
  } catch (error) {
    if (error instanceof RefreshRevisionUnstableError) {
      // The underlying store diagnostic may expose host paths; retain only the fixed boundary category.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Portable data refresh failed at migration_completion");
    }
    // Provider and store diagnostics may contain private source data; expose only the fixed stage category.
    // eslint-disable-next-line preserve-caught-error
    if (!expectation) throw new Error(`Portable data refresh failed at ${stage}`);
    let failure: MigrationStateTransitionResult | void;
    try {
      failure = await dependencies.failMigration(`${stage}_failed`, expectation);
    } catch {
      throw new Error("Portable data refresh failed while recording failure state");
    }
    if (transitionWasSuperseded(failure)) return { status: "superseded" };
    if (failure?.status === "already_failed") {
      // The caught diagnostic is intentionally replaced by the persisted allowlisted state code.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Portable data refresh failed: ${failure.lastError}`);
    }
    // Provider and store diagnostics may contain private source data; expose only the fixed stage category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Portable data refresh failed at ${stage}`);
  }
}

function transitionWasSuperseded(result: MigrationStateTransitionResult | void): boolean {
  return result?.status === "future_state" || result?.status === "not_running" || result?.status === "stale_revision";
}

export type PortableIngestionTrigger = "startup" | "source-change" | "manual-recompute";
export interface PortableIngestionRunner {
  trigger(reason: PortableIngestionTrigger): Promise<void>;
}

interface PortableIngestionRunnerOptions {
  beforeActiveCleanup?: () => Promise<void>;
}

/** Runs at most one ingestion at a time and folds any burst of triggers into one follow-up pass. */
export function createPortableIngestionRunner(
  run: () => Promise<void>,
  onDiagnostic: (diagnostic: "Portable ingestion failed") => void = () => undefined,
  options: PortableIngestionRunnerOptions = {},
): PortableIngestionRunner {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let active: Promise<void> | undefined;
  const waiters = new Map<number, Array<() => void>>();

  const drain = async (): Promise<void> => {
    while (true) {
      while (completedGeneration < requestedGeneration) {
        const generation = requestedGeneration;
        try {
          await run();
        } catch {
          onDiagnostic("Portable ingestion failed");
        }
        completedGeneration = generation;
        settleWaiters();
      }
      await options.beforeActiveCleanup?.();
      if (completedGeneration >= requestedGeneration) return;
    }
  };

  const ensureActive = (): Promise<void> => {
    if (!active) {
      const settled = drain().finally(() => {
        if (active === settled) active = undefined;
        settleWaiters();
        if (completedGeneration < requestedGeneration) void ensureActive();
      });
      active = settled;
    }
    return active;
  };

  /**
   * Resolves callers whose own generation has completed. Waiting on the drain
   * promise instead would mean waiting for *all* queued work: once a cycle takes
   * longer than the polling interval, new generations are requested faster than
   * they finish and the drain promise never settles.
   */
  function settleWaiters(): void {
    for (const [generation, callbacks] of [...waiters]) {
      if (completedGeneration >= generation) {
        waiters.delete(generation);
        for (const resolve of callbacks) resolve();
      }
    }
  }

  const waitForGeneration = (generation: number): Promise<void> => {
    if (completedGeneration >= generation) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const callbacks = waiters.get(generation) ?? [];
      callbacks.push(resolve);
      waiters.set(generation, callbacks);
    });
  };

  return {
    trigger(reason): Promise<void> {
      void reason;
      requestedGeneration += 1;
      void ensureActive();
      return waitForGeneration(requestedGeneration);
    },
  };
}

interface PortableIngestionLifecycleRuntime {
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
  now?(): number;
}

/** Polling cadence; a pass that outlasts this is followed by a cooldown. */
const INGESTION_TICK_MS = 15_000;
/**
 * Upper bound for that cooldown. Without it a slow pass would push the next one
 * arbitrarily far out and usage would show up late.
 */
const INGESTION_MAX_COOLDOWN_MS = 60_000;

export interface PortableIngestionLifecycleOptions {
  /** Returning false skips a scheduled tick entirely. Startup always runs. */
  shouldRun?: () => boolean;
}

export interface PortableIngestionLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  trigger(reason: PortableIngestionTrigger): Promise<void>;
}

/** Owns polling separately from the runner so shutdown stops new work without cancelling an in-flight commit. */
export function createPortableIngestionLifecycle(
  runner: PortableIngestionRunner,
  runtime: PortableIngestionLifecycleRuntime = {
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearInterval: (handle) => clearInterval(handle),
  },
  options: PortableIngestionLifecycleOptions = {},
): PortableIngestionLifecycle {
  // Ticks are cheap to schedule but each one lists the whole source tree, so a
  // caller that can tell when nothing changed suppresses that work.
  const shouldRun = options.shouldRun ?? (() => true);
  const now = runtime.now ?? (() => Date.now());
  let active = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  // A pass costs seconds on a large history. Running back-to-back keeps the main
  // process permanently busy for no gain, so each pass is followed by a cooldown
  // as long as the pass itself, capped so fresh usage still shows up promptly.
  let cooldownUntil = 0;

  const runScheduledPass = (): void => {
    const startedAt = now();
    void track(runner.trigger("source-change").finally(() => {
      const elapsed = Math.max(0, now() - startedAt);
      cooldownUntil = now() + Math.min(elapsed, INGESTION_MAX_COOLDOWN_MS);
    }));
  };

  const track = (work: Promise<void>): Promise<void> => {
    const tracked = work.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  };

  const stop = (): Promise<void> => {
    active = false;
    if (timer !== undefined) {
      runtime.clearInterval(timer);
      timer = undefined;
    }
    return inFlight ?? Promise.resolve();
  };

  return {
    async start(): Promise<void> {
      await stop();
      active = true;
      timer = runtime.setInterval(() => {
        if (!active || now() < cooldownUntil) return;
        if (shouldRun()) runScheduledPass();
      }, INGESTION_TICK_MS);
      timer.unref?.();
      await track(runner.trigger("startup"));
    },
    stop,
    trigger(reason): Promise<void> {
      return active ? track(runner.trigger(reason)) : Promise.resolve();
    },
  };
}

const LEGACY_DEBUG_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

interface LegacyQuotaFileSystem {
  readdir(directory: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
}

/** Reads the allowlisted legacy debug directory without following nested paths or links. */
export async function readLegacyQuotaSnapshots(
  logDir: string,
  options: { fileSystem?: LegacyQuotaFileSystem; include?: (fileName: string) => boolean } = {},
): Promise<SnapshotEvent[]> {
  const fileSystem = options.fileSystem ?? fs;
  let entries: Dirent[];
  try {
    entries = await fileSystem.readdir(logDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    // Host diagnostics can contain paths; expose only the fixed migration category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Legacy quota directory read failed");
  }
  const result: SnapshotEvent[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && LEGACY_DEBUG_FILE.test(candidate.name)
      && (options.include?.(candidate.name) ?? true))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    let contents: string;
    try {
      contents = await fileSystem.readFile(path.join(logDir, entry.name), "utf8");
    } catch {
      throw new Error("Legacy quota file read failed");
    }
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim() || !line.includes('"kind":"snapshot"')) continue;
      try {
        const snapshot = sanitizeQuotaSnapshot(JSON.parse(line));
        if (snapshot) result.push(snapshot);
      } catch {
        // Malformed legacy diagnostics are ignored; valid records and the source file remain untouched.
      }
    }
  }
  return result;
}

export interface LegacyQuotaImport {
  read(): Promise<SnapshotEvent[]>;
  migrate(snapshots: readonly SnapshotEvent[]): Promise<void>;
}

const LEGACY_QUOTA_MANIFEST_VERSION = 1;

/**
 * The quota migration re-merges every legacy debug log on each start. Most of
 * them never change again, yet reading and deduplicating them cost seconds of
 * startup. Files are remembered by size and mtime once their snapshots have been
 * merged, so only new or grown files are read. The import stays a healing path
 * for failed live appends: the current day's file keeps growing and is re-read.
 *
 * The manifest is machine-local cache, deliberately outside the archived quota
 * directory. It is ignored when the quota store holds no partitions, and the
 * startup import path deletes it after applying an archive, so imported quota
 * data still receives this machine's legacy snapshots.
 */
export function createIncrementalLegacyQuotaImport(options: {
  logDir: string;
  quotaDir: string;
  manifestPath: string;
  append: (root: string, snapshots: readonly SnapshotEvent[]) => Promise<void>;
}): LegacyQuotaImport {
  let pendingFiles: Record<string, string> | undefined;
  return {
    async read() {
      pendingFiles = undefined;
      const current = await legacyDebugFileIdentities(options.logDir);
      const known = await hasQuotaPartitions(options.quotaDir)
        ? await readLegacyQuotaManifest(options.manifestPath)
        : {};
      const snapshots = await readLegacyQuotaSnapshots(options.logDir, {
        include: (fileName) => current[fileName] === undefined || known[fileName] !== current[fileName],
      });
      pendingFiles = current;
      return snapshots;
    },
    async migrate(snapshots) {
      await options.append(options.quotaDir, snapshots);
      const files = pendingFiles;
      pendingFiles = undefined;
      if (!files) return;
      try {
        await writeLegacyQuotaManifest(options.manifestPath, files);
      } catch {
        // Without a manifest the next start merges every file again, as before.
      }
    },
  };
}

/** Identities are taken before reading, so a file growing meanwhile differs next time and is re-read. */
async function legacyDebugFileIdentities(logDir: string): Promise<Record<string, string>> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return {};
  }
  const identities: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !LEGACY_DEBUG_FILE.test(entry.name)) continue;
    try {
      const info = await fs.lstat(path.join(logDir, entry.name), { bigint: true });
      if (info.isFile()) identities[entry.name] = `${info.size}:${info.mtimeNs}`;
    } catch {
      // A file that vanished is simply not remembered.
    }
  }
  return identities;
}

async function hasQuotaPartitions(quotaDir: string): Promise<boolean> {
  try {
    return (await fs.readdir(path.join(quotaDir, "snapshots"))).some((name) => name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

async function readLegacyQuotaManifest(manifestPath: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { version?: unknown; files?: unknown };
    if (parsed.version !== LEGACY_QUOTA_MANIFEST_VERSION || !parsed.files || typeof parsed.files !== "object") return {};
    const files: Record<string, string> = {};
    for (const [name, identity] of Object.entries(parsed.files as Record<string, unknown>)) {
      if (LEGACY_DEBUG_FILE.test(name) && typeof identity === "string") files[name] = identity;
    }
    return files;
  } catch {
    return {};
  }
}

async function writeLegacyQuotaManifest(manifestPath: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ version: LEGACY_QUOTA_MANIFEST_VERSION, files }, null, 2)}\n`, "utf8");
  await fs.rename(temporary, manifestPath);
}

/** Forces the next start to merge every legacy debug log again, e.g. after quota data was replaced. */
export async function resetLegacyQuotaImport(manifestPath: string): Promise<void> {
  await fs.rm(manifestPath, { force: true });
}
