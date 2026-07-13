import { mkdtemp, mkdir, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { PathLike } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as nodeFs from "node:fs/promises";
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

  it("reconciles corrected payloads in place and counts unchanged IDs as existing", async () => {
    const original = event("corrected", "2026-07-02T00:00:00.000Z");
    const corrected = event("corrected", "2026-07-02T00:00:00.000Z", {
      inputTokens: 999,
      costUSD: 4.2,
      pricingVersion: "corrected-v2",
    });
    const unchanged = event("unchanged", "2026-07-03T00:00:00.000Z");
    await store.upsert([original, unchanged]);

    expect(await store.reconcile([corrected, unchanged])).toEqual({
      inserted: 0,
      updated: 1,
      existing: 1,
    });
    expect((await store.read()).find(({ id }) => id === "corrected")).toEqual(corrected);
  });

  it("moves a corrected ID to its canonical month without deleting absent IDs", async () => {
    const retained = event("retained", "2026-07-01T00:00:00.000Z");
    await store.upsert([
      retained,
      event("month-move", "2026-07-31T23:00:00.000Z"),
    ]);

    expect(await store.reconcile([
      event("month-move", "2026-08-01T01:00:00.000Z"),
    ])).toEqual({ inserted: 0, updated: 1, existing: 0 });

    expect((await store.read()).map(({ id, occurredAt }) => [id, occurredAt])).toEqual([
      ["retained", "2026-07-01T00:00:00.000Z"],
      ["month-move", "2026-08-01T01:00:00.000Z"],
    ]);
    expect((await readFile(path.join(rootDir, "events", "2026-07.jsonl"), "utf8"))).not.toContain("month-move");
    expect(await readdir(path.join(rootDir, "events"))).toEqual(["2026-07.jsonl", "2026-08.jsonl"]);
  });

  it("uses the last incoming occurrence as the deterministic correction for a repeated ID", async () => {
    const first = event("repeated", "2026-07-02T00:00:00.000Z", { inputTokens: 1 });
    const last = event("repeated", "2026-07-02T00:00:00.000Z", { inputTokens: 2 });

    expect(await store.reconcile([first, last])).toEqual({ inserted: 1, updated: 0, existing: 0 });
    expect((await store.read())[0]).toEqual(last);
  });

  it("serializes concurrent upserts across store instances without losing events", async () => {
    const first = new PortableUsageStore(rootDir);
    const second = new PortableUsageStore(path.join(rootDir, "."));

    const results = await Promise.all([
      first.upsert([event("first", "2026-07-01T00:00:00.000Z")]),
      second.upsert([event("second", "2026-07-02T00:00:00.000Z")]),
    ]);

    expect(results).toEqual([
      { inserted: 1, existing: 0 },
      { inserted: 1, existing: 0 },
    ]);
    expect((await store.read()).map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("reports truthful counts for concurrent duplicate upserts", async () => {
    const results = await Promise.all([
      new PortableUsageStore(rootDir).upsert([event("shared", "2026-07-01T00:00:00.000Z")]),
      new PortableUsageStore(rootDir).upsert([event("shared", "2026-08-01T00:00:00.000Z")]),
    ]);

    expect(results).toEqual([
      { inserted: 1, existing: 0 },
      { inserted: 0, existing: 1 },
    ]);
    expect((await store.read()).map((item) => item.id)).toEqual(["shared"]);
  });

  it("serializes distinct upserts across real Node processes", async () => {
    const childFile = path.join(process.cwd(), "tests", "fixtures", "portableUsageStoreChild.test.ts");
    const vitestCli = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
    const first = runStoreChild(vitestCli, childFile, rootDir, "process-a");
    const second = runStoreChild(vitestCli, childFile, rootDir, "process-b");
    await waitForPaths([
      path.join(rootDir, "ready-process-a"),
      path.join(rootDir, "ready-process-b"),
    ]);
    await writeFile(path.join(rootDir, "child-go"), String(Date.now() + 500), "utf8");

    await Promise.all([first, second]);

    expect((await store.read()).map((item) => item.id)).toEqual(["process-a", "process-b"]);
  }, 30_000);

  it("does not let reads observe an in-process half-commit", async () => {
    let releaseRename!: () => void;
    let signalPaused!: () => void;
    const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
    const release = new Promise<void>((resolve) => { releaseRename = resolve; });
    const pausingFs = {
      ...nodeFs,
      async rename(from: PathLike, to: PathLike) {
        if (String(to).endsWith(path.join("events", "2026-08.jsonl"))) {
          signalPaused();
          await release;
        }
        return nodeFs.rename(from, to);
      },
    };
    const writer = new PortableUsageStore(rootDir, pausingFs).upsert([
      event("july", "2026-07-01T00:00:00.000Z"),
      event("august", "2026-08-01T00:00:00.000Z"),
    ]);
    await paused;
    let readSettled = false;
    const reader = new PortableUsageStore(rootDir).read().then((result) => {
      readSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(readSettled).toBe(false);

    releaseRename();
    await writer;
    expect((await reader).map((item) => item.id)).toEqual(["july", "august"]);
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

  it("persists and returns only allowlisted portable fields", async () => {
    const sensitive = {
      ...event("sanitized", "2026-07-03T00:00:00.000Z"),
      prompt: "private prompt",
      path: "C:\\private\\conversation.jsonl",
      token: "secret-token",
      credential: "secret-credential",
    } as PortableUsageEvent;

    await store.upsert([sensitive]);

    const disk = JSON.parse(
      (await readFile(path.join(rootDir, "events", "2026-07.jsonl"), "utf8")).trim(),
    ) as Record<string, unknown>;
    expect(disk).not.toHaveProperty("prompt");
    expect(disk).not.toHaveProperty("path");
    expect(disk).not.toHaveProperty("token");
    expect(disk).not.toHaveProperty("credential");
    expect(await store.read()).toEqual([{ ...event("sanitized", "2026-07-03T00:00:00.000Z") }]);
  });

  it("sanitizes valid disk records before returning them", async () => {
    const eventsDir = path.join(rootDir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      path.join(eventsDir, "2026-07.jsonl"),
      `${JSON.stringify({ ...event("disk", "2026-07-03T00:00:00.000Z"), prompt: "private", token: "secret" })}\n`,
      "utf8",
    );

    const [stored] = await store.read();
    expect(stored).toEqual(event("disk", "2026-07-03T00:00:00.000Z"));
    expect(stored).not.toHaveProperty("prompt");
    expect(stored).not.toHaveProperty("token");
  });

  it("ignores non-files, misplaced records, and globally deduplicates query results", async () => {
    const eventsDir = path.join(rootDir, "events");
    await mkdir(path.join(eventsDir, "2026-09.jsonl"), { recursive: true });
    await writeFile(
      path.join(eventsDir, "2026-07.jsonl"),
      [
        JSON.stringify(event("duplicate", "2026-07-02T00:00:00.000Z")),
        JSON.stringify(event("misplaced", "2026-08-02T00:00:00.000Z")),
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      path.join(eventsDir, "2026-08.jsonl"),
      `${JSON.stringify(event("duplicate", "2026-08-03T00:00:00.000Z"))}\n`,
      "utf8",
    );

    expect((await store.read()).map((item) => item.id)).toEqual(["duplicate"]);
  });

  it("accepts a correctly located incoming ID when the stored copy is misplaced", async () => {
    const eventsDir = path.join(rootDir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      path.join(eventsDir, "2026-07.jsonl"),
      `${JSON.stringify(event("same", "2026-08-01T00:00:00.000Z"))}\n`,
      "utf8",
    );

    expect(await store.upsert([event("same", "2026-07-01T00:00:00.000Z")])).toEqual({
      inserted: 1,
      existing: 0,
    });
    expect((await store.read()).map((item) => item.occurredAt)).toEqual(["2026-07-01T00:00:00.000Z"]);
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

  it("repairs misplaced records and cross-file duplicates while rebuilding metadata", async () => {
    const eventsDir = path.join(rootDir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      path.join(eventsDir, "2026-07.jsonl"),
      [
        JSON.stringify(event("duplicate", "2026-07-10T00:00:00.000Z")),
        JSON.stringify(event("moved", "2026-08-02T00:00:00.000Z")),
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      path.join(eventsDir, "2026-08.jsonl"),
      [
        JSON.stringify(event("duplicate", "2026-08-01T00:00:00.000Z")),
        JSON.stringify(event("august", "2026-08-03T00:00:00.000Z")),
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(path.join(eventsDir, "2026-09.jsonl"), "not-json\n", "utf8");

    const metadata = await store.rebuildMetadata();

    expect((await store.read()).map((item) => item.id)).toEqual(["duplicate", "moved", "august"]);
    expect(await readdir(eventsDir)).toEqual(["2026-07.jsonl", "2026-08.jsonl"]);
    expect(metadata.partitions).toEqual({
      "2026-07": {
        eventCount: 1,
        firstAt: "2026-07-10T00:00:00.000Z",
        lastAt: "2026-07-10T00:00:00.000Z",
      },
      "2026-08": {
        eventCount: 2,
        firstAt: "2026-08-02T00:00:00.000Z",
        lastAt: "2026-08-03T00:00:00.000Z",
      },
    });
  });

  it("prefers a canonical repair record over a conflicting misplaced copy", async () => {
    const eventsDir = path.join(rootDir, "events");
    await mkdir(eventsDir, { recursive: true });
    const canonical = event("collision", "2026-07-10T00:00:00.000Z", {
      inputTokens: 999,
      costUSD: 9.99,
    });
    const stale = event("collision", "2026-07-10T00:00:00.000Z", {
      inputTokens: 10,
      costUSD: 0.1,
    });
    await writeFile(path.join(eventsDir, "2026-07.jsonl"), `${JSON.stringify(canonical)}\n`, "utf8");
    await writeFile(path.join(eventsDir, "2026-08.jsonl"), `${JSON.stringify(stale)}\n`, "utf8");

    await store.rebuildMetadata();

    expect(await store.read()).toEqual([canonical]);
    expect(await readdir(eventsDir)).toEqual(["2026-07.jsonl"]);
  });

  it("does not delete a newer transaction marker", async () => {
    const newerTransactionId = "00000000-0000-4000-8000-000000000002";
    let replaceMarker = true;
    const replacingFs = {
      ...nodeFs,
      async readFile(file: PathLike | FileHandle, options?: unknown) {
        if (replaceMarker && String(file).endsWith("pending-store-transaction.json")) {
          replaceMarker = false;
          await nodeFs.writeFile(file, `${JSON.stringify({
            schemaVersion: 1,
            transactionId: newerTransactionId,
            entries: [],
            remove: [],
          })}\n`, "utf8");
        }
        return nodeFs.readFile(file, options as Parameters<typeof nodeFs.readFile>[1]);
      },
    };

    await new PortableUsageStore(rootDir, replacingFs).upsert([
      event("marker", "2026-07-01T00:00:00.000Z"),
    ]);

    const marker = JSON.parse(await readFile(path.join(rootDir, "pending-store-transaction.json"), "utf8"));
    expect(marker.transactionId).toBe(newerTransactionId);
  });

  it.each([
    ["escaping target", {
      entries: [{ target: "../escape.jsonl", temporary: "../escape.tmp", sha256: "0".repeat(64) }],
      remove: [],
    }],
    ["non-sibling temp", {
      entries: [{
        target: "store-metadata.json",
        temporary: path.join("events", "2026-07.jsonl.1.1.00000000-0000-4000-8000-000000000001.tmp"),
        sha256: "0".repeat(64),
      }],
      remove: [],
    }],
    ["duplicate targets", {
      entries: [
        {
          target: path.join("events", "2026-07.jsonl"),
          temporary: path.join("events", "2026-07.jsonl.1.1.00000000-0000-4000-8000-000000000001.tmp"),
          sha256: "0".repeat(64),
        },
        {
          target: path.join("events", "2026-07.jsonl"),
          temporary: path.join("events", "2026-07.jsonl.1.1.00000000-0000-4000-8000-000000000002.tmp"),
          sha256: "0".repeat(64),
        },
      ],
      remove: [],
    }],
    ["overlapping write and removal", {
      entries: [{
        target: path.join("events", "2026-07.jsonl"),
        temporary: path.join("events", "2026-07.jsonl.1.1.00000000-0000-4000-8000-000000000001.tmp"),
        sha256: "0".repeat(64),
      }],
      remove: [path.join("events", "2026-07.jsonl")],
    }],
    ["non-canonical target spelling", {
      entries: [{
        target: `events${path.sep}..${path.sep}store-metadata.json`,
        temporary: `events${path.sep}..${path.sep}store-metadata.json.1.1.00000000-0000-4000-8000-000000000001.tmp`,
        sha256: "0".repeat(64),
      }],
      remove: [],
    }],
    ["duplicate removals", {
      entries: [],
      remove: [path.join("events", "2026-07.jsonl"), path.join("events", "2026-07.jsonl")],
    }],
  ])("rejects a corrupt pending marker with %s without mutating data", async (_case, marker) => {
    const eventsDir = path.join(rootDir, "events");
    await mkdir(eventsDir, { recursive: true });
    const target = path.join(eventsDir, "2026-07.jsonl");
    const original = `${JSON.stringify(event("safe", "2026-07-01T00:00:00.000Z"))}\n`;
    await writeFile(target, original, "utf8");
    await writeFile(path.join(rootDir, "pending-store-transaction.json"), `${JSON.stringify({
      schemaVersion: 1,
      transactionId: "00000000-0000-4000-8000-000000000001",
      ...marker,
    })}\n`, "utf8");

    await expect(store.read()).rejects.toThrow("Invalid pending portable store transaction");
    await expect(readFile(target, "utf8")).resolves.toBe(original);
  });

  it("recovers a transaction interrupted after its first partition commit", async () => {
    let failed = false;
    const failingFs = {
      ...nodeFs,
      async rename(from: PathLike, to: PathLike) {
        if (!failed && String(to).endsWith(path.join("events", "2026-08.jsonl"))) {
          failed = true;
          throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
        }
        return nodeFs.rename(from, to);
      },
    };
    const interrupted = new PortableUsageStore(rootDir, failingFs);

    await expect(interrupted.upsert([
      event("july", "2026-07-01T00:00:00.000Z"),
      event("august", "2026-08-01T00:00:00.000Z"),
    ])).rejects.toThrow("injected rename failure");

    const recovered = new PortableUsageStore(rootDir);
    expect((await recovered.read()).map((item) => item.id)).toEqual(["july", "august"]);
    const metadata = JSON.parse(await readFile(path.join(rootDir, "store-metadata.json"), "utf8"));
    expect(metadata.partitions["2026-07"].eventCount).toBe(1);
    expect(metadata.partitions["2026-08"].eventCount).toBe(1);
    expect(await readdir(rootDir)).not.toContain("pending-store-transaction.json");
  });

  it("does not change partitions when metadata staging fails", async () => {
    await store.upsert([event("original", "2026-07-01T00:00:00.000Z")]);
    const originalPartition = await readFile(path.join(rootDir, "events", "2026-07.jsonl"), "utf8");
    const failingFs = {
      ...nodeFs,
      async writeFile(file: PathLike | FileHandle, data: string | Uint8Array, options?: unknown) {
        if (String(file).includes("store-metadata.json.") && String(file).endsWith(".tmp")) {
          await nodeFs.writeFile(file, "partial", "utf8");
          throw Object.assign(new Error("injected metadata stage failure"), { code: "EIO" });
        }
        return nodeFs.writeFile(file, data, options as Parameters<typeof nodeFs.writeFile>[2]);
      },
    };

    await expect(
      new PortableUsageStore(rootDir, failingFs).upsert([event("new", "2026-07-02T00:00:00.000Z")]),
    ).rejects.toThrow("injected metadata stage failure");

    expect(await readFile(path.join(rootDir, "events", "2026-07.jsonl"), "utf8")).toBe(originalPartition);
    expect((await store.read()).map((item) => item.id)).toEqual(["original"]);
    expect((await readdir(rootDir)).filter((name) => name.includes("pending-store-transaction"))).toEqual([]);
    expect((await readdir(rootDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await readdir(path.join(rootDir, "events"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("retries bounded Windows rename access errors", async () => {
    let attempts = 0;
    const retryingFs = {
      ...nodeFs,
      async rename(from: PathLike, to: PathLike) {
        if (String(to).endsWith(path.join("events", "2026-07.jsonl")) && attempts++ < 2) {
          throw Object.assign(new Error("injected access error"), { code: "EPERM" });
        }
        return nodeFs.rename(from, to);
      },
    };

    await new PortableUsageStore(rootDir, retryingFs).upsert([
      event("retry", "2026-07-01T00:00:00.000Z"),
    ]);

    expect(attempts).toBe(3);
    expect((await store.read()).map((item) => item.id)).toEqual(["retry"]);
  });

  it("removes only recognized stale store temp files during rebuild", async () => {
    const eventsDir = path.join(rootDir, "events");
    await mkdir(eventsDir, { recursive: true });
    const recognized = path.join(
      eventsDir,
      "2026-07.jsonl.123.1000000000000.00000000-0000-4000-8000-000000000000.tmp",
    );
    const unrelated = path.join(eventsDir, "unrelated.tmp");
    await writeFile(recognized, "stale", "utf8");
    await writeFile(unrelated, "keep", "utf8");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(recognized, old, old);
    await utimes(unrelated, old, old);

    await store.rebuildMetadata();

    await expect(readFile(recognized, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
  });

  it("reads each historical partition once during upsert", async () => {
    await store.upsert([
      event("july", "2026-07-01T00:00:00.000Z"),
      event("august", "2026-08-01T00:00:00.000Z"),
    ]);
    const partitionReads = new Map<string, number>();
    const countingFs = {
      ...nodeFs,
      async readFile(file: PathLike | FileHandle, options?: unknown) {
        const name = path.basename(String(file));
        if (name === "2026-07.jsonl" || name === "2026-08.jsonl") {
          partitionReads.set(name, (partitionReads.get(name) ?? 0) + 1);
        }
        return nodeFs.readFile(file, options as Parameters<typeof nodeFs.readFile>[1]);
      },
    };

    await new PortableUsageStore(rootDir, countingFs).upsert([
      event("september", "2026-09-01T00:00:00.000Z"),
    ]);

    expect(Object.fromEntries(partitionReads)).toEqual({ "2026-07.jsonl": 1, "2026-08.jsonl": 1 });
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

function runStoreChild(
  vitestCli: string,
  childFile: string,
  childRoot: string,
  childId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, "run", childFile, "--maxWorkers=1"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        QUOTABAR_PORTABLE_CHILD_ROOT: childRoot,
        QUOTABAR_PORTABLE_CHILD_ID: childId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Portable store child exited with code ${code}: ${output}`));
    });
  });
}

async function waitForPaths(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const present = await Promise.all(paths.map(async (filePath) => {
      try {
        await nodeFs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }));
    if (present.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for portable store child processes");
}
