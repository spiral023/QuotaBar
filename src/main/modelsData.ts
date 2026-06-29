import fs from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../config/settings";
import { defaultSettings } from "../config/settings";
import { getDebugLogDir } from "../config/paths";
import { readBackfillDayRecords } from "../reports/backfill-reader";
import type { BackfillDayRecord } from "../reports/types";
import type { ClaudeUsageEntry } from "../pricing/jsonl-reader";
import type { CodexTokenEvent } from "../pricing/codex-log-reader";
import { LiteLLMFetcher } from "../pricing/litellm-fetcher";
import { normalizeModelName, isIgnoredModel } from "../shared/modelNames";
import { generateUsageReport } from "../reports/reportService";

export interface ModelDay {
  date: string; // YYYY-MM-DD (UTC)
  provider: "claude" | "codex";
  model: string; // normalisiert
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number; // Codex: immer 0
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  // Kosten je Token-Typ (Summe == costUSD). 0 für vor v2 geschriebene Backfill-Tage.
  inputCostUSD: number;
  outputCostUSD: number;
  cacheCreationCostUSD: number;
  cacheReadCostUSD: number;
}

export interface ModelPricingRate {
  inputPerMTok: number;
  cacheReadPerMTok: number;
}

export interface ModelsData {
  days: ModelDay[];
  benchmarks: Record<string, number>;
  benchmarksAsOf: string;
  pricing: Record<string, ModelPricingRate>;
  /** Mindest-Token-Anteil (%) für Berücksichtigung in KPI/Scatter (aus Settings). */
  minModelTokenSharePct: number;
  generatedAt: string;
}

export interface ModelsDataDeps {
  settings?: Settings;
  backfillRecords?: BackfillDayRecord[];
  backfillLogDir?: string;
  claudeEntries?: ClaudeUsageEntry[];
  codexEvents?: CodexTokenEvent[];
  benchmarksFile?: string;
}

// tsc kopiert keine JSON-Dateien nach dist/ — zur Laufzeit aus src/ lesen
const DEFAULT_BENCHMARKS_FILE = path.join(__dirname, "..", "..", "src", "config", "model-benchmarks.json");

export async function buildModelsData(deps: ModelsDataDeps = {}): Promise<ModelsData> {
  const settings = deps.settings ?? defaultSettings;
  const records = deps.backfillRecords
    ?? await readBackfillDayRecords(deps.backfillLogDir ?? getDebugLogDir());

  const dayMap = new Map<string, ModelDay>();
  for (const r of records) {
    for (const [rawModel, pm] of Object.entries(r.perModel)) {
      addDay(dayMap, r.date, r.provider, rawModel, {
        inputTokens: pm.inputTokens,
        outputTokens: pm.outputTokens,
        cacheCreationTokens: pm.cacheCreationTokens,
        cacheReadTokens: pm.cacheReadTokens,
        totalTokens: pm.totalTokens,
        costUSD: pm.costUSD,
        inputCostUSD: pm.inputCostUSD ?? 0,
        outputCostUSD: pm.outputCostUSD ?? 0,
        cacheCreationCostUSD: pm.cacheCreationCostUSD ?? 0,
        cacheReadCostUSD: pm.cacheReadCostUSD ?? 0,
      });
    }
  }

  await mergeLiveTail(dayMap, records, settings, deps);

  const days = Array.from(dayMap.values())
    .sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  const { benchmarks, benchmarksAsOf } = await readBenchmarks(deps.benchmarksFile ?? DEFAULT_BENCHMARKS_FILE);
  const pricing = await collectPricing(days, settings);

  return {
    days, benchmarks, benchmarksAsOf, pricing,
    minModelTokenSharePct: settings.minModelTokenSharePct,
    generatedAt: new Date().toISOString(),
  };
}

type DayTotals = Omit<ModelDay, "date" | "provider" | "model">;

function addDay(
  map: Map<string, ModelDay>,
  date: string,
  provider: "claude" | "codex",
  rawModel: string,
  totals: DayTotals,
): void {
  if (isIgnoredModel(rawModel)) return;
  const model = normalizeModelName(rawModel);
  const key = `${date}\0${provider}\0${model}`;
  const existing = map.get(key);
  if (existing) {
    existing.inputTokens += totals.inputTokens;
    existing.outputTokens += totals.outputTokens;
    existing.cacheCreationTokens += totals.cacheCreationTokens;
    existing.cacheReadTokens += totals.cacheReadTokens;
    existing.totalTokens += totals.totalTokens;
    existing.costUSD += totals.costUSD;
    existing.inputCostUSD += totals.inputCostUSD;
    existing.outputCostUSD += totals.outputCostUSD;
    existing.cacheCreationCostUSD += totals.cacheCreationCostUSD;
    existing.cacheReadCostUSD += totals.cacheReadCostUSD;
  } else {
    map.set(key, { date, provider, model, ...totals });
  }
}

async function mergeLiveTail(
  dayMap: Map<string, ModelDay>,
  records: BackfillDayRecord[],
  settings: Settings,
  deps: ModelsDataDeps,
): Promise<void> {
  for (const provider of ["claude", "codex"] as const) {
    const lastBackfillDate = records
      .filter(r => r.provider === provider)
      .reduce<string | undefined>((max, r) => (!max || r.date > max ? r.date : max), undefined);

    const report = await generateUsageReport(
      {
        provider,
        type: "daily",
        timezone: "UTC",
        order: "asc",
        breakdown: true,
        ...(lastBackfillDate ? { since: lastBackfillDate } : {}),
      },
      {
        settings,
        ...(deps.claudeEntries ? { claudeEntries: deps.claudeEntries } : {}),
        ...(deps.codexEvents ? { codexEvents: deps.codexEvents } : {}),
      },
    );

    for (const row of report.rows) {
      if (lastBackfillDate && row.bucket <= lastBackfillDate) continue;
      for (const b of row.modelBreakdowns ?? []) {
        addDay(dayMap, row.bucket, provider, b.model, {
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          cacheCreationTokens: b.cacheCreationTokens,
          cacheReadTokens: b.cacheReadTokens,
          totalTokens: b.totalTokens,
          costUSD: b.costUSD,
          inputCostUSD: b.inputCostUSD ?? 0,
          outputCostUSD: b.outputCostUSD ?? 0,
          cacheCreationCostUSD: b.cacheCreationCostUSD ?? 0,
          cacheReadCostUSD: b.cacheReadCostUSD ?? 0,
        });
      }
    }
  }
}

async function readBenchmarks(file: string): Promise<{ benchmarks: Record<string, number>; benchmarksAsOf: string }> {
  try {
    const json = JSON.parse(await fs.readFile(file, "utf8")) as {
      asOf?: string;
      scores?: Record<string, unknown>;
    };
    const benchmarks: Record<string, number> = {};
    for (const [model, score] of Object.entries(json.scores ?? {})) {
      if (typeof score === "number" && Number.isFinite(score)) benchmarks[model] = score;
    }
    return { benchmarks, benchmarksAsOf: json.asOf ?? "" };
  } catch {
    return { benchmarks: {}, benchmarksAsOf: "" };
  }
}

async function collectPricing(days: ModelDay[], settings: Settings): Promise<Record<string, ModelPricingRate>> {
  const fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
  const result: Record<string, ModelPricingRate> = {};
  const models = [...new Set(days.map(d => d.model))];
  const pricings = await Promise.all(models.map(m => fetcher.getModelPricing(m)));
  models.forEach((model, i) => {
    const p = pricings[i];
    if (!p || typeof p.input_cost_per_token !== "number") return;
    result[model] = {
      inputPerMTok: p.input_cost_per_token * 1e6,
      cacheReadPerMTok: (p.cache_read_input_token_cost ?? 0) * 1e6,
    };
  });
  return result;
}
