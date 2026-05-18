import fs from "node:fs/promises";
import path from "node:path";

export interface CodexTokenEvent {
  timestamp: string;
  model: string;
  isFallback: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

type TokenTotals = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

export async function readCodexTokensForPeriod(
  sessionsDir: string,
  billingStart: Date,
): Promise<CodexTokenEvent[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(sessionsDir, { recursive: true })) as string[];
  } catch {
    return [];
  }

  const files = entries
    .filter((e) => e.endsWith(".jsonl"))
    .map((e) => path.join(sessionsDir, e));

  const events: CodexTokenEvent[] = [];
  for (const file of files) {
    events.push(...(await parseCodexJsonlFile(file, billingStart)));
  }
  return events;
}

async function parseCodexJsonlFile(
  filePath: string,
  billingStart: Date,
): Promise<CodexTokenEvent[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const events: CodexTokenEvent[] = [];
  let currentModel: string | null = null;
  let previousTotals = zeroTotals();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "turn_context") {
      const model = asRecord(entry.payload)?.model;
      if (typeof model === "string" && model) currentModel = model;
      continue;
    }

    if (entry.type !== "event_msg") continue;
    const payload = asRecord(entry.payload);
    if (!payload || payload.type !== "token_count" || payload.info == null) continue;
    const info = asRecord(payload.info);
    if (!info) continue;

    const lastUsage = asRecord(info.last_token_usage);
    const totalUsage = asRecord(info.total_token_usage);

    const oldTotals = previousTotals;
    if (totalUsage) {
      previousTotals = extractTotals(totalUsage);
    } else if (lastUsage) {
      const d = extractTotals(lastUsage);
      previousTotals = {
        input_tokens: previousTotals.input_tokens + d.input_tokens,
        cached_input_tokens: previousTotals.cached_input_tokens + d.cached_input_tokens,
        output_tokens: previousTotals.output_tokens + d.output_tokens,
        reasoning_output_tokens: previousTotals.reasoning_output_tokens + d.reasoning_output_tokens,
        total_tokens: previousTotals.total_tokens + d.total_tokens,
      };
    }

    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
    if (!timestamp || new Date(timestamp) < billingStart) continue;

    let delta: TokenTotals;
    if (lastUsage) {
      delta = extractTotals(lastUsage);
    } else if (totalUsage) {
      delta = diffTotals(extractTotals(totalUsage), oldTotals);
    } else {
      continue;
    }

    const model = resolveModel(info, currentModel);
    events.push({
      timestamp,
      model,
      isFallback: model === "gpt-5",
      inputTokens: delta.input_tokens,
      cachedInputTokens: Math.min(delta.cached_input_tokens, delta.input_tokens),
      outputTokens: delta.output_tokens,
      reasoningOutputTokens: delta.reasoning_output_tokens,
      totalTokens: delta.total_tokens,
    });
  }

  return events;
}

function resolveModel(info: Record<string, unknown>, currentModel: string | null): string {
  if (typeof info.model === "string" && info.model) return info.model;
  const meta = asRecord(info.metadata);
  if (meta && typeof meta.model === "string" && meta.model) return meta.model;
  return currentModel ?? "gpt-5";
}

function extractTotals(obj: Record<string, unknown>): TokenTotals {
  return {
    input_tokens: positiveNumber(obj.input_tokens),
    cached_input_tokens: positiveNumber(obj.cached_input_tokens),
    output_tokens: positiveNumber(obj.output_tokens),
    reasoning_output_tokens: positiveNumber(obj.reasoning_output_tokens),
    total_tokens: positiveNumber(obj.total_tokens),
  };
}

function diffTotals(current: TokenTotals, prev: TokenTotals): TokenTotals {
  return {
    input_tokens: Math.max(current.input_tokens - prev.input_tokens, 0),
    cached_input_tokens: Math.max(current.cached_input_tokens - prev.cached_input_tokens, 0),
    output_tokens: Math.max(current.output_tokens - prev.output_tokens, 0),
    reasoning_output_tokens: Math.max(current.reasoning_output_tokens - prev.reasoning_output_tokens, 0),
    total_tokens: Math.max(current.total_tokens - prev.total_tokens, 0),
  };
}

function zeroTotals(): TokenTotals {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
