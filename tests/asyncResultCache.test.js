"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const asyncResultCache_1 = require("../src/main/asyncResultCache");
(0, vitest_1.describe)("AsyncResultCache", () => {
    (0, vitest_1.it)("reuses the same in-flight promise for matching keys", async () => {
        const cache = new asyncResultCache_1.AsyncResultCache();
        let calls = 0;
        const first = cache.get("analytics:get:30d", async () => {
            calls++;
            return 42;
        });
        const second = cache.get("analytics:get:30d", async () => {
            calls++;
            return 99;
        });
        (0, vitest_1.expect)(first).toBe(second);
        await (0, vitest_1.expect)(first).resolves.toBe(42);
        (0, vitest_1.expect)(calls).toBe(1);
    });
    (0, vitest_1.it)("uses separate entries for separate keys", async () => {
        const cache = new asyncResultCache_1.AsyncResultCache();
        const first = await cache.get("summary:7d", async () => 7);
        const second = await cache.get("summary:30d", async () => 30);
        (0, vitest_1.expect)(first).toBe(7);
        (0, vitest_1.expect)(second).toBe(30);
    });
    (0, vitest_1.it)("recomputes after clearing the cache", async () => {
        const cache = new asyncResultCache_1.AsyncResultCache();
        let value = 1;
        (0, vitest_1.expect)(await cache.get("k", async () => value)).toBe(1);
        value = 2;
        (0, vitest_1.expect)(await cache.get("k", async () => value)).toBe(1);
        cache.clear();
        (0, vitest_1.expect)(await cache.get("k", async () => value)).toBe(2);
    });
});
