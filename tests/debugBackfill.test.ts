import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DebugRecorder } from "../src/main/debugRecorder";
import { runBackfill } from "../src/main/debugBackfill";

let tmpDir: string;
let claudeDir: string;
let codexDir: string;

async function writeClaudeJsonl(file: string, lines: object[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-backfill-"));
  claudeDir = path.join(tmpDir, "claude", "projects");
  codexDir = path.join(tmpDir, "codex", "sessions");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(codexDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runBackfill", () => {
  it("emits tokens.usage and tokens.daySummary into per-day backfill files", async () => {
    await writeClaudeJsonl(path.join(claudeDir, "proj-a", "session-1.jsonl"), [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 } } },
      { type: "assistant", timestamp: "2026-05-21T09:00:00Z",
        message: { id: "m2", model: "claude-sonnet-4-6",
          usage: { input_tokens: 80, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });

    const result = await runBackfill({
      recorder,
      logDir,
      claudeProjectsDirs: [claudeDir],
      codexSessionsDirs: [codexDir],
    });
    await recorder.flush();

    expect(result.daysWritten).toBeGreaterThanOrEqual(2);
    const files = await fs.readdir(logDir);
    expect(files).toContain("2026-05-20.backfill.jsonl");
    expect(files).toContain("2026-05-21.backfill.jsonl");

    const day20 = (await fs.readFile(path.join(logDir, "2026-05-20.backfill.jsonl"), "utf8"))
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(day20.some((e) => e.kind === "tokens.usage" && e.provider === "claude")).toBe(true);
    expect(day20.some((e) => e.kind === "tokens.daySummary" && e.provider === "claude" && e.input === 100)).toBe(true);
  });

  it("is idempotent — skips days whose .backfill.jsonl already exists", async () => {
    await writeClaudeJsonl(path.join(claudeDir, "proj", "session.jsonl"), [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });
    const opts = { recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] };

    const first = await runBackfill(opts);
    await recorder.flush();
    const second = await runBackfill(opts);
    await recorder.flush();

    expect(first.daysWritten).toBeGreaterThan(0);
    expect(second.daysWritten).toBe(0);
    expect(second.daysSkipped).toBeGreaterThan(0);
  });

  it("force=true regenerates existing backfill files", async () => {
    await writeClaudeJsonl(path.join(claudeDir, "proj", "session.jsonl"), [
      { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
        message: { id: "m1", model: "claude-sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const logDir = path.join(tmpDir, "debug");
    const recorder = new DebugRecorder({ enabled: true, logDir });
    const opts = { recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] };

    await runBackfill(opts);
    await recorder.flush();
    const result = await runBackfill({ ...opts, force: true });
    await recorder.flush();

    expect(result.daysWritten).toBeGreaterThan(0);
  });
});
