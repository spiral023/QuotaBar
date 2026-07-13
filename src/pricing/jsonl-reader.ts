import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FileParseCache } from "./file-parse-cache";
import { basenameAnySeparator, plainClaudeProjectName } from "../shared/projectName";

export interface ModelTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface AggregatedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelNames: string[];
  perModel: Record<string, ModelTokens>;
  costUSD: number;
  hasCostUSD: boolean;
}

export interface ClaudeUsageEntry extends ModelTokens {
  provider: "claude";
  timestamp: string;
  model: string;
  project: string;
  projectName?: string;
  session: string;
  costUSD?: number;
  inputCostUSD?: number;
  outputCostUSD?: number;
  cacheCreationCostUSD?: number;
  cacheReadCostUSD?: number;
  pricingVersion?: string;
  sourceEventId?: string;
}

interface ParsedClaudeUsageEntry extends ClaudeUsageEntry {
  messageId?: string;
}

const claudeFileCache = new FileParseCache<ParsedClaudeUsageEntry[]>();

const EMPTY: Omit<AggregatedTokens, "modelNames" | "perModel"> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  hasCostUSD: false,
};

export async function readClaudeTokensForPeriod(
  projectsDir: string | string[],
  billingStart: Date,
): Promise<AggregatedTokens> {
  const entries = await readClaudeUsageEntriesForPeriod(projectsDir, billingStart);
  return aggregateClaudeEntries(entries);
}

export async function readClaudeUsageEntriesForPeriod(
  projectsDir: string | string[],
  billingStart: Date,
): Promise<ClaudeUsageEntry[]> {
  const refs = await listClaudeSourceFiles(projectsDir);
  return readClaudeUsageEntriesFromFiles(refs, billingStart);
}

export interface SourceFileRef {
  file: string;     // absoluter Pfad zur .jsonl-Datei
  baseDir: string;  // projectsDir, aus dem die Datei stammt
}

/** Lists every Claude usage .jsonl source file across the given project dirs. */
export async function listClaudeSourceFiles(projectsDir: string | string[]): Promise<SourceFileRef[]> {
  const dirs = Array.isArray(projectsDir) ? projectsDir : [projectsDir];
  const refs: SourceFileRef[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await fs.readdir(dir, { recursive: true })) as string[];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith(".jsonl")) refs.push({ file: path.join(dir, e), baseDir: dir });
    }
  }
  return refs;
}

export interface StrictClaudeReaderDependencies {
  createReadStream?: (filePath: string, options: { encoding: BufferEncoding }) => NodeJS.ReadableStream;
}

/** Strict ingestion listing: configured directory I/O errors propagate. */
export async function listClaudeSourceFilesStrict(projectsDir: string | string[]): Promise<SourceFileRef[]> {
  const dirs = Array.isArray(projectsDir) ? projectsDir : [projectsDir];
  const refs: SourceFileRef[] = [];
  for (const dir of dirs) {
    const entries = (await fs.readdir(dir, { recursive: true })) as string[];
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) refs.push({ file: path.join(dir, entry), baseDir: dir });
    }
  }
  return refs;
}

/**
 * Parses the given source files with messageId de-duplication.
 * billingStart filter is applied BEFORE dedup — same order as readClaudeEntriesFromDir.
 */
export async function readClaudeUsageEntriesFromFiles(refs: SourceFileRef[], billingStart?: Date): Promise<ClaudeUsageEntry[]> {
  return readClaudeEntries(refs, billingStart, false);
}

/** Strict ingestion reader: outer stream errors propagate and failed parses are not cached. */
export async function readClaudeUsageEntriesFromFilesStrict(
  refs: SourceFileRef[],
  billingStart?: Date,
  dependencies: StrictClaudeReaderDependencies = {},
): Promise<ClaudeUsageEntry[]> {
  return readClaudeEntries(refs, billingStart, true, dependencies);
}

async function readClaudeEntries(
  refs: SourceFileRef[],
  billingStart: Date | undefined,
  strict: boolean,
  dependencies: StrictClaudeReaderDependencies = {},
): Promise<ClaudeUsageEntry[]> {
  const result: ClaudeUsageEntry[] = [];
  const seenMessageIds = new Set<string>();
  for (const ref of refs) {
    const parsed = strict
      ? await processJsonlFile(ref.file, ref.baseDir, true, dependencies)
      : await claudeFileCache.get(ref.file, () => processJsonlFile(ref.file, ref.baseDir));
    for (const entry of parsed) {
      if (billingStart && new Date(entry.timestamp) < billingStart) continue;
      if (entry.messageId) {
        if (seenMessageIds.has(entry.messageId)) continue;
        seenMessageIds.add(entry.messageId);
      }
      const { messageId: _messageId, ...publicEntry } = entry;
      result.push(publicEntry);
    }
  }
  return result;
}

export function aggregateClaudeEntries(entries: ClaudeUsageEntry[]): AggregatedTokens {
  const totals = { ...EMPTY, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const modelSet = new Set<string>();
  const perModel: Record<string, ModelTokens> = {};
  let costUSD = 0;
  let hasCostUSD = false;

  for (const entry of entries) {
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheCreationTokens += entry.cacheCreationTokens;
    totals.cacheReadTokens += entry.cacheReadTokens;
    if (entry.costUSD !== undefined) {
      costUSD += entry.costUSD;
      hasCostUSD = true;
    }
    if (entry.model) {
      modelSet.add(entry.model);
      const m = perModel[entry.model] ?? (perModel[entry.model] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
      m.inputTokens += entry.inputTokens;
      m.outputTokens += entry.outputTokens;
      m.cacheCreationTokens += entry.cacheCreationTokens;
      m.cacheReadTokens += entry.cacheReadTokens;
    }
  }

  return { ...totals, modelNames: Array.from(modelSet), perModel, costUSD, hasCostUSD };
}


async function processJsonlFile(
  filePath: string,
  projectsDir: string,
  strict = false,
  dependencies: StrictClaudeReaderDependencies = {},
): Promise<ParsedClaudeUsageEntry[]> {
  const result: ParsedClaudeUsageEntry[] = [];
  try {
    const rl = createInterface({
      input: (dependencies.createReadStream ?? createReadStream)(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        const parsed = processEntry(entry, filePath, projectsDir);
        if (parsed) result.push(parsed);
      } catch {
        // skip invalid lines
      }
    }
  } catch (error) {
    if (strict) throw error;
    // file not found or read error — return what was collected so far
  }
  return result;
}

function processEntry(
  entry: Record<string, unknown>,
  filePath: string,
  projectsDir: string,
): ParsedClaudeUsageEntry | null {
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : null;
  if (!ts) return null;

  const msg = entry.message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const message = msg as Record<string, unknown>;

  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const msgId = typeof message.id === "string" ? message.id : null;

  const model = typeof message.model === "string" ? message.model : "unknown";

  const u = usage as Record<string, unknown>;

  const input = positiveNumber(u.input_tokens);
  const output = positiveNumber(u.output_tokens);
  const cacheCreate = positiveNumber(u.cache_creation_input_tokens);
  const cacheRead = positiveNumber(u.cache_read_input_tokens);

  const relative = path.relative(projectsDir, filePath);
  const parts = relative.split(/[\\/]/).filter(Boolean);
  const fileBase = path.basename(filePath, ".jsonl");
  const cost = positiveNumber(entry.costUSD);
  const project = parts[0] ?? "unknown";
  const projectName = basenameAnySeparator(entry.cwd) ?? plainClaudeProjectName(project);

  return {
    provider: "claude",
    timestamp: ts,
    model,
    project,
    ...(projectName ? { projectName } : {}),
    session: typeof entry.sessionId === "string" ? entry.sessionId : fileBase,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    ...(msgId ? { sourceEventId: msgId } : {}),
    ...(msgId ? { messageId: msgId } : {}),
    ...(cost > 0 ? { costUSD: cost } : {}),
  };
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
