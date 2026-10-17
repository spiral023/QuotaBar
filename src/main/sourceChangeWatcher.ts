import fs from "node:fs";
import { log } from "./logging";

export interface SourceChangeWatcher {
  /** True when the sources may have changed since the previous call. */
  consume(): boolean;
  close(): void;
}

export interface SourceChangeWatcherOptions {
  /**
   * Upper bound between forced scans. Recursive watches can drop events under
   * bursty writes, and a watch that failed to attach reports nothing at all, so
   * a scan is allowed through at least this often regardless of watch activity.
   */
  forceIntervalMs?: number;
  now?: () => number;
  watch?: (path: string, options: { recursive: boolean }, listener: () => void) => fs.FSWatcher;
}

const DEFAULT_FORCE_INTERVAL_MS = 60_000;

/**
 * Listing the agent source trees costs over a second on a large history, and
 * the ingestion loop did it on every tick regardless of activity. Watching the
 * roots turns that into work that only happens when something actually changed.
 *
 * A root that cannot be watched (UNC and WSL paths are the realistic cases) is
 * covered by the forced scan instead, so its changes arrive within one force
 * interval. Only when no root is watched at all does every tick scan, as before.
 * Letting one small unwatchable root disable the watch for all the others made
 * every tick list the full local history.
 */
export function watchSourceRoots(
  roots: readonly string[],
  options: SourceChangeWatcherOptions = {},
): SourceChangeWatcher {
  const forceIntervalMs = options.forceIntervalMs ?? DEFAULT_FORCE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const watch = options.watch ?? ((path, opts, listener) => fs.watch(path, opts, listener));

  const watchers: fs.FSWatcher[] = [];
  let healthyWatchers = 0;
  let dirty = true;
  let lastForced = 0;

  for (const root of roots) {
    try {
      const watcher = watch(root, { recursive: true }, () => { dirty = true; });
      let healthy = true;
      watcher.on("error", (error: unknown) => {
        if (healthy) {
          healthy = false;
          healthyWatchers -= 1;
        }
        // Events may have been lost before the failure surfaced.
        dirty = true;
        log.warn(`Source watch failed, covering it with periodic scans: ${error instanceof Error ? error.message : String(error)}`);
      });
      watchers.push(watcher);
      healthyWatchers += 1;
    } catch (error) {
      log.warn(`Source watch unavailable, covering it with periodic scans: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    consume(): boolean {
      const timestamp = now();
      if (healthyWatchers <= 0) return true;
      if (dirty || timestamp - lastForced >= forceIntervalMs) {
        dirty = false;
        lastForced = timestamp;
        return true;
      }
      return false;
    },
    close(): void {
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // Closing a watcher that already errored out is not actionable.
        }
      }
      watchers.length = 0;
    },
  };
}
