import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSystemData, findOpenableSystemPath } from "../src/main/systemData";

let tmpDir: string;
let homeDir: string;
let appConfigDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-system-"));
  homeDir = path.join(tmpDir, "home");
  appConfigDir = path.join(tmpDir, "app");
  await fs.mkdir(homeDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("collectSystemData", () => {
  it("detects Codex and Claude from credentials and local data without reading file contents", async () => {
    const codexHome = path.join(homeDir, ".codex");
    const claudeRoot = path.join(homeDir, ".config", "claude");
    await writeFile(path.join(codexHome, "auth.json"), "secret-token");
    await writeFile(path.join(codexHome, "config.toml"), "model = 'x'");
    await writeFile(path.join(codexHome, "sessions", "2026", "06", "11", "a.jsonl"), "{}\n");
    await writeFile(path.join(claudeRoot, "projects", "p1", "log.jsonl"), "{}\n{}\n");
    await writeFile(path.join(homeDir, ".claude", ".credentials.json"), "secret-token");

    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });

    expect(report.agents.map((a) => [a.id, a.status])).toEqual([
      ["claude", "connected"],
      ["codex", "connected"],
    ]);
    expect(report.totals.fileCount).toBe(5);
    expect(report.categories.find((c) => c.id === "credentials")?.fileCount).toBe(2);
    expect(report.categories.find((c) => c.id === "logs")?.fileCount).toBe(2);
    expect(report.categories.find((c) => c.id === "config")?.fileCount).toBe(1);
    expect(report.totals.totalBytes).toBeGreaterThan(0);
  });

  it("marks an agent as detected when only data directories exist", async () => {
    await writeFile(path.join(homeDir, ".codex", "sessions", "s.jsonl"), "{}\n");

    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });
    const codex = report.agents.find((agent) => agent.id === "codex");

    expect(codex?.status).toBe("detected");
    expect(codex?.totals.fileCount).toBe(1);
    expect(codex?.paths.some((p) => p.category === "credentials" && !p.exists)).toBe(true);
  });

  it("reports expected default paths even when an agent has no files yet", async () => {
    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });
    const codex = report.agents.find((agent) => agent.id === "codex");
    const claude = report.agents.find((agent) => agent.id === "claude");

    expect(codex?.status).toBe("not_found");
    expect(codex?.paths.map((p) => p.path)).toContain(path.join(homeDir, ".codex", "auth.json"));
    expect(codex?.paths.map((p) => p.path)).toContain(path.join(homeDir, ".codex", "sessions"));
    expect(claude?.paths.map((p) => p.path)).toContain(path.join(homeDir, ".config", "claude", "projects"));
  });

  it("includes QuotaBar app files and debug data in app sections", async () => {
    await writeFile(path.join(appConfigDir, "settings.json"), "{}");
    await writeFile(path.join(appConfigDir, "quotabar.log"), "line\n");
    await writeFile(path.join(appConfigDir, "cache", "usage-snapshots.json"), "{}");
    await writeFile(path.join(appConfigDir, "cache", "fx-status.json"), "{}");
    await writeFile(path.join(appConfigDir, "debug", "2026-06-11.jsonl"), "{}\n");

    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });

    expect(report.app.paths.filter((p) => p.exists)).toHaveLength(5);
    expect(report.categories.find((c) => c.id === "cache")?.fileCount).toBe(2);
    expect(report.categories.find((c) => c.id === "logs")?.fileCount).toBe(2);
    expect(report.categories.find((c) => c.id === "config")?.fileCount).toBe(1);
  });

  it("includes the QuotaBar distribution variant in app system data", async () => {
    const report = await collectSystemData({
      homeDir,
      appConfigDir,
      env: {},
      appVariant: { id: "zip", label: "ZIP" },
    });

    expect(report.app.variant).toEqual({ id: "zip", label: "ZIP" });
  });

  it("reports the scan duration as a performance metric", async () => {
    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });

    expect(report.scanDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("includes the latest Quick Stats load duration when provided", async () => {
    const report = await collectSystemData({
      homeDir,
      appConfigDir,
      env: {},
      quickStatsLoadDurationMs: 1234,
    });

    expect(report.quickStatsLoadDurationMs).toBe(1234);
  });
});

describe("findOpenableSystemPath", () => {
  it("returns only paths present in the generated report", async () => {
    const sessionsDir = path.join(homeDir, ".codex", "sessions");
    await writeFile(path.join(sessionsDir, "s.jsonl"), "{}\n");
    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });

    expect(findOpenableSystemPath(report, sessionsDir)).toBe(sessionsDir);
    expect(findOpenableSystemPath(report, path.join(tmpDir, "outside"))).toBeNull();
  });

  it("allows opening an existing file path from the generated report", async () => {
    const fxStatus = path.join(appConfigDir, "cache", "fx-status.json");
    await writeFile(fxStatus, "{}");
    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });

    expect(findOpenableSystemPath(report, fxStatus)).toBe(fxStatus);
  });

  it("allows opening the local LiteLLM model price cache instead of the status file", async () => {
    const priceCache = path.join(appConfigDir, "cache", "litellm-model-prices.json");
    const statusFile = path.join(appConfigDir, "cache", "litellm-status.json");
    await writeFile(priceCache, JSON.stringify({ "openai/test": { input_cost_per_token: 1e-6 } }));
    await writeFile(statusFile, "{}");
    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });

    expect(report.app.paths.find((p) => p.id === "app-litellm-prices")?.path).toBe(priceCache);
    expect(findOpenableSystemPath(report, priceCache)).toBe(priceCache);
  });
});
