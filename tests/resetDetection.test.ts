import { describe, expect, it } from "vitest";
import { detectResets } from "../src/usage/resetDetection";
import type { UsageSnapshot, UsageWindow } from "../src/providers/types";

function snap(
  provider: string,
  windows: { name: UsageWindow["name"]; usedPercent?: number }[],
  status: UsageSnapshot["status"] = "ok"
): UsageSnapshot {
  return {
    provider,
    status,
    windows,
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("detectResets", () => {
  it("emits ResetEvent when fiveHour window goes from 100% to 0%", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
    expect(detectResets(prev, next)).toEqual([{ provider: "codex", windowName: "fiveHour" }]);
  });

  it("emits ResetEvent for weekly window reset", () => {
    const prev = snap("claude", [{ name: "weekly", usedPercent: 99.5 }]);
    const next = snap("claude", [{ name: "weekly", usedPercent: 0 }]);
    expect(detectResets(prev, next)).toEqual([{ provider: "claude", windowName: "weekly" }]);
  });

  it("emits nothing when prev was below threshold (80%)", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 80 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("emits nothing when next is above near-empty threshold (50%)", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 50 }]);
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("emits nothing when next status is error", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }], "error");
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("emits nothing when next status is stale", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }], "stale");
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("emits nothing when next status is not_authenticated", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }], "not_authenticated");
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("emits nothing when prev status is error (recovery from error is not a reset)", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }], "error");
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("emits nothing when no previous snapshot (first refresh)", () => {
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
    expect(detectResets(undefined, next)).toEqual([]);
  });

  it("emits multiple events when multiple windows reset simultaneously", () => {
    const prev = snap("claude", [
      { name: "fiveHour", usedPercent: 100 },
      { name: "weekly", usedPercent: 99.5 },
    ]);
    const next = snap("claude", [
      { name: "fiveHour", usedPercent: 0 },
      { name: "weekly", usedPercent: 1 },
    ]);
    const events = detectResets(prev, next);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual({ provider: "claude", windowName: "fiveHour" });
    expect(events).toContainEqual({ provider: "claude", windowName: "weekly" });
  });

  it("threshold boundary: prev exactly 99.5% → emits", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 99.5 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
    expect(detectResets(prev, next)).toHaveLength(1);
  });

  it("threshold boundary: prev 99.4% → no event", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 99.4 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("threshold boundary: next exactly 1% → emits", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 1 }]);
    expect(detectResets(prev, next)).toHaveLength(1);
  });

  it("threshold boundary: next 1.1% → no event", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 1.1 }]);
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("emits nothing when prev window has no usedPercent", () => {
    const prev = snap("codex", [{ name: "fiveHour" }]);
    const next = snap("codex", [{ name: "fiveHour", usedPercent: 0 }]);
    expect(detectResets(prev, next)).toEqual([]);
  });

  it("emits nothing when next window has no usedPercent", () => {
    const prev = snap("codex", [{ name: "fiveHour", usedPercent: 100 }]);
    const next = snap("codex", [{ name: "fiveHour" }]);
    expect(detectResets(prev, next)).toEqual([]);
  });
});
