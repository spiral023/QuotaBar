import { describe, expect, it } from "vitest";
import { buildIconState } from "../src/icon/iconState";
import type { UsageSnapshot } from "../src/providers/types";

function snap(
  provider: string,
  status: UsageSnapshot["status"] = "ok",
  windows: { name: string; usedPercent?: number }[] = []
): UsageSnapshot {
  return {
    provider,
    status,
    windows: windows as UsageSnapshot["windows"],
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("buildIconState", () => {
  it("returns codex bar with usedPercent from fiveHour window", () => {
    const state = buildIconState([snap("codex", "ok", [{ name: "fiveHour", usedPercent: 75 }])]);
    expect(state.codex).toEqual({ usedPercent: 75, isStale: false });
    expect(state.claude).toBeUndefined();
  });

  it("returns claude bar with usedPercent from fiveHour window", () => {
    const state = buildIconState([snap("claude", "ok", [{ name: "fiveHour", usedPercent: 50 }])]);
    expect(state.claude).toEqual({ usedPercent: 50, isStale: false });
    expect(state.codex).toBeUndefined();
  });

  it("returns bar with isStale=true for stale provider", () => {
    const state = buildIconState([snap("codex", "stale", [{ name: "fiveHour", usedPercent: 90 }])]);
    expect(state.codex).toEqual({ usedPercent: 90, isStale: true });
  });

  it("returns undefined for not_authenticated provider", () => {
    const state = buildIconState([snap("codex", "not_authenticated")]);
    expect(state.codex).toBeUndefined();
  });

  it("returns undefined for error provider", () => {
    const state = buildIconState([snap("codex", "error")]);
    expect(state.codex).toBeUndefined();
  });

  it("returns usedPercent=undefined when fiveHour window exists but has no usedPercent", () => {
    const state = buildIconState([snap("codex", "ok", [{ name: "fiveHour" }])]);
    expect(state.codex).toEqual({ usedPercent: undefined, isStale: false });
  });

  it("returns usedPercent=undefined when no fiveHour window present", () => {
    const state = buildIconState([snap("codex", "ok", [{ name: "weekly", usedPercent: 30 }])]);
    expect(state.codex).toEqual({ usedPercent: undefined, isStale: false });
  });

  it("sets hasError=true when any snapshot is stale", () => {
    const state = buildIconState([snap("codex", "ok"), snap("claude", "stale")]);
    expect(state.hasError).toBe(true);
  });

  it("sets hasError=true when any snapshot has error status", () => {
    const state = buildIconState([snap("codex", "ok"), snap("claude", "error")]);
    expect(state.hasError).toBe(true);
  });

  it("sets hasError=false when no stale snapshots", () => {
    const state = buildIconState([snap("codex", "ok"), snap("claude", "ok")]);
    expect(state.hasError).toBe(false);
  });

  it("returns all undefined bars for empty snapshot list", () => {
    const state = buildIconState([]);
    expect(state.codex).toBeUndefined();
    expect(state.claude).toBeUndefined();
    expect(state.hasError).toBe(false);
  });

  it("handles both providers active simultaneously", () => {
    const state = buildIconState([
      snap("codex", "ok", [{ name: "fiveHour", usedPercent: 100 }]),
      snap("claude", "ok", [{ name: "fiveHour", usedPercent: 50 }]),
    ]);
    expect(state.codex).toEqual({ usedPercent: 100, isStale: false });
    expect(state.claude).toEqual({ usedPercent: 50, isStale: false });
    expect(state.hasError).toBe(false);
  });
});
