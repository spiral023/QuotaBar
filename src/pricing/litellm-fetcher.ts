import type { ModelPricing } from "./cost-calculator";
import { httpFetch } from "../main/httpClient";

export type { ModelPricing };

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const FALLBACK_PRICES: Record<string, ModelPricing> = {
  "claude-opus-4": {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_creation_input_token_cost: 1.875e-5,
    cache_read_input_token_cost: 1.5e-6,
    provider_specific_entry: { fast: 6 },
  },
  "claude-sonnet-4-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_creation_input_token_cost: 3.75e-6,
    cache_read_input_token_cost: 3e-7,
  },
  "claude-haiku-4-5": {
    input_cost_per_token: 8e-7,
    output_cost_per_token: 4e-6,
    cache_creation_input_token_cost: 1e-6,
    cache_read_input_token_cost: 8e-8,
  },
  "gpt-4o": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
  },
  "gpt-5.5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 30e-6,
    cache_read_input_token_cost: 0.5e-6,
  },
  "gpt-5.4-mini": {
    input_cost_per_token: 0.75e-6,
    output_cost_per_token: 4.5e-6,
    cache_read_input_token_cost: 0.075e-6,
  },
  "gpt-5.4": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 0.25e-6,
  },
  "gpt-5.3": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 12e-6,
    cache_read_input_token_cost: 0.2e-6,
  },
  "gpt-5.2": {
    input_cost_per_token: 1.75e-6,
    output_cost_per_token: 14e-6,
    cache_read_input_token_cost: 0.175e-6,
  },
  "gpt-5.1": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.125e-6,
  },
  "gpt-5": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.125e-6,
  },
};

export class LiteLLMFetcher {
  private cache: Map<string, ModelPricing> | null = null;
  // Memoisiert das Lookup-Ergebnis je Modellname (inkl. negativer Treffer als
  // `null`), damit der lineare Fuzzy-Scan über die große Preis-Map nicht pro
  // Event erneut läuft. Die Preisdaten sind pro Prozesslauf stabil.
  private readonly lookupCache = new Map<string, ModelPricing | null>();

  constructor(private readonly offlineMode: boolean = false) {}

  async getModelPricing(modelName: string): Promise<ModelPricing | null> {
    const cached = this.lookupCache.get(modelName);
    if (cached !== undefined) return cached;
    const map = await this.getPricingMap();
    const result = this.lookup(modelName, map);
    this.lookupCache.set(modelName, result);
    return result;
  }

  private async getPricingMap(): Promise<Map<string, ModelPricing>> {
    if (this.cache) return this.cache;
    if (this.offlineMode) {
      this.cache = new Map(Object.entries(FALLBACK_PRICES));
      return this.cache;
    }
    try {
      const response = await httpFetch(LITELLM_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as Record<string, unknown>;
      this.cache = buildPricingMap(json);
    } catch {
      this.cache = new Map(Object.entries(FALLBACK_PRICES));
    }
    return this.cache;
  }

  private lookup(modelName: string, pricing: Map<string, ModelPricing>): ModelPricing | null {
    if (pricing.has(modelName)) return pricing.get(modelName)!;
    for (const prefix of ["openai/", "azure/", "openrouter/openai/", "anthropic/", "claude-3-5-", "claude-3-", "claude-"]) {
      const key = `${prefix}${modelName}`;
      if (pricing.has(key)) return pricing.get(key)!;
    }
    const lower = modelName.toLowerCase();
    for (const [key, value] of pricing) {
      const k = key.toLowerCase();
      if (k.includes(lower) || lower.includes(k)) return value;
    }
    return null;
  }
}

function buildPricingMap(json: Record<string, unknown>): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [key, value] of Object.entries(json)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      map.set(key, value as ModelPricing);
    }
  }
  for (const [key, value] of Object.entries(FALLBACK_PRICES)) {
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}
