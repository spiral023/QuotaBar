import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTokenEvent, CodexSourceFileRef } from "../src/pricing/codex-log-reader";
import type { ClaudeUsageEntry, SourceFileRef } from "../src/pricing/jsonl-reader";
import { ingestPortableUsage } from "../src/portable/ingestion";
import { PortableUsageStore } from "../src/portable/usageStore";

function claude(overrides: Partial<ClaudeUsageEntry> = {}): ClaudeUsageEntry {
  return {
    provider: "claude",
    timestamp: "2026-07-13T10:00:00.000Z",
    model: "claude-sonnet-4-6",
    project: "QuotaBar",
    projectName: "QuotaBar",
    session: "raw-claude-session",
    sourceEventId: "claude-source-event",
    inputTokens: 11,
    outputTokens: 12,
    cacheCreationTokens: 13,
    cacheReadTokens: 14,
    costUSD: 0.42,
    ...overrides,
  };
}

function codex(overrides: Partial<CodexTokenEvent> = {}): CodexTokenEvent {
  return {
    timestamp: "2026-07-13T11:00:00.000Z",
    model: "gpt-5.2-codex",
    isFallback: false,
    session: "raw-codex-session",
    sourceEventId: "codex-source-event",
    directory: "QuotaBar",
    projectName: "QuotaBar",
    inputTokens: 21,
    cachedInputTokens: 5,
    outputTokens: 8,
    reasoningOutputTokens: 2,
    totalTokens: 29,
    ...overrides,
  };
}

describe("portable usage ingestion", () => {
  let rootDir: string;
  let statePath: string;
  let store: PortableUsageStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-portable-ingest-"));
    statePath = path.join(rootDir, "ingest-state.json");
    store = new PortableUsageStore(path.join(rootDir, "store"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("inserts a new source once and skips its reader while the fingerprint is unchanged", async () => {
    const ref = await claudeRef(rootDir, "claude.jsonl", "fixture");
    const readClaude = vi.fn(async () => [claude()]);
    const options = { store, statePath, claudeRefs: [ref], codexRefs: [], readClaude };

    expect(await ingestPortableUsage(options)).toMatchObject({
      scanned: 1,
      changed: 1,
      inserted: 1,
      updated: 0,
      existing: 0,
      errors: [],
    });
    expect(await ingestPortableUsage(options)).toMatchObject({
      scanned: 1,
      changed: 0,
      inserted: 0,
      updated: 0,
      existing: 0,
      errors: [],
    });
    expect(readClaude).toHaveBeenCalledTimes(1);
    expect(await store.read()).toHaveLength(1);
  });

  it("reprocesses only a changed source, updates corrected IDs, and appends new IDs", async () => {
    const firstRef = await claudeRef(rootDir, "a.jsonl", "a");
    const unchangedRef = await claudeRef(rootDir, "b.jsonl", "b");
    const readClaude = vi.fn(async ([ref]: SourceFileRef[]) => ref.file === firstRef.file
      ? [claude()]
      : [claude({ sourceEventId: undefined, session: "source-less", timestamp: "2026-07-13T12:00:00.000Z" })]);
    const options = { store, statePath, claudeRefs: [unchangedRef, firstRef], codexRefs: [], readClaude };
    await ingestPortableUsage(options);
    readClaude.mockClear();

    await writeFile(firstRef.file, "changed-size", "utf8");
    readClaude.mockImplementation(async ([ref]: SourceFileRef[]) => ref.file === firstRef.file
      ? [
          claude({ inputTokens: 999, costUSD: 4.2 }),
          claude({ sourceEventId: "new-source-event", timestamp: "2026-07-14T10:00:00.000Z" }),
        ]
      : [claude({ sourceEventId: undefined, session: "source-less", timestamp: "2026-07-13T12:00:00.000Z" })]);

    expect(await ingestPortableUsage(options)).toMatchObject({
      scanned: 2,
      changed: 1,
      inserted: 1,
      updated: 1,
      existing: 0,
      errors: [],
    });
    expect(readClaude).toHaveBeenCalledTimes(1);
    expect(readClaude.mock.calls[0][0][0].file).toBe(firstRef.file);
    const stored = await store.read();
    expect(stored).toHaveLength(3);
    expect(stored.find(({ inputTokens }) => inputTokens === 999)?.costUSD).toBe(4.2);
  });

  it("keeps historical events and marks state inactive when a previous source disappears", async () => {
    const ref = await claudeRef(rootDir, "removed.jsonl", "fixture");
    await ingestPortableUsage({
      store,
      statePath,
      claudeRefs: [ref],
      codexRefs: [],
      readClaude: async () => [claude()],
    });

    const result = await ingestPortableUsage({ store, statePath, claudeRefs: [], codexRefs: [] });
    const state = JSON.parse(await readFile(statePath, "utf8")) as { sources: Record<string, { active: boolean }> };
    expect(result).toMatchObject({ scanned: 0, changed: 0, inserted: 0, updated: 0, existing: 0, errors: [] });
    expect(await store.read()).toHaveLength(1);
    expect(Object.values(state.sources)).toEqual([expect.objectContaining({ active: false })]);
  });

  it("isolates corrupt sources, retries them, and never exposes thrown secrets", async () => {
    const corrupt = await claudeRef(rootDir, "a-corrupt.jsonl", "corrupt");
    const valid = await codexRef(rootDir, "b-valid.jsonl", "valid");
    const secret = "Bearer secret-token cookie=secret-cookie eyJhbGciOiJIUzI1NiJ9";
    const readClaude = vi.fn(async () => { throw new Error(`${secret} event={inputTokens:999}`); });
    const readCodex = vi.fn(async () => [codex()]);
    const options = {
      store,
      statePath,
      claudeRefs: [corrupt],
      codexRefs: [valid],
      readClaude,
      readCodex,
    };

    const first = await ingestPortableUsage(options);
    const second = await ingestPortableUsage(options);
    const serialized = JSON.stringify([first, second]);
    const stateText = await readFile(statePath, "utf8");
    expect(first).toMatchObject({ scanned: 2, changed: 2, inserted: 1, updated: 0, existing: 0 });
    expect(first.errors).toEqual([{ provider: "claude", path: corrupt.file, message: "Source could not be read." }]);
    expect(second).toMatchObject({ scanned: 2, changed: 1, inserted: 0, updated: 0, existing: 0 });
    expect(readClaude).toHaveBeenCalledTimes(2);
    expect(readCodex).toHaveBeenCalledTimes(1);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("inputTokens");
    expect(stateText).not.toContain(path.basename(corrupt.file));
    expect(stateText).not.toContain(secret);
  });

  it("does not alter the old state bytes when store reconciliation fails", async () => {
    const ref = await claudeRef(rootDir, "source.jsonl", "first");
    const options = { store, statePath, claudeRefs: [ref], codexRefs: [], readClaude: async () => [claude()] };
    await ingestPortableUsage(options);
    const oldState = await readFile(statePath);
    await writeFile(ref.file, "changed", "utf8");
    const failingStore = {
      async reconcile(): Promise<never> {
        throw new Error("database failure secret-payload");
      },
    };

    await expect(ingestPortableUsage({ ...options, store: failingStore })).rejects.toThrow("database failure secret-payload");
    expect(await readFile(statePath)).toEqual(oldState);
  });

  it("serializes concurrent calls for the same canonical state path", async () => {
    const ref = await claudeRef(rootDir, "source.jsonl", "fixture");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const readerStarted = new Promise<void>((resolve) => { started = resolve; });
    const readClaude = vi.fn(async () => {
      started();
      await blocked;
      return [claude()];
    });
    const options = { store, statePath, claudeRefs: [ref], codexRefs: [], readClaude };

    const first = ingestPortableUsage(options);
    await readerStarted;
    const second = ingestPortableUsage({ ...options, statePath: path.join(path.dirname(statePath), ".", path.basename(statePath)) });
    release();
    const results = await Promise.all([first, second]);

    expect(results.map(({ scanned, changed, inserted }) => ({ scanned, changed, inserted }))).toEqual([
      { scanned: 1, changed: 1, inserted: 1 },
      { scanned: 1, changed: 0, inserted: 0 },
    ]);
    expect(readClaude).toHaveBeenCalledTimes(1);
    expect(await store.read()).toHaveLength(1);
  });

  it("writes only fingerprint and non-secret identity metadata to version 1 state", async () => {
    const ref = await claudeRef(rootDir, "state.jsonl", "provider-event-body-secret");
    await ingestPortableUsage({
      store,
      statePath,
      claudeRefs: [ref],
      codexRefs: [],
      readClaude: async () => [claude({ session: "session-secret", project: "project-secret", inputTokens: 123456 })],
    });

    const stateText = await readFile(statePath, "utf8");
    const state = JSON.parse(stateText) as {
      schemaVersion: number;
      sources: Record<string, Record<string, unknown>>;
    };
    const source = Object.values(state.sources)[0];
    expect(state.schemaVersion).toBe(1);
    expect(source).toMatchObject({ provider: "claude", path: ref.file, active: true, size: 26 });
    expect(source.eventIds).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(Object.keys(source).sort()).toEqual(["active", "eventIds", "mtimeMs", "path", "processedAt", "provider", "size"]);
    expect(stateText).not.toMatch(/provider-event-body-secret|session-secret|project-secret|123456|inputTokens/);
    expect((await readdir(rootDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

async function claudeRef(rootDir: string, name: string, contents: string): Promise<SourceFileRef> {
  const file = path.join(rootDir, name);
  await writeFile(file, contents, "utf8");
  return { file, baseDir: rootDir };
}

async function codexRef(rootDir: string, name: string, contents: string): Promise<CodexSourceFileRef> {
  const file = path.join(rootDir, name);
  await writeFile(file, contents, "utf8");
  return { file, baseDir: rootDir };
}
