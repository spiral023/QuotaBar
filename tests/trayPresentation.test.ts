import { describe, expect, it } from "vitest";
import { buildTooltip } from "../src/main/trayPresentation";
import type { UsageSnapshot } from "../src/providers/types";

function snap(provider: string, usedPercent: number): UsageSnapshot {
  return {
    provider,
    status: "ok",
    windows: [{ name: "fiveHour", usedPercent }],
    updatedAt: "2026-07-10T12:00:00.000Z",
  };
}

describe("tray presentation order", () => {
  it("lists tooltip providers in the configured order", () => {
    const snapshots = [snap("claude", 50), snap("codex", 75)];

    expect(buildTooltip(snapshots, ["codex", "claude"]).split("\n")).toEqual([
      "QuotaBar",
      "Codex: 75%",
      "Claude: 50%",
    ]);
  });
});
