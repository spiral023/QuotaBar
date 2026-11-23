import { describe, expect, it, vi } from "vitest";
import {
  PORTABLE_PREPARATION_RETRY_DELAYS_MS,
  preparePortableDataWithRetry,
  type PreparePortableDataResult,
} from "../src/main/debugBackfill";

const complete: PreparePortableDataResult = { status: "complete", ingested: 1, legacyInserted: 0, quotaSnapshots: 0 };

describe("preparePortableDataWithRetry", () => {
  it("retries a failed preparation with increasing backoff until it completes", async () => {
    const prepare = vi.fn<() => Promise<PreparePortableDataResult>>()
      .mockRejectedValueOnce(Object.assign(new Error("Portable data preparation failed at ingestion (EBUSY)"), { code: "EBUSY" }))
      .mockRejectedValueOnce(new Error("Portable data preparation failed at quota_migration"))
      .mockResolvedValueOnce(complete);
    const waits: number[] = [];
    const retries: Array<[string, number, number]> = [];

    const result = await preparePortableDataWithRetry(prepare, {
      stopSignal: new AbortController().signal,
      wait: async (ms) => { waits.push(ms); },
      onRetry: (error, attempt, delayMs) => retries.push([(error as Error).message, attempt, delayMs]),
    });

    expect(result).toBe(complete);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(waits).toEqual(PORTABLE_PREPARATION_RETRY_DELAYS_MS.slice(0, 2));
    expect(retries.map(([message, attempt]) => [message, attempt])).toEqual([
      ["Portable data preparation failed at ingestion (EBUSY)", 1],
      ["Portable data preparation failed at quota_migration", 2],
    ]);
  });

  it("keeps retrying at the longest delay", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await preparePortableDataWithRetry(async () => {
      calls += 1;
      if (calls <= 4) throw new Error("still locked");
      return complete;
    }, {
      stopSignal: new AbortController().signal,
      delaysMs: [10, 20],
      wait: async (ms) => { waits.push(ms); },
    });

    expect(result).toBe(complete);
    expect(waits).toEqual([10, 20, 20, 20]);
  });

  it("does not retry a superseded preparation", async () => {
    const prepare = vi.fn(async (): Promise<PreparePortableDataResult> => ({ status: "superseded" }));

    await expect(preparePortableDataWithRetry(prepare, { stopSignal: new AbortController().signal }))
      .resolves.toEqual({ status: "superseded" });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("stops waiting as soon as shutdown begins", async () => {
    const stop = new AbortController();
    const prepare = vi.fn(async (): Promise<PreparePortableDataResult> => { throw new Error("locked"); });

    const running = preparePortableDataWithRetry(prepare, {
      stopSignal: stop.signal,
      delaysMs: [60 * 60_000],
      onRetry: () => stop.abort(),
    });

    await expect(running).resolves.toEqual({ status: "stopped" });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("does not start when already stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const prepare = vi.fn(async () => complete);

    await expect(preparePortableDataWithRetry(prepare, { stopSignal: stop.signal })).resolves.toEqual({ status: "stopped" });
    expect(prepare).not.toHaveBeenCalled();
  });
});
