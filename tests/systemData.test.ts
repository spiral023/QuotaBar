import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectSystemData,
  findOpenableSystemPath,
  formatSystemPathDiagnostics,
  formatWslDiscoveryDiagnostics,
  formatWslSuggestionDiagnostics,
} from "../src/main/systemData";
import { PortableUsageStore } from "../src/portable/usageStore";

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

  it("includes additional configured Claude roots in credentials and project paths", async () => {
    const defaultRoot = path.join(homeDir, ".claude");
    const extraRoot = path.join(tmpDir, "wsl-claude");
    await writeFile(path.join(defaultRoot, ".credentials.json"), "token");
    await writeFile(path.join(extraRoot, "settings.json"), "{}");
    await writeFile(path.join(extraRoot, "projects", "p1", "log.jsonl"), "{}\n");

    const report = await collectSystemData({
      homeDir,
      appConfigDir,
      env: {},
      claudeRoots: [extraRoot],
    });
    const claude = report.agents.find((agent) => agent.id === "claude");
    const paths = claude?.paths.map((p) => p.path) ?? [];

    expect(paths).toContain(path.join(extraRoot, ".credentials.json"));
    expect(paths).toContain(path.join(extraRoot, "settings.json"));
    expect(paths).toContain(path.join(extraRoot, "projects"));
    expect(claude?.paths.find((p) => p.path === path.join(extraRoot, "settings.json"))?.category).toBe("config");
    expect(claude?.paths.find((p) => p.path === path.join(extraRoot, "settings.json"))?.source).toBe("settings");
    expect(claude?.paths.find((p) => p.path === path.join(extraRoot, "projects"))?.fileCount).toBe(1);
  });

  it("includes additional configured Codex homes in auth, config, and session paths", async () => {
    const defaultHome = path.join(homeDir, ".codex");
    const extraHome = path.join(tmpDir, "wsl-codex");
    await writeFile(path.join(defaultHome, "auth.json"), "token");
    await writeFile(path.join(extraHome, "sessions", "s.jsonl"), "{}\n");

    const report = await collectSystemData({
      homeDir,
      appConfigDir,
      env: {},
      codexHomes: [extraHome],
    });
    const codex = report.agents.find((agent) => agent.id === "codex");
    const paths = codex?.paths.map((p) => p.path) ?? [];

    expect(paths).toContain(path.join(extraHome, "auth.json"));
    expect(paths).toContain(path.join(extraHome, "config.toml"));
    expect(paths).toContain(path.join(extraHome, "sessions"));
    expect(codex?.paths.find((p) => p.path === path.join(extraHome, "auth.json"))?.source).toBe("settings");
    expect(codex?.paths.find((p) => p.path === path.join(extraHome, "auth.json"))?.active).toBe(true);
    expect(codex?.paths.find((p) => p.path === path.join(extraHome, "sessions"))?.fileCount).toBe(1);
  });

  it("includes automatically discovered WSL roots in agent status without saving them first", async () => {
    const wslClaudeRoot = path.join(tmpDir, "wsl", "Ubuntu", "home", "asi", ".claude");
    const wslCodexHome = path.join(tmpDir, "wsl", "Ubuntu", "home", "asi", ".codex");
    await writeFile(path.join(wslClaudeRoot, ".credentials.json"), "secret-token");
    await writeFile(path.join(wslCodexHome, "auth.json"), "secret-token");
    await writeFile(path.join(wslCodexHome, "sessions", "s.jsonl"), "{}\n");

    const report = await collectSystemData({
      homeDir,
      appConfigDir,
      env: {},
      wslClaudeRoots: [wslClaudeRoot],
      wslCodexHomes: [wslCodexHome],
    });
    const claude = report.agents.find((agent) => agent.id === "claude");
    const codex = report.agents.find((agent) => agent.id === "codex");

    expect(claude?.status).toBe("connected");
    expect(codex?.status).toBe("connected");
    expect(claude?.paths.find((p) => p.path === path.join(wslClaudeRoot, ".credentials.json"))?.source).toBe("wsl");
    expect(codex?.paths.find((p) => p.path === path.join(wslCodexHome, "auth.json"))?.source).toBe("wsl");
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

  it("lists only the known portable QuotaBar paths", async () => {
    await writeFile(path.join(appConfigDir, "usage", "events", "2026-07.jsonl"), "{}\n");
    await writeFile(path.join(appConfigDir, "quota", "2026-07.jsonl"), "{}\n");
    await writeFile(path.join(appConfigDir, "usage", "migration-state.json"), JSON.stringify({
      status: "running",
      privateDetail: "must-not-leave-the-file",
    }));
    await writeFile(path.join(appConfigDir, "pending-import.json"), "{}\n");
    const unrelatedDir = path.join(tmpDir, "unrelated");
    await writeFile(path.join(unrelatedDir, "private.txt"), "must-not-be-scanned");

    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });
    const portablePaths = report.app.paths.filter((item) => item.id.startsWith("app-portable-"));

    expect(portablePaths.map(({ label, path: itemPath }) => [label, itemPath])).toEqual([
      ["Usage Store", path.join(appConfigDir, "usage")],
      ["Quota Snapshots", path.join(appConfigDir, "quota")],
      ["Migration State", path.join(appConfigDir, "usage", "migration-state.json")],
      ["Pending Import", path.join(appConfigDir, "pending-import.json")],
    ]);
    expect(report.totals.fileCount).toBe(5);
    expect(JSON.stringify(report)).not.toContain(unrelatedDir);
    expect(JSON.stringify(report)).not.toContain("must-not-be-scanned");
  });

  it.each(["pending", "running", "complete", "failed"] as const)(
    "returns only the sanitized %s migration status",
    async (status) => {
      await writeFile(path.join(appConfigDir, "usage", "migration-state.json"), JSON.stringify({
        status,
        privateDetail: `hidden-${status}`,
      }));

      const report = await collectSystemData({ homeDir, appConfigDir, env: {} });

      expect(report.app.portableMigrationStatus).toBe(status);
      expect(JSON.stringify(report)).not.toContain(`hidden-${status}`);
    },
  );

  it("does not return an unrecognized migration status", async () => {
    await writeFile(path.join(appConfigDir, "usage", "migration-state.json"), JSON.stringify({
      status: "unexpected",
      privateDetail: "hidden-invalid-state",
    }));

    const report = await collectSystemData({ homeDir, appConfigDir, env: {} });

    expect(report.app.portableMigrationStatus).toBeNull();
    expect(report.app.portableDataReady).toBe(false);
    expect(JSON.stringify(report)).not.toContain("unexpected");
    expect(JSON.stringify(report)).not.toContain("hidden-invalid-state");
  });

  it("reports portable data ready only when the complete state matches the usage-store revision", async () => {
    const usageDir = path.join(appConfigDir, "usage");
    const store = new PortableUsageStore(usageDir);
    const revision = await store.getRevision();
    await writeFile(path.join(usageDir, "migration-state.json"), `${JSON.stringify({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: 1,
      storeRevision: revision,
      updatedAt: "2026-07-14T00:00:00.000Z",
    })}\n`);

    const ready = await collectSystemData({ homeDir, appConfigDir, env: {} });
    expect(ready.app.portableDataReady).toBe(true);

    await writeFile(path.join(usageDir, "migration-state.json"), `${JSON.stringify({
      schemaVersion: 1,
      status: "complete",
      usageMigrationVersion: 1,
      storeRevision: "0".repeat(64),
      updatedAt: "2026-07-14T00:01:00.000Z",
    })}\n`);
    const stale = await collectSystemData({ homeDir, appConfigDir, env: {} });
    expect(stale.app.portableMigrationStatus).toBe("complete");
    expect(stale.app.portableDataReady).toBe(false);
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

describe("system path diagnostics", () => {
  it("formats agent paths without leaking credential file contents", async () => {
    const codexHome = path.join(homeDir, ".codex");
    await writeFile(path.join(codexHome, "auth.json"), "secret-token-that-must-not-be-logged");
    await writeFile(path.join(codexHome, "sessions", "s.jsonl"), "{}\n");

    const report = await collectSystemData({ homeDir, appConfigDir, env: { CODEX_HOME: codexHome } });
    const diagnostics = formatSystemPathDiagnostics(report, {
      homeDir,
      platform: "win32",
      env: { CODEX_HOME: codexHome },
      settings: { codexHomes: [codexHome] },
    });
    const joined = [...diagnostics.info, ...diagnostics.debug].join("\n");

    expect(joined).toContain("Agent path summary:");
    expect(joined).toContain("Agent paths: platform=win32");
    expect(joined).toContain(`codexHomes=[${codexHome}]`);
    expect(joined).toContain(`path=${path.join(codexHome, "auth.json")}`);
    expect(joined).toContain("CODEX_HOME=set");
    expect(joined).toContain("source=env");
    expect(joined).toContain("active=true");
    expect(joined).not.toContain("secret-token-that-must-not-be-logged");
  });

  it("formats WSL detection results with paths and existence flags", () => {
    const lines = formatWslSuggestionDiagnostics("Codex homes", [{
      path: "\\\\wsl.localhost\\Ubuntu\\home\\asi\\.codex",
      label: "Ubuntu / asi",
      source: "wsl",
      hasAuth: true,
      hasSessions: false,
    }], "win32");

    expect(lines).toEqual([
      "WSL discovery: Codex homes found=1",
      "WSL discovery: Codex homes Ubuntu / asi auth=yes sessions=no path=\\\\wsl.localhost\\Ubuntu\\home\\asi\\.codex",
    ]);
  });

  it("formats WSL availability separately from provider root matches", () => {
    const lines = formatWslDiscoveryDiagnostics({
      platform: "win32",
      available: true,
      hosts: ["\\\\wsl.localhost", "\\\\wsl$"],
      durationMs: 42,
      distros: ["Ubuntu", "docker-desktop", "docker-desktop-data"],
      claudeRoots: [],
      codexHomes: [],
    });

    expect(lines).toEqual([
      "WSL discovery: available=true hosts=[\\\\wsl.localhost, \\\\wsl$] distros=[Ubuntu] duration=42ms",
      "WSL discovery: Claude roots found=0",
      "WSL discovery: Codex homes found=0",
    ]);
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
