import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultNotificationSettings } from "../src/config/settings";
import { NotificationLog } from "../src/main/notificationLog";
import { NotificationService } from "../src/main/notifications";
import { createShutdownDrain } from "../src/main/shutdown";
import { withPortableRootLock } from "../src/portable/rootLock";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("application shutdown drain", () => {
  it("waits for latest notification state and log before recorder flush, once across reentry", async () => {
    const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-shutdown-drain-"));
    roots.push(appDir);
    const statePath = path.join(appDir, "notification-state.json");
    const logPath = path.join(appDir, "notifications.log");
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const lockHolder = withPortableRootLock(appDir, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await acquiredPromise;
    const notificationLog = new NotificationLog(logPath);
    const service = new NotificationService(defaultNotificationSettings, { statePath, notificationLog });
    service.dismissUpdateVersion("1.2.3");
    const order: string[] = [];
    const drain = createShutdownDrain({
      stopIngestion: async () => { order.push("ingestion"); },
      flushNotifications: async () => { await service.flush(); order.push("notifications"); },
      flushRecorder: async () => { order.push("recorder"); },
      warn: vi.fn(),
    });

    const first = drain();
    const second = drain();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(order).toEqual(["ingestion"]);
    release();
    await Promise.all([lockHolder, first, second]);

    expect(order).toEqual(["ingestion", "notifications", "recorder"]);
    expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toMatchObject({ dismissedUpdateVersion: "1.2.3" });
    expect(await fs.readFile(logPath, "utf8")).toContain('"evt":"start"');
  });

  it("reports a fixed sanitized warning and still flushes the recorder after notification failure", async () => {
    const warn = vi.fn();
    const order: string[] = [];
    const drain = createShutdownDrain({
      stopIngestion: async () => { order.push("ingestion"); },
      flushNotifications: async () => { throw new Error("secret C:/private/token"); },
      flushRecorder: async () => { order.push("recorder"); },
      warn,
    });

    await drain();

    expect(order).toEqual(["ingestion", "recorder"]);
    expect(warn).toHaveBeenCalledWith("Notification persistence flush failed during shutdown");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });
});
