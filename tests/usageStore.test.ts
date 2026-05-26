import { describe, expect, it } from "vitest";
import type { UsageSnapshot } from "../src/providers/types";
import { UsageStore } from "../src/usage/usageStore";

function snap(provider: string): UsageSnapshot {
  return {
    provider,
    status: "stale",
    windows: [{ name: "fiveHour", usedPercent: 12 }],
    updatedAt: "2026-05-26T10:00:00.000Z",
  };
}

describe("UsageStore", () => {
  it("can be initialized with cached snapshots", () => {
    const store = new UsageStore([snap("codex"), snap("claude")]);

    expect(store.getAll().map((snapshot) => snapshot.provider)).toEqual(["claude", "codex"]);
    expect(store.get("claude")?.windows[0].usedPercent).toBe(12);
  });
});
