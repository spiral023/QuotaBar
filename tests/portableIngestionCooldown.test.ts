import { describe, expect, it } from "vitest";
import { createPortableIngestionLifecycle, type PortableIngestionRunner } from "../src/main/debugBackfill";

// Each scheduled pass is followed by a cooldown as long as the pass itself, so a
// cycle that outlasts the 15s tick no longer keeps the main process busy
// back-to-back. Manual and startup triggers bypass it.

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

function harness(passDurationMs: number) {
  let clock = 0;
  const triggers: string[] = [];
  const runner: PortableIngestionRunner = {
    trigger: (reason) => {
      triggers.push(reason);
      // A pass consumes time on the fake clock before it settles.
      return Promise.resolve().then(() => { clock += passDurationMs; });
    },
  };
  let poll: (() => void) | undefined;
  const lifecycle = createPortableIngestionLifecycle(runner, {
    setInterval: (callback) => { poll = callback; return 1 as unknown as NodeJS.Timeout; },
    clearInterval: () => undefined,
    now: () => clock,
  }, {});
  return {
    lifecycle, triggers,
    tick: () => poll?.(),
    advance: (ms: number) => { clock += ms; },
    scheduled: () => triggers.filter((reason) => reason === "source-change").length,
  };
}

describe("portable ingestion cooldown", () => {
  it("skips ticks while the cooldown from a long pass is active", async () => {
    const h = harness(40_000);           // pass takes far longer than a tick
    await h.lifecycle.start();
    await flush();

    h.tick();                            // starts a pass, clock jumps 40s
    await flush();
    expect(h.scheduled()).toBe(1);

    h.advance(15_000);
    h.tick();
    await flush();
    expect(h.scheduled()).toBe(1);       // still cooling down

    h.advance(15_000);
    h.tick();
    await flush();
    expect(h.scheduled()).toBe(1);
  });

  it("runs again once the cooldown has elapsed", async () => {
    const h = harness(20_000);
    await h.lifecycle.start();
    await flush();

    h.tick();
    await flush();
    expect(h.scheduled()).toBe(1);

    h.advance(20_001);                   // cooldown equals the 20s pass
    h.tick();
    await flush();
    expect(h.scheduled()).toBe(2);
  });

  it("does not throttle fast passes", async () => {
    const h = harness(0);
    await h.lifecycle.start();
    await flush();

    for (let index = 0; index < 4; index += 1) {
      h.advance(15_000);
      h.tick();
      await flush();
    }
    expect(h.scheduled()).toBe(4);
  });

  it("caps the cooldown so usage still appears promptly", async () => {
    const h = harness(300_000);          // absurdly long pass
    await h.lifecycle.start();
    await flush();

    h.tick();
    await flush();
    expect(h.scheduled()).toBe(1);

    h.advance(60_001);                   // cap is 60s, not 300s
    h.tick();
    await flush();
    expect(h.scheduled()).toBe(2);
  });

  it("lets manual triggers through during a cooldown", async () => {
    const h = harness(40_000);
    await h.lifecycle.start();
    await flush();

    h.tick();
    await flush();
    await h.lifecycle.trigger("manual-recompute");
    await flush();

    expect(h.triggers).toContain("manual-recompute");
  });

  it("runs the startup pass immediately", async () => {
    const h = harness(40_000);
    await h.lifecycle.start();
    await flush();
    expect(h.triggers[0]).toBe("startup");
  });
});
