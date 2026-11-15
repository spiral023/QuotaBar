import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PortableUsageEvent } from "../src/portable/types";
import { canonicalSerialize, compareCanonicalEvents, equalPortableEvents, requirePortableEvent } from "../src/portable/usageEventCodec";
import { PortableUsageStore } from "../src/portable/usageStore";
import { buildMetadata, deduplicateGlobally, snapshotsToMaps } from "../src/portable/usageStoreFormat";

function event(index: number): PortableUsageEvent {
  return requirePortableEvent({ schemaVersion: 1, id: `id-${index}`, provider: "claude", occurredAt: "2026-01-01T01:00:00.000Z",
    model: "fixture", sessionKey: "session", source: "claude-log", synthetic: false,
    inputTokens: index, outputTokens: 100, cacheCreationTokens: 1, cacheReadTokens: 2, reasoningOutputTokens: 3 });
}

describe("canonical store performance equivalence", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "quotabar-store-equivalence-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("preserves canonical winners and metadata for unsorted duplicates and timestamp offsets", () => {
    const input = Array.from({ length: 240 }, (_, index) => ({ ...event(index % 29), costUSD: index % 7,
      occurredAt: index % 3 ? "2026-01-01T01:00:00.000Z" : "2026-01-01T12:00:00.000+10:00" })).reverse();
    const reference = new Map<string, PortableUsageEvent>();
    for (const item of [...input].sort(compareCanonicalEvents)) if (!reference.has(item.id)) reference.set(item.id, item);
    const expected = [...reference.values()].sort(compareCanonicalEvents);
    expect(deduplicateGlobally(input)).toEqual(expected);
    const partitions = snapshotsToMaps([{ month: "2026-01", filePath: "fixture", events: input }]);
    expect([...partitions.get("2026-01")!.values()].sort(compareCanonicalEvents)).toEqual(expected);
    expect(buildMetadata(partitions).partitions).toEqual({ "2026-01": {
      eventCount: expected.length, firstAt: expected[0].occurredAt, lastAt: expected.at(-1)!.occurredAt,
    } });
  });

  it("keeps public reads and nested legacy values isolated from the owned partition cache", async () => {
    const store = new PortableUsageStore(root);
    const legacyTarget = { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0,
      reasoningOutputTokens: 0, costUSD: 1, inputCostUSD: .4, outputCostUSD: .6, cacheCreationCostUSD: 0, cacheReadCostUSD: 0 };
    const original = { ...event(1), source: "legacy-reconciliation" as const, synthetic: true, legacyTarget };
    await store.upsert([original]); const revision = await store.getRevision();
    const exposed = await store.read(); exposed[0].outputTokens = 999; exposed[0].legacyTarget!.costUSD = 999;
    exposed.splice(0); original.legacyTarget.inputTokens = 999;
    const again = await store.read();
    expect(again[0].outputTokens).toBe(100); expect(again[0].legacyTarget!.costUSD).toBe(1);
    expect(again[0].legacyTarget!.inputTokens).toBe(10); expect(await store.getRevision()).toBe(revision);
    expect(await store.reconcile(again)).toEqual({ inserted: 0, updated: 0, existing: 1 });
  });

  it("retains the established ordering for mixed offset representations", () => {
    const input = ["2026-01-01T12:00:00.000Z", "2026-01-01T15:00:00.000+10:00", "2026-01-01T08:00:00.000-10:00"]
      .map(occurredAt => ({ ...event(1), occurredAt }));
    const ordered = [...input].sort(compareCanonicalEvents);
    expect(deduplicateGlobally(input)).toEqual([ordered[0]]);
    expect([...snapshotsToMaps([{ month: "2026-01", filePath: "fixture", events: input }]).get("2026-01")!.values()]).toEqual([ordered[0]]);
  });

  it("matches canonical JSON equality across every scalar and nested persisted field", () => {
    const base = requirePortableEvent({ ...event(1), source: "legacy-reconciliation", synthetic: true,
      projectName: "Fixture", pricingVersion: "fixture-v1", costUSD: .01, inputCostUSD: .005,
      outputCostUSD: .005, cacheCreationCostUSD: 0, cacheReadCostUSD: 0,
      legacyTarget: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4,
        reasoningOutputTokens: 5, costUSD: 1, inputCostUSD: .2, outputCostUSD: .3, cacheCreationCostUSD: .4, cacheReadCostUSD: .1 } });
    const cases: PortableUsageEvent[] = [requirePortableEvent(base)];
    for (const [key, value] of Object.entries(base)) {
      if (key === "legacyTarget") {
        for (const field of Object.keys(base.legacyTarget!)) cases.push({ ...base, legacyTarget: { ...base.legacyTarget!, [field]: 42 } });
        cases.push({ ...base, legacyTarget: undefined });
      } else cases.push({ ...base, [key]: typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : `${value}-changed` });
    }
    cases.push({ ...base, costUSD: undefined }, { ...base, costUSD: 0 });
    for (const other of cases) expect(equalPortableEvents(base, other)).toBe(canonicalSerialize(base) === canonicalSerialize(other));
  });
});
