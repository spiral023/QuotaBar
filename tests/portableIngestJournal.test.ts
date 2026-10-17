import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeUsageEntry, SourceFileRef } from "../src/pricing/jsonl-reader";
import {
  applyPortableIngestJournal,
  portableIngestSourceKey,
  serializePortableIngestJournalEntry,
  serializePortableIngestJournalHeader,
  type PortableIngestJournalBase,
} from "../src/portable/ingestState";
import type { PortableIngestState } from "../src/portable/types";

function claude(sourceEventId: string, overrides: Partial<ClaudeUsageEntry> = {}): ClaudeUsageEntry {
  return {
    provider: "claude",
    timestamp: "2026-07-13T10:00:00.000Z",
    model: "claude-sonnet-4-6",
    project: "QuotaBar",
    projectName: "QuotaBar",
    session: "raw-claude-session",
    sourceEventId,
    inputTokens: 11,
    outputTokens: 12,
    cacheCreationTokens: 13,
    cacheReadTokens: 14,
    costUSD: 0.42,
    ...overrides,
  };
}

/**
 * The parsed ingest state is cached per process, so "a later app start" is
 * simulated with fresh module instances that must rebuild it from disk.
 */
async function freshModules() {
  vi.resetModules();
  const ingestion = await import("../src/portable/ingestion");
  const usageStore = await import("../src/portable/usageStore");
  return { ingestPortableUsage: ingestion.ingestPortableUsage, PortableUsageStore: usageStore.PortableUsageStore };
}

describe("portable ingest state journal", () => {
  let rootDir: string;
  let statePath: string;
  let journalPath: string;
  let refA: SourceFileRef;
  let refB: SourceFileRef;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-ingest-journal-"));
    statePath = path.join(rootDir, "ingest-state.json");
    journalPath = path.join(rootDir, "ingest-state.journal.jsonl");
    refA = await sourceFile(rootDir, "a.jsonl", "a");
    refB = await sourceFile(rootDir, "b.jsonl", "b");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  function reader() {
    return vi.fn(async ([ref]: SourceFileRef[]) => [claude(path.basename(ref.file))]);
  }

  let modules: Awaited<ReturnType<typeof freshModules>> | undefined;

  async function ingest(
    readClaude: ReturnType<typeof reader>,
    extra: { journalMinSnapshotBytes?: number; journalMaxSnapshotShare?: number; sameProcess?: boolean } = {},
  ) {
    const { sameProcess, ...options } = extra;
    if (!sameProcess || !modules) modules = await freshModules();
    const { ingestPortableUsage, PortableUsageStore } = modules;
    return ingestPortableUsage({
      store: new PortableUsageStore(rootDir),
      statePath,
      claudeRefs: [refA, refB],
      codexRefs: [],
      readClaude: readClaude as unknown as (refs: SourceFileRef[]) => Promise<ClaudeUsageEntry[]>,
      // The fixture snapshot is tiny, so the default share would compact on every pass.
      journalMinSnapshotBytes: 0,
      journalMaxSnapshotShare: 100,
      ...options,
    });
  }

  it("appends a changed source to the journal and leaves the snapshot untouched", async () => {
    await ingest(reader());
    const snapshot = await readFile(statePath, "utf8");
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(refA.file, "a-changed", "utf8");
    const changedRead = reader();
    expect(await ingest(changedRead)).toMatchObject({ changed: 1, errors: [] });
    expect(changedRead).toHaveBeenCalledTimes(1);
    expect(await readFile(statePath, "utf8")).toBe(snapshot);
    const journal = (await readFile(journalPath, "utf8")).trim().split("\n");
    expect(journal).toHaveLength(2);
    expect(Object.keys(JSON.parse(journal[1]).sources)).toEqual([portableIngestSourceKey("claude", refA.file)]);

    // A later start rebuilds the state from snapshot plus journal and re-reads nothing.
    const laterRead = reader();
    expect(await ingest(laterRead)).toMatchObject({ changed: 0, inserted: 0, errors: [] });
    expect(laterRead).not.toHaveBeenCalled();
  });

  it("keeps rewriting the snapshot while it is smaller than the journaling threshold", async () => {
    await ingest(reader(), { journalMinSnapshotBytes: 1024 * 1024 });
    await writeFile(refA.file, "a-changed", "utf8");
    const before = await readFile(statePath, "utf8");
    await ingest(reader(), { journalMinSnapshotBytes: 1024 * 1024 });

    expect(await readFile(statePath, "utf8")).not.toBe(before);
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores a journal once its snapshot was replaced, even by identical bytes", async () => {
    // One process throughout, so the in-memory state must notice the replacement too.
    await ingest(reader(), { sameProcess: true });
    await writeFile(refA.file, "a-changed", "utf8");
    await ingest(reader(), { sameProcess: true });
    const staleHeader = (await readFile(journalPath, "utf8")).split("\n")[0];

    // An import writes a fresh snapshot; identical content must not revive the old journal.
    await writeFile(statePath, await readFile(statePath, "utf8"), "utf8");
    const laterRead = reader();
    expect(await ingest(laterRead, { sameProcess: true })).toMatchObject({ changed: 1, inserted: 0, errors: [] });
    expect(laterRead).toHaveBeenCalledTimes(1);
    expect(laterRead.mock.calls[0][0][0].file).toBe(refA.file);

    // The journal was restarted on the current snapshot.
    expect((await readFile(journalPath, "utf8")).split("\n")[0]).not.toBe(staleHeader);
    const settledRead = reader();
    expect(await ingest(settledRead)).toMatchObject({ changed: 0 });
    expect(settledRead).not.toHaveBeenCalled();
  });

  it("skips a torn journal tail and compacts on the next write", async () => {
    await ingest(reader());
    await writeFile(refA.file, "a-changed", "utf8");
    await ingest(reader());
    await appendFile(journalPath, "{\"sources\":{", "utf8");
    const snapshot = await readFile(statePath, "utf8");

    await writeFile(refB.file, "b-changed", "utf8");
    const laterRead = reader();
    expect(await ingest(laterRead)).toMatchObject({ changed: 1, errors: [] });
    // The intact journal line still counted: only b was read.
    expect(laterRead.mock.calls.map(([[ref]]) => ref.file)).toEqual([refB.file]);
    expect(await readFile(statePath, "utf8")).not.toBe(snapshot);
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });

    const settledRead = reader();
    expect(await ingest(settledRead)).toMatchObject({ changed: 0 });
    expect(settledRead).not.toHaveBeenCalled();
  });

  it("compacts the journal into the snapshot once it outgrows its share", async () => {
    await ingest(reader());
    const snapshot = await readFile(statePath, "utf8");
    const share = { journalMaxSnapshotShare: 1 };
    let journaled = 0;
    for (let round = 0; round < 10; round += 1) {
      await writeFile(refA.file, `a-changed-${round}`, "utf8");
      await ingest(reader(), share);
      if (await stat(journalPath).then(() => true, () => false)) journaled += 1;
      else break;
    }

    expect(journaled).toBeGreaterThan(0);
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(statePath, "utf8")).not.toBe(snapshot);
    const settledRead = reader();
    expect(await ingest(settledRead)).toMatchObject({ changed: 0 });
    expect(settledRead).not.toHaveBeenCalled();
  });
});

describe("applyPortableIngestJournal", () => {
  const sourcePath = path.resolve(os.tmpdir(), "journal-source.jsonl");
  const key = portableIngestSourceKey("claude", sourcePath);
  const base: PortableIngestJournalBase = { size: "10", mtimeNs: "20", sha256: "a".repeat(64) };
  const snapshot: PortableIngestState = { schemaVersion: 1, sources: {} };
  const record = {
    provider: "claude" as const,
    path: sourcePath,
    size: "1",
    mtimeNs: "2",
    ctimeNs: "3",
    processedAt: "2026-07-13T10:00:00.000Z",
    eventIds: ["b".repeat(64)],
    active: true,
  };

  it("applies records and later removals in order", () => {
    const text = serializePortableIngestJournalHeader(base)
      + serializePortableIngestJournalEntry({ [key]: record })
      + serializePortableIngestJournalEntry({ [key]: { ...record, active: false } });
    const applied = applyPortableIngestJournal(snapshot, base, text);
    expect(applied).toMatchObject({ usable: true, damaged: false });
    expect(applied.state.sources[key]).toMatchObject({ active: false });

    const removed = applyPortableIngestJournal(snapshot, base, `${text}${serializePortableIngestJournalEntry({ [key]: null })}`);
    expect(removed.state.sources).toEqual({});
  });

  it("does not replay onto a different snapshot", () => {
    const text = serializePortableIngestJournalHeader(base) + serializePortableIngestJournalEntry({ [key]: record });
    const applied = applyPortableIngestJournal(snapshot, { ...base, mtimeNs: "21" }, text);
    expect(applied).toEqual({ state: snapshot, usable: false, damaged: false });
  });

  it("stops at the first invalid line and reports the damage", () => {
    const misplaced = { ...record, path: path.resolve(os.tmpdir(), "elsewhere.jsonl") };
    const text = serializePortableIngestJournalHeader(base)
      + serializePortableIngestJournalEntry({ [key]: record })
      + `${JSON.stringify({ sources: { [key]: misplaced } })}\n`
      + serializePortableIngestJournalEntry({ [key]: null });
    const applied = applyPortableIngestJournal(snapshot, base, text);
    expect(applied).toMatchObject({ usable: false, damaged: true });
    expect(applied.state.sources[key]).toMatchObject({ active: true });
  });

  it("rejects records whose key does not match their path", () => {
    expect(() => serializePortableIngestJournalEntry({ "claude:elsewhere": record })).toThrow();
  });
});

async function sourceFile(rootDir: string, name: string, contents: string): Promise<SourceFileRef> {
  const file = path.join(rootDir, name);
  await writeFile(file, contents, "utf8");
  return { file, baseDir: rootDir };
}
