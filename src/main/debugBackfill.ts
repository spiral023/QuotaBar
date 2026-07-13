import fs from "node:fs/promises";
import path from "node:path";
import { listClaudeSourceFiles, readClaudeUsageEntriesFromFiles, type ClaudeUsageEntry, type SourceFileRef } from "../pricing/jsonl-reader";
import { listCodexSourceFiles, readCodexTokensFromFiles, type CodexTokenEvent, type CodexSourceFileRef } from "../pricing/codex-log-reader";
import { calculateCodexApiCostBreakdown, readCodexSpeedTierFromPaths } from "../pricing/codex-cost-calculator";
import { calculateCostBreakdown, scaleBreakdownTo, sumBreakdown } from "../pricing/cost-calculator";
import type { HistoricalPricingResolver } from "../pricing/historical-pricing-resolver";
import type { DebugRecorder } from "./debugRecorder";
import type { SnapshotEvent, TokensDaySummaryEvent, TokensUsageEvent } from "./debugEvents";
import { log } from "./logging";
import { loadManifest, saveManifest, fileSignature, diffSources, type BackfillManifest } from "./backfillManifest";
import type { BackfillDayRecord } from "../reports/types";
import { sanitizeQuotaSnapshot } from "../portable/quotaStore";
import type { MigrationStateTransitionResult } from "../portable/migration";

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
 * 3 = Deleted source files now trigger a rebuild and stale backfill day files
 *     are removed, so ghost entries from rotated logs disappear.
 */
export const BACKFILL_REPAIR_VERSION = 3;

export type PortablePreparationFailureStage =
  | "ingestion"
  | "legacy_reconciliation"
  | "quota_migration"
  | "migration_completion"
  | "consumer_prewarm";

interface PortableIngestionCounts {
  inserted: number;
  updated: number;
}

interface PortableLegacyMigrationCounts {
  storeRevision: string;
  syntheticInserted: number;
  syntheticUpdated: number;
}

export interface PreparePortableDataDependencies {
  beginMigration(): Promise<MigrationStateTransitionResult | void>;
  ingestProviderEvents(): Promise<PortableIngestionCounts>;
  readLegacyRecords(): Promise<readonly BackfillDayRecord[]>;
  reconcileLegacy(records: readonly BackfillDayRecord[]): Promise<PortableLegacyMigrationCounts>;
  readLegacyQuota(): Promise<readonly SnapshotEvent[]>;
  migrateQuota(snapshots: readonly SnapshotEvent[]): Promise<void>;
  completeMigration(storeRevision: string): Promise<MigrationStateTransitionResult | void>;
  failMigration(code: `${PortablePreparationFailureStage}_failed`): Promise<MigrationStateTransitionResult | void>;
  prewarmConsumers(): void | Promise<void>;
  onStageComplete?(stage: PortablePreparationFailureStage, durationMs: number, count: number): void;
}

export type PreparePortableDataResult = {
  status: "complete";
  ingested: number;
  legacyInserted: number;
  quotaSnapshots: number;
} | { status: "superseded" };

/**
 * Activates portable consumers only after every persistent migration stage has committed.
 * Dependencies keep startup ordering testable and ensure thrown provider diagnostics never cross this boundary.
 */
export async function preparePortableData(
  dependencies: PreparePortableDataDependencies,
): Promise<PreparePortableDataResult> {
  const beginResult = await dependencies.beginMigration();
  if (transitionWasSuperseded(beginResult)) {
    return { status: "superseded" };
  }
  let stage: PortablePreparationFailureStage = "ingestion";
  try {
    let startedAt = Date.now();
    const ingestion = await dependencies.ingestProviderEvents();
    const ingested = ingestion.inserted + ingestion.updated;
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, ingested);

    stage = "legacy_reconciliation";
    startedAt = Date.now();
    const records = await dependencies.readLegacyRecords();
    const legacy = await dependencies.reconcileLegacy(records);
    dependencies.onStageComplete?.(
      stage,
      Date.now() - startedAt,
      legacy.syntheticInserted + legacy.syntheticUpdated,
    );

    stage = "quota_migration";
    startedAt = Date.now();
    const quotaSnapshots = await dependencies.readLegacyQuota();
    await dependencies.migrateQuota(quotaSnapshots);
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, quotaSnapshots.length);

    stage = "migration_completion";
    startedAt = Date.now();
    const completionResult = await dependencies.completeMigration(legacy.storeRevision);
    if (transitionWasSuperseded(completionResult)) {
      return { status: "superseded" };
    }
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, 1);

    stage = "consumer_prewarm";
    startedAt = Date.now();
    await dependencies.prewarmConsumers();
    dependencies.onStageComplete?.(stage, Date.now() - startedAt, 1);

    return {
      status: "complete",
      ingested,
      legacyInserted: legacy.syntheticInserted + legacy.syntheticUpdated,
      quotaSnapshots: quotaSnapshots.length,
    };
  } catch {
    let failureResult: MigrationStateTransitionResult | void;
    try {
      failureResult = await dependencies.failMigration(`${stage}_failed`);
    } catch {
      throw new Error("Portable data preparation failed while recording failure state");
    }
    if (transitionWasSuperseded(failureResult)) {
      return { status: "superseded" };
    }
    // The original failure may contain provider data; expose only the fixed stage category.
    throw new Error(`Portable data preparation failed at ${stage}`);
  }
}

function transitionWasSuperseded(result: MigrationStateTransitionResult | void): boolean {
  return result?.status === "future_state" || result?.status === "not_running";
}

export type PortableIngestionTrigger = "startup" | "source-change" | "manual-recompute";
export interface PortableIngestionRunner {
  trigger(reason: PortableIngestionTrigger): Promise<void>;
}

/** Runs at most one ingestion at a time and folds any burst of triggers into one follow-up pass. */
export function createPortableIngestionRunner(
  run: () => Promise<void>,
  onDiagnostic: (diagnostic: "Portable ingestion failed") => void = () => undefined,
): PortableIngestionRunner {
  let requested = false;
  let active: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    while (requested) {
      requested = false;
      try {
        await run();
      } catch {
        onDiagnostic("Portable ingestion failed");
      }
    }
  };

  return {
    trigger(reason): Promise<void> {
      void reason;
      requested = true;
      if (!active) {
        active = drain().finally(() => {
          active = undefined;
        });
      }
      return active;
    },
  };
}

interface PortableIngestionLifecycleRuntime {
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export interface PortableIngestionLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  trigger(reason: PortableIngestionTrigger): Promise<void>;
}

/** Owns polling separately from the runner so shutdown stops new work without cancelling an in-flight commit. */
export function createPortableIngestionLifecycle(
  runner: PortableIngestionRunner,
  runtime: PortableIngestionLifecycleRuntime = {
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearInterval: (handle) => clearInterval(handle),
  },
): PortableIngestionLifecycle {
  let active = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  const track = (work: Promise<void>): Promise<void> => {
    const tracked = work.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  };

  const stop = (): Promise<void> => {
    active = false;
    if (timer !== undefined) {
      runtime.clearInterval(timer);
      timer = undefined;
    }
    return inFlight ?? Promise.resolve();
  };

  return {
    async start(): Promise<void> {
      await stop();
      active = true;
      timer = runtime.setInterval(() => {
        if (active) void track(runner.trigger("source-change"));
      }, 15_000);
      timer.unref?.();
      await track(runner.trigger("startup"));
    },
    stop,
    trigger(reason): Promise<void> {
      return active ? track(runner.trigger(reason)) : Promise.resolve();
    },
  };
}

const LEGACY_DEBUG_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Reads the allowlisted legacy debug directory without following nested paths or links. */
export async function readLegacyQuotaSnapshots(logDir: string): Promise<SnapshotEvent[]> {
  let entries;
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: SnapshotEvent[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && LEGACY_DEBUG_FILE.test(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(logDir, entry.name), "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim() || !line.includes('"kind":"snapshot"')) continue;
      try {
        const snapshot = sanitizeQuotaSnapshot(JSON.parse(line));
        if (snapshot) result.push(snapshot);
      } catch {
        // Malformed legacy diagnostics are ignored; valid records and the source file remain untouched.
      }
    }
  }
  return result;
}

export interface BackfillOptions {
  recorder: DebugRecorder;
  logDir: string;
  claudeProjectsDirs: string[];
  codexSessionsDirs: string[];
  force?: boolean;
  pricingResolver?: HistoricalPricingResolver;
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
  const { changed, unchanged, deleted } = diffSources(manifest.sources, currentSources);

  if (!opts.force && changed.length === 0 && deleted.length === 0) {
    opts.recorder.write({ kind: "backfill.skipped", unchangedSources: unchanged.length });
    await saveManifest(opts.logDir, { version: 1, sources: currentSources, lastRunAt: new Date().toISOString() });
    const durationMs = Date.now() - startedAt;
    opts.recorder.write({ kind: "backfill.done", daysWritten: 0, daysSkipped: 0, durationMs, sourcesScanned: Object.keys(currentSources).length, sourcesChanged: 0 });
    return { daysWritten: 0, daysSkipped: 0, durationMs, errors };
  }

  // Nur geänderte/neue Dateien parsen (bzw. bei force: alle).
  // Wichtig: `deleted` bedeutet nur "nicht mehr im aktuellen Source-Set sichtbar".
  // Das kann durch Root-/WSL-Konfigurationsänderungen oder temporär unerreichbare
  // UNC-Pfade passieren und darf persistierte QuotaBar-Historie nicht löschen.
  const rebuildAll = opts.force;
  const changedSet = new Set(rebuildAll ? Object.keys(currentSources) : changed);
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

  const speedTier = opts.pricingResolver && opts.codexConfigPaths?.length
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
    if (bucket.claude.length > 0) opts.recorder.writeBackfill(day, await summarizeClaude(day, bucket.claude, opts.pricingResolver));
    if (bucket.codex.length > 0) opts.recorder.writeBackfill(day, await summarizeCodex(day, bucket.codex, opts.pricingResolver, speedTier));
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
    sourcesChanged: changedSet.size + deleted.length,
  });
  return { daysWritten: written, daysSkipped: 0, durationMs, errors };
}

async function summarizeClaude(date: string, entries: ClaudeUsageEntry[], pricingResolver?: HistoricalPricingResolver): Promise<TokensDaySummaryEvent> {
  const perModel: TokensDaySummaryEvent["perModel"] = {};
  const sessions = new Set<string>();
  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0, totalCostUSD = 0;
  for (const e of entries) {
    input += e.inputTokens; output += e.outputTokens;
    cacheCreation += e.cacheCreationTokens; cacheRead += e.cacheReadTokens;
    sessions.add(e.session);
    const pm = perModel[e.model] ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUSD: 0 };
    pm.input += e.inputTokens; pm.output += e.outputTokens;
    pm.cacheCreation = (pm.cacheCreation ?? 0) + e.cacheCreationTokens;
    pm.cacheRead = (pm.cacheRead ?? 0) + e.cacheReadTokens;
    if (e.costUSD !== undefined) {
      totalCostUSD += e.costUSD;
      pm.costUSD += e.costUSD;
      // Provider cost remains authoritative; pricing is used only to proportionally
      // attribute that fixed total across token components.
      const pricing = pricingResolver && await pricingResolver.getModelPricing(e.model, e.timestamp);
      const breakdown = pricing ? scaleBreakdownTo(calculateCostBreakdown({
        input_tokens: e.inputTokens,
        output_tokens: e.outputTokens,
        cache_creation_input_tokens: e.cacheCreationTokens,
        cache_read_input_tokens: e.cacheReadTokens,
      }, pricing), e.costUSD) : undefined;
      pm.inputCostUSD = (pm.inputCostUSD ?? 0) + (breakdown?.inputCostUSD ?? 0);
      pm.outputCostUSD = (pm.outputCostUSD ?? 0) + (breakdown?.outputCostUSD ?? 0);
      pm.cacheCreationCostUSD = (pm.cacheCreationCostUSD ?? 0) + (breakdown?.cacheCreationCostUSD ?? 0);
      pm.cacheReadCostUSD = (pm.cacheReadCostUSD ?? 0) + (breakdown?.cacheReadCostUSD ?? 0);
    } else if (pricingResolver) {
      const pricing = await pricingResolver.getModelPricing(e.model, e.timestamp);
      if (pricing) {
        const breakdown = calculateCostBreakdown({
          input_tokens: e.inputTokens,
          output_tokens: e.outputTokens,
          cache_creation_input_tokens: e.cacheCreationTokens,
          cache_read_input_tokens: e.cacheReadTokens,
        }, pricing);
        const cost = sumBreakdown(breakdown);
        totalCostUSD += cost;
        pm.costUSD += cost;
        pm.inputCostUSD = (pm.inputCostUSD ?? 0) + breakdown.inputCostUSD;
        pm.outputCostUSD = (pm.outputCostUSD ?? 0) + breakdown.outputCostUSD;
        pm.cacheCreationCostUSD = (pm.cacheCreationCostUSD ?? 0) + breakdown.cacheCreationCostUSD;
        pm.cacheReadCostUSD = (pm.cacheReadCostUSD ?? 0) + breakdown.cacheReadCostUSD;
      }
    }
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

async function summarizeCodex(date: string, events: CodexTokenEvent[], pricingResolver?: HistoricalPricingResolver, speedTier: "standard" | "fast" = "standard"): Promise<TokensDaySummaryEvent> {
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
    if (pricingResolver) {
      const list = byModel.get(e.model) ?? [];
      list.push(e);
      byModel.set(e.model, list);
    }
  }
  let totalCostUSD = 0;
  if (pricingResolver) {
    for (const [model, modelEvents] of byModel) {
      const b = await calculateCodexApiCostBreakdown(modelEvents, pricingResolver, speedTier);
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

