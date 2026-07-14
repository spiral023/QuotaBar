import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/config/settings";
import { PortableImportApplyError } from "../src/portable/archiveService";
import { loadInitialStartupState } from "../src/main/pendingImportStartup";

describe("pending portable import startup", () => {
  it("applies pending data before first-run and settings reads, then continues", async () => {
    const calls: string[] = [];
    const log = { info: vi.fn(), error: vi.fn() };
    const result = await loadInitialStartupState({ pollIntervalSeconds: 90 }, {
      applyPendingImport: async () => {
        calls.push("apply");
        return { applied: true, fileCount: 4, totalBytes: 128 };
      },
      isFirstRun: async () => { calls.push("first-run"); return false; },
      loadSettings: async (overrides) => { calls.push("settings"); return { ...defaultSettings, ...overrides }; },
      log,
    });

    expect(calls).toEqual(["apply", "first-run", "settings"]);
    expect(result).toMatchObject({ firstRun: false, settings: { pollIntervalSeconds: 90 } });
    expect(log.info).toHaveBeenCalledWith("Portable pending import applied files=4 bytes=128");
  });

  it.each(["completed", "pending-recovery", "not-attempted"] as const)(
    "logs the actual %s rollback outcome and aborts normal reads",
    async (rollbackOutcome) => {
      const isFirstRun = vi.fn();
      const loadSettings = vi.fn();
      const log = { info: vi.fn(), error: vi.fn() };

      await expect(loadInitialStartupState({}, {
        applyPendingImport: async () => { throw new PortableImportApplyError(rollbackOutcome); },
        isFirstRun,
        loadSettings,
        log,
      })).rejects.toThrow("Portable pending import apply failed");

      expect(isFirstRun).not.toHaveBeenCalled();
      expect(loadSettings).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        `Portable pending import apply failed rollback=${rollbackOutcome} error=Portable data apply failed`,
      );
    },
  );

  it("does not invent a rollback outcome for an unexpected apply failure", async () => {
    const log = { info: vi.fn(), error: vi.fn() };

    await expect(loadInitialStartupState({}, {
      applyPendingImport: async () => { throw new Error("sensitive unexpected detail"); },
      isFirstRun: vi.fn(),
      loadSettings: vi.fn(),
      log,
    })).rejects.toThrow("Portable pending import apply failed");

    expect(log.error).toHaveBeenCalledWith(
      "Portable pending import apply failed rollback=unknown error=Portable data apply failed",
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("sensitive unexpected detail");
  });

  it("wires the runtime startup loader inside whenReady", async () => {
    const source = await readFile(path.resolve("src/main/main.ts"), "utf8");
    const whenReady = source.indexOf("app.whenReady()");
    const startupLoad = source.indexOf("await loadInitialStartupState(", whenReady);

    expect(whenReady).toBeGreaterThan(-1);
    expect(startupLoad).toBeGreaterThan(whenReady);
  });
});
