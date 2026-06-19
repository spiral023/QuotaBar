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

export interface CostBreakdown {
  inputCostUSD: number;
  outputCostUSD: number;
  cacheCreationCostUSD: number;
  cacheReadCostUSD: number;
}

/**
 * Wie {@link calculateCostFromTokens}, gibt aber die vier Einzelkosten zurück
 * (inkl. Tier-Staffel und Fast-Multiplikator). Summe der Felder == das Ergebnis
 * von calculateCostFromTokens – einzige Quelle der Wahrheit für die Zerlegung.
 */
export function calculateCostBreakdown(tokens: TokenCounts, pricing: ModelPricing): CostBreakdown {
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
  const multiplier = tokens.speed === "fast" ? (pricing.provider_specific_entry?.fast ?? 1) : 1;
  return {
    inputCostUSD: inputCost * multiplier,
    outputCostUSD: outputCost * multiplier,
    cacheCreationCostUSD: cacheCreationCost * multiplier,
    cacheReadCostUSD: cacheReadCost * multiplier,
  };
}

export function sumBreakdown(b: CostBreakdown): number {
  return b.inputCostUSD + b.outputCostUSD + b.cacheCreationCostUSD + b.cacheReadCostUSD;
}

export const ZERO_BREAKDOWN: CostBreakdown = {
  inputCostUSD: 0, outputCostUSD: 0, cacheCreationCostUSD: 0, cacheReadCostUSD: 0,
};

/**
 * Skaliert eine rate-basierte Zerlegung so, dass ihre Summe exakt `actualTotal`
 * ergibt. Nötig, wenn der maßgebliche Tageswert teils aus Quell-Kosten (ohne
 * Typ-Aufschlüsselung) stammt: die Aufteilung folgt den Listenpreisen, die Summe
 * bleibt der echte Wert. Bei rein berechneten Kosten ist der Faktor 1 → exakt.
 */
export function scaleBreakdownTo(breakdown: CostBreakdown, actualTotal: number): CostBreakdown {
  const rateTotal = sumBreakdown(breakdown);
  if (rateTotal <= 0) return { ...ZERO_BREAKDOWN };
  const f = actualTotal / rateTotal;
  return {
    inputCostUSD: breakdown.inputCostUSD * f,
    outputCostUSD: breakdown.outputCostUSD * f,
    cacheCreationCostUSD: breakdown.cacheCreationCostUSD * f,
    cacheReadCostUSD: breakdown.cacheReadCostUSD * f,
  };
}

export function calculateCostFromTokens(tokens: TokenCounts, pricing: ModelPricing): number {
  return sumBreakdown(calculateCostBreakdown(tokens, pricing));
}
