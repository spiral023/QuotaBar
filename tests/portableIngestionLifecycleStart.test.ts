import { describe, expect, it, vi } from "vitest";
import { createPortableIngestionLifecycle, createPortableIngestionRunner } from "../src/main/debugBackfill";

// start() awaits the startup ingest. It must resolve once *that* pass is done —
// not wait for every follow-up cycle the interval keeps requesting. When an
// ingest takes longer than the 15s interval, waiting for all of them never
// returns, and everything after it in main.ts (tray menu, refresh loop) is
// never reached.

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

function harness() {
  let releaseRun: (() => void) | undefined;
  const runs: Array<() => void> = [];
  const run = vi.fn(() => new Promise<void>((resolve) => {
    releaseRun = resolve;
    runs.push(resolve);
  }));
  const runner = createPortableIngestionRunner(run);
  let poll: (() => void) | undefined;
  const lifecycle = createPortableIngestionLifecycle(runner, {
    setInterval: (callback) => { poll = callback; return 1 as unknown as NodeJS.Timeout; },
    clearInterval: () => undefined,
  });
  return {
    lifecycle, run, runs,
    tick: () => poll?.(),
    release: () => releaseRun?.(),
  };
}

describe("portable ingestion lifecycle start", () => {
  it("resolves start() once the startup pass finishes, even while later cycles run", async () => {
    const { lifecycle, runs, tick, release } = harness();
    let started = false;
    const startPromise = lifecycle.start().then(() => { started = true; });

    await flush();
    expect(runs).toHaveLength(1);

    // The interval fires while the startup pass is still running — exactly what
    // happens when a cycle outlasts the interval.
    tick();
    tick();
    await flush();

    release();          // startup pass completes
    await flush();

    expect(started).toBe(true);
    await startPromise;
  });

  it("does not block start() when cycles keep being requested", async () => {
    const { lifecycle, tick, release, runs } = harness();
    let started = false;
    const startPromise = lifecycle.start().then(() => { started = true; });
    await flush();

    release();
    await flush();
    for (let index = 0; index < 3; index += 1) {
      tick();
      await flush();
      release();
      await flush();
    }
    expect(started).toBe(true);
    expect(runs.length).toBeGreaterThan(1);
    await startPromise;
  });
});
