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

import { loadSettings } from "../src/config/settings";

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

  it("does not overwrite an existing malformed settings file", async () => {
    await fs.writeFile(mocks.settingsPath, "{ not json", "utf8");

    await loadSettings();

    expect(await fs.readFile(mocks.settingsPath, "utf8")).toBe("{ not json");
  });
});
