import fs from "node:fs/promises";
import type { CodexTokenEvent } from "./codex-log-reader";
import type { LiteLLMFetcher } from "./litellm-fetcher";
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
  fetcher: LiteLLMFetcher,
  speedTier: "standard" | "fast",
): Promise<CostBreakdown> {
  let inputCostUSD = 0, outputCostUSD = 0, cacheReadCostUSD = 0;
  for (const event of events) {
    const modelName = MODEL_ALIASES[event.model] ?? event.model;
    const pricing = await fetcher.getModelPricing(modelName);
    if (!pricing) continue;

    const mult = speedTier === "fast" ? (pricing.provider_specific_entry?.fast ?? 2) : 1;
    const nonCachedInput = Math.max(event.inputTokens - event.cachedInputTokens, 0);
    inputCostUSD     += nonCachedInput * (pricing.input_cost_per_token ?? 0) * mult;
    cacheReadCostUSD += event.cachedInputTokens * (pricing.cache_read_input_token_cost ?? pricing.input_cost_per_token ?? 0) * mult;
    outputCostUSD    += event.outputTokens * (pricing.output_cost_per_token ?? 0) * mult;
  }
  return { inputCostUSD, outputCostUSD, cacheCreationCostUSD: 0, cacheReadCostUSD };
}

export async function calculateCodexApiCost(
  events: CodexTokenEvent[],
  fetcher: LiteLLMFetcher,
  speedTier: "standard" | "fast",
): Promise<number> {
  return sumBreakdown(await calculateCodexApiCostBreakdown(events, fetcher, speedTier));
}

/**
 * Modellnamen aus den Events, für die kein Preis gefunden wird (nach Alias-Auflösung).
 * Deren Tokens fließen nicht in `calculateCodexApiCost` ein — dieser Helper macht sie
 * sichtbar, ohne die bestehende Kostenfunktion zu verändern. Preise sind gecacht,
 * daher ist der zusätzliche Lookup günstig.
 */
export async function findUnpricedCodexModels(
  events: CodexTokenEvent[],
  fetcher: LiteLLMFetcher,
): Promise<string[]> {
  const missing = new Set<string>();
  for (const event of events) {
    const modelName = MODEL_ALIASES[event.model] ?? event.model;
    if (!(await fetcher.getModelPricing(modelName))) missing.add(modelName);
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
