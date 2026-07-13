import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { getPortableIngestStatePath } from "../config/paths";
import {
  listCodexSourceFiles,
  readCodexTokensFromFiles,
  type CodexSourceFileRef,
  type CodexTokenEvent,
} from "../pricing/codex-log-reader";
import {
  listClaudeSourceFiles,
  readClaudeUsageEntriesFromFiles,
  type ClaudeUsageEntry,
  type SourceFileRef,
} from "../pricing/jsonl-reader";
import { fromClaudeEntries, fromCodexEvents } from "./eventAdapters";
import { PORTABLE_STORE_VERSION, type PortableIngestState, type PortableProvider, type PortableUsageEvent } from "./types";
import { PortableUsageStore } from "./usageStore";

type ReconcileResult = { inserted: number; updated: number; existing: number };
type IngestionStore = { reconcile(events: readonly PortableUsageEvent[]): Promise<ReconcileResult> };
type IngestError = { provider: PortableProvider; path: string; message: string };

export interface IngestPortableUsageOptions {
  store?: IngestionStore;
  statePath?: string;
  claudeProjectsDirs?: string | string[];
  codexSessionsDirs?: string | string[];
  claudeRefs?: readonly SourceFileRef[];
  codexRefs?: readonly CodexSourceFileRef[];
  readClaude?: (refs: SourceFileRef[]) => Promise<ClaudeUsageEntry[]>;
  readCodex?: (refs: CodexSourceFileRef[]) => Promise<CodexTokenEvent[]>;
}

export interface IngestPortableUsageResult extends ReconcileResult {
  scanned: number;
  changed: number;
  errors: IngestError[];
}

interface KnownSource {
  provider: PortableProvider;
  path: string;
  ref: SourceFileRef | CodexSourceFileRef;
}

interface CompleteSourceState {
  provider: PortableProvider;
  path: string;
  size: number;
  mtimeMs: number;
  processedAt: string;
  eventIds: string[];
  active: boolean;
}

const stateQueues = new Map<string, Promise<void>>();

export function ingestPortableUsage(options: IngestPortableUsageOptions = {}): Promise<IngestPortableUsageResult> {
  const statePath = path.resolve(options.statePath ?? getPortableIngestStatePath());
  const stateKey = canonicalPath(statePath);
  // The portable store has its own cross-process lock. Ingest state is main-process-owned; this queue serializes it in-isolate.
  const previous = stateQueues.get(stateKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => ingestExclusive(options, statePath));
  const tail = result.then(() => undefined, () => undefined);
  stateQueues.set(stateKey, tail);
  return result.finally(() => {
    if (stateQueues.get(stateKey) === tail) stateQueues.delete(stateKey);
  });
}

async function ingestExclusive(
  options: IngestPortableUsageOptions,
  statePath: string,
): Promise<IngestPortableUsageResult> {
  const store = options.store ?? new PortableUsageStore();
  const readClaude = options.readClaude ?? readClaudeUsageEntriesFromFiles;
  const readCodex = options.readCodex ?? readCodexTokensFromFiles;
  const errors: IngestError[] = [];
  const previousState = await readState(statePath);
  const nextSources = cloneSources(previousState.sources);
  const knownSources = await collectKnownSources(options, errors);
  const currentKeys = new Set(knownSources.map(({ provider, path: sourcePath }) => sourceKey(provider, sourcePath)));

  let activityChanged = false;
  for (const [key, source] of Object.entries(nextSources)) {
    if (isCompleteSourceState(source) && !currentKeys.has(sourceKey(source.provider, source.path)) && source.active !== false) {
      nextSources[key] = { ...source, active: false };
      activityChanged = true;
    }
  }

  let changed = 0;
  let successfulChanged = 0;
  const incoming: PortableUsageEvent[] = [];
  for (const source of knownSources) {
    const key = sourceKey(source.provider, source.path);
    const previous = findPreviousSource(nextSources, source);
    let fingerprint: { size: number; mtimeMs: number };
    try {
      const info = await nodeFs.stat(source.path);
      if (!info.isFile()) throw new Error("not a file");
      fingerprint = { size: info.size, mtimeMs: Math.round(info.mtimeMs) };
    } catch {
      if (previous && previous.active !== false) {
        nextSources[key] = { ...previous, provider: source.provider, path: source.path, active: false };
        activityChanged = true;
      }
      errors.push({ provider: source.provider, path: source.path, message: "Source could not be inspected." });
      continue;
    }

    if (previous && previous.size === fingerprint.size && previous.mtimeMs === fingerprint.mtimeMs) {
      if (previous.active !== true || previous.provider !== source.provider || previous.path !== source.path) {
        nextSources[key] = { ...previous, provider: source.provider, path: source.path, active: true };
        activityChanged = true;
      }
      continue;
    }

    changed += 1;
    try {
      const events = source.provider === "claude"
        ? fromClaudeEntries(await readClaude([source.ref as SourceFileRef]))
        : fromCodexEvents(await readCodex([source.ref as CodexSourceFileRef]));
      incoming.push(...events);
      successfulChanged += 1;
      nextSources[key] = {
        provider: source.provider,
        path: source.path,
        ...fingerprint,
        processedAt: new Date().toISOString(),
        eventIds: events.map(({ id }) => id),
        active: true,
      };
    } catch {
      errors.push({ provider: source.provider, path: source.path, message: "Source could not be read." });
    }
  }

  if (successfulChanged === 0 && !activityChanged) {
    return { scanned: knownSources.length, changed, inserted: 0, updated: 0, existing: 0, errors };
  }

  const reconciled = await store.reconcile(incoming);
  const nextState: PortableIngestState = { schemaVersion: PORTABLE_STORE_VERSION, sources: nextSources };
  await writeStateAtomic(statePath, nextState);
  return { scanned: knownSources.length, changed, ...reconciled, errors };
}

async function collectKnownSources(
  options: IngestPortableUsageOptions,
  errors: IngestError[],
): Promise<KnownSource[]> {
  const claudeRefs = options.claudeRefs === undefined
    ? await listKnownClaudeRefs(options.claudeProjectsDirs ?? [], errors)
    : [...options.claudeRefs];
  const codexRefs = options.codexRefs === undefined
    ? await listKnownCodexRefs(options.codexSessionsDirs ?? [], errors)
    : [...options.codexRefs];
  const unique = new Map<string, KnownSource>();
  for (const ref of claudeRefs) {
    const sourcePath = path.resolve(ref.file);
    unique.set(sourceKey("claude", sourcePath), { provider: "claude", path: sourcePath, ref });
  }
  for (const ref of codexRefs) {
    const sourcePath = path.resolve(ref.file);
    unique.set(sourceKey("codex", sourcePath), { provider: "codex", path: sourcePath, ref });
  }
  return [...unique.values()].sort((left, right) => compareText(left.provider, right.provider)
    || compareText(canonicalPath(left.path), canonicalPath(right.path)));
}

async function listKnownClaudeRefs(
  directories: string | string[],
  errors: IngestError[],
): Promise<SourceFileRef[]> {
  try {
    return await listClaudeSourceFiles(directories);
  } catch {
    for (const directory of asList(directories)) {
      errors.push({ provider: "claude", path: directory, message: "Source files could not be listed." });
    }
    return [];
  }
}

async function listKnownCodexRefs(
  directories: string | string[],
  errors: IngestError[],
): Promise<CodexSourceFileRef[]> {
  try {
    return await listCodexSourceFiles(directories);
  } catch {
    for (const directory of asList(directories)) {
      errors.push({ provider: "codex", path: directory, message: "Source files could not be listed." });
    }
    return [];
  }
}

async function readState(statePath: string): Promise<PortableIngestState> {
  let text: string;
  try {
    text = await nodeFs.readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { schemaVersion: PORTABLE_STORE_VERSION, sources: {} };
    }
    throw error;
  }
  try {
    return parseState(JSON.parse(text));
  } catch {
    throw new Error("Invalid portable ingest state");
  }
}

function parseState(value: unknown): PortableIngestState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid state");
  const fields = value as Record<string, unknown>;
  if (fields.schemaVersion !== PORTABLE_STORE_VERSION
    || !fields.sources || typeof fields.sources !== "object" || Array.isArray(fields.sources)) {
    throw new Error("invalid state");
  }
  const sources: PortableIngestState["sources"] = {};
  for (const [key, source] of Object.entries(fields.sources as Record<string, unknown>)) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid source state");
    const item = source as Record<string, unknown>;
    if (!isNonNegativeFinite(item.size) || !isNonNegativeFinite(item.mtimeMs)
      || typeof item.processedAt !== "string" || !Number.isFinite(Date.parse(item.processedAt))) {
      throw new Error("invalid source state");
    }
    const parsed: PortableIngestState["sources"][string] = {
      size: item.size,
      mtimeMs: item.mtimeMs,
      processedAt: item.processedAt,
    };
    if (item.provider === "claude" || item.provider === "codex") parsed.provider = item.provider;
    if (typeof item.path === "string") parsed.path = item.path;
    if (Array.isArray(item.eventIds) && item.eventIds.every((id) => typeof id === "string")) parsed.eventIds = [...item.eventIds];
    if (typeof item.active === "boolean") parsed.active = item.active;
    sources[key] = parsed;
  }
  return { schemaVersion: PORTABLE_STORE_VERSION, sources };
}

async function writeStateAtomic(statePath: string, state: PortableIngestState): Promise<void> {
  await nodeFs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await nodeFs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await nodeFs.rename(temporary, statePath);
  } catch (error) {
    try {
      await nodeFs.unlink(temporary);
    } catch {
      // Preserve the primary atomic-write failure.
    }
    throw error;
  }
}

function cloneSources(sources: PortableIngestState["sources"]): PortableIngestState["sources"] {
  return Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, {
    ...value,
    ...(value.eventIds ? { eventIds: [...value.eventIds] } : {}),
  }]));
}

function findPreviousSource(
  sources: PortableIngestState["sources"],
  source: KnownSource,
): CompleteSourceState | undefined {
  const direct = sources[sourceKey(source.provider, source.path)];
  if (isCompleteSourceState(direct)) return direct;
  for (const candidate of Object.values(sources)) {
    if (isCompleteSourceState(candidate)
      && candidate.provider === source.provider
      && canonicalPath(candidate.path) === canonicalPath(source.path)) return candidate;
  }
  return undefined;
}

function isCompleteSourceState(value: PortableIngestState["sources"][string] | undefined): value is CompleteSourceState {
  return Boolean(value
    && (value.provider === "claude" || value.provider === "codex")
    && typeof value.path === "string"
    && Array.isArray(value.eventIds)
    && typeof value.active === "boolean");
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

function asList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
