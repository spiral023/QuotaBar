import {
  calculateCostBreakdown,
  scaleBreakdownTo,
  sumBreakdown,
  type CostBreakdown,
  type ModelPricing,
} from "../pricing/cost-calculator";
import type { VersionedModelPricing } from "../pricing/historical-pricing-resolver";
import type { PortableUsageEvent } from "./types";

export interface PortablePricingResolver {
  getModelPricingBatch(
    modelName: string,
    eventTimestamps: readonly string[],
  ): Promise<(VersionedModelPricing | null)[]>;
}

export const PORTABLE_COST_ENRICHMENT_VERSION = 1 as const;

const CODEX_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5.3-codex": "gpt-5.2-codex",
};

export async function enrichPortableEventCosts(
  events: readonly PortableUsageEvent[],
  pricingResolver: PortablePricingResolver,
  codexSpeed: "standard" | "fast",
): Promise<PortableUsageEvent[]> {
  const result = [...events];
  const groups = new Map<string, { model: string; indexes: number[] }>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.source === "legacy-reconciliation" || hasCompleteStoredCost(event)) continue;
    const model = event.provider === "codex" ? (CODEX_MODEL_ALIASES[event.model] ?? event.model) : event.model;
    const key = JSON.stringify([event.provider, model]);
    const group = groups.get(key) ?? { model, indexes: [] };
    group.indexes.push(index);
    groups.set(key, group);
  }

  await Promise.all([...groups.values()].map(async ({ model, indexes }) => {
    const resolved = await pricingResolver.getModelPricingBatch(
      model,
      indexes.map((index) => events[index].occurredAt),
    );
    for (let offset = 0; offset < indexes.length; offset += 1) {
      const index = indexes[offset];
      const event = events[index];
      const price = resolved[offset];
      if (!price) continue;
      const calculated = event.provider === "codex"
        ? codexBreakdown(event, price.pricing, codexSpeed)
        : calculateCostBreakdown({
            input_tokens: event.inputTokens,
            output_tokens: event.outputTokens,
            cache_creation_input_tokens: event.cacheCreationTokens,
            cache_read_input_tokens: event.cacheReadTokens,
          }, price.pricing);
      const components = event.costUSD === undefined
        ? calculated
        : authoritativeComponents(calculated, event.costUSD);
      result[index] = {
        ...event,
        costUSD: event.costUSD ?? sumBreakdown(components),
        ...components,
        pricingVersion: event.provider === "codex"
          ? `${price.pricingVersion};speed=${codexSpeed}`
          : price.pricingVersion,
      };
    }
  }));
  return result;
}

function authoritativeComponents(calculated: CostBreakdown, costUSD: number): CostBreakdown {
  if (costUSD > 0 && sumBreakdown(calculated) === 0) {
    return {
      inputCostUSD: 0,
      outputCostUSD: costUSD,
      cacheCreationCostUSD: 0,
      cacheReadCostUSD: 0,
    };
  }
  return scaleBreakdownTo(calculated, costUSD);
}

function hasCompleteStoredCost(event: PortableUsageEvent): boolean {
  return event.costUSD !== undefined
    && event.inputCostUSD !== undefined
    && event.outputCostUSD !== undefined
    && event.cacheCreationCostUSD !== undefined
    && event.cacheReadCostUSD !== undefined
    && event.pricingVersion !== undefined;
}

function codexBreakdown(
  event: PortableUsageEvent,
  pricing: ModelPricing,
  speed: "standard" | "fast",
): CostBreakdown {
  const multiplier = speed === "fast" ? (pricing.provider_specific_entry?.fast ?? 2) : 1;
  return {
    inputCostUSD: event.inputTokens * (pricing.input_cost_per_token ?? 0) * multiplier,
    outputCostUSD: event.outputTokens * (pricing.output_cost_per_token ?? 0) * multiplier,
    cacheCreationCostUSD: 0,
    cacheReadCostUSD: event.cacheReadTokens
      * (pricing.cache_read_input_token_cost ?? pricing.input_cost_per_token ?? 0)
      * multiplier,
  };
}
