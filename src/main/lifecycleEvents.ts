import { powerMonitor } from "electron";
import type { DebugRecorder } from "./debugRecorder";
import { log } from "./logging";

export interface LifecycleDeps {
  recorder: DebugRecorder;
  onResume: () => void;
}

/**
 * Registers powerMonitor listeners so that sleep/wake and lock/unlock gaps in
 * polling become explainable in the debug log. On resume it also triggers an
 * immediate refresh via the injected callback.
 */
export function registerLifecycleEvents(deps: LifecycleDeps): void {
  let suspendedAt: number | null = null;

  powerMonitor.on("suspend", () => {
    suspendedAt = Date.now();
    deps.recorder.write({ kind: "system.suspend" });
    log.info("system suspend");
  });

  powerMonitor.on("resume", () => {
    const sleepSeconds = suspendedAt !== null ? Math.round((Date.now() - suspendedAt) / 1000) : 0;
    suspendedAt = null;
    deps.recorder.write({ kind: "system.resume", sleepSeconds });
    log.info(`system resume after ${sleepSeconds}s`);
    deps.onResume();
  });

  powerMonitor.on("lock-screen", () => {
    deps.recorder.write({ kind: "system.lock" });
  });

  powerMonitor.on("unlock-screen", () => {
    deps.recorder.write({ kind: "system.unlock" });
  });
}
