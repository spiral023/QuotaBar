export interface ModelPricing {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  provider_specific_entry?: { fast?: number };
}

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  speed?: "standard" | "fast";
}

const TIERED_THRESHOLD = 200_000;

export function calculateTieredCost(
  totalTokens: number | undefined,
  basePrice: number | undefined,
  tieredPrice: number | undefined,
): number {
  if (totalTokens == null || totalTokens <= 0) return 0;
  if (totalTokens > TIERED_THRESHOLD && tieredPrice != null) {
    const belowCost = basePrice != null ? TIERED_THRESHOLD * basePrice : 0;
    return belowCost + (totalTokens - TIERED_THRESHOLD) * tieredPrice;
  }
  if (basePrice != null) return totalTokens * basePrice;
  return 0;
}

export function calculateCostFromTokens(tokens: TokenCounts, pricing: ModelPricing): number {
  const inputCost = calculateTieredCost(
    tokens.input_tokens,
    pricing.input_cost_per_token,
    pricing.input_cost_per_token_above_200k_tokens,
  );
  const outputCost = calculateTieredCost(
    tokens.output_tokens,
    pricing.output_cost_per_token,
    pricing.output_cost_per_token_above_200k_tokens,
  );
  const cacheCreationCost = calculateTieredCost(
    tokens.cache_creation_input_tokens,
    pricing.cache_creation_input_token_cost,
    pricing.cache_creation_input_token_cost_above_200k_tokens,
  );
  const cacheReadCost = calculateTieredCost(
    tokens.cache_read_input_tokens,
    pricing.cache_read_input_token_cost,
    pricing.cache_read_input_token_cost_above_200k_tokens,
  );
  const baseCost = inputCost + outputCost + cacheCreationCost + cacheReadCost;
  const multiplier = tokens.speed === "fast" ? (pricing.provider_specific_entry?.fast ?? 1) : 1;
  return baseCost * multiplier;
}
