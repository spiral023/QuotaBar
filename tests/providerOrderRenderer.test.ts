import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Point = { x: number; y: number };

interface ProviderOrderDragApi {
  hasPassedThreshold(start: Point, current: Point, threshold?: number): boolean;
  insertionIndex(midpoints: number[], pointerY: number): number;
  persistOrder(
    next: string[],
    previous: string[],
    save: (order: string[]) => Promise<{ providerOrder?: string[] }>,
  ): Promise<{ order: string[]; saved: boolean }>;
}

function loadHelpers(): ProviderOrderDragApi {
  const qb = {};
  const context = vm.createContext({ window: { QB: qb }, QB: qb });
  const script = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer", "shared", "provider-order.js"),
    "utf8",
  );
  vm.runInContext(script, context);
  return (context.QB as { providerOrderDrag: ProviderOrderDragApi }).providerOrderDrag;
}

describe("provider-order renderer helpers", () => {
  it("starts dragging only after the movement threshold", () => {
    const api = loadHelpers();
    expect(api.hasPassedThreshold({ x: 10, y: 10 }, { x: 15, y: 12 })).toBe(false);
    expect(api.hasPassedThreshold({ x: 10, y: 10 }, { x: 17, y: 10 })).toBe(true);
  });

  it("finds the insertion slot from card midpoints", () => {
    const api = loadHelpers();
    expect(api.insertionIndex([100, 200], 50)).toBe(0);
    expect(api.insertionIndex([100, 200], 150)).toBe(1);
    expect(api.insertionIndex([100, 200], 250)).toBe(2);
  });

  it("keeps the saved normalized order after a successful commit", async () => {
    const api = loadHelpers();
    await expect(api.persistOrder(
      ["codex", "claude"],
      ["claude", "codex"],
      async () => ({ providerOrder: ["codex", "claude"] }),
    )).resolves.toEqual({ order: ["codex", "claude"], saved: true });
  });

  it("restores the previous order when persistence fails", async () => {
    const api = loadHelpers();
    await expect(api.persistOrder(
      ["codex", "claude"],
      ["claude", "codex"],
      async () => { throw new Error("save failed"); },
    )).resolves.toEqual({ order: ["claude", "codex"], saved: false });
  });
});
