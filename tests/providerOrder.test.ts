import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_ORDER,
  normalizeProviderOrder,
  sortByProviderOrder,
} from "../src/providers/providerOrder";

describe("provider order", () => {
  it("uses the default order when the setting is missing", () => {
    expect(normalizeProviderOrder(undefined)).toEqual(DEFAULT_PROVIDER_ORDER);
  });

  it("removes unknown and duplicate IDs and appends missing providers", () => {
    expect(normalizeProviderOrder(["codex", "unknown", "codex"])).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("sorts provider-bearing values without mutating the input", () => {
    const input = [{ provider: "claude" }, { provider: "codex" }];

    const result = sortByProviderOrder(
      input,
      ["codex", "claude"],
      (item) => item.provider,
    );

    expect(result.map((item) => item.provider)).toEqual(["codex", "claude"]);
    expect(input.map((item) => item.provider)).toEqual(["claude", "codex"]);
  });
});
