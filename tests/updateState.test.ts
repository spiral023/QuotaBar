import { describe, it, expect } from "vitest";
import { initialUpdateState, reduceUpdateState } from "../src/main/updateState";

describe("initialUpdateState", () => {
  it("is disabled when updater is not enabled (dev)", () => {
    const s = initialUpdateState("0.1.0", false);
    expect(s.status).toBe("disabled");
    expect(s.currentVersion).toBe("0.1.0");
  });
  it("is idle when enabled", () => {
    expect(initialUpdateState("0.1.0", true).status).toBe("idle");
  });
});

describe("reduceUpdateState", () => {
  const base = initialUpdateState("0.1.0", true);

  it("moves to checking", () => {
    expect(reduceUpdateState(base, { type: "checking" }).status).toBe("checking");
  });
  it("records an available version", () => {
    const s = reduceUpdateState(base, { type: "available", version: "0.2.0" });
    expect(s.status).toBe("available");
    expect(s.newVersion).toBe("0.2.0");
  });
  it("records a manual-only update (ZIP/Portable) without downloading", () => {
    const s = reduceUpdateState(base, { type: "manual-available", version: "0.2.0" });
    expect(s.status).toBe("manual");
    expect(s.newVersion).toBe("0.2.0");
    expect(s.downloadPercent).toBe(0);
  });
  it("tracks download progress", () => {
    const s = reduceUpdateState(base, { type: "progress", percent: 42 });
    expect(s.status).toBe("downloading");
    expect(s.downloadPercent).toBe(42);
  });
  it("marks ready after download", () => {
    const s = reduceUpdateState(base, { type: "downloaded", version: "0.2.0" });
    expect(s.status).toBe("ready");
    expect(s.newVersion).toBe("0.2.0");
  });
  it("returns to idle when nothing is available", () => {
    const checking = reduceUpdateState(base, { type: "checking" });
    expect(reduceUpdateState(checking, { type: "not-available" }).status).toBe("idle");
  });
  it("captures errors without losing the current version", () => {
    const s = reduceUpdateState(base, { type: "error", message: "boom" });
    expect(s.status).toBe("error");
    expect(s.error).toBe("boom");
    expect(s.currentVersion).toBe("0.1.0");
  });
  it("keeps a downloaded update installable when a later updater error arrives", () => {
    const ready = reduceUpdateState(base, { type: "downloaded", version: "0.2.0" });
    const afterError = reduceUpdateState(ready, { type: "error", message: "network down" });

    expect(afterError.status).toBe("ready");
    expect(afterError.newVersion).toBe("0.2.0");
    expect(afterError.error).toBe("network down");
  });
  it("never leaves the disabled state", () => {
    const disabled = initialUpdateState("0.1.0", false);
    expect(reduceUpdateState(disabled, { type: "checking" }).status).toBe("disabled");
  });
});
