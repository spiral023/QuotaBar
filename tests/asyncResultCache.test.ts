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
});
