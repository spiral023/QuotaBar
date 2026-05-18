import { describe, expect, it } from "vitest";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";
import { estimateGeminiCost } from "../src/pricing/gemini-estimator";

describe("estimateGeminiCost", () => {
  it("returns 0 for 0 sessions", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const cost = await estimateGeminiCost(0, fetcher);
    expect(cost).toBe(0);
  });

  it("returns positive cost for 10 sessions", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const cost = await estimateGeminiCost(10, fetcher);
    expect(cost).toBeGreaterThan(0);
  });

  it("cost scales linearly with session count", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const ten = await estimateGeminiCost(10, fetcher);
    const twenty = await estimateGeminiCost(20, fetcher);
    expect(twenty).toBeCloseTo(ten * 2, 5);
  });
});
