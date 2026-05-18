import fs from "node:fs/promises";
import path from "node:path";

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
}

const EMPTY: Omit<AggregatedTokens, "modelNames" | "perModel"> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

export async function readClaudeTokensForPeriod(
  projectsDir: string,
  billingStart: Date,
): Promise<AggregatedTokens> {
  let entries: string[];
  try {
    entries = (await fs.readdir(projectsDir, { recursive: true })) as string[];
  } catch {
    return { ...EMPTY, modelNames: [], perModel: {} };
  }

  const files = entries.filter((e) => e.endsWith(".jsonl")).map((e) => path.join(projectsDir, e));

  const totals = { ...EMPTY, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const modelSet = new Set<string>();
  const seenMessageIds = new Set<string>();
  const perModel: Record<string, ModelTokens> = {};

  for (const file of files) {
    await processJsonlFile(file, billingStart, totals, modelSet, seenMessageIds, perModel);
  }

  return { ...totals, modelNames: Array.from(modelSet), perModel };
}

async function processJsonlFile(
  filePath: string,
  billingStart: Date,
  totals: Omit<AggregatedTokens, "modelNames" | "perModel">,
  modelSet: Set<string>,
  seenMessageIds: Set<string>,
  perModel: Record<string, ModelTokens>,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      processEntry(entry, billingStart, totals, modelSet, seenMessageIds, perModel);
    } catch {
      // skip invalid lines
    }
  }
}

function processEntry(
  entry: Record<string, unknown>,
  billingStart: Date,
  totals: Omit<AggregatedTokens, "modelNames" | "perModel">,
  modelSet: Set<string>,
  seenMessageIds: Set<string>,
  perModel: Record<string, ModelTokens>,
): void {
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : null;
  if (!ts) return;
  if (new Date(ts) < billingStart) return;

  const msg = entry.message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  const message = msg as Record<string, unknown>;

  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;

  // Claude Code logs multiple streaming snapshots of the same API response.
  // Deduplicate by message.id so each API call is counted exactly once.
  const msgId = typeof message.id === "string" ? message.id : null;
  if (msgId) {
    if (seenMessageIds.has(msgId)) return;
    seenMessageIds.add(msgId);
  }

  const model = typeof message.model === "string" ? message.model : null;
  if (model) modelSet.add(model);

  const u = usage as Record<string, unknown>;

  const input = positiveNumber(u.input_tokens);
  const output = positiveNumber(u.output_tokens);
  const cacheCreate = positiveNumber(u.cache_creation_input_tokens);
  const cacheRead = positiveNumber(u.cache_read_input_tokens);

  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.cacheCreationTokens += cacheCreate;
  totals.cacheReadTokens += cacheRead;

  if (model) {
    const m = perModel[model] ?? (perModel[model] = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    m.inputTokens += input;
    m.outputTokens += output;
    m.cacheCreationTokens += cacheCreate;
    m.cacheReadTokens += cacheRead;
  }
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
