import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getClaudeCredentialPaths,
  getClaudeProjectsDirs,
  getClaudeRoots,
  getConfiguredClaudeRoots,
  getConfiguredCodexHomes,
  getCodexConfigPaths,
  getCodexHomes,
  getCodexSessionsDirs,
  getDebugLogDir,
  getDebugLogPath,
  getDebugBackfillPath,
  getUsageSnapshotCachePath,
} from "../src/config/paths";

const tmpRoot = path.join(os.tmpdir(), `quotabar-paths-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("data path resolution", () => {
  it("combines current and legacy Claude project directories by default", async () => {
    const home = path.join(tmpRoot, "home");
    const current = path.join(home, ".config", "claude", "projects");
    const legacy = path.join(home, ".claude", "projects");
    await fs.mkdir(current, { recursive: true });
    await fs.mkdir(legacy, { recursive: true });

    expect(getClaudeProjectsDirs({ homeDir: home, env: {} })).toEqual([legacy, current]);
  });

  it("uses comma-separated CLAUDE_CONFIG_DIR roots and skips duplicates and missing dirs", async () => {
    const rootA = path.join(tmpRoot, "claude-a");
    const rootB = path.join(tmpRoot, "claude-b");
    await fs.mkdir(path.join(rootA, "projects"), { recursive: true });
    await fs.mkdir(path.join(rootB, "projects"), { recursive: true });

    expect(getClaudeProjectsDirs({
      homeDir: tmpRoot,
      env: { CLAUDE_CONFIG_DIR: `${rootA},${rootA},${path.join(tmpRoot, "missing")},${rootB}` },
    })).toEqual([path.join(rootA, "projects"), path.join(rootB, "projects")]);
  });

  it("merges CLAUDE_CONFIG_DIR, saved Claude roots, and default roots", async () => {
    const envRoot = path.join(tmpRoot, "claude-env");
    const savedRoot = path.join(tmpRoot, "claude-saved");
    const currentDefault = path.join(tmpRoot, ".config", "claude");
    const legacyDefault = path.join(tmpRoot, ".claude");
    await fs.mkdir(path.join(envRoot, "projects"), { recursive: true });
    await fs.mkdir(path.join(savedRoot, "projects"), { recursive: true });
    await fs.mkdir(path.join(currentDefault, "projects"), { recursive: true });
    await fs.mkdir(path.join(legacyDefault, "projects"), { recursive: true });

    const ctx = { homeDir: tmpRoot, env: { CLAUDE_CONFIG_DIR: envRoot }, claudeRoots: [savedRoot] };

    expect(getConfiguredClaudeRoots(ctx)).toEqual([envRoot, savedRoot]);
    expect(getClaudeRoots(ctx)).toEqual([envRoot, savedRoot, legacyDefault, currentDefault]);
    expect(getClaudeProjectsDirs(ctx)).toEqual([
      path.join(envRoot, "projects"),
      path.join(savedRoot, "projects"),
      path.join(legacyDefault, "projects"),
      path.join(currentDefault, "projects"),
    ]);
    expect(getClaudeCredentialPaths(ctx)).toEqual([
      path.join(envRoot, ".credentials.json"),
      path.join(savedRoot, ".credentials.json"),
      path.join(legacyDefault, ".credentials.json"),
      path.join(currentDefault, ".credentials.json"),
    ]);
  });

  it("uses comma-separated CODEX_HOME roots for sessions and configs", async () => {
    const homeA = path.join(tmpRoot, "codex-a");
    const homeB = path.join(tmpRoot, "codex-b");
    await fs.mkdir(path.join(homeA, "sessions"), { recursive: true });
    await fs.mkdir(path.join(homeB, "sessions"), { recursive: true });

    const ctx = { homeDir: tmpRoot, env: { CODEX_HOME: `${homeA},${homeB},${homeA}` } };

    expect(getCodexHomes(ctx)).toEqual([homeA, homeB]);
    expect(getCodexSessionsDirs(ctx)).toEqual([
      path.join(homeA, "sessions"),
      path.join(homeB, "sessions"),
    ]);
    expect(getCodexConfigPaths(ctx)).toEqual([
      path.join(homeA, "config.toml"),
      path.join(homeB, "config.toml"),
    ]);
  });

  it("merges CODEX_HOME, saved Codex roots, and the default home", async () => {
    const envHome = path.join(tmpRoot, "codex-env");
    const savedHome = path.join(tmpRoot, "codex-saved");
    const defaultHome = path.join(tmpRoot, ".codex");
    await fs.mkdir(path.join(envHome, "sessions"), { recursive: true });
    await fs.mkdir(path.join(savedHome, "sessions"), { recursive: true });
    await fs.mkdir(path.join(defaultHome, "sessions"), { recursive: true });

    const ctx = { homeDir: tmpRoot, env: { CODEX_HOME: envHome }, codexHomes: [savedHome] };

    expect(getConfiguredCodexHomes(ctx)).toEqual([envHome, savedHome]);
    expect(getCodexHomes(ctx)).toEqual([envHome, savedHome, defaultHome]);
    expect(getCodexSessionsDirs(ctx)).toEqual([
      path.join(envHome, "sessions"),
      path.join(savedHome, "sessions"),
      path.join(defaultHome, "sessions"),
    ]);
  });
});

describe("debug log paths", () => {
  it("returns debug subdir under app config dir", () => {
    expect(getDebugLogDir()).toMatch(/[\\/]\.quotabar-win[\\/]debug$/);
  });

  it("returns usage snapshot cache path under app cache dir", () => {
    expect(getUsageSnapshotCachePath()).toMatch(/[\\/]\.quotabar-win[\\/]cache[\\/]usage-snapshots\.json$/);
  });

  it("returns YYYY-MM-DD.jsonl filename for a given date", () => {
    const d = new Date(Date.UTC(2026, 4, 26, 14, 23, 0));
    expect(getDebugLogPath(d)).toMatch(/[\\/]debug[\\/]2026-05-26\.jsonl$/);
  });

  it("returns YYYY-MM-DD.backfill.jsonl filename for a given date", () => {
    const d = new Date(Date.UTC(2026, 4, 26, 14, 23, 0));
    expect(getDebugBackfillPath(d)).toMatch(/[\\/]debug[\\/]2026-05-26\.backfill\.jsonl$/);
  });

  it("uses UTC day boundary, not local", () => {
    const d = new Date(Date.UTC(2026, 4, 26, 23, 30, 0));
    expect(getDebugLogPath(d)).toMatch(/2026-05-26\.jsonl$/);
  });
});
