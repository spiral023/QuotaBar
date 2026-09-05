import { EventEmitter } from "node:events";
import type fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { watchSourceRoots } from "../src/main/sourceChangeWatcher";

vi.mock("../src/main/logging", () => ({ log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
}

function harness(rootCount = 1) {
  const watchers: FakeWatcher[] = [];
  const listeners: Array<() => void> = [];
  let clock = 0;
  const watcher = watchSourceRoots(
    Array.from({ length: rootCount }, (_, index) => `/root-${index}`),
    {
      now: () => clock,
      watch: (_path, _options, listener) => {
        const fake = new FakeWatcher();
        watchers.push(fake);
        listeners.push(listener);
        return fake as unknown as fs.FSWatcher;
      },
    },
  );
  return { watcher, watchers, listeners, advance: (ms: number) => { clock += ms; } };
}

describe("watchSourceRoots", () => {
  it("reports the first consume so startup always scans", () => {
    const { watcher } = harness();
    expect(watcher.consume()).toBe(true);
  });

  it("stays quiet while nothing changes", () => {
    const { watcher } = harness();
    watcher.consume();
    expect(watcher.consume()).toBe(false);
    expect(watcher.consume()).toBe(false);
  });

  it("reports a change once and then goes quiet again", () => {
    const { watcher, listeners } = harness();
    watcher.consume();
    listeners[0]();
    expect(watcher.consume()).toBe(true);
    expect(watcher.consume()).toBe(false);
  });

  it("forces a scan once the interval elapses even without events", () => {
    const { watcher, advance } = harness();
    watcher.consume();
    expect(watcher.consume()).toBe(false);
    advance(60_000);
    expect(watcher.consume()).toBe(true);
    expect(watcher.consume()).toBe(false);
  });

  it("falls back to always scanning when a root cannot be watched", () => {
    const watcher = watchSourceRoots(["/unwatchable"], {
      watch: () => { throw new Error("EINVAL"); },
    });
    expect(watcher.consume()).toBe(true);
    expect(watcher.consume()).toBe(true);
  });

  it("falls back to always scanning after a watcher errors at runtime", () => {
    const { watcher, watchers } = harness();
    watcher.consume();
    expect(watcher.consume()).toBe(false);
    watchers[0].emit("error", new Error("ERROR_NOTIFY_ENUM_DIR"));
    expect(watcher.consume()).toBe(true);
    expect(watcher.consume()).toBe(true);
  });

  it("falls back to always scanning when there are no roots", () => {
    const watcher = watchSourceRoots([], { watch: () => { throw new Error("unused"); } });
    expect(watcher.consume()).toBe(true);
    expect(watcher.consume()).toBe(true);
  });

  it("notices changes from any watched root", () => {
    const { watcher, listeners } = harness(2);
    watcher.consume();
    listeners[1]();
    expect(watcher.consume()).toBe(true);
  });

  it("closes every watcher it opened", () => {
    const { watcher, watchers } = harness(2);
    watcher.close();
    expect(watchers.every((item) => item.closed)).toBe(true);
  });
});
