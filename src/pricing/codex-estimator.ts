import { calculateCostFromTokens } from "./cost-calculator";
import type { LiteLLMFetcher } from "./litellm-fetcher";

const CODEX_REFERENCE_INPUT_TOKENS = 2_000_000;
const CODEX_REFERENCE_OUTPUT_TOKENS = 500_000;
const CODEX_MODEL = "gpt-4o";

export async function estimateCodexCost(usedPercent: number, fetcher: LiteLLMFetcher): Promise<number> {
  if (usedPercent <= 0) return 0;
  const pricing = await fetcher.getModelPricing(CODEX_MODEL);
  if (!pricing) return 0;
  const fraction = usedPercent / 100;
  return calculateCostFromTokens(
    {
      input_tokens: Math.round(CODEX_REFERENCE_INPUT_TOKENS * fraction),
      output_tokens: Math.round(CODEX_REFERENCE_OUTPUT_TOKENS * fraction),
    },
    pricing,
  );
}
