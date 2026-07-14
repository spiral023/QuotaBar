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
  isCurrentIngestSourceState,
  parsePortableIngestStateForLoad,
  portableIngestSourceKey,
  type CurrentIngestSourceState,
} from "./ingestState";
import { withNamedPortableRootLock } from "./rootLock";
import { PORTABLE_STORE_VERSION, type PortableIngestState, type PortableProvider, type PortableUsageEvent } from "./types";
import { PortableUsageStore } from "./usageStore";

type ReconcileResult = { inserted: number; updated: number; existing: number };
type SourceErrorCode = "listing_failed" | "stat_failed" | "read_failed" | "adapter_failed" | "cost_failed";
type IngestError = { provider: PortableProvider; path: string; message: SourceErrorCode };
type IngestDiagnostic = { code: "state_recovered"; path: string };
type IngestionStore = {
  getIngestStatePath(): string;
  recoverPending(): Promise<void>;
  reconcileWithIngestState(events: readonly PortableUsageEvent[], state: PortableIngestState): Promise<ReconcileResult>;
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
}

const stateQueues = new Map<string, Promise<void>>();
// Normal production has one canonical root; retaining its store also retains verified partition snapshots.
const defaultStores = new Map<string, PortableUsageStore>();
const INGEST_OPERATION_ERROR = Symbol("ingest-operation-error");
const CORRUPT_STATE_FILE = /^ingest-state\.corrupt\.(\d{13})\.json$/;
const MAX_CORRUPT_STATE_FILES = 3;

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
  const loaded = await readStateRecovering(statePath);
  const previousState = loaded.state;
  if (options.enrichCosts
    && previousState.costEnrichmentVersion !== undefined
    && previousState.costEnrichmentVersion > PORTABLE_COST_ENRICHMENT_VERSION) {
    throw new Error("Portable cost enrichment version is newer than supported");
  }
  const nextSources = cloneSources(previousState.sources);
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
  if (costRepairRequired && store.read) {
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
  if (successfulChanged === 0 && incoming.length === 0 && !activityChanged && !costRepairCompleted) {
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
  let reconciled: ReconcileResult;
  try {
    reconciled = await store.reconcileWithIngestState(incoming, nextState);
  } catch {
    throw new Error("Portable usage reconciliation failed");
  }
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
    const parsed = parsePortableIngestStateForLoad(JSON.parse(await nodeFs.readFile(statePath, "utf8"))).state;
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

async function readStateRecovering(statePath: string): Promise<LoadedState> {
  let text: string;
  try {
    text = await nodeFs.readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { state: emptyState(), diagnostics: [], rewriteRequired: false };
    }
    // The filesystem message may contain arbitrary host details; this boundary intentionally has no cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable ingest state read failed");
  }
  try {
    const parsed = parsePortableIngestStateForLoad(JSON.parse(text));
    const canonical = `${JSON.stringify(parsed.state, null, 2)}\n`;
    return { state: parsed.state, diagnostics: [], rewriteRequired: parsed.migrated || text !== canonical };
  } catch {
    const quarantine = path.join(path.dirname(statePath), `ingest-state.corrupt.${Date.now()}.json`);
    try {
      await renameWithRetry(statePath, quarantine);
      await cleanupCorruptStateFiles(path.dirname(statePath));
    } catch {
      throw new Error("Portable ingest state recovery failed");
    }
    return {
      state: emptyState(),
      diagnostics: [{ code: "state_recovered", path: statePath }],
      rewriteRequired: true,
    };
  }
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

function cloneSources(sources: PortableIngestState["sources"]): PortableIngestState["sources"] {
  return Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, {
    ...value,
    ...(value.eventIds ? { eventIds: [...value.eventIds] } : {}),
  }]));
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

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
  const rootDir = path.resolve(getPortableUsageDir());
  const key = canonicalPath(rootDir);
  const existing = defaultStores.get(key);
  if (existing) return existing;
  const store = new PortableUsageStore(rootDir);
  defaultStores.set(key, store);
  return store;
}
