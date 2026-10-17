import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import {
  getClaudeProjectsDirs,
  getCodexSessionsDirs,
  getPortableUsageDir,
} from "../config/paths";
import {
  listCodexSourceFilesStrict,
  readCodexTokensFromFilesStrict,
  type CodexSourceFileRef,
  type CodexTokenEvent,
} from "../pricing/codex-log-reader";
import {
  listClaudeSourceFilesStrict,
  readClaudeUsageEntriesFromFilesStrict,
  type ClaudeUsageEntry,
  type SourceFileRef,
} from "../pricing/jsonl-reader";
import { fromClaudeEntries, fromCodexEvents } from "./eventAdapters";
import { PORTABLE_COST_ENRICHMENT_VERSION } from "./costEnrichment";
import {
  applyPortableIngestJournal,
  isCurrentIngestSourceState,
  parsePortableIngestStateForLoad,
  portableIngestSourceKey,
  PORTABLE_INGEST_JOURNAL_FILE,
  serializePortableIngestJournalEntry,
  type CurrentIngestSourceState,
  type PortableIngestJournalBase,
  type PortableIngestStateDelta,
} from "./ingestState";
import { withNamedPortableRootLock } from "./rootLock";
import { PORTABLE_STORE_VERSION, type PortableIngestState, type PortableProvider, type PortableUsageEvent } from "./types";
import { getSharedUsageStore, PortableUsageStore, type IngestJournalWrite } from "./usageStore";

type ReconcileResult = { inserted: number; updated: number; existing: number };
type SourceErrorCode = "listing_failed" | "stat_failed" | "read_failed" | "adapter_failed" | "cost_failed";
type IngestError = { provider: PortableProvider; path: string; message: SourceErrorCode };
type IngestDiagnostic = { code: "state_recovered"; path: string };
type IngestionStore = {
  getIngestStatePath(): string;
  recoverPending(): Promise<void>;
  reconcileWithIngestState(events: readonly PortableUsageEvent[], state: PortableIngestState): Promise<ReconcileResult>;
  reconcileWithIngestJournal?(events: readonly PortableUsageEvent[], write: IngestJournalWrite): Promise<ReconcileResult>;
  read?(): Promise<PortableUsageEvent[]>;
};

export interface PortableSourceFingerprint {
  isFile: boolean;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface IngestPortableUsageOptions {
  store?: IngestionStore;
  /** Must resolve exactly to the supplied store's canonical ingest-state.json path. */
  statePath?: string;
  claudeProjectsDirs?: string | string[];
  codexSessionsDirs?: string | string[];
  claudeRefs?: readonly SourceFileRef[];
  codexRefs?: readonly CodexSourceFileRef[];
  readClaude?: (refs: SourceFileRef[]) => Promise<ClaudeUsageEntry[]>;
  readCodex?: (refs: CodexSourceFileRef[]) => Promise<CodexTokenEvent[]>;
  statSource?: (sourcePath: string) => Promise<PortableSourceFingerprint>;
  enrichCosts?: (events: readonly PortableUsageEvent[]) => Promise<PortableUsageEvent[]>;
  /** Smallest snapshot worth journaling; below it a full rewrite is cheap enough. */
  journalMinSnapshotBytes?: number;
  /** Journal size, relative to the snapshot, at which it is compacted into a new snapshot. */
  journalMaxSnapshotShare?: number;
  /** Minimum time between attempts to price events that had no price last time. */
  costRetryIntervalMs?: number;
  now?: () => number;
}

export interface IngestPortableUsageResult extends ReconcileResult {
  scanned: number;
  changed: number;
  errors: IngestError[];
  diagnostics: IngestDiagnostic[];
}

interface KnownSource {
  key: string;
  provider: PortableProvider;
  path: string;
  ref: SourceFileRef | CodexSourceFileRef;
}

interface FailedSourceRoot {
  provider: PortableProvider;
  path: string;
}

interface SourceDiscovery {
  sources: KnownSource[];
  failedRoots: FailedSourceRoot[];
}

interface LoadedState {
  state: PortableIngestState;
  diagnostics: IngestDiagnostic[];
  rewriteRequired: boolean;
  /** Present when the snapshot on disk can be extended by a journal. */
  journal?: LoadedJournal;
  /** Identity of the state files this was read from, when it could be taken. */
  identity?: string;
}

interface LoadedJournal {
  base: PortableIngestJournalBase;
  snapshotBytes: number;
  /** False when the next journal write has to start a new journal on this snapshot. */
  usable: boolean;
  bytes: number;
}

interface CachedState {
  identity: string;
  loaded: Omit<LoadedState, "diagnostics">;
}

const stateQueues = new Map<string, Promise<void>>();
const INGEST_OPERATION_ERROR = Symbol("ingest-operation-error");
const CORRUPT_STATE_FILE = /^ingest-state\.corrupt\.(\d{13})\.json$/;
const MAX_CORRUPT_STATE_FILES = 3;
const JOURNAL_MIN_SNAPSHOT_BYTES = 256 * 1024;
/** Compacting once the journal reaches a quarter of the snapshot keeps replay cheap and rewrites rare. */
const JOURNAL_MAX_SNAPSHOT_SHARE = 0.25;
/**
 * Parsed ingest state by canonical state path. The state is megabytes of JSON
 * that every pass used to re-read, re-validate and re-serialize even when no
 * source had changed. File identities guard each entry, so a write by anyone
 * else — an import, another process — is still picked up.
 */
const stateCache = new Map<string, CachedState>();

/**
 * Events whose model has no price keep their source out of the state and the
 * cost-enrichment version unset, so both are retried. Retrying on every pass
 * re-read those source files and the entire store each time, seconds per pass
 * for a price that will not appear between two ticks. Retries are therefore
 * spaced out, but only while the state files are exactly as this process left
 * them; anyone else writing them (an import, another process) resets the memo.
 */
interface CostRetryMemo {
  stateIdentity?: string;
  /** When pricing the stored events was last attempted without completing the repair. */
  repairAttemptedAt?: number;
  /** Sources read successfully but left unresolved, by the fingerprint they were read at. */
  unresolved: Map<string, { fingerprint: string; attemptedAt: number }>;
}

const COST_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const costRetryMemos = new Map<string, CostRetryMemo>();

export function ingestPortableUsage(options: IngestPortableUsageOptions = {}): Promise<IngestPortableUsageResult> {
  const store = options.store ?? getDefaultStore();
  if (options.enrichCosts && !store.read) {
    return Promise.reject(new Error("Portable cost enrichment requires a readable store"));
  }
  let storeStatePath: string;
  try {
    storeStatePath = path.resolve(store.getIngestStatePath());
  } catch {
    return Promise.reject(new Error("Portable usage store configuration is invalid"));
  }
  const statePath = path.resolve(options.statePath ?? storeStatePath);
  if (canonicalPath(statePath) !== canonicalPath(storeStatePath)) {
    return Promise.reject(new Error("Portable ingest state path must match the store root"));
  }
  const stateKey = canonicalPath(statePath);
  const previous = stateQueues.get(stateKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => runWithIngestionLock(options, store, statePath));
  const tail = result.then(() => undefined, () => undefined);
  stateQueues.set(stateKey, tail);
  return result.finally(() => {
    if (stateQueues.get(stateKey) === tail) stateQueues.delete(stateKey);
  });
}

async function runWithIngestionLock(
  options: IngestPortableUsageOptions,
  store: IngestionStore,
  statePath: string,
): Promise<IngestPortableUsageResult> {
  if (options.enrichCosts) await assertSupportedCostEnrichmentState(statePath);
  try {
    return await withNamedPortableRootLock(path.dirname(statePath), ".portable-ingestion.lock", async () => {
      try {
        return await ingestExclusive(options, store, statePath);
      } catch (error) {
        throw { marker: INGEST_OPERATION_ERROR, error };
      }
    });
  } catch (error) {
    if (isOperationError(error)) throw error.error;
    // Lock diagnostics may contain arbitrary host details; expose only the allowlisted boundary category.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable usage ingestion lock failed");
  }
}

async function ingestExclusive(
  options: IngestPortableUsageOptions,
  store: IngestionStore,
  statePath: string,
): Promise<IngestPortableUsageResult> {
  const readClaude = options.readClaude ?? readClaudeUsageEntriesFromFilesStrict;
  const readCodex = options.readCodex ?? readCodexTokensFromFilesStrict;
  const statSource = options.statSource ?? statSourceStrict;
  const errors: IngestError[] = [];
  try {
    await store.recoverPending();
  } catch {
    throw new Error("Portable usage store recovery failed");
  }
  const loaded = await readStateCached(statePath);
  const previousState = loaded.state;
  const passStartedAt = (options.now ?? Date.now)();
  const costRetryIntervalMs = options.costRetryIntervalMs ?? COST_RETRY_INTERVAL_MS;
  const retryDue = (attemptedAt: number): boolean => passStartedAt - attemptedAt >= costRetryIntervalMs;
  const memoKey = canonicalPath(statePath);
  const costMemo = costRetryMemos.get(memoKey);
  if (costMemo && (loaded.identity === undefined || costMemo.stateIdentity !== loaded.identity)) {
    costRetryMemos.delete(memoKey);
  }
  const retryMemo = costRetryMemos.get(memoKey);
  if (options.enrichCosts
    && previousState.costEnrichmentVersion !== undefined
    && previousState.costEnrichmentVersion > PORTABLE_COST_ENRICHMENT_VERSION) {
    throw new Error("Portable cost enrichment version is newer than supported");
  }
  // Source records are only ever replaced, never mutated, so cached records can
  // be shared and a changed record is recognizable by identity.
  const nextSources: PortableIngestState["sources"] = { ...previousState.sources };
  const discovery = await collectKnownSources(options, errors);
  const knownSources = discovery.sources;
  const sourceByKey = new Map(knownSources.map((source) => [source.key, source]));
  const currentKeys = new Set(sourceByKey.keys());
  const unavailableKeys = new Set<string>();
  let repairedEvents: PortableUsageEvent[] = [];
  let repairedCostsComplete = true;
  const enrichCosts = options.enrichCosts;
  const costRepairRequired = enrichCosts !== undefined
    && previousState.costEnrichmentVersion !== PORTABLE_COST_ENRICHMENT_VERSION;
  const repairThrottled = retryMemo?.repairAttemptedAt !== undefined && !retryDue(retryMemo.repairAttemptedAt);
  let repairAttempted = false;
  if (costRepairRequired && repairThrottled) {
    // Not attempted this pass, so the repair cannot count as complete.
    repairedCostsComplete = false;
  } else if (costRepairRequired && store.read) {
    repairAttempted = true;
    let stored: PortableUsageEvent[];
    try {
      stored = await store.read();
      const candidates = stored.filter((event) => event.source !== "legacy-reconciliation" && !hasCompleteCost(event));
      repairedEvents = candidates.length > 0 ? await enrichCosts(candidates) : [];
      if (!preservesCostOnlyChanges(candidates, repairedEvents)) throw new Error("invalid cost enrichment");
      repairedCostsComplete = repairedEvents.every(hasCompleteCost);
    } catch {
      throw new Error("Portable cost enrichment failed");
    }
  }

  let activityChanged = loaded.rewriteRequired;
  for (const [key, source] of Object.entries(nextSources)) {
    if (!isCurrentIngestSourceState(source) || currentKeys.has(sourceKey(source.provider, source.path))) continue;
    if (source.active !== false && isUnderFailedRoot(source, discovery.failedRoots)) {
      unavailableKeys.add(key);
    } else if (source.active !== false) {
      nextSources[key] = { ...source, active: false };
      activityChanged = true;
    }
  }

  const fingerprints = new Map<string, Omit<PortableSourceFingerprint, "isFile">>();
  const previousByKey = new Map<string, CurrentIngestSourceState>();
  const changedKeys: string[] = [];
  let changed = 0;
  for (const source of knownSources) {
    const previous = findPreviousSource(nextSources, source);
    if (previous) previousByKey.set(source.key, previous);
    let fingerprint: PortableSourceFingerprint;
    try {
      fingerprint = await statSource(source.path);
      if (!fingerprint.isFile || !isDecimal(fingerprint.size)
        || !isDecimal(fingerprint.mtimeNs) || !isDecimal(fingerprint.ctimeNs)) throw new Error("invalid stat");
    } catch {
      if (previous && previous.active !== false) {
        unavailableKeys.add(source.key);
      }
      errors.push({ provider: source.provider, path: source.path, message: "stat_failed" });
      continue;
    }
    const value = { size: fingerprint.size, mtimeNs: fingerprint.mtimeNs, ctimeNs: fingerprint.ctimeNs };
    fingerprints.set(source.key, value);
    if (!previous || !previous.active || !sameFingerprint(previous, value)) {
      // Already read at exactly this fingerprint and its events reconciled; only
      // the missing price kept it out of the state, so reading it again is moot.
      const pending = retryMemo?.unresolved.get(source.key);
      if (pending && pending.fingerprint === fingerprintKey(value) && !retryDue(pending.attemptedAt)) continue;
      changed += 1;
      changedKeys.push(source.key);
    }
  }

  const batches = new Map<string, PortableUsageEvent[]>();
  const failedKeys = new Set<string>();
  for (const key of changedKeys) {
    await readSource(sourceByKey.get(key) as KnownSource, readClaude, readCodex, options.enrichCosts, batches, failedKeys, errors);
  }

  const collisionOwners = new Set<string>();
  const activeOwners = new Map<string, CurrentIngestSourceState>();
  for (const [key, source] of Object.entries(nextSources)) {
    if (isCurrentIngestSourceState(source) && source.active) activeOwners.set(key, source);
  }
  for (const [changedKey, events] of batches) {
    const ids = new Set([
      ...events.map(({ id }) => id),
      ...(previousByKey.get(changedKey)?.eventIds ?? []),
    ]);
    for (const [ownerKey, owner] of activeOwners) {
      if (owner.eventIds.some((id) => ids.has(id))) collisionOwners.add(ownerKey);
    }
  }
  for (const ownerKey of [...collisionOwners].sort(compareText)) {
    if (!batches.has(ownerKey) && sourceByKey.has(ownerKey)) {
      await readSource(sourceByKey.get(ownerKey) as KnownSource, readClaude, readCodex, options.enrichCosts, batches, failedKeys, errors);
    }
  }
  const unresolvedCostKeys = new Set<string>();
  if (enrichCosts) {
    for (const [sourceKey, events] of batches) {
      if (events.some((event) => !hasCompleteCost(event))) unresolvedCostKeys.add(sourceKey);
    }
  }

  const protectedIds = new Set<string>();
  for (const key of failedKeys) {
    for (const id of previousByKey.get(key)?.eventIds ?? []) protectedIds.add(id);
  }
  const winningOwnerById = new Map<string, string>();
  for (const [ownerKey, owner] of [...activeOwners].sort(([, left], [, right]) => compareSourceStates(left, right))) {
    for (const id of owner.eventIds) winningOwnerById.set(id, ownerKey);
  }
  for (const [id, ownerKey] of winningOwnerById) {
    if (unavailableKeys.has(ownerKey)) protectedIds.add(id);
  }
  const incoming: PortableUsageEvent[] = [...repairedEvents];
  const nextUnresolved = new Map([...retryMemo?.unresolved ?? []].filter(([key]) => sourceByKey.has(key)));
  let successfulChanged = 0;
  // Sources are normalized above by provider then canonical path. Later sources are authoritative for shared IDs,
  // both on the initial ingest and when collision owners are reread after an incremental change.
  for (const source of knownSources) {
    const events = batches.get(source.key);
    if (!events) continue;
    incoming.push(...events.filter(({ id }) => !protectedIds.has(id)));
    const wasChanged = changedKeys.includes(source.key);
    const intersectsProtected = events.some(({ id }) => protectedIds.has(id));
    if (wasChanged && !intersectsProtected) successfulChanged += 1;
    const sourceFingerprint = fingerprints.get(source.key);
    if (!intersectsProtected && unresolvedCostKeys.has(source.key) && sourceFingerprint) {
      nextUnresolved.set(source.key, { fingerprint: fingerprintKey(sourceFingerprint), attemptedAt: passStartedAt });
    } else {
      nextUnresolved.delete(source.key);
    }
    if (!intersectsProtected && !unresolvedCostKeys.has(source.key)) {
      const fingerprint = fingerprints.get(source.key);
      if (fingerprint) {
        removeLegacySource(nextSources, source);
        nextSources[source.key] = {
          provider: source.provider,
          path: source.path,
          ...fingerprint,
          processedAt: new Date().toISOString(),
          eventIds: [...new Set(events.map(({ id }) => id))].sort(),
          active: true,
        };
      }
    }
  }

  const allObservedCostsComplete = repairedCostsComplete && unresolvedCostKeys.size === 0;
  const costRepairCompleted = costRepairRequired && errors.length === 0 && allObservedCostsComplete;
  const nextRepairAttemptedAt = !costRepairRequired || costRepairCompleted
    ? undefined
    : repairAttempted ? passStartedAt : retryMemo?.repairAttemptedAt;
  const rememberCostRetries = (stateIdentity: string | undefined): void => {
    if (stateIdentity === undefined || (nextUnresolved.size === 0 && nextRepairAttemptedAt === undefined)) {
      costRetryMemos.delete(memoKey);
      return;
    }
    costRetryMemos.set(memoKey, { stateIdentity, repairAttemptedAt: nextRepairAttemptedAt, unresolved: nextUnresolved });
  };
  if (successfulChanged === 0 && incoming.length === 0 && !activityChanged && !costRepairCompleted) {
    rememberCostRetries(loaded.identity);
    return emptyResult(knownSources.length, changed, errors, loaded.diagnostics);
  }

  const nextCostEnrichmentVersion = enrichCosts
    ? !allObservedCostsComplete
      ? undefined
      : costRepairCompleted
        ? PORTABLE_COST_ENRICHMENT_VERSION
        : previousState.costEnrichmentVersion
    : previousState.costEnrichmentVersion;
  const nextState: PortableIngestState = {
    schemaVersion: PORTABLE_STORE_VERSION,
    ...(nextCostEnrichmentVersion !== undefined
      ? { costEnrichmentVersion: nextCostEnrichmentVersion }
      : {}),
    sources: nextSources,
  };
  const journalWrite = planJournalWrite(loaded, nextState, store, {
    minSnapshotBytes: options.journalMinSnapshotBytes ?? JOURNAL_MIN_SNAPSHOT_BYTES,
    maxSnapshotShare: options.journalMaxSnapshotShare ?? JOURNAL_MAX_SNAPSHOT_SHARE,
  });
  const cacheKey = canonicalPath(statePath);
  stateCache.delete(cacheKey);
  let reconciled: ReconcileResult;
  try {
    reconciled = journalWrite && store.reconcileWithIngestJournal
      ? await store.reconcileWithIngestJournal(incoming, journalWrite)
      : await store.reconcileWithIngestState(incoming, nextState);
  } catch {
    throw new Error("Portable usage reconciliation failed");
  }
  let identity: { key: string; journalBytes: number } | undefined;
  try {
    identity = await stateFilesIdentity(statePath);
  } catch {
    // Without an identity the next pass simply reads the files again.
  }
  // After a journal append the new state is known exactly. A full rewrite is
  // re-serialized by the store, so the next pass reads that back instead.
  if (journalWrite && loaded.journal && identity) {
    stateCache.set(cacheKey, {
      identity: identity.key,
      loaded: {
        state: nextState,
        rewriteRequired: false,
        journal: { ...loaded.journal, usable: true, bytes: identity.journalBytes },
      },
    });
  }
  rememberCostRetries(identity?.key);
  return {
    scanned: knownSources.length,
    changed,
    inserted: reconciled.inserted,
    updated: reconciled.updated,
    existing: reconciled.existing,
    errors,
    diagnostics: loaded.diagnostics,
  };
}

async function readSource(
  source: KnownSource,
  readClaude: (refs: SourceFileRef[]) => Promise<ClaudeUsageEntry[]>,
  readCodex: (refs: CodexSourceFileRef[]) => Promise<CodexTokenEvent[]>,
  enrichCosts: ((events: readonly PortableUsageEvent[]) => Promise<PortableUsageEvent[]>) | undefined,
  batches: Map<string, PortableUsageEvent[]>,
  failedKeys: Set<string>,
  errors: IngestError[],
): Promise<void> {
  let providerEvents: ClaudeUsageEntry[] | CodexTokenEvent[];
  try {
    providerEvents = source.provider === "claude"
      ? await readClaude([source.ref as SourceFileRef])
      : await readCodex([source.ref as CodexSourceFileRef]);
  } catch {
    failedKeys.add(source.key);
    errors.push({ provider: source.provider, path: source.path, message: "read_failed" });
    return;
  }
  try {
    const normalized = source.provider === "claude"
      ? fromClaudeEntries(providerEvents as ClaudeUsageEntry[])
      : fromCodexEvents(providerEvents as CodexTokenEvent[]);
    const events = enrichCosts ? await enrichCosts(normalized) : normalized;
    if (enrichCosts && !preservesCostOnlyChanges(normalized, events)) throw new Error("invalid cost enrichment");
    batches.set(source.key, events);
  } catch {
    failedKeys.add(source.key);
    errors.push({ provider: source.provider, path: source.path, message: enrichCosts ? "cost_failed" : "adapter_failed" });
  }
}

function hasCompleteCost(event: PortableUsageEvent): boolean {
  return event.costUSD !== undefined
    && event.inputCostUSD !== undefined
    && event.outputCostUSD !== undefined
    && event.cacheCreationCostUSD !== undefined
    && event.cacheReadCostUSD !== undefined
    && event.pricingVersion !== undefined;
}

const COST_ENRICHMENT_FIELDS = new Set([
  "costUSD",
  "inputCostUSD",
  "outputCostUSD",
  "cacheCreationCostUSD",
  "cacheReadCostUSD",
  "pricingVersion",
]);

function preservesCostOnlyChanges(
  input: readonly PortableUsageEvent[],
  output: readonly PortableUsageEvent[],
): boolean {
  if (input.length !== output.length) return false;
  return input.every((event, index) => immutableEventFingerprint(event) === immutableEventFingerprint(output[index]));
}

function immutableEventFingerprint(event: PortableUsageEvent): string {
  const fields = Object.entries(event as unknown as Record<string, unknown>)
    .filter(([key]) => !COST_ENRICHMENT_FIELDS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return canonicalValue(fields);
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function assertSupportedCostEnrichmentState(statePath: string): Promise<void> {
  try {
    // The version is never journaled — changing it forces a snapshot rewrite —
    // so a cached state that still matches the files answers this as well.
    const cached = stateCache.get(canonicalPath(statePath));
    const parsed = cached && cached.identity === (await stateFilesIdentity(statePath)).key
      ? cached.loaded.state
      : parsePortableIngestStateForLoad(JSON.parse(await nodeFs.readFile(statePath, "utf8"))).state;
    if (parsed.costEnrichmentVersion !== undefined
      && parsed.costEnrichmentVersion > PORTABLE_COST_ENRICHMENT_VERSION) {
      throw new Error("Portable cost enrichment version is newer than supported");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Portable cost enrichment version is newer than supported") {
      throw error;
    }
    // Missing, corrupt, or interrupted state is handled under the normal ingestion lock.
  }
}

async function collectKnownSources(
  options: IngestPortableUsageOptions,
  errors: IngestError[],
): Promise<SourceDiscovery> {
  const failedRoots: FailedSourceRoot[] = [];
  const claudeRefs = options.claudeRefs === undefined
    ? await listClaudeDirectories(options.claudeProjectsDirs === undefined
      ? getClaudeProjectsDirs()
      : asList(options.claudeProjectsDirs), errors, failedRoots)
    : [...options.claudeRefs];
  const codexRefs = options.codexRefs === undefined
    ? await listCodexDirectories(options.codexSessionsDirs === undefined
      ? getCodexSessionsDirs()
      : asList(options.codexSessionsDirs), errors, failedRoots)
    : [...options.codexRefs];
  const unique = new Map<string, KnownSource>();
  for (const ref of claudeRefs) addKnownSource(unique, "claude", ref);
  for (const ref of codexRefs) addKnownSource(unique, "codex", ref);
  return {
    sources: [...unique.values()].sort((left, right) => compareText(left.provider, right.provider)
      || compareText(canonicalPath(left.path), canonicalPath(right.path))),
    failedRoots,
  };
}

async function listClaudeDirectories(
  directories: string[],
  errors: IngestError[],
  failedRoots: FailedSourceRoot[],
): Promise<SourceFileRef[]> {
  const refs: SourceFileRef[] = [];
  for (const directory of directories) {
    try {
      refs.push(...await listClaudeSourceFilesStrict(directory));
    } catch {
      errors.push({ provider: "claude", path: directory, message: "listing_failed" });
      failedRoots.push({ provider: "claude", path: path.resolve(directory) });
    }
  }
  return refs;
}

async function listCodexDirectories(
  directories: string[],
  errors: IngestError[],
  failedRoots: FailedSourceRoot[],
): Promise<CodexSourceFileRef[]> {
  const refs: CodexSourceFileRef[] = [];
  for (const directory of directories) {
    try {
      refs.push(...await listCodexSourceFilesStrict(directory));
    } catch {
      errors.push({ provider: "codex", path: directory, message: "listing_failed" });
      failedRoots.push({ provider: "codex", path: path.resolve(directory) });
    }
  }
  return refs;
}

function addKnownSource(
  target: Map<string, KnownSource>,
  provider: PortableProvider,
  ref: SourceFileRef | CodexSourceFileRef,
): void {
  const sourcePath = path.resolve(ref.file);
  const key = sourceKey(provider, sourcePath);
  target.set(key, { key, provider, path: sourcePath, ref });
}

async function statSourceStrict(sourcePath: string): Promise<PortableSourceFingerprint> {
  const info = await nodeFs.stat(sourcePath, { bigint: true });
  return {
    isFile: info.isFile(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  };
}

async function readStateCached(statePath: string): Promise<LoadedState> {
  const cacheKey = canonicalPath(statePath);
  let identity: string | undefined;
  try {
    identity = (await stateFilesIdentity(statePath)).key;
  } catch {
    identity = undefined;
  }
  const cached = stateCache.get(cacheKey);
  if (identity !== undefined && cached?.identity === identity) return { ...cached.loaded, diagnostics: [], identity };
  stateCache.delete(cacheKey);
  const loaded = await readStateRecovering(statePath);
  // The identity was taken before reading, so a write in between only makes the
  // entry miss next time; it can never pin content the files no longer hold.
  if (identity !== undefined && loaded.diagnostics.length === 0) {
    const { diagnostics: _diagnostics, ...rest } = loaded;
    stateCache.set(cacheKey, { identity, loaded: rest });
  }
  // Recovery may have rewritten the files, so only an untouched read keeps its identity.
  return { ...loaded, identity: loaded.diagnostics.length === 0 ? identity : undefined };
}

async function stateFilesIdentity(statePath: string): Promise<{ key: string; journalBytes: number }> {
  const snapshot = await fileIdentity(statePath);
  const journal = await fileIdentity(journalPathFor(statePath));
  return { key: `${snapshot.key}|${journal.key}`, journalBytes: journal.size };
}

async function fileIdentity(filePath: string): Promise<{ key: string; size: number; mtimeNs: string }> {
  try {
    const info = await nodeFs.stat(filePath, { bigint: true });
    return { key: `${info.size}:${info.mtimeNs}:${info.ctimeNs}`, size: Number(info.size), mtimeNs: info.mtimeNs.toString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { key: "missing", size: 0, mtimeNs: "0" };
    throw error;
  }
}

function journalPathFor(statePath: string): string {
  return path.join(path.dirname(statePath), PORTABLE_INGEST_JOURNAL_FILE);
}

/**
 * Decides whether this pass may append to the journal instead of rewriting the
 * snapshot. Anything unusual — a migrated or recovered state, a damaged journal,
 * a changed cost-enrichment version — takes the full rewrite, which is always
 * correct and also compacts the journal away.
 */
function planJournalWrite(
  loaded: LoadedState,
  nextState: PortableIngestState,
  store: IngestionStore,
  limits: { minSnapshotBytes: number; maxSnapshotShare: number },
): IngestJournalWrite | undefined {
  const journal = loaded.journal;
  const previousState = loaded.state;
  if (!store.reconcileWithIngestJournal || !journal || loaded.rewriteRequired) return undefined;
  if (journal.snapshotBytes < limits.minSnapshotBytes) return undefined;
  if (nextState.costEnrichmentVersion !== previousState.costEnrichmentVersion) return undefined;
  const delta: PortableIngestStateDelta = {};
  for (const [key, record] of Object.entries(nextState.sources)) {
    if (previousState.sources[key] === record) continue;
    // Legacy records are never produced by a pass, only migrated away by a rewrite.
    if (!isCurrentIngestSourceState(record)) return undefined;
    delta[key] = record;
  }
  for (const key of Object.keys(previousState.sources)) {
    if (!Object.prototype.hasOwnProperty.call(nextState.sources, key)) delta[key] = null;
  }
  const entryBytes = Buffer.byteLength(serializePortableIngestJournalEntry(delta), "utf8");
  const existingBytes = journal.usable ? journal.bytes : 0;
  if (existingBytes + entryBytes > journal.snapshotBytes * limits.maxSnapshotShare) return undefined;
  return journal.usable ? { delta } : { delta, startWith: journal.base };
}

async function readStateRecovering(statePath: string): Promise<LoadedState> {
  let bytes: Buffer;
  try {
    bytes = await nodeFs.readFile(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { state: emptyState(), diagnostics: [], rewriteRequired: false };
    }
    // The filesystem message may contain arbitrary host details; this boundary intentionally has no cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable ingest state read failed");
  }
  const text = bytes.toString("utf8");
  let parsed: ReturnType<typeof parsePortableIngestStateForLoad> | undefined;
  try {
    parsed = parsePortableIngestStateForLoad(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (parsed) {
    const canonical = `${JSON.stringify(parsed.state, null, 2)}\n`;
    const journal = await readJournal(statePath, parsed.state, bytes);
    return {
      state: journal.state,
      diagnostics: [],
      rewriteRequired: parsed.migrated || text !== canonical || journal.damaged,
      ...(journal.loaded ? { journal: journal.loaded } : {}),
    };
  }

  const quarantine = path.join(path.dirname(statePath), `ingest-state.corrupt.${Date.now()}.json`);
  try {
    await renameWithRetry(statePath, quarantine);
    await cleanupCorruptStateFiles(path.dirname(statePath));
  } catch {
    throw new Error("Portable ingest state recovery failed");
  }
  // No journal is loaded, so the rewrite that follows also removes any journal
  // that belonged to the quarantined snapshot.
  return {
    state: emptyState(),
    diagnostics: [{ code: "state_recovered", path: statePath }],
    rewriteRequired: true,
  };
}

/** Reads the journal next to a parsed snapshot. Any read problem degrades to "no journal". */
async function readJournal(
  statePath: string,
  snapshot: PortableIngestState,
  snapshotBytes: Buffer,
): Promise<{ state: PortableIngestState; damaged: boolean; loaded?: LoadedJournal }> {
  let base: PortableIngestJournalBase;
  try {
    const identity = await fileIdentity(statePath);
    base = {
      size: String(snapshotBytes.byteLength),
      mtimeNs: identity.mtimeNs,
      sha256: createHash("sha256").update(snapshotBytes).digest("hex"),
    };
  } catch {
    return { state: snapshot, damaged: false };
  }
  let text: string;
  try {
    text = await nodeFs.readFile(journalPathFor(statePath), "utf8");
  } catch {
    // Missing or unreadable: the next journal write starts over on this snapshot.
    return {
      state: snapshot,
      damaged: false,
      loaded: { base, snapshotBytes: snapshotBytes.byteLength, usable: false, bytes: 0 },
    };
  }
  const applied = applyPortableIngestJournal(snapshot, base, text);
  return {
    state: applied.state,
    damaged: applied.damaged,
    loaded: {
      base,
      snapshotBytes: snapshotBytes.byteLength,
      usable: applied.usable,
      bytes: applied.usable ? Buffer.byteLength(text, "utf8") : 0,
    },
  };
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await nodeFs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code !== "EPERM" && code !== "EACCES") || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

async function cleanupCorruptStateFiles(rootDir: string): Promise<void> {
  const entries = await nodeFs.readdir(rootDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const match = CORRUPT_STATE_FILE.exec(entry.name);
      return match ? [{ name: entry.name, timestamp: Number(match[1]) }] : [];
    })
    .sort((left, right) => right.timestamp - left.timestamp || compareText(right.name, left.name));
  for (const candidate of candidates.slice(MAX_CORRUPT_STATE_FILES)) {
    try {
      await nodeFs.unlink(path.join(rootDir, candidate.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
}

function findPreviousSource(
  sources: PortableIngestState["sources"],
  source: KnownSource,
): CurrentIngestSourceState | undefined {
  const direct = sources[source.key];
  if (isCurrentIngestSourceState(direct)) return direct;
  return Object.values(sources).find((candidate): candidate is CurrentIngestSourceState => isCurrentIngestSourceState(candidate)
    && candidate.provider === source.provider && canonicalPath(candidate.path) === canonicalPath(source.path));
}

function removeLegacySource(sources: PortableIngestState["sources"], source: KnownSource): void {
  for (const [key, candidate] of Object.entries(sources)) {
    if (isCurrentIngestSourceState(candidate)) continue;
    const sameOwnedPath = candidate.provider === source.provider && typeof candidate.path === "string"
      && canonicalPath(candidate.path) === canonicalPath(source.path);
    if (sameOwnedPath || canonicalPath(key) === canonicalPath(source.path)) delete sources[key];
  }
}

function sameFingerprint(
  state: CurrentIngestSourceState,
  fingerprint: { size: string; mtimeNs: string; ctimeNs: string },
): boolean {
  return state.size === fingerprint.size && state.mtimeNs === fingerprint.mtimeNs && state.ctimeNs === fingerprint.ctimeNs;
}

function fingerprintKey(fingerprint: Omit<PortableSourceFingerprint, "isFile">): string {
  return `${fingerprint.size}:${fingerprint.mtimeNs}:${fingerprint.ctimeNs}`;
}

function emptyState(): PortableIngestState {
  return { schemaVersion: PORTABLE_STORE_VERSION, sources: {} };
}

function emptyResult(
  scanned: number,
  changed: number,
  errors: IngestError[],
  diagnostics: IngestDiagnostic[],
): IngestPortableUsageResult {
  return { scanned, changed, inserted: 0, updated: 0, existing: 0, errors, diagnostics };
}

function sourceKey(provider: PortableProvider, sourcePath: string): string {
  return portableIngestSourceKey(provider, sourcePath);
}

// path.resolve is not cheap and this runs several times per known source, which
// means thousands of calls per ingest pass over the same handful of paths.
const canonicalPaths = new Map<string, string>();

function canonicalPath(filePath: string): string {
  const cached = canonicalPaths.get(filePath);
  if (cached !== undefined) return cached;
  const resolved = path.resolve(filePath);
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  // Paths come from directory listings and stored state, so the set is bounded
  // by the number of sources; a cap keeps a pathological case from growing it.
  if (canonicalPaths.size < 50_000) canonicalPaths.set(filePath, canonical);
  return canonical;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSourceStates(left: CurrentIngestSourceState, right: CurrentIngestSourceState): number {
  return compareText(left.provider, right.provider)
    || compareText(canonicalPath(left.path), canonicalPath(right.path));
}

function isUnderFailedRoot(source: CurrentIngestSourceState, failedRoots: readonly FailedSourceRoot[]): boolean {
  return failedRoots.some((root) => root.provider === source.provider && isPathContained(root.path, source.path));
}

function isPathContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(canonicalPath(rootPath), canonicalPath(candidatePath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function asList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isOperationError(value: unknown): value is { marker: symbol; error: unknown } {
  return Boolean(value && typeof value === "object"
    && (value as { marker?: unknown }).marker === INGEST_OPERATION_ERROR
    && Object.prototype.hasOwnProperty.call(value, "error"));
}

function getDefaultStore(): PortableUsageStore {
  return getSharedUsageStore(getPortableUsageDir());
}
