import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { flush, rendererHarness } from "./helpers/rendererHarness";

const script = fs.readFileSync("src/renderer/tabs/system.js", "utf8");
const styles = fs.readFileSync("src/renderer/styles.css", "utf8");

function systemReport() {
  return {
    generatedAt: "2026-07-14T00:00:00.000Z",
    scanDurationMs: 4,
    quickStatsLoadDurationMs: 2,
    totals: { fileCount: 0, totalBytes: 0, lastModifiedAt: null },
    agents: [],
    categories: [],
    app: {
      totals: { fileCount: 0, totalBytes: 0, lastModifiedAt: null },
      paths: [],
      variant: { label: "Development" },
    },
  };
}

function transferHarness(extraResponses: Record<string, unknown[]>) {
  const h = rendererHarness({
    "system:get": [systemReport()],
    "update:get-state": [null],
    "dataSources:get": [{}],
    "settings:get": [{}],
    ...extraResponses,
  });
  h.run("src/renderer/tabs/system.js");
  return h;
}

describe("System portable data transfer controls", () => {
  it("renders stable, accessible English export and import controls beside data deletion", () => {
    expect(script).toContain('id="sys-export-portable-data"');
    expect(script).toContain('id="sys-import-portable-data"');
    expect(script).toContain('id="sys-delete-toggle"');
    expect(script).toContain("Export data");
    expect(script).toContain("Import data");
    expect(script).toContain('class="sys-transfer-result"');
    expect(script).toContain('role="status"');
    expect(script).toContain('aria-live="polite"');
  });

  it("explains replacement, automatic backup, and restart before import confirmation", () => {
    expect(script).toContain("Import replaces portable statistics and settings");
    expect(script).toContain("A backup is created automatically");
    expect(script).toContain("QuotaBar restarts after a successful import");
    expect(script).toContain('id="sys-import-portable-confirm"');
    expect(script).toContain('id="sys-import-portable-cancel"');
  });

  it("invokes the narrow portable transfer channels and communicates every outcome", () => {
    expect(script).toContain("system:export-portable-data");
    expect(script).toContain("system:import-portable-data");
    expect(script).toContain("Preparing archive…");
    expect(script).toContain("Validating and backing up…");
    expect(script).toContain("Export cancelled.");
    expect(script).toContain("Import cancelled.");
    expect(script).toContain("Exported to ");
    expect(script).toContain("Backup created at ");
  });

  it("uses one transfer busy flag to disable all destructive and repeat actions", () => {
    expect(script.match(/let _transferBusy = false;/g)).toHaveLength(1);
    expect(script).toMatch(/function setTransferBusy[\s\S]*sys-export-portable-data[\s\S]*sys-import-portable-data[\s\S]*sys-delete-toggle[\s\S]*sys-import-portable-confirm/);
    expect(script).toContain("if (_transferBusy) return;");
  });

  it("writes main-process results as text and keeps archive content copy credential-free", () => {
    expect(script).toMatch(/function setTransferResult[\s\S]*textContent/);
    const transferMarkup = script.slice(
      script.indexOf('id="sys-export-portable-data"'),
      script.indexOf('id="sys-delete-panel"'),
    );
    expect(transferMarkup.toLowerCase()).not.toMatch(/credential|authorization|jwt|cookie|token/);
  });

  it("styles the compact confirmation and status region in the existing System language", () => {
    expect(styles).toContain(".sys-transfer-panel");
    expect(styles).toContain(".sys-transfer-result");
    expect(styles).toContain(".sys-transfer-actions");
  });

  it("disables every data action while export is pending and reports its destination", async () => {
    let finishExport!: (result: unknown) => void;
    const pendingExport = new Promise((resolve) => { finishExport = resolve; });
    const h = transferHarness({ "system:export-portable-data": [pendingExport] });
    await h.QB.renderSystem();

    const exportButton = h.document.getElementById("sys-export-portable-data");
    const click = exportButton.emit("click");
    await flush();

    expect(h.document.getElementById("sys-transfer-result").textContent).toBe("Preparing archive…");
    for (const id of ["sys-export-portable-data", "sys-import-portable-data", "sys-delete-toggle", "sys-import-portable-confirm"]) {
      expect(h.document.getElementById(id).disabled).toBe(true);
    }

    finishExport({ ok: true, path: "C:\\Exports\\portable.zip" });
    await click;

    expect(h.document.getElementById("sys-transfer-result").textContent).toBe("Exported to C:\\Exports\\portable.zip");
    expect(exportButton.disabled).toBe(false);
    expect(h.calls).toContain("system:export-portable-data");
  });

  it("displays backup success before acknowledging the import restart", async () => {
    const frames: Array<() => void> = [];
    const h = transferHarness({
      "system:import-portable-data": [{
        ok: true,
        restartScheduled: true,
        backupPath: "C:\\Backups\\before-import.zip",
      }],
      "system:confirm-portable-import-restart": [{ ok: true }],
    });
    (h.context as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    };
    await h.QB.renderSystem();

    const click = h.document.getElementById("sys-import-portable-confirm").emit("click");
    await flush();

    expect(h.document.getElementById("sys-transfer-result").textContent).toBe("Backup created at C:\\Backups\\before-import.zip");
    expect(h.calls.at(-1)).toBe("system:import-portable-data");

    frames.shift()?.();
    await flush();
    frames.shift()?.();
    await click;

    expect(h.calls.slice(-2)).toEqual([
      "system:import-portable-data",
      "system:confirm-portable-import-restart",
    ]);
  });
});
