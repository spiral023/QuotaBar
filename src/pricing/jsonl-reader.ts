import fs from "node:fs/promises";
import path from "node:path";

export interface AggregatedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelNames: string[];
}

const EMPTY: Omit<AggregatedTokens, "modelNames"> = {
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
    return { ...EMPTY, modelNames: [] };
  }

  const files = entries.filter((e) => e.endsWith(".jsonl")).map((e) => path.join(projectsDir, e));

  const totals = { ...EMPTY, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const modelSet = new Set<string>();
  const seenMessageIds = new Set<string>();

  for (const file of files) {
    await processJsonlFile(file, billingStart, totals, modelSet, seenMessageIds);
  }

  return { ...totals, modelNames: Array.from(modelSet) };
}

async function processJsonlFile(
  filePath: string,
  billingStart: Date,
  totals: Omit<AggregatedTokens, "modelNames">,
  modelSet: Set<string>,
  seenMessageIds: Set<string>,
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
      processEntry(entry, billingStart, totals, modelSet, seenMessageIds);
    } catch {
      // skip invalid lines
    }
  }
}

function processEntry(
  entry: Record<string, unknown>,
  billingStart: Date,
  totals: Omit<AggregatedTokens, "modelNames">,
  modelSet: Set<string>,
  seenMessageIds: Set<string>,
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

  totals.inputTokens += positiveNumber(u.input_tokens);
  totals.outputTokens += positiveNumber(u.output_tokens);
  totals.cacheCreationTokens += positiveNumber(u.cache_creation_input_tokens);
  totals.cacheReadTokens += positiveNumber(u.cache_read_input_tokens);
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
