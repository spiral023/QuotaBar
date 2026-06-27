import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPaths = vi.hoisted(() => ({ dir: "" }));

vi.mock("../src/config/paths", () => ({
  getAppConfigDir: () => mockPaths.dir,
}));

import { readDataSourceInfo } from "../src/main/dataSourceStatus";

describe("readDataSourceInfo", () => {
  beforeEach(() => {
    mockPaths.dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-ds-"));
  });

  afterEach(() => {
    fs.rmSync(mockPaths.dir, { recursive: true, force: true });
  });

  it("returns status and data file metadata for an existing FX cache", () => {
    const cacheDir = path.join(mockPaths.dir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const fxPath = path.join(cacheDir, "fx-rates.json");
    fs.writeFileSync(fxPath, JSON.stringify({ EURUSD: { "2026-06-25": 1.08 } }), "utf8");

    const info = readDataSourceInfo("fx", fxPath);

    expect(info.dataFile?.exists).toBe(true);
    expect(info.dataFile?.path).toBe(fxPath);
    expect(info.status?.ok).toBe(true);
    expect(info.status?.detail).toBe("latest rate 2026-06-25");
    expect(info.status?.at).toBe(info.dataFile?.lastModifiedAt);
  });

  it("returns status file metadata for LiteLLM when only the status file exists", () => {
    const cacheDir = path.join(mockPaths.dir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const statusPath = path.join(cacheDir, "litellm-status.json");
    fs.writeFileSync(statusPath, JSON.stringify({
      ok: true,
      source: "live",
      at: "2026-06-27T02:12:27.733Z",
      detail: "2920 models",
    }), "utf8");

    const info = readDataSourceInfo("litellm");

    expect(info.status?.detail).toBe("2920 models");
    expect(info.statusFile.exists).toBe(true);
    expect(info.statusFile.path).toBe(statusPath);
    expect(info.dataFile).toBeUndefined();
  });
});
