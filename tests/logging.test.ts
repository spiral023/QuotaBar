import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPaths = vi.hoisted(() => ({ dir: "" }));

vi.mock("../src/config/paths", () => ({
  getAppConfigDir: () => mockPaths.dir,
  getLogPath: () => path.join(mockPaths.dir, "quotabar.log"),
}));

import { AsyncLogWriter } from "../src/main/asyncLogWriter";
import { flushLogging, initializeLogging, log } from "../src/main/logging";

describe("app logging", () => {
  beforeEach(async () => {
    mockPaths.dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-log-"));
    initializeLogging(false);
  });

  afterEach(async () => {
    await flushLogging();
    await fs.rm(mockPaths.dir, { recursive: true, force: true });
  });

  it("trims the app log before it grows past the size cap", async () => {
    const logPath = path.join(mockPaths.dir, "quotabar.log");
    const oldLine = "old diagnostic line\n";
    const filler = "x".repeat(5_300_000);
    await fs.writeFile(logPath, oldLine + filler, "utf8");

    log.info("new diagnostic line");
    await flushLogging();

    const stat = await fs.stat(logPath);
    const content = await fs.readFile(logPath, "utf8");
    expect(stat.size).toBeLessThan(5_000_000);
    expect(content).not.toContain(oldLine.trim());
    expect(content).toContain("new diagnostic line");
  });

  it("preserves message order and drains queued writes before shutdown", async () => {
    log.info("first diagnostic"); log.warn("second diagnostic");
    await flushLogging();
    const content = await fs.readFile(path.join(mockPaths.dir, "quotabar.log"), "utf8");
    expect(content.indexOf("first diagnostic")).toBeLessThan(content.indexOf("second diagnostic"));
  });

  it("bounds queued messages and records overload without blocking", async () => {
    const writer = new AsyncLogWriter(128);
    const file = path.join(mockPaths.dir, "bounded.log");
    for (let i = 0; i < 1000; i++) writer.write(file, `synthetic diagnostic ${i}\n`);
    await writer.flush();
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("Logger dropped");
    expect(content.length).toBeLessThan(300);
  });

  it("does not reject a drain when the destination is unavailable", async () => {
    const writer = new AsyncLogWriter();
    const obstruction = path.join(mockPaths.dir, "obstruction");
    await fs.writeFile(obstruction, "fixture");
    writer.write(path.join(obstruction, "app.log"), "diagnostic\n");
    await expect(writer.flush()).resolves.toBeUndefined();
  });
});
