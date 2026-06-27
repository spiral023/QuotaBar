import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appConfigDir: "",
  pricePath: "",
  fetch: vi.fn(),
}));

vi.mock("../src/config/paths", () => ({
  getAppConfigDir: () => mocks.appConfigDir,
  getLiteLLMModelPricesPath: () => mocks.pricePath,
}));

vi.mock("../src/main/httpClient", () => ({
  httpFetch: mocks.fetch,
}));

vi.mock("../src/main/logging", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { LiteLLMFetcher } from "../src/pricing/litellm-fetcher";

describe("LiteLLMFetcher live cache", () => {
  beforeEach(() => {
    mocks.appConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-litellm-"));
    mocks.pricePath = path.join(mocks.appConfigDir, "cache", "litellm-model-prices.json");
    mocks.fetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(mocks.appConfigDir, { recursive: true, force: true });
  });

  it("persists the downloaded LiteLLM model price file for inspection", async () => {
    const payload = {
      "openai/test-model": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    };
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const fetcher = new LiteLLMFetcher(false);
    await fetcher.getModelPricing("openai/test-model");

    expect(JSON.parse(fs.readFileSync(mocks.pricePath, "utf8"))).toEqual(payload);
  });
});
