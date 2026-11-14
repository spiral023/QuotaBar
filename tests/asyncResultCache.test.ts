import { describe, expect, it } from "vitest";
import { AsyncResultCache } from "../src/main/asyncResultCache";

describe("AsyncResultCache", () => {
  it("reuses the same in-flight promise for matching keys", async () => {
    const cache = new AsyncResultCache<number>();
    let calls = 0;

    const first = cache.get("analytics:get:30d", async () => {
      calls++;
      return 42;
    });
    const second = cache.get("analytics:get:30d", async () => {
      calls++;
      return 99;
    });

    expect(first).toBe(second);
    await expect(first).resolves.toBe(42);
    expect(calls).toBe(1);
  });

  it("uses separate entries for separate keys", async () => {
    const cache = new AsyncResultCache<number>();
    const first = await cache.get("summary:7d", async () => 7);
    const second = await cache.get("summary:30d", async () => 30);

    expect(first).toBe(7);
    expect(second).toBe(30);
  });

  it("recomputes after clearing the cache", async () => {
    const cache = new AsyncResultCache<number>();
    let value = 1;

    expect(await cache.get("k", async () => value)).toBe(1);
    value = 2;
    expect(await cache.get("k", async () => value)).toBe(1);

    cache.clear();

    expect(await cache.get("k", async () => value)).toBe(2);
  });

  it("evicts the least recently used result when capacity is reached", async () => {
    const cache = new AsyncResultCache<number>(2);
    await cache.get("a", async () => 1);
    await cache.get("b", async () => 2);
    await cache.get("a", async () => 9);
    await cache.get("c", async () => 3);
    expect(await cache.get("a", async () => 9)).toBe(1);
    expect(await cache.get("b", async () => 9)).toBe(9);
  });

  it("does not evict a replacement when an earlier generation rejects", async () => {
    const cache = new AsyncResultCache<number>();
    let reject!: (error: Error) => void;
    const old = cache.get("a", () => new Promise<number>((_, fail) => { reject = fail; }));
    cache.clear();
    await cache.get("a", async () => 2);
    reject(new Error("old failure"));
    await expect(old).rejects.toThrow("old failure");
    expect(await cache.get("a", async () => 3)).toBe(2);
  });
});
