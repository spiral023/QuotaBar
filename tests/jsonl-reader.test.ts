import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  listClaudeSourceFilesStrict,
  readClaudeTokensForPeriod,
  readClaudeUsageEntriesForPeriod,
  readClaudeUsageEntriesFromFilesStrict,
} from "../src/pricing/jsonl-reader";

const tmpDir = path.join(os.tmpdir(), `quotabar-test-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeJsonl(dir: string, filename: string, entries: unknown[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

describe("readClaudeTokensForPeriod", () => {
  it("strict listing and reading propagate outer I/O failures", async () => {
    const missing = path.join(tmpDir, "missing");
    await expect(listClaudeSourceFilesStrict(missing)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readClaudeUsageEntriesFromFilesStrict([{ file: path.join(missing, "gone.jsonl"), baseDir: missing }]))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("strict reading still skips malformed individual lines", async () => {
    const projectDir = path.join(tmpDir, "strict-project");
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, "strict.jsonl");
    await fs.writeFile(file, `not-json\n${JSON.stringify({
      timestamp: "2026-05-10T10:00:00.000Z",
      message: { id: "strict-id", model: "claude-sonnet-4-6", usage: { input_tokens: 7, output_tokens: 3 } },
    })}\n`, "utf8");

    await expect(readClaudeUsageEntriesFromFilesStrict([{ file, baseDir: tmpDir }]))
      .resolves.toEqual([expect.objectContaining({ sourceEventId: "strict-id", inputTokens: 7 })]);
  });

  it("strict reading rejects an interrupted stream without caching its partial entries", async () => {
    const file = path.join(tmpDir, "interrupted.jsonl");
    const valid = JSON.stringify({
      timestamp: "2026-05-10T10:00:00.000Z",
      message: { id: "after-retry", model: "claude-sonnet-4-6", usage: { input_tokens: 7, output_tokens: 3 } },
    });
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(file, `${valid}\n`, "utf8");
    const interrupted = () => Readable.from((async function* () {
      yield `${valid}\n`;
      throw Object.assign(new Error("secret stream failure"), { code: "EIO" });
    })());

    await expect(readClaudeUsageEntriesFromFilesStrict([{ file, baseDir: tmpDir }], undefined, {
      createReadStream: interrupted,
    })).rejects.toMatchObject({ code: "EIO" });
    await expect(readClaudeUsageEntriesFromFilesStrict([{ file, baseDir: tmpDir }]))
      .resolves.toEqual([expect.objectContaining({ sourceEventId: "after-retry" })]);
  });

  it.each([
    ["C:\\Users\\person\\src\\QuotaBar", "QuotaBar"],
    ["/home/person/src/quota-bar", "quota-bar"],
    ["/home/alice/-frontend", "-frontend"],
    ["C:\\work\\C--compiler", "C--compiler"],
  ])("uses only the basename of cwd as projectName (%s)", async (cwd, expected) => {
    await writeJsonl(path.join(tmpDir, "legacy-project"), "session.jsonl", [{
      timestamp: "2026-05-10T10:00:00.000Z",
      cwd,
      message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 2 } },
    }]);

    const [entry] = await readClaudeUsageEntriesForPeriod(tmpDir, new Date("2026-05-01"));
    expect(entry.projectName).toBe(expected);
    expect(entry.projectName).not.toContain("person");
  });

  it("falls back to the existing project label when cwd is unavailable", async () => {
    await writeJsonl(path.join(tmpDir, "legacy-project"), "session.jsonl", [{
      timestamp: "2026-05-10T10:00:00.000Z",
      message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 2 } },
    }]);
    const [entry] = await readClaudeUsageEntriesForPeriod(tmpDir, new Date("2026-05-01"));
    expect(entry.projectName).toBe("legacy-project");
  });

  it.each([
    "C--Users-Alice-Documents-GitHub-QuotaBar",
    "D--Work-Alice-QuotaBar",
    "C--src-private-QuotaBar",
    "-home-alice-projects-QuotaBar",
    "-workspace-alice-QuotaBar",
  ])("does not expose encoded provider directory labels (%s)", async (encodedProject) => {
    await writeJsonl(path.join(tmpDir, encodedProject), "session.jsonl", [{
      timestamp: "2026-05-10T10:00:00.000Z",
      message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 2 } },
    }]);
    const [entry] = await readClaudeUsageEntriesForPeriod(tmpDir, new Date("2026-05-01"));
    expect(entry.projectName).toBeUndefined();
    expect(Object.keys(entry)).not.toContain("projectName");
    expect(JSON.stringify({ projectName: entry.projectName })).not.toMatch(/Alice|alice|home|Documents/);
  });

  it("exposes the provider message ID as in-memory source identity", async () => {
    await writeJsonl(path.join(tmpDir, "QuotaBar"), "source-id.jsonl", [{
      timestamp: "2026-05-10T10:00:00.000Z",
      message: { id: "msg_source_123", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 2 } },
    }]);
    const [entry] = await readClaudeUsageEntriesForPeriod(tmpDir, new Date("2026-05-01"));
    expect(entry.sourceEventId).toBe("msg_source_123");
  });

  it("returns zeros when directory does not exist", async () => {
    const result = await readClaudeTokensForPeriod("/nonexistent/path/xyz", new Date("2026-05-01"));
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUSD: 0,
      hasCostUSD: false,
      modelNames: [],
      perModel: {},
    });
  });

  it("aggregates tokens from entries within billing period", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      {
        timestamp: "2026-05-10T10:00:00.000Z",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } },
      },
      {
        timestamp: "2026-05-15T12:00:00.000Z",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 200, output_tokens: 80 } },
      },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01T00:00:00.000Z"));
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(130);
    expect(result.cacheCreationTokens).toBe(20);
    expect(result.cacheReadTokens).toBe(30);
    expect(result.modelNames).toContain("claude-sonnet-4-5");
  });

  it("excludes entries before billing period", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      {
        timestamp: "2026-04-30T23:59:59.000Z",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 999, output_tokens: 999 } },
      },
      {
        timestamp: "2026-05-01T00:00:00.001Z",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01T00:00:00.000Z"));
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it("skips invalid JSONL lines without throwing", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "session.jsonl"),
      [
        "not valid json{{{{",
        JSON.stringify({ timestamp: "2026-05-10T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 50, output_tokens: 25 } } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(25);
  });

  it("reads JSONL files from nested subdirectories", async () => {
    const nested = path.join(tmpDir, "proj", "subdir");
    await writeJsonl(nested, "chat.jsonl", [
      { timestamp: "2026-05-12T08:00:00.000Z", message: { model: "claude-opus-4", usage: { input_tokens: 77, output_tokens: 33 } } },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(result.inputTokens).toBe(77);
    expect(result.modelNames).toContain("claude-opus-4");
  });

  it("deduplicates model names", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      { timestamp: "2026-05-10T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } } },
      { timestamp: "2026-05-11T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(result.modelNames.filter((m) => m === "claude-sonnet-4-5").length).toBe(1);
  });

  it("deduplicates entries with the same message.id (streaming snapshots)", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      {
        timestamp: "2026-05-10T10:00:00.000Z",
        message: { id: "msg_abc123", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 10000 } },
      },
      // Same API response stored again as a different streaming snapshot
      {
        timestamp: "2026-05-10T10:00:00.000Z",
        message: { id: "msg_abc123", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 10000 } },
      },
      // Different API call — should be counted
      {
        timestamp: "2026-05-10T10:01:00.000Z",
        message: { id: "msg_def456", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 50, cache_read_input_tokens: 8000 } },
      },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(result.inputTokens).toBe(8);        // 5 + 3 (not 5+5+3)
    expect(result.outputTokens).toBe(250);      // 200 + 50
    expect(result.cacheReadTokens).toBe(18000); // 10000 + 8000
  });

  it("counts entries without message.id (no deduplication possible)", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      { timestamp: "2026-05-10T10:00:00.000Z", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 20 } } },
      { timestamp: "2026-05-10T10:01:00.000Z", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 15, output_tokens: 25 } } },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(result.inputTokens).toBe(25);
    expect(result.outputTokens).toBe(45);
  });

  it("tracks tokens per model separately in perModel", async () => {
    const projectDir = path.join(tmpDir, "proj1");
    await writeJsonl(projectDir, "session.jsonl", [
      {
        timestamp: "2026-05-10T10:00:00.000Z",
        message: { id: "msg_001", model: "claude-haiku-4-5", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000 } },
      },
      {
        timestamp: "2026-05-10T10:01:00.000Z",
        message: { id: "msg_002", model: "claude-sonnet-4-6", usage: { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 1000 } },
      },
      {
        timestamp: "2026-05-10T10:02:00.000Z",
        message: { id: "msg_003", model: "claude-haiku-4-5", usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 2000 } },
      },
    ]);

    const result = await readClaudeTokensForPeriod(tmpDir, new Date("2026-05-01"));

    expect(result.perModel["claude-haiku-4-5"]).toEqual({ inputTokens: 150, outputTokens: 70, cacheCreationTokens: 0, cacheReadTokens: 7000 });
    expect(result.perModel["claude-sonnet-4-6"]).toEqual({ inputTokens: 200, outputTokens: 80, cacheCreationTokens: 1000, cacheReadTokens: 0 });

    // Overall totals should still be consistent
    expect(result.inputTokens).toBe(350);
    expect(result.outputTokens).toBe(150);
    expect(result.cacheCreationTokens).toBe(1000);
    expect(result.cacheReadTokens).toBe(7000);
  });
});
