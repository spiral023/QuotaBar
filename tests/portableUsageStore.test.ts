import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortableUsageStore } from "../src/portable/usageStore";
import type { PortableUsageEvent } from "../src/portable/types";

function event(
  id: string,
  occurredAt: string,
  overrides: Partial<PortableUsageEvent> = {},
): PortableUsageEvent {
  return {
    schemaVersion: 1,
    id,
    provider: "claude",
    occurredAt,
    model: "claude-sonnet-4",
    projectName: "QuotaBar",
    sessionKey: `session-${id}`,
    source: "claude-log",
    synthetic: false,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    reasoningOutputTokens: 0,
    costUSD: 0.02,
    inputCostUSD: 0.001,
    outputCostUSD: 0.002,
    cacheCreationCostUSD: 0.003,
    cacheReadCostUSD: 0.004,
    pricingVersion: "2026-07-01",
    ...overrides,
  };
}

describe("PortableUsageStore", () => {
  let rootDir: string;
  let store: PortableUsageStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-portable-store-"));
    store = new PortableUsageStore(rootDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("writes events to their UTC monthly partitions", async () => {
    await store.upsert([
      event("july-2", "2026-07-31T23:59:59.000Z"),
      event("july-1", "2026-07-01T00:00:00.000Z"),
      event("august-1", "2026-08-01T00:00:00.000Z"),
    ]);

    const eventsDir = path.join(rootDir, "events");
    expect(await readdir(eventsDir)).toEqual(["2026-07.jsonl", "2026-08.jsonl"]);
    expect((await readFile(path.join(eventsDir, "2026-07.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await readFile(path.join(eventsDir, "2026-08.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("stores duplicate IDs once and reports inserted and existing counts", async () => {
    const original = event("same-id", "2026-07-02T00:00:00.000Z");

    expect(await store.upsert([original, original, event("other-id", "2026-07-03T00:00:00.000Z")])).toEqual({
      inserted: 2,
      existing: 1,
    });
    expect(await store.upsert([original])).toEqual({
      inserted: 0,
      existing: 1,
    });
    expect((await store.read()).map((item) => item.id)).toEqual(["same-id", "other-id"]);
  });

  it("keeps the first incoming occurrence when an ID spans monthly partitions", async () => {
    expect(await store.upsert([
      event("global-id", "2026-07-31T23:00:00.000Z"),
      event("global-id", "2026-08-01T01:00:00.000Z"),
    ])).toEqual({ inserted: 1, existing: 1 });

    const stored = await store.read();
    expect(stored).toHaveLength(1);
    expect(stored[0].occurredAt).toBe("2026-07-31T23:00:00.000Z");
    expect(await readdir(path.join(rootDir, "events"))).toEqual(["2026-07.jsonl"]);
  });

  it("deduplicates an ID already stored in a different monthly partition", async () => {
    await store.upsert([event("global-id", "2026-07-31T23:00:00.000Z")]);

    expect(await store.upsert([event("global-id", "2026-08-01T01:00:00.000Z")])).toEqual({
      inserted: 0,
      existing: 1,
    });
    expect((await store.read()).map((item) => item.occurredAt)).toEqual(["2026-07-31T23:00:00.000Z"]);
    expect(await readdir(path.join(rootDir, "events"))).toEqual(["2026-07.jsonl"]);
  });

  it("reads inclusive bounded ranges and unbounded events", async () => {
    await store.upsert([
      event("august", "2026-08-01T12:00:00.000Z"),
      event("july-end", "2026-07-31T23:59:59.999Z"),
      event("july-start", "2026-07-01T00:00:00.000Z"),
    ]);

    expect((await store.read({ since: "2026-07-01", until: "2026-07-31" })).map((item) => item.id)).toEqual([
      "july-start",
      "july-end",
    ]);
    expect((await store.read({ since: "2026-08-01", until: "2026-08-31" })).map((item) => item.id)).toEqual([
      "august",
    ]);
    expect((await store.read()).map((item) => item.id)).toEqual(["july-start", "july-end", "august"]);
  });

  it("sorts output by occurredAt and then id", async () => {
    await store.upsert([
      event("z", "2026-07-01T01:00:00.000Z"),
      event("b", "2026-07-01T00:00:00.000Z"),
      event("a", "2026-07-01T00:00:00.000Z"),
    ]);

    expect((await store.read()).map((item) => item.id)).toEqual(["a", "b", "z"]);
    const lines = (await readFile(path.join(rootDir, "events", "2026-07.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PortableUsageEvent);
    expect(lines.map((item) => item.id)).toEqual(["a", "b", "z"]);
  });

  it("skips blank, malformed, and invalid JSONL records", async () => {
    const eventsDir = path.join(rootDir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      path.join(eventsDir, "2026-07.jsonl"),
      [``, `{not-json`, JSON.stringify({ ...event("invalid", "2026-07-02T00:00:00.000Z"), provider: "other" }), JSON.stringify(event("valid", "2026-07-03T00:00:00.000Z")), ``].join("\n"),
      "utf8",
    );

    expect((await store.read()).map((item) => item.id)).toEqual(["valid"]);
  });

  it.each([
    ["schema", { schemaVersion: 2 }],
    ["provider", { provider: "other" }],
    ["timestamp", { occurredAt: "not-a-date" }],
    ["id", { id: "  " }],
    ["model", { model: "" }],
    ["session key", { sessionKey: "" }],
    ["input tokens", { inputTokens: -1 }],
    ["output tokens", { outputTokens: Number.NaN }],
    ["cache creation tokens", { cacheCreationTokens: Number.POSITIVE_INFINITY }],
    ["cache read tokens", { cacheReadTokens: -0.1 }],
    ["reasoning output tokens", { reasoningOutputTokens: Number.NEGATIVE_INFINITY }],
  ])("rejects an invalid v1 event %s before writing", async (_case, overrides) => {
    const invalid = event("invalid", "2026-07-01T00:00:00.000Z", overrides as Partial<PortableUsageEvent>);

    await expect(store.upsert([invalid])).rejects.toThrow(/^Invalid portable usage event:/);
    await expect(readdir(rootDir)).resolves.toEqual([]);
  });

  it("validates ranges", async () => {
    await expect(store.read({ since: "yesterday" })).rejects.toThrow("Invalid portable usage range");
    await expect(store.read({ until: "2026-02-30" })).rejects.toThrow("Invalid portable usage range");
    await expect(store.read({ since: "2026-08-01", until: "2026-07-31" })).rejects.toThrow(
      "Invalid portable usage range: since is after until",
    );
  });

  it("rebuilds metadata from valid monthly partitions", async () => {
    await store.upsert([
      event("july-late", "2026-07-31T22:00:00.000Z"),
      event("july-early", "2026-07-02T03:00:00.000Z"),
      event("august", "2026-08-10T04:00:00.000Z"),
    ]);
    await unlink(path.join(rootDir, "store-metadata.json"));
    await writeFile(path.join(rootDir, "events", "notes.jsonl"), JSON.stringify(event("ignored", "2026-09-01T00:00:00.000Z")));

    const metadata = await store.rebuildMetadata();

    expect(metadata.schemaVersion).toBe(1);
    expect(metadata.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(metadata.partitions).toEqual({
      "2026-07": {
        eventCount: 2,
        firstAt: "2026-07-02T03:00:00.000Z",
        lastAt: "2026-07-31T22:00:00.000Z",
      },
      "2026-08": {
        eventCount: 1,
        firstAt: "2026-08-10T04:00:00.000Z",
        lastAt: "2026-08-10T04:00:00.000Z",
      },
    });
    expect(JSON.parse(await readFile(path.join(rootDir, "store-metadata.json"), "utf8"))).toEqual(metadata);
  });

  it("does not leave temporary files after successful writes", async () => {
    await store.upsert([event("one", "2026-07-01T00:00:00.000Z")]);

    expect((await readdir(path.join(rootDir, "events"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await readdir(rootDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("uses a unique temporary name when the PID and clock path already exists", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const legacyTemporary = path.join(
      rootDir,
      `store-metadata.json.${process.pid}.1700000000000.tmp`,
    );
    await writeFile(legacyTemporary, "reserved", "utf8");

    await store.rebuildMetadata();

    expect(await readFile(legacyTemporary, "utf8")).toBe("reserved");
    expect(JSON.parse(await readFile(path.join(rootDir, "store-metadata.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      partitions: {},
    });
  });
});
