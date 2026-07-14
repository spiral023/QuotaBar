import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PathLike } from "node:fs";
import * as nodeFs from "node:fs/promises";
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
    store = new PortableUsageStore(rootDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("rejects a non-canonical state path before reading sources or mutating either location", async () => {
    const ref = await claudeRef(rootDir, "mismatch-source.jsonl", "fixture");
    const externalStatePath = path.join(rootDir, "external", "ingest-state.json");
    const readClaude = vi.fn(async () => [claude()]);
    const statSource = vi.fn(async () => ({ isFile: true, size: "7", mtimeNs: "1", ctimeNs: "2" }));

    let thrown: unknown;
    try {
      await ingestPortableUsage({
        store, statePath: externalStatePath, claudeRefs: [ref], codexRefs: [], readClaude, statSource,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Portable ingest state path must match the store root");
    expect(statSource).not.toHaveBeenCalled();
    expect(readClaude).not.toHaveBeenCalled();
    await expect(readdir(path.dirname(externalStatePath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(externalStatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(rootDir, "store-metadata.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

  it("repairs already ingested cost-less events once without changing their IDs", async () => {
    const ref = await claudeRef(rootDir, "cost-repair.jsonl", "fixture");
    const raw = claude({ costUSD: undefined });
    const readClaude = vi.fn(async () => [raw]);
    const base = { store, statePath, claudeRefs: [ref], codexRefs: [], readClaude };
    await ingestPortableUsage(base);
    const [before] = await store.read();
    readClaude.mockClear();
    const enrichCosts = vi.fn(async (events: readonly import("../src/portable/types").PortableUsageEvent[]) =>
      events.map((event) => ({
        ...event,
        costUSD: 1.25,
        inputCostUSD: 0.25,
        outputCostUSD: 1,
        cacheCreationCostUSD: 0,
        cacheReadCostUSD: 0,
        pricingVersion: "litellm:test",
      })));

    const repaired = await ingestPortableUsage({ ...base, enrichCosts });
    const [after] = await store.read();

    expect(repaired).toMatchObject({ changed: 0, inserted: 0, updated: 1 });
    expect(readClaude).not.toHaveBeenCalled();
    expect(enrichCosts).toHaveBeenCalledOnce();
    expect(after).toMatchObject({ id: before.id, costUSD: 1.25, pricingVersion: "litellm:test" });

    readClaude.mockClear();
    enrichCosts.mockClear();
    expect(await ingestPortableUsage({ ...base, enrichCosts })).toMatchObject({ changed: 0, updated: 0 });
    expect(readClaude).not.toHaveBeenCalled();
    expect(enrichCosts).not.toHaveBeenCalled();
  });

  it("keeps unresolved existing events retryable until every provider event has complete costs", async () => {
    const ref = await claudeRef(rootDir, "unknown-existing.jsonl", "fixture");
    const readClaude = vi.fn(async () => [claude({ costUSD: undefined })]);
    const base = { store, statePath, claudeRefs: [ref], codexRefs: [], readClaude };
    await ingestPortableUsage(base);
    const enrichCosts = vi.fn(async (events: readonly import("../src/portable/types").PortableUsageEvent[]) => events);

    await ingestPortableUsage({ ...base, enrichCosts });
    await ingestPortableUsage({ ...base, enrichCosts });

    expect(enrichCosts).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(statePath, "utf8"))).not.toHaveProperty("costEnrichmentVersion");
  });

  it("does not mark repair complete when enrichment drops an existing provider event", async () => {
    const ref = await claudeRef(rootDir, "dropped-existing.jsonl", "fixture");
    const base = {
      store, statePath, claudeRefs: [ref], codexRefs: [],
      readClaude: async () => [claude({ costUSD: undefined })],
    };
    await ingestPortableUsage(base);

    await ingestPortableUsage({ ...base, enrichCosts: async () => [] });

    expect(JSON.parse(await readFile(statePath, "utf8"))).not.toHaveProperty("costEnrichmentVersion");
    expect(await store.read()).toHaveLength(1);
  });

  it("invalidates the repair marker and retries an unresolved source added later", async () => {
    const known = await claudeRef(rootDir, "known.jsonl", "known");
    const added = await claudeRef(rootDir, "added.jsonl", "added");
    const readClaude = vi.fn(async ([ref]: SourceFileRef[]) => [claude({
      sourceEventId: ref.file === known.file ? "known" : "added",
      model: ref.file === known.file ? "known-model" : "unknown-model",
      costUSD: undefined,
    })]);
    const enrichCosts = vi.fn(async (events: readonly import("../src/portable/types").PortableUsageEvent[]) =>
      events.map((item) => item.model === "unknown-model" ? item : {
        ...item,
        costUSD: 1,
        inputCostUSD: 1,
        outputCostUSD: 0,
        cacheCreationCostUSD: 0,
        cacheReadCostUSD: 0,
        pricingVersion: "litellm:test",
      }));

    await ingestPortableUsage({ store, statePath, claudeRefs: [known], codexRefs: [], readClaude, enrichCosts });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toHaveProperty("costEnrichmentVersion", 1);

    await ingestPortableUsage({ store, statePath, claudeRefs: [known, added], codexRefs: [], readClaude, enrichCosts });
    expect(JSON.parse(await readFile(statePath, "utf8"))).not.toHaveProperty("costEnrichmentVersion");
    readClaude.mockClear();
    await ingestPortableUsage({ store, statePath, claudeRefs: [known, added], codexRefs: [], readClaude, enrichCosts });
    expect(readClaude.mock.calls.some(([refs]) => refs[0].file === added.file)).toBe(true);
  });

  it("fails closed without modifying a future cost enrichment state", async () => {
    const future = `${JSON.stringify({ schemaVersion: 1, costEnrichmentVersion: 2, sources: {} }, null, 2)}\n`;
    await writeFile(statePath, future, "utf8");
    const recoverPending = vi.fn(async () => undefined);
    const futureStore = {
      getIngestStatePath: () => statePath,
      recoverPending,
      read: () => store.read(),
      reconcileWithIngestState: vi.fn(async () => ({ inserted: 0, updated: 0, existing: 0 })),
    };
    const readClaude = vi.fn(async () => [claude()]);
    const enrichCosts = vi.fn(async (events) => events);

    await expect(ingestPortableUsage({
      store: futureStore, statePath, claudeRefs: [], codexRefs: [], readClaude, enrichCosts,
    })).rejects.toThrow("Portable cost enrichment version is newer than supported");

    expect(await readFile(statePath, "utf8")).toBe(future);
    expect(readClaude).not.toHaveBeenCalled();
    expect(enrichCosts).not.toHaveBeenCalled();
    expect(recoverPending).not.toHaveBeenCalled();
    expect(await store.read()).toEqual([]);
  });

  it("rejects cost enrichment when the store cannot read existing events", async () => {
    const unreadableStore = {
      getIngestStatePath: () => statePath,
      recoverPending: vi.fn(async () => undefined),
      reconcileWithIngestState: vi.fn(async () => ({ inserted: 0, updated: 0, existing: 0 })),
    };
    const enrichCosts = vi.fn(async (events) => events);

    await expect(ingestPortableUsage({
      store: unreadableStore, statePath, claudeRefs: [], codexRefs: [], enrichCosts,
    })).rejects.toThrow("Portable cost enrichment requires a readable store");
    expect(unreadableStore.recoverPending).not.toHaveBeenCalled();
    expect(unreadableStore.reconcileWithIngestState).not.toHaveBeenCalled();
  });

  it("retries cost enrichment failures without committing the repair marker", async () => {
    const ref = await claudeRef(rootDir, "cost-retry.jsonl", "fixture");
    const readClaude = vi.fn(async () => [claude({ costUSD: undefined })]);
    const enrichCosts = vi.fn()
      .mockRejectedValueOnce(new Error("Bearer private-pricing-error"))
      .mockImplementation(async (events) => events);
    const options = { store, statePath, claudeRefs: [ref], codexRefs: [], readClaude, enrichCosts };

    const failed = await ingestPortableUsage(options);
    const retried = await ingestPortableUsage(options);

    expect(failed.errors).toEqual([{ provider: "claude", path: ref.file, message: "cost_failed" }]);
    expect(JSON.stringify(failed)).not.toContain("private-pricing-error");
    expect(retried).toMatchObject({ changed: 1, inserted: 1, errors: [] });
    expect(readClaude).toHaveBeenCalledTimes(2);
  });

  it("commits successfully enriched sources while leaving a failed source retryable", async () => {
    const failedRef = await claudeRef(rootDir, "a-cost-failed.jsonl", "failed");
    const validRef = await claudeRef(rootDir, "b-cost-valid.jsonl", "valid");
    const readClaude = async ([ref]: SourceFileRef[]) => [claude({
      sourceEventId: ref.file === failedRef.file ? "failed-cost" : "valid-cost",
      model: ref.file === failedRef.file ? "failed-model" : "valid-model",
      costUSD: undefined,
    })];
    const enrichCosts = async (events: readonly import("../src/portable/types").PortableUsageEvent[]) => {
      if (events[0]?.model === "failed-model") throw new Error("private pricing failure");
      return events.map((event) => ({
        ...event,
        costUSD: 1,
        inputCostUSD: 1,
        outputCostUSD: 0,
        cacheCreationCostUSD: 0,
        cacheReadCostUSD: 0,
        pricingVersion: "litellm:test",
      }));
    };

    const result = await ingestPortableUsage({
      store, statePath, claudeRefs: [failedRef, validRef], codexRefs: [], readClaude, enrichCosts,
    });

    expect(result).toMatchObject({ inserted: 1 });
    expect(result.errors).toEqual([{ provider: "claude", path: failedRef.file, message: "cost_failed" }]);
    expect(await store.read()).toHaveLength(1);
    expect(JSON.parse(await readFile(statePath, "utf8"))).not.toHaveProperty("costEnrichmentVersion");
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
    expect(first.errors).toEqual([{ provider: "claude", path: corrupt.file, message: "read_failed" }]);
    expect(second).toMatchObject({ scanned: 2, changed: 1, inserted: 0, updated: 0, existing: 0 });
    expect(readClaude).toHaveBeenCalledTimes(2);
    expect(readCodex).toHaveBeenCalledTimes(1);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("inputTokens");
    expect(stateText).not.toContain(path.basename(corrupt.file));
    expect(stateText).not.toContain(secret);
  });

  it("sanitizes store reconciliation failures without altering the old state bytes", async () => {
    const ref = await claudeRef(rootDir, "source.jsonl", "first");
    const options = { store, statePath, claudeRefs: [ref], codexRefs: [], readClaude: async () => [claude()] };
    await ingestPortableUsage(options);
    const oldState = await readFile(statePath);
    await writeFile(ref.file, "changed", "utf8");
    const failingStore = {
      getIngestStatePath: () => statePath,
      recoverPending: async () => undefined,
      async reconcileWithIngestState(): Promise<never> {
        throw new Error("database failure secret-payload token=abc auth=def cookie=ghi JWT=Bearer.value");
      },
    };

    let thrown: unknown;
    try {
      await ingestPortableUsage({ ...options, store: failingStore });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Portable usage reconciliation failed");
    expect(thrown).not.toHaveProperty("cause");
    const serialized = JSON.stringify({
      message: (thrown as Error).message,
      cause: (thrown as Error & { cause?: unknown }).cause,
      value: String(thrown),
    }).toLowerCase();
    for (const sensitive of ["database failure", "secret", "token", "auth", "cookie", "jwt", "bearer"]) {
      expect(serialized).not.toContain(sensitive);
    }
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
    expect(source).toMatchObject({ provider: "claude", path: ref.file, active: true, size: "26" });
    expect(source.eventIds).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(source.mtimeNs).toMatch(/^\d+$/);
    expect(source.ctimeNs).toMatch(/^\d+$/);
    expect(Object.keys(source).sort()).toEqual(["active", "ctimeNs", "eventIds", "mtimeNs", "path", "processedAt", "provider", "size"]);
    expect(stateText).not.toMatch(/provider-event-body-secret|session-secret|project-secret|123456|inputTokens/);
    expect((await readdir(rootDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("deduplicates source event ownership IDs before handing state to the store", async () => {
    const ref = await claudeRef(rootDir, "duplicate-ownership.jsonl", "fixture");
    let capturedState: { sources: Record<string, { eventIds?: string[] }> } | undefined;
    const capturingStore = {
      getIngestStatePath: () => statePath,
      recoverPending: async () => undefined,
      async reconcileWithIngestState(_events: unknown, state: unknown) {
        capturedState = state as typeof capturedState;
        return { inserted: 0, updated: 0, existing: 0 };
      },
    };

    await ingestPortableUsage({
      store: capturingStore,
      statePath,
      claudeRefs: [ref],
      codexRefs: [],
      readClaude: async () => [claude(), claude()],
    });

    expect(Object.values(capturedState?.sources ?? {})[0].eventIds).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });

  it("uses lossless stat fingerprints and detects a same-size high-resolution rewrite", async () => {
    const ref = await claudeRef(rootDir, "precise.jsonl", "same");
    let ctimeNs = "1000000001";
    const statSource = vi.fn(async () => ({ isFile: true, size: "4", mtimeNs: "1000000000", ctimeNs }));
    const readClaude = vi.fn(async () => [claude()]);
    const options = { store, statePath, claudeRefs: [ref], codexRefs: [], readClaude, statSource };

    await ingestPortableUsage(options);
    await ingestPortableUsage(options);
    ctimeNs = "1000000002";
    const changed = await ingestPortableUsage(options);

    expect(readClaude).toHaveBeenCalledTimes(2);
    expect(changed.changed).toBe(1);
    expect(changed.existing).toBe(1);
  });

  it("quarantines malformed state and reingests with a safe recovery diagnostic", async () => {
    const ref = await claudeRef(rootDir, "recovered.jsonl", "fixture");
    await writeFile(statePath, "{secret-token malformed", "utf8");

    const result = await ingestPortableUsage({
      store,
      statePath,
      claudeRefs: [ref],
      codexRefs: [],
      readClaude: async () => [claude()],
    });

    expect(result.diagnostics).toEqual([{ code: "state_recovered", path: statePath }]);
    const quarantined = (await readdir(rootDir)).filter((name) => /^ingest-state\.corrupt\.\d+\.json$/.test(name));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(rootDir, quarantined[0]), "utf8")).toBe("{secret-token malformed");
    expect(await store.read()).toHaveLength(1);
  });

  it("quarantines a version 1 state record with invalid current field types", async () => {
    const ref = await claudeRef(rootDir, "invalid-state.jsonl", "fixture");
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      sources: {
        bad: {
          provider: "claude",
          path: ref.file,
          size: 7,
          mtimeNs: "1",
          ctimeNs: "2",
          processedAt: "2026-07-01T00:00:00.000Z",
          eventIds: [],
          active: true,
        },
      },
    })}\n`, "utf8");

    const result = await ingestPortableUsage({
      store, statePath, claudeRefs: [ref], codexRefs: [], readClaude: async () => [claude()],
    });

    expect(result.diagnostics).toEqual([{ code: "state_recovered", path: statePath }]);
    expect((await readdir(rootDir)).some((name) => /^ingest-state\.corrupt\.\d+\.json$/.test(name))).toBe(true);
  });

  it("quarantines unknown top-level state fields and rewrites an empty canonical state without source activity", async () => {
    const unsafe = JSON.stringify({
      schemaVersion: 1,
      sources: {},
      rawSessionToken: "must-not-remain",
    });
    await writeFile(statePath, unsafe, "utf8");

    const result = await ingestPortableUsage({ store, statePath, claudeRefs: [], codexRefs: [] });

    expect(result.diagnostics).toEqual([{ code: "state_recovered", path: statePath }]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ schemaVersion: 1, sources: {} });
    const quarantined = (await readdir(rootDir)).filter((name) => /^ingest-state\.corrupt\.\d+\.json$/.test(name));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(rootDir, quarantined[0]), "utf8")).toBe(unsafe);
  });

  it("quarantines an unknown source field instead of retaining the record", async () => {
    const sourcePath = path.join(rootDir, "unknown-field.jsonl");
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      sources: {
        bad: {
          provider: "claude",
          path: sourcePath,
          size: "7",
          mtimeNs: "1",
          ctimeNs: "2",
          processedAt: "2026-07-01T00:00:00.000Z",
          eventIds: [],
          active: true,
          authorization: "must-not-remain",
        },
      },
    })}\n`, "utf8");

    const result = await ingestPortableUsage({ store, statePath, claudeRefs: [], codexRefs: [] });

    expect(result.diagnostics).toEqual([{ code: "state_recovered", path: statePath }]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ schemaVersion: 1, sources: {} });
  });

  it("retains only the newest three exact corrupt-state files and preserves unrelated entries", async () => {
    const oldNames = [
      "ingest-state.corrupt.1000000000001.json",
      "ingest-state.corrupt.1000000000002.json",
      "ingest-state.corrupt.1000000000003.json",
      "ingest-state.corrupt.1000000000004.json",
    ];
    for (const name of oldNames) await writeFile(path.join(rootDir, name), "old", "utf8");
    const matchingDirectory = "ingest-state.corrupt.9999999999999.json";
    const unrelated = "ingest-state.corrupt.1000000000000.json.backup";
    await mkdir(path.join(rootDir, matchingDirectory));
    await writeFile(path.join(rootDir, unrelated), "keep", "utf8");
    await writeFile(statePath, "{malformed", "utf8");

    await ingestPortableUsage({ store, statePath, claudeRefs: [], codexRefs: [] });

    const entries = await readdir(rootDir, { withFileTypes: true });
    const quarantines = entries
      .filter((entry) => entry.isFile() && /^ingest-state\.corrupt\.\d{13}\.json$/.test(entry.name))
      .map(({ name }) => name)
      .sort();
    expect(quarantines).toHaveLength(3);
    expect(quarantines).not.toContain(oldNames[0]);
    expect(quarantines).not.toContain(oldNames[1]);
    expect(entries.find(({ name }) => name === matchingDirectory)?.isDirectory()).toBe(true);
    expect(await readFile(path.join(rootDir, unrelated), "utf8")).toBe("keep");
  });

  it("continues strict listing across known directories and reports a safe category", async () => {
    const missing = path.join(rootDir, "missing-projects");
    const projects = path.join(rootDir, "available-projects");
    await claudeRef(projects, "session.jsonl", JSON.stringify({
      timestamp: "2026-07-13T10:00:00.000Z",
      message: { id: "listed-event", model: "claude-sonnet-4-6", usage: { input_tokens: 7, output_tokens: 3 } },
    }));

    const result = await ingestPortableUsage({
      store, statePath, claudeProjectsDirs: [missing, projects], codexRefs: [],
    });

    expect(result.inserted).toBe(1);
    expect(result.errors).toEqual([{ provider: "claude", path: missing, message: "listing_failed" }]);
  });

  it("preserves an unavailable directory's winning ownership through listing failure and recovery", async () => {
    const contenderDir = path.join(rootDir, "a-contender");
    const winnerDir = path.join(rootDir, "z-winner");
    const backupDir = path.join(rootDir, "winner-backup");
    const contender = await claudeRef(contenderDir, "session.jsonl", "contender");
    const winner = await claudeRef(winnerDir, "session.jsonl", "winner");
    let contenderTokens = 1;
    const readClaude = vi.fn(async ([ref]: SourceFileRef[]) => [claude({
      sourceEventId: "shared-listing-owner",
      inputTokens: ref.file === winner.file ? 9 : contenderTokens,
    })]);
    const options = {
      store,
      statePath,
      claudeProjectsDirs: [contenderDir, winnerDir],
      codexRefs: [],
      readClaude,
    };

    await ingestPortableUsage(options);
    await rename(winnerDir, backupDir);
    contenderTokens = 2;
    await writeFile(contender.file, "contender-changed", "utf8");
    const unavailable = await ingestPortableUsage(options);
    const winnerDuringFailure = (await store.read())[0].inputTokens;

    await rename(backupDir, winnerDir);
    const recovered = await ingestPortableUsage(options);
    const winnerAfterRecovery = (await store.read())[0].inputTokens;

    expect(unavailable.errors).toEqual([{ provider: "claude", path: winnerDir, message: "listing_failed" }]);
    expect(recovered.errors).toEqual([]);
    expect([winnerDuringFailure, winnerAfterRecovery]).toEqual([9, 9]);
  });

  it("preserves a winning source through stat failure while a lower-precedence owner changes", async () => {
    const contender = await claudeRef(rootDir, "a-stat-contender.jsonl", "contender");
    const winner = await claudeRef(rootDir, "z-stat-winner.jsonl", "winner");
    const fingerprints = new Map([
      [contender.file, { isFile: true, size: "10", mtimeNs: "10", ctimeNs: "10" }],
      [winner.file, { isFile: true, size: "20", mtimeNs: "20", ctimeNs: "20" }],
    ]);
    let failWinnerStat = false;
    let contenderTokens = 1;
    const statSource = vi.fn(async (sourcePath: string) => {
      if (failWinnerStat && sourcePath === winner.file) throw new Error("unavailable");
      return fingerprints.get(sourcePath) as { isFile: boolean; size: string; mtimeNs: string; ctimeNs: string };
    });
    const readClaude = vi.fn(async ([ref]: SourceFileRef[]) => [claude({
      sourceEventId: "shared-stat-owner",
      inputTokens: ref.file === winner.file ? 9 : contenderTokens,
    })]);
    const options = { store, statePath, claudeRefs: [contender, winner], codexRefs: [], statSource, readClaude };

    await ingestPortableUsage(options);
    failWinnerStat = true;
    contenderTokens = 2;
    fingerprints.set(contender.file, { isFile: true, size: "10", mtimeNs: "10", ctimeNs: "11" });
    const unavailable = await ingestPortableUsage(options);
    const winnerDuringFailure = (await store.read())[0].inputTokens;

    failWinnerStat = false;
    const recovered = await ingestPortableUsage(options);
    const winnerAfterRecovery = (await store.read())[0].inputTokens;

    expect(unavailable.errors).toEqual([{ provider: "claude", path: winner.file, message: "stat_failed" }]);
    expect(recovered.errors).toEqual([]);
    expect([winnerDuringFailure, winnerAfterRecovery]).toEqual([9, 9]);
  });

  it("recovers pending combined state before deriving ownership from source discovery", async () => {
    const contenderDir = path.join(rootDir, "a-recovery-contender");
    const unavailableWinnerDir = path.join(rootDir, "z-recovery-winner");
    const contender = await claudeRef(contenderDir, "session.jsonl", "contender");
    const readClaude = vi.fn(async () => [claude({ sourceEventId: "shared-recovery-owner", inputTokens: 1 })]);
    await ingestPortableUsage({ store, statePath, claudeRefs: [contender], codexRefs: [], readClaude });
    const originalState = JSON.parse(await readFile(statePath, "utf8")) as {
      schemaVersion: 1;
      sources: Record<string, Record<string, unknown>>;
    };
    const storedWinner = (await store.read())[0];
    const contenderState = Object.values(originalState.sources)[0];
    const winnerPath = path.join(unavailableWinnerDir, "session.jsonl");
    const canonicalWinnerPath = process.platform === "win32" ? winnerPath.toLowerCase() : winnerPath;
    const winnerKey = `claude:${canonicalWinnerPath}`;
    const pendingState = {
      schemaVersion: 1 as const,
      sources: {
        ...originalState.sources,
        [winnerKey]: {
          ...contenderState,
          path: winnerPath,
          eventIds: [storedWinner.id],
          active: true,
        },
      },
    };
    let failStateRename = true;
    const failingFs = {
      ...nodeFs,
      async rename(from: PathLike, to: PathLike) {
        if (failStateRename && String(to).endsWith("ingest-state.json")) {
          failStateRename = false;
          throw Object.assign(new Error("injected state rename failure"), { code: "EIO" });
        }
        return nodeFs.rename(from, to);
      },
    };
    await expect(new PortableUsageStore(rootDir, failingFs).reconcileWithIngestState([
      { ...storedWinner, inputTokens: 9 },
    ], pendingState)).rejects.toThrow("injected state rename failure");

    await writeFile(contender.file, "contender-changed", "utf8");
    readClaude.mockResolvedValue([claude({ sourceEventId: "shared-recovery-owner", inputTokens: 2 })]);
    const result = await ingestPortableUsage({
      store: new PortableUsageStore(rootDir),
      statePath,
      claudeProjectsDirs: [contenderDir, unavailableWinnerDir],
      codexRefs: [],
      readClaude,
    });

    expect(result.errors).toEqual([{
      provider: "claude", path: unavailableWinnerDir, message: "listing_failed",
    }]);
    expect((await store.read())[0].inputTokens).toBe(9);
    const recoveredState = JSON.parse(await readFile(statePath, "utf8")) as { sources: Record<string, unknown> };
    expect(recoveredState.sources).toHaveProperty(winnerKey);
    expect(await readdir(rootDir)).not.toContain("pending-store-transaction.json");
  });

  it("rereads a truly missing source when it reappears with the same fingerprint", async () => {
    const contender = await claudeRef(rootDir, "a-contender.jsonl", "contender");
    const winner = await claudeRef(rootDir, "z-winner.jsonl", "winner");
    const fingerprints = new Map([
      [contender.file, { isFile: true, size: "10", mtimeNs: "10", ctimeNs: "10" }],
      [winner.file, { isFile: true, size: "20", mtimeNs: "20", ctimeNs: "20" }],
    ]);
    let contenderTokens = 1;
    const statSource = vi.fn(async (sourcePath: string) => fingerprints.get(sourcePath) as {
      isFile: boolean; size: string; mtimeNs: string; ctimeNs: string;
    });
    const readClaude = vi.fn(async ([ref]: SourceFileRef[]) => [claude({
      sourceEventId: "shared-reappearing-owner",
      inputTokens: ref.file === winner.file ? 9 : contenderTokens,
    })]);
    const options = { store, statePath, claudeRefs: [contender, winner], codexRefs: [], statSource, readClaude };

    await ingestPortableUsage(options);
    await ingestPortableUsage({ ...options, claudeRefs: [contender] });
    contenderTokens = 2;
    fingerprints.set(contender.file, { isFile: true, size: "10", mtimeNs: "10", ctimeNs: "11" });
    await ingestPortableUsage({ ...options, claudeRefs: [contender] });
    expect((await store.read())[0].inputTokens).toBe(2);
    readClaude.mockClear();

    await ingestPortableUsage(options);

    expect(readClaude.mock.calls.map(([refs]) => refs[0].file)).toContain(winner.file);
    expect((await store.read())[0].inputTokens).toBe(9);
  });

  it("does not treat a path-prefix sibling as contained by a failed directory", async () => {
    const siblingDir = path.join(rootDir, "projects-old");
    const failedDir = path.join(rootDir, "projects");
    const sibling = await claudeRef(siblingDir, "session.jsonl", "fixture");
    await ingestPortableUsage({
      store, statePath, claudeRefs: [sibling], codexRefs: [], readClaude: async () => [claude()],
    });

    await ingestPortableUsage({ store, statePath, claudeProjectsDirs: [failedDir], codexRefs: [] });

    const state = JSON.parse(await readFile(statePath, "utf8")) as { sources: Record<string, { active: boolean }> };
    expect(Object.values(state.sources)).toEqual([expect.objectContaining({ active: false })]);
  });

  it("migrates legacy version 1 fingerprints by safely reprocessing the known source", async () => {
    const ref = await claudeRef(rootDir, "legacy.jsonl", "fixture");
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      sources: {
        [ref.file]: { size: 7, mtimeMs: 1, processedAt: "2026-07-01T00:00:00.000Z" },
      },
    })}\n`, "utf8");
    const readClaude = vi.fn(async () => [claude()]);

    await ingestPortableUsage({ store, statePath, claudeRefs: [ref], codexRefs: [], readClaude });

    const state = JSON.parse(await readFile(statePath, "utf8")) as { sources: Record<string, Record<string, unknown>> };
    expect(readClaude).toHaveBeenCalledTimes(1);
    expect(Object.values(state.sources)).toEqual([expect.objectContaining({
      provider: "claude", path: ref.file, size: "7", active: true,
    })]);
  });

  it("rewrites a validated legacy state even when no sources are discovered", async () => {
    const legacyState = {
      schemaVersion: 1,
      sources: {
        [path.join(rootDir, "legacy-missing.jsonl")]: {
          size: 7,
          mtimeMs: 1,
          processedAt: "2026-07-01T00:00:00.000Z",
        },
      },
    };
    await writeFile(statePath, JSON.stringify(legacyState), "utf8");

    const result = await ingestPortableUsage({ store, statePath, claudeRefs: [], codexRefs: [] });

    expect(result.diagnostics).toEqual([]);
    expect(await readFile(statePath, "utf8")).toBe(`${JSON.stringify(legacyState, null, 2)}\n`);
  });

  it("migrates the prior owned version 1 record without treating it as corruption", async () => {
    const ref = await claudeRef(rootDir, "owned-legacy.jsonl", "fixture");
    const canonical = process.platform === "win32" ? path.resolve(ref.file).toLowerCase() : path.resolve(ref.file);
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      sources: {
        [`claude:${canonical}`]: {
          provider: "claude",
          path: ref.file,
          size: 7,
          mtimeMs: 1,
          processedAt: "2026-07-01T00:00:00.000Z",
          eventIds: [],
          active: true,
        },
      },
    })}\n`, "utf8");

    const result = await ingestPortableUsage({
      store, statePath, claudeRefs: [ref], codexRefs: [], readClaude: async () => [claude()],
    });

    expect(result.diagnostics).toEqual([]);
    expect((await readdir(rootDir)).some((name) => name.includes(".corrupt."))).toBe(false);
    const state = JSON.parse(await readFile(statePath, "utf8")) as { sources: Record<string, Record<string, unknown>> };
    expect(Object.values(state.sources)).toEqual([expect.objectContaining({ size: "7", mtimeNs: expect.any(String) })]);
  });

  it("does not advance state when a source disappears between stat and strict open, then retries", async () => {
    const ref = await claudeRef(rootDir, "racy.jsonl", "fixture");
    let first = true;
    const statSource = async () => {
      const info = { isFile: true, size: "7", mtimeNs: "10", ctimeNs: "11" };
      if (first) {
        first = false;
        await rm(ref.file);
      }
      return info;
    };

    const failed = await ingestPortableUsage({ store, statePath, claudeRefs: [ref], codexRefs: [], statSource });
    expect(failed.errors).toEqual([{ provider: "claude", path: ref.file, message: "read_failed" }]);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(ref.file, "fixture", "utf8");
    const retried = await ingestPortableUsage({
      store,
      statePath,
      claudeRefs: [ref],
      codexRefs: [],
      statSource,
      readClaude: async () => [claude()],
    });
    expect(retried.inserted).toBe(1);
  });

  it("keeps later normalized source precedence stable regardless of which colliding source changes", async () => {
    const a = await claudeRef(rootDir, "a.jsonl", "a");
    const b = await claudeRef(rootDir, "b.jsonl", "b");
    let aTokens = 1;
    let bTokens = 2;
    const readClaude = vi.fn(async ([ref]: SourceFileRef[]) => [claude({
      sourceEventId: "shared-source-id",
      inputTokens: ref.file === a.file ? aTokens : bTokens,
    })]);
    const options = { store, statePath, claudeRefs: [b, a], codexRefs: [], readClaude };

    await ingestPortableUsage(options);
    expect((await store.read())[0].inputTokens).toBe(2);

    aTokens = 3;
    await writeFile(a.file, "a-changed", "utf8");
    await ingestPortableUsage(options);
    expect((await store.read())[0].inputTokens).toBe(2);

    bTokens = 4;
    await writeFile(b.file, "b-changed", "utf8");
    await ingestPortableUsage(options);
    expect((await store.read())[0].inputTokens).toBe(4);

    aTokens = 5;
    await writeFile(a.file, "a-changed-again", "utf8");
    await ingestPortableUsage({ ...options, claudeRefs: [a] });
    expect((await store.read())[0].inputTokens).toBe(5);
  });

  it("serializes two real ingestion processes before either reads the shared source", async () => {
    const sourceDir = path.join(rootDir, "provider-source");
    const ref = await claudeRef(sourceDir, "session.jsonl", JSON.stringify({
      timestamp: "2026-07-13T10:00:00.000Z",
      sessionId: "cross-process-session",
      message: { id: "cross-process-event", model: "claude-sonnet-4-6", usage: { input_tokens: 7, output_tokens: 3 } },
    }));
    const childFile = path.join(process.cwd(), "tests", "fixtures", "portableIngestionChild.test.ts");
    const vitestCli = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
    const first = runIngestionChild(vitestCli, childFile, rootDir, ref, "a");
    const second = runIngestionChild(vitestCli, childFile, rootDir, ref, "b");
    await waitForPaths([path.join(rootDir, "ingest-ready-a"), path.join(rootDir, "ingest-ready-b")]);
    await writeFile(path.join(rootDir, "ingest-go"), String(Date.now() + 300), "utf8");

    await Promise.all([first, second]);

    const reads = (await readFile(path.join(rootDir, "provider-read.log"), "utf8")).trim().split(/\r?\n/);
    expect(reads).toHaveLength(1);
    expect((await store.read()).map(({ id }) => id)).toHaveLength(1);
  }, 30_000);
});

async function claudeRef(rootDir: string, name: string, contents: string): Promise<SourceFileRef> {
  await mkdir(rootDir, { recursive: true });
  const file = path.join(rootDir, name);
  await writeFile(file, contents, "utf8");
  return { file, baseDir: rootDir };
}

async function codexRef(rootDir: string, name: string, contents: string): Promise<CodexSourceFileRef> {
  await mkdir(rootDir, { recursive: true });
  const file = path.join(rootDir, name);
  await writeFile(file, contents, "utf8");
  return { file, baseDir: rootDir };
}

function runIngestionChild(
  vitestCli: string,
  childFile: string,
  childRoot: string,
  ref: SourceFileRef,
  childId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, "run", childFile, "--pool=forks", "--maxWorkers=1"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        QUOTABAR_INGEST_CHILD_ROOT: childRoot,
        QUOTABAR_INGEST_CHILD_SOURCE: ref.file,
        QUOTABAR_INGEST_CHILD_BASE: ref.baseDir,
        QUOTABAR_INGEST_CHILD_ID: childId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Portable ingestion child exited with code ${code}: ${output}`));
    });
  });
}

async function waitForPaths(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const present = await Promise.all(paths.map(async (filePath) => {
      try {
        await readFile(filePath);
        return true;
      } catch {
        return false;
      }
    }));
    if (present.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for portable ingestion child processes");
}
