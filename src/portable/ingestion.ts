import * as nodeFs from "node:fs/promises";
import path from "node:path";
import {
  getClaudeProjectsDirs,
  getCodexSessionsDirs,
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
import { withNamedPortableRootLock } from "./rootLock";
import { PORTABLE_STORE_VERSION, type PortableIngestState, type PortableProvider, type PortableUsageEvent } from "./types";
import { PortableUsageStore } from "./usageStore";

type ReconcileResult = { inserted: number; updated: number; existing: number };
type SourceErrorCode = "listing_failed" | "stat_failed" | "read_failed" | "adapter_failed";
type IngestError = { provider: PortableProvider; path: string; message: SourceErrorCode };
type IngestDiagnostic = { code: "state_recovered"; path: string };
type IngestionStore = {
  getIngestStatePath(): string;
  reconcileWithIngestState(events: readonly PortableUsageEvent[], state: PortableIngestState): Promise<ReconcileResult>;
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

interface CurrentSourceState {
  provider: PortableProvider;
  path: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  processedAt: string;
  eventIds: string[];
  active: boolean;
}

interface LoadedState {
  state: PortableIngestState;
  diagnostics: IngestDiagnostic[];
  rewriteRequired: boolean;
}

interface ParsedState {
  state: PortableIngestState;
  migrated: boolean;
}

const stateQueues = new Map<string, Promise<void>>();
const INGEST_OPERATION_ERROR = Symbol("ingest-operation-error");

export function ingestPortableUsage(options: IngestPortableUsageOptions = {}): Promise<IngestPortableUsageResult> {
  const store = options.store ?? new PortableUsageStore();
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
  const loaded = await readStateRecovering(statePath);
  const previousState = loaded.state;
  const nextSources = cloneSources(previousState.sources);
  const discovery = await collectKnownSources(options, errors);
  const knownSources = discovery.sources;
  const sourceByKey = new Map(knownSources.map((source) => [source.key, source]));
  const currentKeys = new Set(sourceByKey.keys());
  const unavailableKeys = new Set<string>();

  let activityChanged = loaded.rewriteRequired;
  for (const [key, source] of Object.entries(nextSources)) {
    if (!isCurrentSourceState(source) || currentKeys.has(sourceKey(source.provider, source.path))) continue;
    if (source.active !== false && isUnderFailedRoot(source, discovery.failedRoots)) {
      unavailableKeys.add(key);
    } else if (source.active !== false) {
      nextSources[key] = { ...source, active: false };
      activityChanged = true;
    }
  }

  const fingerprints = new Map<string, Omit<PortableSourceFingerprint, "isFile">>();
  const previousByKey = new Map<string, CurrentSourceState>();
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
        nextSources[source.key] = { ...previous, active: false };
        activityChanged = true;
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
    await readSource(sourceByKey.get(key) as KnownSource, readClaude, readCodex, batches, failedKeys, errors);
  }

  const collisionOwners = new Set<string>();
  const activeOwners = new Map<string, CurrentSourceState>();
  for (const [key, source] of Object.entries(nextSources)) {
    if (isCurrentSourceState(source) && source.active) activeOwners.set(key, source);
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
      await readSource(sourceByKey.get(ownerKey) as KnownSource, readClaude, readCodex, batches, failedKeys, errors);
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
  const incoming: PortableUsageEvent[] = [];
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
    if (!intersectsProtected) {
      const fingerprint = fingerprints.get(source.key);
      if (fingerprint) {
        removeLegacySource(nextSources, source);
        nextSources[source.key] = {
          provider: source.provider,
          path: source.path,
          ...fingerprint,
          processedAt: new Date().toISOString(),
          eventIds: events.map(({ id }) => id),
          active: true,
        };
      }
    }
  }

  if (successfulChanged === 0 && incoming.length === 0 && !activityChanged) {
    return emptyResult(knownSources.length, changed, errors, loaded.diagnostics);
  }

  const nextState: PortableIngestState = { schemaVersion: PORTABLE_STORE_VERSION, sources: nextSources };
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
    const events = source.provider === "claude"
      ? fromClaudeEntries(providerEvents as ClaudeUsageEntry[])
      : fromCodexEvents(providerEvents as CodexTokenEvent[]);
    batches.set(source.key, events);
  } catch {
    failedKeys.add(source.key);
    errors.push({ provider: source.provider, path: source.path, message: "adapter_failed" });
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
    const parsed = parseState(JSON.parse(text));
    const canonical = `${JSON.stringify(parsed.state, null, 2)}\n`;
    return { state: parsed.state, diagnostics: [], rewriteRequired: parsed.migrated || text !== canonical };
  } catch {
    const quarantine = path.join(path.dirname(statePath), `ingest-state.corrupt.${Date.now()}.json`);
    try {
      await renameWithRetry(statePath, quarantine);
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

function parseState(value: unknown): ParsedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid state");
  const fields = value as Record<string, unknown>;
  if (!hasExactKeys(fields, ["schemaVersion", "sources"])
    || fields.schemaVersion !== PORTABLE_STORE_VERSION
    || !fields.sources || typeof fields.sources !== "object" || Array.isArray(fields.sources)) throw new Error("invalid state");
  const sources: PortableIngestState["sources"] = {};
  let migrated = false;
  for (const [key, valueSource] of Object.entries(fields.sources as Record<string, unknown>)) {
    if (!valueSource || typeof valueSource !== "object" || Array.isArray(valueSource)) throw new Error("invalid source");
    const source = valueSource as Record<string, unknown>;
    if (isLegacySource(source)) {
      migrated = true;
      sources[key] = { size: source.size, mtimeMs: source.mtimeMs, processedAt: source.processedAt };
      continue;
    }
    if (isOwnedLegacySource(source)) {
      migrated = true;
      sources[key] = {
        provider: source.provider,
        path: source.path,
        size: source.size,
        mtimeMs: source.mtimeMs,
        processedAt: source.processedAt,
        eventIds: [...source.eventIds],
        active: source.active,
      };
      continue;
    }
    if (!isCurrentSourceRecord(source)) throw new Error("invalid source");
    const current = source as unknown as CurrentSourceState;
    if (key !== sourceKey(current.provider, current.path)) throw new Error("invalid source key");
    sources[key] = {
      provider: current.provider,
      path: current.path,
      size: current.size,
      mtimeNs: current.mtimeNs,
      ctimeNs: current.ctimeNs,
      processedAt: current.processedAt,
      eventIds: [...current.eventIds],
      active: current.active,
    };
  }
  return { state: { schemaVersion: PORTABLE_STORE_VERSION, sources }, migrated };
}

function isLegacySource(source: Record<string, unknown>): source is {
  size: number; mtimeMs: number; processedAt: string;
} {
  return Object.keys(source).every((key) => ["size", "mtimeMs", "processedAt"].includes(key))
    && isNonNegativeFinite(source.size) && isNonNegativeFinite(source.mtimeMs)
    && typeof source.processedAt === "string" && Number.isFinite(Date.parse(source.processedAt));
}

function isOwnedLegacySource(source: Record<string, unknown>): source is {
  provider: PortableProvider; path: string; size: number; mtimeMs: number;
  processedAt: string; eventIds: string[]; active: boolean;
} {
  const allowed = ["provider", "path", "size", "mtimeMs", "processedAt", "eventIds", "active"];
  return Object.keys(source).every((key) => allowed.includes(key))
    && (source.provider === "claude" || source.provider === "codex")
    && typeof source.path === "string" && path.isAbsolute(source.path)
    && isNonNegativeFinite(source.size) && isNonNegativeFinite(source.mtimeMs)
    && typeof source.processedAt === "string" && Number.isFinite(Date.parse(source.processedAt))
    && Array.isArray(source.eventIds) && source.eventIds.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id))
    && typeof source.active === "boolean";
}

function isCurrentSourceRecord(source: Record<string, unknown>): boolean {
  const allowed = ["provider", "path", "size", "mtimeNs", "ctimeNs", "processedAt", "eventIds", "active"];
  return Object.keys(source).every((key) => allowed.includes(key))
    && (source.provider === "claude" || source.provider === "codex")
    && typeof source.path === "string" && path.isAbsolute(source.path) && isDecimal(source.size)
    && isDecimal(source.mtimeNs) && isDecimal(source.ctimeNs)
    && typeof source.processedAt === "string" && Number.isFinite(Date.parse(source.processedAt))
    && Array.isArray(source.eventIds) && source.eventIds.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id))
    && typeof source.active === "boolean";
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

function findPreviousSource(
  sources: PortableIngestState["sources"],
  source: KnownSource,
): CurrentSourceState | undefined {
  const direct = sources[source.key];
  if (isCurrentSourceState(direct)) return direct;
  return Object.values(sources).find((candidate): candidate is CurrentSourceState => isCurrentSourceState(candidate)
    && candidate.provider === source.provider && canonicalPath(candidate.path) === canonicalPath(source.path));
}

function removeLegacySource(sources: PortableIngestState["sources"], source: KnownSource): void {
  for (const [key, candidate] of Object.entries(sources)) {
    if (isCurrentSourceState(candidate)) continue;
    const sameOwnedPath = candidate.provider === source.provider && typeof candidate.path === "string"
      && canonicalPath(candidate.path) === canonicalPath(source.path);
    if (sameOwnedPath || canonicalPath(key) === canonicalPath(source.path)) delete sources[key];
  }
}

function isCurrentSourceState(
  value: PortableIngestState["sources"][string] | undefined,
): value is CurrentSourceState {
  return Boolean(value && isCurrentSourceRecord(value as unknown as Record<string, unknown>));
}

function sameFingerprint(
  state: CurrentSourceState,
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
  return `${provider}:${canonicalPath(sourcePath)}`;
}

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSourceStates(left: CurrentSourceState, right: CurrentSourceState): number {
  return compareText(left.provider, right.provider)
    || compareText(canonicalPath(left.path), canonicalPath(right.path));
}

function isUnderFailedRoot(source: CurrentSourceState, failedRoots: readonly FailedSourceRoot[]): boolean {
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

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isOperationError(value: unknown): value is { marker: symbol; error: unknown } {
  return Boolean(value && typeof value === "object"
    && (value as { marker?: unknown }).marker === INGEST_OPERATION_ERROR
    && Object.prototype.hasOwnProperty.call(value, "error"));
}
