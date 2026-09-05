import * as nodeFs from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PortableUsageStore } from "../src/portable/usageStore";
import type { PortableUsageEvent } from "../src/portable/types";

// Inserting into an existing partition appends the new lines instead of
// rewriting the whole month. Append and rewrite are only distinguishable by
// on-disk line order — a rewrite sorts chronologically, an append puts the new
// line last whatever its timestamp — so the assertions below use that.

function event(id: string, occurredAt: string): PortableUsageEvent {
  return {
    schemaVersion: 1, id, provider: "claude", occurredAt,
    model: "claude-sonnet-4", projectName: "QuotaBar", sessionKey: `session-${id}`,
    source: "claude-log", synthetic: false,
    inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40,
    reasoningOutputTokens: 0, costUSD: 0.02,
  };
}

let rootDir: string;
let store: PortableUsageStore;
const partition = (): string => path.join(rootDir, "events", "2026-07.jsonl");

/** An event that sorts before an existing one, so its file position is telling. */
const EARLY = (): PortableUsageEvent => event("early", "2026-07-01T00:00:00.001Z");

async function idsInFileOrder(): Promise<string[]> {
  const contents = await readFile(partition(), "utf8");
  return contents.trim().split("\n").map((line) => JSON.parse(line).id as string);
}

async function seed(): Promise<void> {
  await store.reconcile([event("a", "2026-07-01T00:00:00.000Z"), event("b", "2026-07-02T00:00:00.000Z")]);
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-append-"));
  store = new PortableUsageStore(rootDir);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("partition appends", () => {
  it("appends a new event as the last line even when it sorts earlier", async () => {
    await seed();
    await store.reconcile([EARLY()]);
    expect(await idsInFileOrder()).toEqual(["a", "b", "early"]);
  });

  it("writes far less than the partition when inserting one event", async () => {
    // A larger partition makes the rewrite-vs-append gap unambiguous.
    await store.reconcile(Array.from({ length: 40 }, (_, index) =>
      event(`seed${index}`, `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`)));
    const partitionSize = (await stat(partition())).size;
    let partitionBytes = 0;
    const counting = new PortableUsageStore(rootDir, {
      ...nodeFs,
      writeFile: (async (file: unknown, data: unknown, options: unknown) => {
        if (String(file).includes("2026-07.jsonl")) partitionBytes += Buffer.byteLength(data as string);
        return (nodeFs.writeFile as (...args: unknown[]) => Promise<void>)(file, data, options);
      }) as typeof nodeFs.writeFile,
    });
    await counting.read();
    // The first write of a fresh instance is always a rewrite; it establishes
    // the reference size that later appends check against.
    await counting.reconcile([event("c", "2026-07-03T00:00:00.000Z")]);
    partitionBytes = 0;
    await counting.reconcile([event("d", "2026-07-04T00:00:00.000Z")]);
    expect(partitionBytes).toBeGreaterThan(0);
    // One event's worth of bytes, not forty.
    expect(partitionBytes).toBeLessThan(partitionSize / 10);
  });

  it("returns appended events in chronological order regardless of file order", async () => {
    await seed();
    await store.reconcile([EARLY()]);
    expect(await idsInFileOrder()).toEqual(["a", "b", "early"]);
    const events = await store.read();
    expect(events.map((item) => item.id)).toEqual(["a", "early", "b"]);
  });

  it("keeps the revision equal to a full rewrite of the same events", async () => {
    await seed();
    await store.reconcile([EARLY()]);
    const appendedRevision = await store.getRevision();

    const rewriteDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-rewrite-"));
    try {
      const rewritten = new PortableUsageStore(rewriteDir);
      await rewritten.reconcile([
        event("a", "2026-07-01T00:00:00.000Z"),
        event("b", "2026-07-02T00:00:00.000Z"),
        EARLY(),
      ]);
      expect(await rewritten.getRevision()).toBe(appendedRevision);
    } finally {
      await rm(rewriteDir, { recursive: true, force: true });
    }
  });

  it("rewrites instead of appending when an event is updated", async () => {
    await seed();
    await store.reconcile([EARLY()]);
    await store.reconcile([{ ...event("a", "2026-07-01T00:00:00.000Z"), outputTokens: 999 }]);
    expect(await idsInFileOrder()).toEqual(["a", "early", "b"]);
    const events = await store.read();
    expect(events.filter((item) => item.id === "a")).toHaveLength(1);
    expect(events.find((item) => item.id === "a")?.outputTokens).toBe(999);
  });

  it("rewrites when the file changed behind the store's back", async () => {
    await seed();
    // Stands in for an append cut short by a crash: a partial trailing line.
    await writeFile(partition(), `${await readFile(partition(), "utf8")}{ truncated\n`, "utf8");
    await store.reconcile([EARLY()]);
    const contents = await readFile(partition(), "utf8");
    expect(contents).not.toContain("{ truncated");
    expect(await idsInFileOrder()).toEqual(["a", "early", "b"]);
  });

  it("rewrites on the first write of a process that did not write the file", async () => {
    await seed();
    const fresh = new PortableUsageStore(rootDir);
    await fresh.reconcile([EARLY()]);
    expect(await idsInFileOrder()).toEqual(["a", "early", "b"]);
  });

  it("appends repeatedly without corrupting the partition", async () => {
    await seed();
    for (let index = 0; index < 5; index += 1) {
      await store.reconcile([event(`x${index}`, `2026-07-1${index}T00:00:00.000Z`)]);
    }
    const events = await store.read();
    expect(events).toHaveLength(7);
    const lines = (await readFile(partition(), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("counts a re-sent event as existing rather than appending it twice", async () => {
    await seed();
    await store.reconcile([EARLY()]);
    const result = await store.reconcile([EARLY()]);
    expect(result).toMatchObject({ inserted: 0, existing: 1 });
    expect(await idsInFileOrder()).toEqual(["a", "b", "early"]);
  });

  it("appends into the right month when two partitions are touched", async () => {
    await seed();
    await store.reconcile([event("aug", "2026-08-01T00:00:00.000Z")]);
    await store.reconcile([EARLY()]);
    expect(await idsInFileOrder()).toEqual(["a", "b", "early"]);
    expect((await store.read()).map((item) => item.id)).toEqual(["a", "early", "b", "aug"]);
  });
});
