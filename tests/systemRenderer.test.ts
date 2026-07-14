import { describe, expect, it, vi } from "vitest";
import { rendererHarness } from "./helpers/rendererHarness";

describe("system renderer portable import workflow", () => {
  it("acknowledges restart only after the successful import result is processed", async () => {
    const h = rendererHarness({
      "system:import-portable-data": [{
        ok: true,
        restartScheduled: true,
        backupPath: "C:\\Backups\\verified.zip",
        fileCount: 3,
        totalBytes: 96,
      }],
      "system:confirm-portable-import-restart": [{ ok: true }],
    });
    h.run("src/renderer/tabs/system.js");
    const processed = vi.fn(async () => {
      expect(h.calls).toEqual(["system:import-portable-data"]);
    });

    const result = await h.QB.importPortableData(processed);

    expect(result).toMatchObject({ ok: true, restartScheduled: true });
    expect(processed).toHaveBeenCalledWith(expect.objectContaining({ backupPath: "C:\\Backups\\verified.zip" }));
    expect(h.calls).toEqual([
      "system:import-portable-data",
      "system:confirm-portable-import-restart",
    ]);
  });

  it("does not acknowledge restart after a cancelled import", async () => {
    const h = rendererHarness({
      "system:import-portable-data": [{ ok: false, cancelled: true }],
    });
    h.run("src/renderer/tabs/system.js");
    const processed = vi.fn();

    await expect(h.QB.importPortableData(processed)).resolves.toEqual({ ok: false, cancelled: true });

    expect(processed).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["system:import-portable-data"]);
  });

  it("does not acknowledge a successful import without a result processor", async () => {
    const h = rendererHarness({
      "system:import-portable-data": [{ ok: true, restartScheduled: true }],
    });
    h.run("src/renderer/tabs/system.js");

    await expect(h.QB.importPortableData()).rejects.toThrow("Portable import success handler is required");

    expect(h.calls).toEqual(["system:import-portable-data"]);
  });

  it("does not report import success when restart confirmation is rejected", async () => {
    const h = rendererHarness({
      "system:import-portable-data": [{ ok: true, restartScheduled: true }],
      "system:confirm-portable-import-restart": [{
        ok: false,
        error: "portable_import_restart_not_pending",
        message: "No portable import restart is pending.",
      }],
    });
    h.run("src/renderer/tabs/system.js");

    await expect(h.QB.importPortableData(vi.fn())).rejects.toThrow(
      "Portable import restart confirmation failed",
    );
    expect(h.calls).toEqual([
      "system:import-portable-data",
      "system:confirm-portable-import-restart",
    ]);
  });
});
