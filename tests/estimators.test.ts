import { describe, expect, it } from "vitest";
import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";
import { estimateCodexCost } from "../src/pricing/codex-estimator";
import { estimateGeminiCost } from "../src/pricing/gemini-estimator";

describe("estimateCodexCost", () => {
  it("returns 0 for 0% usage", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const cost = await estimateCodexCost(0, fetcher);
    expect(cost).toBe(0);
  });

  it("returns positive cost for 100% usage", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const cost = await estimateCodexCost(100, fetcher);
    expect(cost).toBeGreaterThan(0);
  });

  it("cost at 50% is half of cost at 100%", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const full = await estimateCodexCost(100, fetcher);
    const half = await estimateCodexCost(50, fetcher);
    expect(half).toBeCloseTo(full / 2, 5);
  });
});

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
