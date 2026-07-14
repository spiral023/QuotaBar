import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { flush, rendererHarness } from "./helpers/rendererHarness";

const script = fs.readFileSync("src/renderer/tabs/system.js", "utf8");
const styles = fs.readFileSync("src/renderer/styles.css", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const calculationGuide = fs.readFileSync("docs/how-quotabar-calculates.md", "utf8");
const testingGuide = fs.readFileSync("TESTING.md", "utf8");

function systemReport(portable: { status?: string | null; ready?: boolean } = {}) {
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
      portableMigrationStatus: portable.status ?? null,
      portableDataReady: portable.ready ?? false,
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

function byId(h: ReturnType<typeof transferHarness>, id: string) {
  const element = h.document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

describe("System portable data transfer controls", () => {
  it("documents portable imports separately from private same-machine backups", () => {
    expect(readme).toContain("System Import accepts only ZIPs created by **Export data**");
    expect(readme).toContain("private full same-machine safety backup");
    expect(readme).toContain("Fully quit QuotaBar");
    expect(readme).not.toContain("import that backup ZIP through the same System action");
    expect(calculationGuide).toContain("cannot be selected in System Import");
    expect(calculationGuide).not.toContain("either an exported archive or an automatic backup");
    expect(testingGuide).toContain("Never pass the automatic backup to System Import");
  });

  it("documents fixture isolation before any QuotaBar module is imported", () => {
    const fixtureIndex = testingGuide.indexOf("const fixtureRoot");
    const userProfileIndex = testingGuide.indexOf("process.env.USERPROFILE = fixtureRoot");
    const userDataIndex = testingGuide.indexOf("app.setPath('userData'");
    const moduleImportIndex = testingGuide.indexOf("require('./dist/main/detailsWindow.js')");

    expect(fixtureIndex).toBeGreaterThanOrEqual(0);
    expect(userProfileIndex).toBeGreaterThan(fixtureIndex);
    expect(userDataIndex).toBeGreaterThan(userProfileIndex);
    expect(moduleImportIndex).toBeGreaterThan(userDataIndex);
    expect(testingGuide).toContain("QB_FIXTURE_ROOT: fixtureRoot");
    expect(testingGuide).toContain("finally");
    expect(testingGuide).toContain("await fs.rm(fixtureRoot, { recursive: true, force: true })");
  });

  it.each([
    [{ status: "complete", ready: true }, "Portable data: Ready"],
    [{ status: "pending", ready: false }, "Portable data: Preparing"],
    [{ status: "running", ready: false }, "Portable data: Preparing"],
    [{ status: "failed", ready: false }, "Portable data: Needs attention"],
    [{ status: "complete", ready: false }, "Portable data: Needs attention"],
  ])("renders the safe portable readiness label for %j", async (portable, expected) => {
    const h = rendererHarness({
      "system:get": [systemReport(portable)],
      "update:get-state": [null],
      "dataSources:get": [{}],
      "settings:get": [{}],
    });
    h.run("src/renderer/tabs/system.js");

    await h.QB.renderSystem();

    expect(byId(h, "sys-portable-status")).toBeTruthy();
    expect(byId(h, "system-content").innerHTML).toContain(`id="sys-portable-status">${expected}</span>`);
  });

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

  it("acknowledges restart through a bounded fallback when animation frames never fire", async () => {
    const h = transferHarness({
      "system:import-portable-data": [{
        ok: true,
        restartScheduled: true,
        backupPath: "C:\\Backups\\hidden-window.zip",
      }],
      "system:confirm-portable-import-restart": [{ ok: true }],
    });
    (h.context as Record<string, unknown>).requestAnimationFrame = () => 1;
    await h.QB.renderSystem();

    void byId(h, "sys-import-portable-confirm").emit("click");
    await flush();

    expect(byId(h, "sys-transfer-result").textContent).toContain("C:\\Backups\\hidden-window.zip");
    expect(h.calls.at(-1)).toBe("system:import-portable-data");

    h.timers.advanceBy(250);
    await flush();

    expect(h.calls.slice(-2)).toEqual([
      "system:import-portable-data",
      "system:confirm-portable-import-restart",
    ]);
  });

  it("keeps successful deletion disabled until the scheduled rerender", async () => {
    const h = transferHarness({
      "system:delete-app-data": [{ ok: true, deleted: ["cache.json"] }],
    });
    await h.QB.renderSystem();

    const row = h.document.querySelectorAll(".sys-delete-row")[0];
    await row.emit("click");
    await byId(h, "sys-delete-confirm").emit("click");
    const execute = byId(h, "sys-del-execute");

    await execute.emit("click");
    await execute.emit("click");

    expect(execute.disabled).toBe(true);
    expect(h.calls.filter((channel) => channel === "system:delete-app-data")).toHaveLength(1);
  });

  it("keeps staged import recovery visible and retries rejected restart confirmation", async () => {
    const h = transferHarness({
      "system:import-portable-data": [{
        ok: true,
        restartScheduled: true,
        backupPath: "C:\\Backups\\recovery.zip",
      }],
      "system:confirm-portable-import-restart": [
        { ok: false, message: "No portable import restart is pending." },
        { ok: true },
      ],
    });
    (h.context as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => { callback(); return 1; };
    await h.QB.renderSystem();

    await byId(h, "sys-import-portable-confirm").emit("click");

    expect(byId(h, "sys-transfer-result").textContent).toContain("Import is ready");
    expect(byId(h, "sys-transfer-result").textContent).toContain("C:\\Backups\\recovery.zip");
    expect(byId(h, "sys-import-restart-retry").hidden).toBe(false);

    await byId(h, "sys-import-restart-retry").emit("click");

    expect(h.calls.filter((channel) => channel === "system:confirm-portable-import-restart")).toHaveLength(2);
    expect(byId(h, "sys-transfer-result").textContent).toBe("Restarting QuotaBar…");
  });

  it("sanitizes thrown restart errors while retaining staged recovery", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = transferHarness({
      "system:import-portable-data": [{
        ok: true,
        restartScheduled: true,
        backupPath: "C:\\Backups\\safe.zip",
      }],
      "system:confirm-portable-import-restart": [() => { throw new Error("raw secret detail"); }],
    });
    (h.context as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => { callback(); return 1; };
    await h.QB.renderSystem();

    await byId(h, "sys-import-portable-confirm").emit("click");

    expect(byId(h, "sys-transfer-result").textContent).toContain("Import is ready");
    expect(byId(h, "sys-transfer-result").textContent).not.toContain("raw secret detail");
    expect(errorLog).toHaveBeenCalledWith("system:import-portable-data failed");
    errorLog.mockRestore();
  });

  it("treats Import and Delete as exclusive accessible disclosures with focus return", async () => {
    const h = transferHarness({});
    await h.QB.renderSystem();
    const importToggle = byId(h, "sys-import-portable-data");
    const deleteToggle = byId(h, "sys-delete-toggle");
    const importPanel = byId(h, "sys-import-portable-panel");
    const deletePanel = byId(h, "sys-delete-panel");

    expect(importPanel.hidden).toBe(true);
    expect(deletePanel.hidden).toBe(true);
    expect(importToggle.getAttribute("aria-expanded")).toBe("false");
    expect(deleteToggle.getAttribute("aria-expanded")).toBe("false");

    await importToggle.emit("click");
    expect(importPanel.hidden).toBe(false);
    expect(deletePanel.hidden).toBe(true);
    expect(h.document.activeElement).toBe(byId(h, "sys-import-portable-confirm"));

    await deleteToggle.emit("click");
    expect(importPanel.hidden).toBe(true);
    expect(deletePanel.hidden).toBe(false);
    expect(importToggle.getAttribute("aria-expanded")).toBe("false");
    expect(deleteToggle.getAttribute("aria-expanded")).toBe("true");
    expect(h.document.activeElement).toBe(byId(h, "sys-delete-cancel"));

    await byId(h, "sys-delete-cancel").emit("click");
    expect(deletePanel.hidden).toBe(true);
    expect(h.document.activeElement).toBe(deleteToggle);
  });

  it("disables disclosure cancel and back controls so they cannot overwrite active export status", async () => {
    let finishExport!: (result: unknown) => void;
    const pendingExport = new Promise((resolve) => { finishExport = resolve; });
    const h = transferHarness({ "system:export-portable-data": [pendingExport] });
    await h.QB.renderSystem();

    await byId(h, "sys-delete-toggle").emit("click");
    await h.document.querySelectorAll(".sys-delete-row")[0].emit("click");
    await byId(h, "sys-delete-confirm").emit("click");
    await byId(h, "sys-import-portable-data").emit("click");

    const exportClick = byId(h, "sys-export-portable-data").emit("click");
    await flush();

    for (const id of [
      "sys-import-portable-cancel",
      "sys-import-portable-confirm",
      "sys-import-restart-retry",
      "sys-delete-cancel",
      "sys-del-back",
      "sys-del-execute",
    ]) {
      expect(byId(h, id).disabled).toBe(true);
    }
    await byId(h, "sys-import-portable-cancel").emit("click");
    expect(byId(h, "sys-transfer-result").textContent).toBe("Preparing archive…");

    finishExport({ ok: false, cancelled: true });
    await exportClick;
  });

  it("restores staged recovery into the current connected UI after rerender", async () => {
    const h = transferHarness({
      "system:import-portable-data": [{
        ok: true,
        restartScheduled: true,
        backupPath: "C:\\Backups\\rerendered.zip",
      }],
      "system:confirm-portable-import-restart": [{ ok: false }],
    });
    (h.context as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => { callback(); return 1; };
    await h.QB.renderSystem();
    await byId(h, "sys-import-portable-confirm").emit("click");
    const removedRetry = byId(h, "sys-import-restart-retry");

    await h.QB.renderSystem();

    const currentRetry = byId(h, "sys-import-restart-retry");
    expect(currentRetry).not.toBe(removedRetry);
    expect(removedRetry.isConnected).toBe(false);
    expect(currentRetry.isConnected).toBe(true);
    expect(byId(h, "sys-import-portable-panel").hidden).toBe(false);
    expect(byId(h, "sys-transfer-result").textContent).toContain("C:\\Backups\\rerendered.zip");
    expect(byId(h, "sys-import-portable-data").disabled).toBe(true);
    expect(currentRetry.hidden).toBe(false);
    expect(h.document.activeElement).toBe(currentRetry);
  });

  it("applies pending confirmation failure to the live UI after a rerender", async () => {
    let finishConfirmation!: (result: unknown) => void;
    const pendingConfirmation = new Promise((resolve) => { finishConfirmation = resolve; });
    const h = transferHarness({
      "system:import-portable-data": [{
        ok: true,
        restartScheduled: true,
        backupPath: "C:\\Backups\\pending-rerender.zip",
      }],
      "system:confirm-portable-import-restart": [pendingConfirmation],
    });
    (h.context as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => { callback(); return 1; };
    await h.QB.renderSystem();

    const importClick = byId(h, "sys-import-portable-confirm").emit("click");
    await flush();
    await h.QB.renderSystem();
    const currentRetry = byId(h, "sys-import-restart-retry");

    expect(byId(h, "sys-import-portable-panel").hidden).toBe(false);
    expect(currentRetry.hidden).toBe(false);
    expect(currentRetry.disabled).toBe(true);
    expect(byId(h, "sys-transfer-result").textContent).toContain("C:\\Backups\\pending-rerender.zip");

    finishConfirmation({ ok: false });
    await importClick;

    expect(byId(h, "sys-import-restart-retry")).toBe(currentRetry);
    expect(currentRetry.disabled).toBe(false);
    expect(h.document.activeElement).toBe(currentRetry);
    expect(byId(h, "sys-transfer-result").textContent).toContain("Restart confirmation failed");
  });

  it("recovers safe controls when the post-delete refresh fails without allowing repeat deletion", async () => {
    const h = transferHarness({
      "system:get": [systemReport(), () => { throw new Error("refresh failed"); }],
      "system:delete-app-data": [{ ok: true, deleted: ["cache.json"] }],
    });
    await h.QB.renderSystem();
    await h.document.querySelectorAll(".sys-delete-row")[0].emit("click");
    await byId(h, "sys-delete-confirm").emit("click");
    const execute = byId(h, "sys-del-execute");
    await execute.emit("click");

    h.timers.advanceBy(1_200);
    await flush();

    expect(byId(h, "sys-export-portable-data").disabled).toBe(false);
    expect(byId(h, "sys-import-portable-data").disabled).toBe(false);
    expect(byId(h, "sys-delete-toggle").disabled).toBe(true);
    expect(execute.disabled).toBe(true);
    expect(byId(h, "sys-transfer-result").textContent).toContain("Scan");

    await execute.emit("click");
    expect(h.calls.filter((channel) => channel === "system:delete-app-data")).toHaveLength(1);
  });
});
