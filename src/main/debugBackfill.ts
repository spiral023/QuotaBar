import fs from "node:fs/promises";
import path from "node:path";
import { readClaudeUsageEntriesForPeriod, type ClaudeUsageEntry } from "../pricing/jsonl-reader";
import { readCodexTokensForPeriod, type CodexTokenEvent } from "../pricing/codex-log-reader";
import type { DebugRecorder } from "./debugRecorder";
import type { TokensDaySummaryEvent, TokensUsageEvent } from "./debugEvents";
import { log } from "./logging";

export interface BackfillOptions {
  recorder: DebugRecorder;
  logDir: string;
  claudeProjectsDirs: string[];
  codexSessionsDirs: string[];
  force?: boolean;
}

export interface BackfillResult {
  daysWritten: number;
  daysSkipped: number;
  durationMs: number;
  errors: string[];
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const startedAt = Date.now();
  const epoch = new Date(0);
  const errors: string[] = [];
  const claudeEntries = await readClaudeUsageEntriesForPeriod(opts.claudeProjectsDirs, epoch)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Backfill: Claude reader failed: ${msg}`);
      errors.push(`claude: ${msg}`);
      return [] as ClaudeUsageEntry[];
    });
  const codexEvents = await readCodexTokensForPeriod(opts.codexSessionsDirs, epoch)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Backfill: Codex reader failed: ${msg}`);
      errors.push(`codex: ${msg}`);
      return [] as CodexTokenEvent[];
    });

  const byDay = new Map<string, { claude: ClaudeUsageEntry[]; codex: CodexTokenEvent[] }>();
  for (const entry of claudeEntries) {
    const key = utcDayKey(entry.timestamp);
    if (!key) continue;
    const bucket = byDay.get(key) ?? { claude: [], codex: [] };
    bucket.claude.push(entry);
    byDay.set(key, bucket);
  }
  for (const event of codexEvents) {
    const key = utcDayKey(event.timestamp);
    if (!key) continue;
    const bucket = byDay.get(key) ?? { claude: [], codex: [] };
    bucket.codex.push(event);
    byDay.set(key, bucket);
  }

  let written = 0;
  let skipped = 0;
  const sortedDays = [...byDay.keys()].sort();

  opts.recorder.write({ kind: "backfill.start", days: sortedDays });

  for (const day of sortedDays) {
    const filePath = path.join(opts.logDir, `${day}.backfill.jsonl`);
    if (!opts.force && (await exists(filePath))) {
      skipped++;
      continue;
    }
    if (opts.force) {
      await fs.rm(filePath, { force: true });
    }
    const bucket = byDay.get(day)!;
    for (const entry of bucket.claude) {
      const event: TokensUsageEvent = {
        kind: "tokens.usage", provider: "claude",
        model: entry.model, session: entry.session, project: entry.project,
        input: entry.inputTokens, output: entry.outputTokens,
        cacheCreation: entry.cacheCreationTokens, cacheRead: entry.cacheReadTokens,
        costUSD: entry.costUSD,
      };
      opts.recorder.writeBackfill(day, event);
    }
    for (const ev of bucket.codex) {
      const event: TokensUsageEvent = {
        kind: "tokens.usage", provider: "codex",
        model: ev.model, session: ev.session, directory: ev.directory,
        input: ev.inputTokens, output: ev.outputTokens,
        cachedInput: ev.cachedInputTokens, reasoningOutput: ev.reasoningOutputTokens,
      };
      opts.recorder.writeBackfill(day, event);
    }
    if (bucket.claude.length > 0) opts.recorder.writeBackfill(day, summarizeClaude(day, bucket.claude));
    if (bucket.codex.length > 0) opts.recorder.writeBackfill(day, summarizeCodex(day, bucket.codex));
    written++;
  }

  const durationMs = Date.now() - startedAt;
  opts.recorder.write({ kind: "backfill.done", daysWritten: written, daysSkipped: skipped, durationMs });
  return { daysWritten: written, daysSkipped: skipped, durationMs, errors };
}

function summarizeClaude(date: string, entries: ClaudeUsageEntry[]): TokensDaySummaryEvent {
  const perModel: TokensDaySummaryEvent["perModel"] = {};
  const sessions = new Set<string>();
  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0, totalCostUSD = 0;
  for (const e of entries) {
    input += e.inputTokens; output += e.outputTokens;
    cacheCreation += e.cacheCreationTokens; cacheRead += e.cacheReadTokens;
    totalCostUSD += e.costUSD ?? 0;
    sessions.add(e.session);
    const pm = perModel[e.model] ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUSD: 0 };
    pm.input += e.inputTokens; pm.output += e.outputTokens;
    pm.cacheCreation = (pm.cacheCreation ?? 0) + e.cacheCreationTokens;
    pm.cacheRead = (pm.cacheRead ?? 0) + e.cacheReadTokens;
    pm.costUSD += e.costUSD ?? 0;
    perModel[e.model] = pm;
  }
  return {
    kind: "tokens.daySummary", provider: "claude", date,
    input, output, cacheCreation, cacheRead,
    totalTokens: input + output + cacheCreation + cacheRead,
    totalCostUSD, sessionCount: sessions.size,
    models: Object.keys(perModel), perModel,
  };
}

function summarizeCodex(date: string, events: CodexTokenEvent[]): TokensDaySummaryEvent {
  const perModel: TokensDaySummaryEvent["perModel"] = {};
  const sessions = new Set<string>();
  let input = 0, output = 0, cachedInput = 0, reasoningOutput = 0;
  for (const e of events) {
    input += e.inputTokens; output += e.outputTokens;
    cachedInput += e.cachedInputTokens; reasoningOutput += e.reasoningOutputTokens;
    sessions.add(e.session);
    const pm = perModel[e.model] ?? { input: 0, output: 0, cachedInput: 0, reasoningOutput: 0, costUSD: 0 };
    pm.input += e.inputTokens; pm.output += e.outputTokens;
    pm.cachedInput = (pm.cachedInput ?? 0) + e.cachedInputTokens;
    pm.reasoningOutput = (pm.reasoningOutput ?? 0) + e.reasoningOutputTokens;
    perModel[e.model] = pm;
  }
  return {
    kind: "tokens.daySummary", provider: "codex", date,
    input, output, cachedInput, reasoningOutput,
    totalTokens: input + output + reasoningOutput, // cachedInput is a subset of input, not additive
    totalCostUSD: 0, sessionCount: sessions.size,
    models: Object.keys(perModel), perModel,
  };
}

function utcDayKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
