import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings, saveSettings } from "../src/config/settings";
import { exportPortableData } from "../src/portable/archiveService";
import { withPortableRootLock } from "../src/portable/rootLock";
import { saveBonusStateFile } from "../src/usage/bonusStateStore";
import { BONUS_STATE_VERSION } from "../src/usage/bonusReset";
import { saveWindowHistoryFile } from "../src/usage/windowHistoryStore";
import { saveWindowRatioFile } from "../src/usage/windowRatioStore";
import { emptyRatioFile } from "../src/usage/windowRatio";
import { NotificationLog } from "../src/main/notificationLog";
import { saveNotificationStateFile } from "../src/main/notifications";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed app-data writer lock", () => {
  it("blocks every asynchronous root-state writer while the archive app lock is held", async () => {
    const writers = [
      async (appDir: string) => saveSettings(defaultSettings, { appDir }),
      async (appDir: string) => saveBonusStateFile(path.join(appDir, "bonus-state.json"), { version: BONUS_STATE_VERSION, providers: {} }),
      async (appDir: string) => saveWindowHistoryFile(path.join(appDir, "window-history.json"), { version: 2, entries: [] }),
      async (appDir: string) => saveWindowRatioFile(path.join(appDir, "window-ratio.json"), emptyRatioFile()),
    ];
    for (const writer of writers) {
      const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-app-writer-lock-"));
      roots.push(appDir);
      let release!: () => void;
      let acquired!: () => void;
      const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
      const holder = withPortableRootLock(appDir, async () => {
        acquired();
        await new Promise<void>((resolve) => { release = resolve; });
      });
      await acquiredPromise;
      let completed = false;
      const writing = writer(appDir).then(() => { completed = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(completed).toBe(false);
      release();
      await Promise.all([holder, writing]);
    }
  });

  it("blocks export while an ordinary writer owns the app-data lock", async () => {
    const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-app-export-lock-"));
    roots.push(appDir);
    await fs.writeFile(path.join(appDir, "settings.json"), "{}");
    const archivePath = path.join(path.dirname(appDir), `${path.basename(appDir)}.zip`);
    roots.push(archivePath);
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withPortableRootLock(appDir, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await acquiredPromise;
    let completed = false;
    const exporting = exportPortableData(appDir, archivePath).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(completed).toBe(false);
    release();
    await Promise.all([holder, exporting]);
  });

  it("does not let a stale queued writer overwrite data restored while it waited", async () => {
    const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-stale-writer-"));
    roots.push(appDir);
    const filePath = path.join(appDir, "bonus-state.json");
    await fs.writeFile(filePath, "before-archive", "utf8");
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withPortableRootLock(appDir, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
      await fs.writeFile(filePath, "restored-by-archive", "utf8");
    });
    await acquiredPromise;
    const staleWrite = saveBonusStateFile(filePath, { version: BONUS_STATE_VERSION, providers: {} });
    await new Promise((resolve) => setTimeout(resolve, 75));
    release();
    await holder;

    await expect(staleWrite).rejects.toThrow("App data changed while waiting for the write lock");
    expect(await fs.readFile(filePath, "utf8")).toBe("restored-by-archive");
  });

  it("locks queued notification-state and notification-log rewrites", async () => {
    const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-notification-writer-"));
    roots.push(appDir);
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withPortableRootLock(appDir, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await acquiredPromise;
    let stateCompleted = false;
    const stateWrite = saveNotificationStateFile(path.join(appDir, "notification-state.json"), { dismissedUpdateVersion: "1.2.3" })
      .then(() => { stateCompleted = true; });
    const log = new NotificationLog(path.join(appDir, "notifications.log"));
    log.write({
      ruleId: "highUsage", provider: "claude", severity: "warning", title: "High usage",
      body: "Body", firedAt: "2026-07-14T00:00:00.000Z", reason: "test",
    });
    let logCompleted = false;
    const logWrite = log.flush().then(() => { logCompleted = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stateCompleted).toBe(false);
    expect(logCompleted).toBe(false);
    release();
    await Promise.all([holder, stateWrite, logWrite]);
  });
});
