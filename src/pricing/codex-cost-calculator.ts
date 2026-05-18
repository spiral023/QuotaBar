import fs from "node:fs/promises";
import type { CodexTokenEvent } from "./codex-log-reader";
import type { LiteLLMFetcher } from "./litellm-fetcher";

const MODEL_ALIASES: Record<string, string> = {
  "gpt-5-codex": "gpt-5",
  "gpt-5.3-codex": "gpt-5.2-codex",
};

export async function calculateCodexApiCost(
  events: CodexTokenEvent[],
  fetcher: LiteLLMFetcher,
  speedTier: "standard" | "fast",
): Promise<number> {
  let total = 0;
  for (const event of events) {
    const modelName = MODEL_ALIASES[event.model] ?? event.model;
    const pricing = await fetcher.getModelPricing(modelName);
    if (!pricing) continue;

    const nonCachedInput = Math.max(event.inputTokens - event.cachedInputTokens, 0);
    let cost =
      nonCachedInput * (pricing.input_cost_per_token ?? 0) +
      event.cachedInputTokens * (pricing.cache_read_input_token_cost ?? 0) +
      event.outputTokens * (pricing.output_cost_per_token ?? 0);

    if (speedTier === "fast") {
      cost *= pricing.provider_specific_entry?.fast ?? 2;
    }

    total += cost;
  }
  return total;
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
