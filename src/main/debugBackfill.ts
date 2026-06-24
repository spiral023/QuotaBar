import fs from "node:fs/promises";
import path from "node:path";
import { listClaudeSourceFiles, readClaudeUsageEntriesFromFiles, type ClaudeUsageEntry, type SourceFileRef } from "../pricing/jsonl-reader";
import { listCodexSourceFiles, readCodexTokensFromFiles, type CodexTokenEvent, type CodexSourceFileRef } from "../pricing/codex-log-reader";
import { calculateCodexApiCostBreakdown, readCodexSpeedTierFromPaths } from "../pricing/codex-cost-calculator";
import { calculateCostFromTokens, calculateCostBreakdown, scaleBreakdownTo, ZERO_BREAKDOWN } from "../pricing/cost-calculator";
import type { LiteLLMFetcher } from "../pricing/litellm-fetcher";
import type { DebugRecorder } from "./debugRecorder";
import type { TokensDaySummaryEvent, TokensUsageEvent } from "./debugEvents";
import { log } from "./logging";
import { loadManifest, saveManifest, fileSignature, diffSources, type BackfillManifest } from "./backfillManifest";

/**
 * Wird bei jedem Fix erhöht, der ein einmaliges Neuberechnen aller bereits
 * geschriebenen Backfill-Tagessätze erfordert. Beim Start vergleicht main.ts diese
 * Zahl mit der persistierten Reparatur-Version; bei Rückstand läuft einmalig ein
 * Force-Rebuild.
 *
 * 1 = Partial-Rewrite-Bug behoben (Tagessätze wurden aus nur den geänderten
 *     Quelldateien neu geschrieben → Datenverlust unveränderter Dateien).
 * 2 = Per-Token-Typ-Kosten (input/output/cacheCreation/cacheRead CostUSD) je
 *     Modell ergänzt → historische Tagessätze einmalig neu berechnen.
 */
export const BACKFILL_REPAIR_VERSION = 2;

export interface BackfillOptions {
  recorder: DebugRecorder;
  logDir: string;
  claudeProjectsDirs: string[];
  codexSessionsDirs: string[];
  force?: boolean;
  fetcher?: LiteLLMFetcher;
  codexConfigPaths?: string[];
}

export interface BackfillResult {
  daysWritten: number;
  daysSkipped: number;
  durationMs: number;
  errors: string[];
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const startedAt = Date.now();
  const errors: string[] = [];

  const claudeRefs = await listClaudeSourceFiles(opts.claudeProjectsDirs).catch(() => [] as SourceFileRef[]);
  const codexRefs = await listCodexSourceFiles(opts.codexSessionsDirs).catch(() => [] as CodexSourceFileRef[]);

  // Aktuelle Signaturen aller Quelldateien berechnen.
  const currentSources: Record<string, string> = {};
  for (const ref of [...claudeRefs, ...codexRefs]) {
    const sig = await fileSignature(ref.file);
    if (sig !== null) currentSources[ref.file] = sig;
  }

  const manifest: BackfillManifest = opts.force
    ? { version: 1, sources: {}, lastRunAt: new Date(0).toISOString() }
    : await loadManifest(opts.logDir);
  const { changed, unchanged } = diffSources(manifest.sources, currentSources);

  if (!opts.force && changed.length === 0) {
    opts.recorder.write({ kind: "backfill.skipped", unchangedSources: unchanged.length });
    await saveManifest(opts.logDir, { version: 1, sources: currentSources, lastRunAt: new Date().toISOString() });
    const durationMs = Date.now() - startedAt;
    opts.recorder.write({ kind: "backfill.done", daysWritten: 0, daysSkipped: 0, durationMs, sourcesScanned: Object.keys(currentSources).length, sourcesChanged: 0 });
    return { daysWritten: 0, daysSkipped: 0, durationMs, errors };
  }

  // Nur geänderte/neue Dateien parsen (bzw. bei force: alle).
  const changedSet = new Set(opts.force ? Object.keys(currentSources) : changed);
  const claudeChanged = claudeRefs.filter((r) => changedSet.has(r.file));
  const codexChanged = codexRefs.filter((r) => changedSet.has(r.file));

  const readClaude = (refs: SourceFileRef[]) => readClaudeUsageEntriesFromFiles(refs).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Backfill: Claude reader failed: ${msg}`);
    errors.push(`claude: ${msg}`);
    return [] as ClaudeUsageEntry[];
  });
  const readCodex = (refs: CodexSourceFileRef[]) => readCodexTokensFromFiles(refs).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Backfill: Codex reader failed: ${msg}`);
    errors.push(`codex: ${msg}`);
    return [] as CodexTokenEvent[];
  });

  const claudeChangedEntries = await readClaude(claudeChanged);
  const codexChangedEvents = await readCodex(codexChanged);

  // Ein Tagessatz wird aus ALLEN Quelldateien dieses Tages aggregiert. Die geänderten
  // Dateien bestimmen, welche Tage neu geschrieben werden; für genau diese Tage müssen
  // aber auch die Beiträge UNVERÄNDERTER Dateien erneut gelesen werden — sonst gehen sie
  // beim Löschen+Neuschreiben der Tagesdatei verloren (Tag wird sonst aus einer Teilmenge
  // seiner Eingaben neu berechnet und schrumpft bei jedem inkrementellen Lauf).
  // Der fingerprint-basierte Datei-Cache hält unveränderte Dateien im laufenden Prozess
  // warm, daher bleibt der erneute Lesevorgang günstig.
  const affectedDays = new Set<string>();
  for (const e of claudeChangedEntries) { const k = utcDayKey(e.timestamp); if (k) affectedDays.add(k); }
  for (const e of codexChangedEvents)   { const k = utcDayKey(e.timestamp); if (k) affectedDays.add(k); }

  const onAffectedDay = (iso: string): boolean => {
    const k = utcDayKey(iso);
    return k !== null && affectedDays.has(k);
  };
  const claudeExtra = affectedDays.size > 0
    ? (await readClaude(claudeRefs.filter((r) => !changedSet.has(r.file)))).filter((e) => onAffectedDay(e.timestamp))
    : [];
  const codexExtra = affectedDays.size > 0
    ? (await readCodex(codexRefs.filter((r) => !changedSet.has(r.file)))).filter((e) => onAffectedDay(e.timestamp))
    : [];

  const claudeEntries = [...claudeChangedEntries, ...claudeExtra];
  const codexEvents = [...codexChangedEvents, ...codexExtra];

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
  const sortedDays = [...byDay.keys()].sort();

  const speedTier = opts.fetcher && opts.codexConfigPaths?.length
    ? await readCodexSpeedTierFromPaths(opts.codexConfigPaths)
    : "standard";

  opts.recorder.write({ kind: "backfill.start", days: sortedDays });

  for (const day of sortedDays) {
    const filePath = path.join(opts.logDir, `${day}.backfill.jsonl`);
    // Betroffener Tag wird immer neu geschrieben (Quelldatei hat sich geändert).
    await fs.rm(filePath, { force: true });
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
    if (bucket.claude.length > 0) opts.recorder.writeBackfill(day, await summarizeClaude(day, bucket.claude, opts.fetcher));
    if (bucket.codex.length > 0) opts.recorder.writeBackfill(day, await summarizeCodex(day, bucket.codex, opts.fetcher, speedTier));
    written++;
  }

  await saveManifest(opts.logDir, { version: 1, sources: currentSources, lastRunAt: new Date().toISOString() });
  const durationMs = Date.now() - startedAt;
  opts.recorder.write({
    kind: "backfill.done",
    daysWritten: written,
    daysSkipped: 0,
    durationMs,
    sourcesScanned: Object.keys(currentSources).length,
    sourcesChanged: changedSet.size,
  });
  return { daysWritten: written, daysSkipped: 0, durationMs, errors };
}

async function summarizeClaude(date: string, entries: ClaudeUsageEntry[], fetcher?: LiteLLMFetcher): Promise<TokensDaySummaryEvent> {
  const perModel: TokensDaySummaryEvent["perModel"] = {};
  const perModelNoSourceCost: Record<string, { input: number; output: number; cacheCreation: number; cacheRead: number }> = {};
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
    if (fetcher && e.costUSD === undefined) {
      const nc = perModelNoSourceCost[e.model] ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      nc.input += e.inputTokens; nc.output += e.outputTokens;
      nc.cacheCreation += e.cacheCreationTokens; nc.cacheRead += e.cacheReadTokens;
      perModelNoSourceCost[e.model] = nc;
    }
  }
  if (fetcher) {
    for (const [model, nc] of Object.entries(perModelNoSourceCost)) {
      const pricing = await fetcher.getModelPricing(model);
      if (!pricing) continue;
      const cost = calculateCostFromTokens({
        input_tokens: nc.input, output_tokens: nc.output,
        cache_creation_input_tokens: nc.cacheCreation, cache_read_input_tokens: nc.cacheRead,
      }, pricing);
      totalCostUSD += cost;
      perModel[model].costUSD += cost;
    }
    // Kosten je Token-Typ: rate-basiert je Modell, exakt auf den (ggf. aus Quell-
    // kosten gemischten) costUSD skaliert → Komponenten summieren auf costUSD.
    for (const [model, pm] of Object.entries(perModel)) {
      const pricing = await fetcher.getModelPricing(model);
      const breakdown = pricing ? calculateCostBreakdown({
        input_tokens: pm.input, output_tokens: pm.output,
        cache_creation_input_tokens: pm.cacheCreation ?? 0, cache_read_input_tokens: pm.cacheRead ?? 0,
      }, pricing) : ZERO_BREAKDOWN;
      const scaled = scaleBreakdownTo(breakdown, pm.costUSD);
      pm.inputCostUSD = scaled.inputCostUSD;
      pm.outputCostUSD = scaled.outputCostUSD;
      pm.cacheCreationCostUSD = scaled.cacheCreationCostUSD;
      pm.cacheReadCostUSD = scaled.cacheReadCostUSD;
    }
  }
  return {
    kind: "tokens.daySummary", provider: "claude", date,
    input, output, cacheCreation, cacheRead,
    totalTokens: input + output + cacheCreation + cacheRead,
    totalCostUSD, sessionCount: sessions.size,
    models: Object.keys(perModel), perModel,
  };
}

async function summarizeCodex(date: string, events: CodexTokenEvent[], fetcher?: LiteLLMFetcher, speedTier: "standard" | "fast" = "standard"): Promise<TokensDaySummaryEvent> {
  const perModel: TokensDaySummaryEvent["perModel"] = {};
  const byModel = new Map<string, CodexTokenEvent[]>();
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
    if (fetcher) {
      const list = byModel.get(e.model) ?? [];
      list.push(e);
      byModel.set(e.model, list);
    }
  }
  let totalCostUSD = 0;
  if (fetcher) {
    for (const [model, modelEvents] of byModel) {
      const b = await calculateCodexApiCostBreakdown(modelEvents, fetcher, speedTier);
      const pm = perModel[model];
      pm.inputCostUSD = b.inputCostUSD;
      pm.outputCostUSD = b.outputCostUSD;
      pm.cacheCreationCostUSD = b.cacheCreationCostUSD;
      pm.cacheReadCostUSD = b.cacheReadCostUSD;
      const cost = b.inputCostUSD + b.outputCostUSD + b.cacheCreationCostUSD + b.cacheReadCostUSD;
      pm.costUSD = cost;
      totalCostUSD += cost;
    }
  }
  return {
    kind: "tokens.daySummary", provider: "codex", date,
    input, output, cachedInput, reasoningOutput,
    totalTokens: input + output + reasoningOutput, // cachedInput is a subset of input, not additive
    totalCostUSD, sessionCount: sessions.size,
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

