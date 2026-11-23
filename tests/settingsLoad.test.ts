import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsPath: "",
  configDir: "",
}));

vi.mock("../src/config/paths", () => ({
  getSettingsPath: () => mocks.settingsPath,
}));

vi.mock("../src/main/logging", () => ({
  ensureConfigDir: async () => {
    await fs.mkdir(mocks.configDir, { recursive: true });
  },
}));

import { loadSettings, loadSettingsAtStartup, SettingsReadError, updateSettings } from "../src/config/settings";

describe("loadSettings", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qb-settings-"));
    mocks.configDir = tmp;
    mocks.settingsPath = path.join(tmp, "settings.json");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("creates defaults when the settings file is missing", async () => {
    await loadSettings();

    expect(await fs.readFile(mocks.settingsPath, "utf8")).toContain("pollIntervalSeconds");
  });

  it("throws instead of returning defaults for a malformed settings file", async () => {
    await fs.writeFile(mocks.settingsPath, "{ not json", "utf8");

    await expect(loadSettings()).rejects.toBeInstanceOf(SettingsReadError);
    await expect(loadSettings()).rejects.toMatchObject({ reason: "corrupt" });

    expect(await fs.readFile(mocks.settingsPath, "utf8")).toBe("{ not json");
  });

  it("treats a JSON value that is not an object as corrupt", async () => {
    await fs.writeFile(mocks.settingsPath, "[1, 2]", "utf8");

    await expect(loadSettings()).rejects.toMatchObject({ reason: "corrupt" });
  });

  it("aborts an update on a malformed file without writing defaults over it", async () => {
    await fs.writeFile(mocks.settingsPath, "{ not json", "utf8");

    await expect(updateSettings((current) => ({ ...current, pinned: true })))
      .rejects.toMatchObject({ reason: "corrupt" });

    expect(await fs.readFile(mocks.settingsPath, "utf8")).toBe("{ not json");
    expect((await fs.readdir(tmp)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("updates against the file contents read under the lock", async () => {
    await fs.writeFile(mocks.settingsPath, JSON.stringify({ pollIntervalSeconds: 120, viewMode: "compact" }), "utf8");

    const saved = await updateSettings((current) => ({ ...current, pinned: true }));

    expect(saved).toMatchObject({ pollIntervalSeconds: 120, viewMode: "compact", pinned: true });
    expect(JSON.parse(await fs.readFile(mocks.settingsPath, "utf8"))).toMatchObject({
      pollIntervalSeconds: 120,
      viewMode: "compact",
      pinned: true,
    });
  });

  it("does not lose concurrent updates to different keys", async () => {
    await loadSettings();

    await Promise.all([
      updateSettings((current) => ({ ...current, pinned: true })),
      updateSettings((current) => ({ ...current, viewMode: "compact" })),
      updateSettings((current) => ({ ...current, pollIntervalSeconds: 300 })),
    ]);

    expect(await loadSettings()).toMatchObject({ pinned: true, viewMode: "compact", pollIntervalSeconds: 300 });
  });

  it("does not persist overrides through updates", async () => {
    await loadSettings({ pollIntervalSeconds: 600 });
    await fs.writeFile(mocks.settingsPath, JSON.stringify({ pollIntervalSeconds: 120 }), "utf8");

    expect((await loadSettings({ pollIntervalSeconds: 600 })).pollIntervalSeconds).toBe(600);
    await updateSettings((current) => ({ ...current, pinned: true }));

    expect(JSON.parse(await fs.readFile(mocks.settingsPath, "utf8")).pollIntervalSeconds).toBe(120);
  });

  it("quarantines a malformed file at startup and continues with defaults", async () => {
    await fs.writeFile(mocks.settingsPath, "{ not json", "utf8");
    const recovered: string[] = [];

    const settings = await loadSettingsAtStartup({}, (name) => recovered.push(name));

    expect(settings.pollIntervalSeconds).toBeGreaterThan(0);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatch(/^settings\.corrupt-\d+\.json$/);
    expect(await fs.readFile(path.join(tmp, recovered[0]), "utf8")).toBe("{ not json");
    expect(JSON.parse(await fs.readFile(mocks.settingsPath, "utf8"))).toHaveProperty("pollIntervalSeconds");
  });
});
