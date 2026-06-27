import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPaths = vi.hoisted(() => ({ dir: "" }));

vi.mock("../src/config/paths", () => ({
  getAppConfigDir: () => mockPaths.dir,
  getLogPath: () => path.join(mockPaths.dir, "quotabar.log"),
}));

import { initializeLogging, log } from "../src/main/logging";

describe("app logging", () => {
  beforeEach(async () => {
    mockPaths.dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-log-"));
    initializeLogging(false);
  });

  afterEach(async () => {
    await fs.rm(mockPaths.dir, { recursive: true, force: true });
  });

  it("trims the app log before it grows past the size cap", async () => {
    const logPath = path.join(mockPaths.dir, "quotabar.log");
    const oldLine = "old diagnostic line\n";
    const filler = "x".repeat(5_300_000);
    await fs.writeFile(logPath, oldLine + filler, "utf8");

    log.info("new diagnostic line");

    const stat = await fs.stat(logPath);
    const content = await fs.readFile(logPath, "utf8");
    expect(stat.size).toBeLessThan(5_000_000);
    expect(content).not.toContain(oldLine.trim());
    expect(content).toContain("new diagnostic line");
  });
});
