import fs from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../config/settings";
import { defaultSettings } from "../config/settings";
import { normalizeModelName, isIgnoredModel } from "../shared/modelNames";
import { PortableUsageStore } from "../portable/usageStore";
import type { PortableUsageEvent } from "../portable/types";
import { isNeutralInternalMarker } from "../portable/eventAdapters";

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

export interface BenchmarkIndex {
  label: string;
  source: string;
  asOf: string;
  methodology: string;
  methodologyUrl: string;
  reasoningNote: string;
  scores: Record<string, number>;
}

export interface ModelsData {
  days: ModelDay[];
  benchmarks: Record<string, number>;
  benchmarksAsOf: string;
  benchmarkIndexes: Record<string, BenchmarkIndex>;
  pricing: Record<string, ModelPricingRate>;
  /** Mindest-Token-Anteil (%) für Berücksichtigung in KPI/Scatter (aus Settings). */
  minModelTokenSharePct: number;
  generatedAt: string;
}

export interface ModelsDataDeps {
  settings?: Settings;
  usageEvents?: PortableUsageEvent[];
  usageStore?: PortableUsageStore;
  usageRange?: { since: string; until: string };
  benchmarksFile?: string;
}

// tsc kopiert keine JSON-Dateien nach dist/ — zur Laufzeit aus src/ lesen
const DEFAULT_BENCHMARKS_FILE = path.join(__dirname, "..", "..", "src", "config", "model-benchmarks.json");

export async function buildModelsData(deps: ModelsDataDeps = {}): Promise<ModelsData> {
  const settings = deps.settings ?? defaultSettings;
  const usageRange = deps.usageRange ?? {
    since: "1970-01-01T00:00:00.000Z",
    until: new Date().toISOString(),
  };
  const events = deps.usageEvents ?? await (deps.usageStore ?? new PortableUsageStore()).read(usageRange);

  const dayMap = new Map<string, ModelDay>();
  for (const event of events) {
    if (isNeutralInternalMarker(event)) continue;
    addDay(dayMap, event.occurredAt.slice(0, 10), event.provider, event.model, {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      cacheReadTokens: event.cacheReadTokens,
      totalTokens: event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens,
      costUSD: storedCost(event),
      inputCostUSD: event.inputCostUSD ?? 0,
      outputCostUSD: event.outputCostUSD ?? 0,
      cacheCreationCostUSD: event.cacheCreationCostUSD ?? 0,
      cacheReadCostUSD: event.cacheReadCostUSD ?? 0,
    });
  }

  const days = Array.from(dayMap.values())
    .sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  const { benchmarks, benchmarksAsOf, benchmarkIndexes } = await readBenchmarks(deps.benchmarksFile ?? DEFAULT_BENCHMARKS_FILE);
  const pricing = collectPricing(events);

  return {
    days, benchmarks, benchmarksAsOf, benchmarkIndexes, pricing,
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

function storedCost(event: PortableUsageEvent): number {
  return event.costUSD ?? (event.inputCostUSD ?? 0) + (event.outputCostUSD ?? 0)
    + (event.cacheCreationCostUSD ?? 0) + (event.cacheReadCostUSD ?? 0);
}

async function readBenchmarks(file: string): Promise<{
  benchmarks: Record<string, number>;
  benchmarksAsOf: string;
  benchmarkIndexes: Record<string, BenchmarkIndex>;
}> {
  try {
    const json = JSON.parse(await fs.readFile(file, "utf8")) as {
      asOf?: string;
      source?: string;
      scores?: Record<string, unknown>;
      indexes?: Record<string, {
        label?: string;
        source?: string;
        asOf?: string;
        methodology?: string;
        methodologyUrl?: string;
        reasoningNote?: string;
        scores?: Record<string, unknown>;
      }>;
    };
    const parseIndex = (index: NonNullable<typeof json.indexes>[string]): BenchmarkIndex => {
      const scores: Record<string, number> = {};
      for (const [model, score] of Object.entries(index.scores ?? {})) {
        if (typeof score === "number" && Number.isFinite(score)) scores[model] = score;
      }
      return {
        label: index.label ?? "Intelligence",
        source: index.source ?? "Artificial Analysis",
        asOf: index.asOf ?? "",
        methodology: index.methodology ?? "",
        methodologyUrl: index.methodologyUrl ?? "",
        reasoningNote: index.reasoningNote ?? "",
        scores,
      };
    };
    const benchmarkIndexes: Record<string, BenchmarkIndex> = {};
    for (const [key, index] of Object.entries(json.indexes ?? {})) {
      benchmarkIndexes[key] = parseIndex(index);
    }
    if (Object.keys(benchmarkIndexes).length === 0) {
      benchmarkIndexes.intelligence = parseIndex({
        label: "Intelligence", source: json.source, asOf: json.asOf, scores: json.scores,
      });
    }
    const defaultIndex = benchmarkIndexes.intelligence ?? Object.values(benchmarkIndexes)[0];
    return { benchmarks: defaultIndex?.scores ?? {}, benchmarksAsOf: defaultIndex?.asOf ?? "", benchmarkIndexes };
  } catch {
    return { benchmarks: {}, benchmarksAsOf: "", benchmarkIndexes: {} };
  }
}

function collectPricing(events: readonly PortableUsageEvent[]): Record<string, ModelPricingRate> {
  const result: Record<string, ModelPricingRate> = {};
  const models = [...new Set(events
    .filter((event) => !isNeutralInternalMarker(event) && !isIgnoredModel(event.model))
    .map((event) => normalizeModelName(event.model)))];
  for (const model of models) {
    const rows = events.filter((event) => normalizeModelName(event.model) === model);
    const inputRows = rows.filter((event) => event.inputCostUSD !== undefined);
    const cacheRows = rows.filter((event) => event.cacheReadCostUSD !== undefined);
    const inputTokens = inputRows.reduce((sum, event) => sum + event.inputTokens, 0);
    const cacheReadTokens = cacheRows.reduce((sum, event) => sum + event.cacheReadTokens, 0);
    if (inputTokens === 0) continue;
    result[model] = {
      inputPerMTok: inputRows.reduce((sum, event) => sum + (event.inputCostUSD ?? 0), 0) / inputTokens * 1e6,
      cacheReadPerMTok: cacheReadTokens > 0
        ? cacheRows.reduce((sum, event) => sum + (event.cacheReadCostUSD ?? 0), 0) / cacheReadTokens * 1e6
        : 0,
    };
  }
  return result;
}
