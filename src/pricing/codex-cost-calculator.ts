import fs from "node:fs/promises";
import type { CodexTokenEvent } from "./codex-log-reader";
import type { HistoricalPricingResolver } from "./historical-pricing-resolver";
import { type CostBreakdown, sumBreakdown } from "./cost-calculator";

const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.3-codex": "gpt-5.2-codex",
};

/**
 * Codex-Kosten in die vier Einzelposten zerlegt (Cache-Creation gibt es bei
 * Codex nicht → immer 0). Summe == {@link calculateCodexApiCost}.
 */
export async function calculateCodexApiCostBreakdown(
  events: CodexTokenEvent[],
  pricing: HistoricalPricingResolver,
  speedTier: "standard" | "fast",
): Promise<CostBreakdown> {
  let inputCostUSD = 0, outputCostUSD = 0, cacheReadCostUSD = 0;
  for (const event of events) {
    const modelName = MODEL_ALIASES[event.model] ?? event.model;
    const modelPricing = await pricing.getModelPricing(modelName, event.timestamp);
    if (!modelPricing) continue;

    const mult = speedTier === "fast" ? (modelPricing.provider_specific_entry?.fast ?? 2) : 1;
    const nonCachedInput = Math.max(event.inputTokens - event.cachedInputTokens, 0);
    inputCostUSD     += nonCachedInput * (modelPricing.input_cost_per_token ?? 0) * mult;
    cacheReadCostUSD += event.cachedInputTokens * (modelPricing.cache_read_input_token_cost ?? modelPricing.input_cost_per_token ?? 0) * mult;
    outputCostUSD    += event.outputTokens * (modelPricing.output_cost_per_token ?? 0) * mult;
  }
  return { inputCostUSD, outputCostUSD, cacheCreationCostUSD: 0, cacheReadCostUSD };
}

export async function calculateCodexApiCost(
  events: CodexTokenEvent[],
  pricing: HistoricalPricingResolver,
  speedTier: "standard" | "fast",
): Promise<number> {
  return sumBreakdown(await calculateCodexApiCostBreakdown(events, pricing, speedTier));
}

/**
 * Modellnamen aus den Events, für die kein Preis gefunden wird (nach Alias-Auflösung).
 * Deren Tokens fließen nicht in `calculateCodexApiCost` ein — dieser Helper macht sie
 * sichtbar, ohne die bestehende Kostenfunktion zu verändern. Preise sind gecacht,
 * daher ist der zusätzliche Lookup günstig.
 */
export async function findUnpricedCodexModels(
  events: CodexTokenEvent[],
  pricing: HistoricalPricingResolver,
): Promise<string[]> {
  const missing = new Set<string>();
  for (const event of events) {
    const modelName = MODEL_ALIASES[event.model] ?? event.model;
    if (!(await pricing.getModelPricing(modelName, event.timestamp))) missing.add(modelName);
  }
  return [...missing];
}

export async function readCodexSpeedTier(configPath: string): Promise<"standard" | "fast"> {
  try {
    const content = await fs.readFile(configPath, "utf8");
    const match = /^service_tier\s*=\s*["']?([\w-]+)["']?/m.exec(content);
    if (match) {
      const tier = match[1].toLowerCase();
      if (tier === "priority" || tier === "fast") return "fast";
    }
  } catch {
    // config not found or not readable — default to standard
  }
  return "standard";
}

export async function readCodexSpeedTierFromPaths(configPaths: string[]): Promise<"standard" | "fast"> {
  for (const configPath of configPaths) {
    if ((await readCodexSpeedTier(configPath)) === "fast") return "fast";
  }
  return "standard";
}
