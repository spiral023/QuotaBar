import { calculateCostFromTokens } from "./cost-calculator";
import type { LiteLLMFetcher } from "./litellm-fetcher";

const GEMINI_AVG_INPUT_PER_SESSION = 5_000;
const GEMINI_AVG_OUTPUT_PER_SESSION = 1_000;
const GEMINI_MODEL = "gemini-2.0-flash";

export async function estimateGeminiCost(sessionCount: number, fetcher: LiteLLMFetcher): Promise<number> {
  if (sessionCount <= 0) return 0;
  const pricing = await fetcher.getModelPricing(GEMINI_MODEL);
  if (!pricing) return 0;
  return calculateCostFromTokens(
    {
      input_tokens: GEMINI_AVG_INPUT_PER_SESSION * sessionCount,
      output_tokens: GEMINI_AVG_OUTPUT_PER_SESSION * sessionCount,
    },
    pricing,
  );
}
