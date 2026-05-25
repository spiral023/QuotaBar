import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DebugRecorder } from "../src/main/debugRecorder";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-recorder-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("DebugRecorder", () => {
  it("does nothing when disabled", async () => {
    const r = new DebugRecorder({ enabled: false, logDir: tmpDir });
    r.write({ kind: "app.start", version: "x", pollIntervalSeconds: 60, noWindow: false, platform: "win32" });
    await r.flush();
    const files = await fs.readdir(tmpDir).catch(() => []);
    expect(files).toEqual([]);
  });

  it("writes one JSONL line per event with ts and kind", async () => {
    const r = new DebugRecorder({ enabled: true, logDir: tmpDir });
    r.write({ kind: "app.start", version: "x", pollIntervalSeconds: 60, noWindow: false, platform: "win32" });
    r.write({ kind: "refresh.start", providers: ["claude"], trigger: "interval" });
    await r.flush();
    const files = await fs.readdir(tmpDir);
    expect(files).toHaveLength(1);
    const content = await fs.readFile(path.join(tmpDir, files[0]), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].kind).toBe("app.start");
    expect(parsed[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed[1].kind).toBe("refresh.start");
  });

  it("creates the debug dir if it does not exist", async () => {
    const subDir = path.join(tmpDir, "nested", "debug");
    const r = new DebugRecorder({ enabled: true, logDir: subDir });
    r.write({ kind: "app.start", version: "x", pollIntervalSeconds: 60, noWindow: false, platform: "win32" });
    await r.flush();
    const files = await fs.readdir(subDir);
    expect(files).toHaveLength(1);
  });

  it("redacts PII fields like email and accountId", async () => {
    const r = new DebugRecorder({ enabled: true, logDir: tmpDir });
    r.write({
      kind: "snapshot", provider: "codex", status: "ok",
      windows: [], fetchedAt: new Date().toISOString(),
      // @ts-expect-error - extending for redaction check
      identity: { email: "x@y.com", accountId: "abc" },
    });
    await r.flush();
    const files = await fs.readdir(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, files[0]), "utf8");
    expect(content).toContain("<redacted>");
    expect(content).not.toContain("x@y.com");
    expect(content).not.toContain("\"abc\"");
  });

  it("writeBackfill writes to .backfill.jsonl with caller-supplied date", async () => {
    const r = new DebugRecorder({ enabled: true, logDir: tmpDir });
    r.writeBackfill("2026-05-20", { kind: "tokens.usage", provider: "claude", model: "x", session: "s", input: 1, output: 1 });
    await r.flush();
    const files = await fs.readdir(tmpDir);
    expect(files).toContain("2026-05-20.backfill.jsonl");
  });

  it("setEnabled(false) stops further writes", async () => {
    const r = new DebugRecorder({ enabled: true, logDir: tmpDir });
    r.write({ kind: "app.start", version: "x", pollIntervalSeconds: 60, noWindow: false, platform: "win32" });
    await r.flush();
    r.setEnabled(false);
    r.write({ kind: "refresh.start", providers: ["claude"], trigger: "interval" });
    await r.flush();
    const files = await fs.readdir(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, files[0]), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });
});
