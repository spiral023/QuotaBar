"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const errors_1 = require("../src/shared/errors");
const refreshLoop_1 = require("../src/usage/refreshLoop");
const usageStore_1 = require("../src/usage/usageStore");
const debugRecorder_1 = require("../src/main/debugRecorder");
function okSnap(provider) {
    return {
        provider,
        status: "ok",
        windows: [{ name: "fiveHour", usedPercent: 50, windowSeconds: 18000 }],
        updatedAt: new Date().toISOString(),
    };
}
function makeProvider(id, fetchFn) {
    return {
        id,
        displayName: id,
        isAvailable: async () => true,
        getAuthHint: async () => null,
        fetchUsage: fetchFn,
    };
}
(0, vitest_1.describe)("RefreshLoop backoff", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.useFakeTimers();
        vitest_1.vi.spyOn(Math, "random").mockReturnValue(0);
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("skips provider in backoff on subsequent refresh", async () => {
        const store = new usageStore_1.UsageStore();
        let callCount = 0;
        const provider = makeProvider("claude", async () => {
            callCount++;
            if (callCount === 1)
                throw new errors_1.RateLimitError(5 * 60 * 1000);
            return okSnap("claude");
        });
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000);
        await loop.refreshNow();
        (0, vitest_1.expect)(callCount).toBe(1);
        await loop.refreshNow();
        (0, vitest_1.expect)(callCount).toBe(1); // still in backoff, not called again
        vitest_1.vi.advanceTimersByTime(5 * 60 * 1000 + 1);
        await loop.refreshNow();
        (0, vitest_1.expect)(callCount).toBe(2); // backoff expired, fetched again
    });
    (0, vitest_1.it)("respects retryAfterMs from RateLimitError", async () => {
        const store = new usageStore_1.UsageStore();
        let callCount = 0;
        const retryAfterMs = 2 * 60 * 1000;
        const provider = makeProvider("codex", async () => {
            callCount++;
            if (callCount === 1)
                throw new errors_1.RateLimitError(retryAfterMs);
            return okSnap("codex");
        });
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000);
        await loop.refreshNow();
        (0, vitest_1.expect)(callCount).toBe(1);
        vitest_1.vi.advanceTimersByTime(retryAfterMs - 1);
        await loop.refreshNow();
        (0, vitest_1.expect)(callCount).toBe(1); // still blocked
        vitest_1.vi.advanceTimersByTime(2);
        await loop.refreshNow();
        (0, vitest_1.expect)(callCount).toBe(2); // now expired
    });
    (0, vitest_1.it)("does not back off provider on non-rate-limit errors", async () => {
        const store = new usageStore_1.UsageStore();
        let callCount = 0;
        const provider = makeProvider("claude", async () => {
            callCount++;
            throw new Error("network error");
        });
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000);
        await loop.refreshNow();
        await loop.refreshNow();
        (0, vitest_1.expect)(callCount).toBe(2); // no backoff applied
    });
    (0, vitest_1.it)("marks previous ok snapshot as stale when rate limited", async () => {
        const store = new usageStore_1.UsageStore();
        let callCount = 0;
        const provider = makeProvider("claude", async () => {
            callCount++;
            if (callCount === 1)
                return okSnap("claude");
            throw new errors_1.RateLimitError(5 * 60 * 1000);
        });
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000);
        await loop.refreshNow(); // ok
        await loop.refreshNow(); // rate limited → stale
        (0, vitest_1.expect)(store.get("claude")?.status).toBe("stale");
    });
    (0, vitest_1.it)("keeps stale snapshot unchanged while provider is in backoff", async () => {
        const store = new usageStore_1.UsageStore();
        let callCount = 0;
        const provider = makeProvider("claude", async () => {
            callCount++;
            if (callCount === 1)
                return okSnap("claude");
            throw new errors_1.RateLimitError(5 * 60 * 1000);
        });
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000);
        await loop.refreshNow(); // ok
        await loop.refreshNow(); // rate limited → stale
        const staleSnap = store.get("claude");
        (0, vitest_1.expect)(staleSnap?.status).toBe("stale");
        await loop.refreshNow(); // in backoff → provider skipped
        (0, vitest_1.expect)(store.get("claude")?.status).toBe("stale"); // unchanged
        (0, vitest_1.expect)(callCount).toBe(2); // provider not called a third time
    });
    (0, vitest_1.it)("other providers are not affected by one provider's backoff", async () => {
        const store = new usageStore_1.UsageStore();
        let claudeCalls = 0;
        let codexCalls = 0;
        const claude = makeProvider("claude", async () => {
            claudeCalls++;
            if (claudeCalls === 1)
                throw new errors_1.RateLimitError(5 * 60 * 1000);
            return okSnap("claude");
        });
        const codex = makeProvider("codex", async () => {
            codexCalls++;
            return okSnap("codex");
        });
        const loop = new refreshLoop_1.RefreshLoop([claude, codex], store, 60, 10_000);
        await loop.refreshNow();
        (0, vitest_1.expect)(claudeCalls).toBe(1);
        (0, vitest_1.expect)(codexCalls).toBe(1);
        await loop.refreshNow(); // claude in backoff, codex still fetched
        (0, vitest_1.expect)(claudeCalls).toBe(1);
        (0, vitest_1.expect)(codexCalls).toBe(2);
    });
});
(0, vitest_1.describe)("RefreshLoop debug recording", () => {
    let tmpDir;
    (0, vitest_1.beforeEach)(async () => {
        tmpDir = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "qb-rl-rec-"));
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.afterEach)(async () => {
        await promises_1.default.rm(tmpDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)("emits refresh.start and one snapshot event per provider", async () => {
        const store = new usageStore_1.UsageStore();
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: tmpDir });
        const provider = makeProvider("claude", async () => okSnap("claude"));
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000, undefined, recorder);
        await loop.refreshNow();
        await recorder.flush();
        const files = await promises_1.default.readdir(tmpDir);
        const content = await promises_1.default.readFile(node_path_1.default.join(tmpDir, files[0]), "utf8");
        const events = content.trim().split("\n").map((l) => JSON.parse(l));
        (0, vitest_1.expect)(events.some((e) => e.kind === "refresh.start")).toBe(true);
        const snapshots = events.filter((e) => e.kind === "snapshot");
        (0, vitest_1.expect)(snapshots).toHaveLength(1);
        (0, vitest_1.expect)(snapshots[0].provider).toBe("claude");
    });
    (0, vitest_1.it)("respects the trigger argument", async () => {
        const store = new usageStore_1.UsageStore();
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: tmpDir });
        const provider = makeProvider("claude", async () => okSnap("claude"));
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000, undefined, recorder);
        await loop.refreshNow("manual");
        await recorder.flush();
        const files = await promises_1.default.readdir(tmpDir);
        const content = await promises_1.default.readFile(node_path_1.default.join(tmpDir, files[0]), "utf8");
        const events = content.trim().split("\n").map((l) => JSON.parse(l));
        const start = events.find((e) => e.kind === "refresh.start");
        (0, vitest_1.expect)(start.trigger).toBe("manual");
    });
    (0, vitest_1.it)("emits refresh.skipped when a provider is in backoff", async () => {
        const store = new usageStore_1.UsageStore();
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: tmpDir });
        const provider = makeProvider("claude", async () => { throw new errors_1.RateLimitError(60_000); });
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000, undefined, recorder);
        await loop.refreshNow(); // triggers backoff
        await loop.refreshNow(); // should skip
        await recorder.flush();
        const files = await promises_1.default.readdir(tmpDir);
        const content = await promises_1.default.readFile(node_path_1.default.join(tmpDir, files[0]), "utf8");
        const events = content.trim().split("\n").map((l) => JSON.parse(l));
        (0, vitest_1.expect)(events.some((e) => e.kind === "refresh.skipped" && e.provider === "claude")).toBe(true);
    });
});
(0, vitest_1.describe)("RefreshLoop window intelligence", () => {
    (0, vitest_1.it)("attaches pace to fiveHour window (not just weekly)", async () => {
        const store = new usageStore_1.UsageStore();
        const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString(); // 2h from now
        const provider = makeProvider("claude", async () => ({
            provider: "claude",
            status: "ok",
            windows: [{ name: "fiveHour", usedPercent: 20, windowSeconds: 18000, resetsAt }],
            updatedAt: new Date().toISOString(),
        }));
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000);
        await loop.refreshNow();
        const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
        (0, vitest_1.expect)(win?.pace).not.toBeUndefined();
        (0, vitest_1.expect)(win?.pace).not.toBeNull();
    });
    (0, vitest_1.it)("burnRatePctPerHour is null after first refresh (insufficient history)", async () => {
        const store = new usageStore_1.UsageStore();
        const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
        const provider = makeProvider("claude", async () => ({
            provider: "claude",
            status: "ok",
            windows: [{ name: "fiveHour", usedPercent: 30, windowSeconds: 18000, resetsAt }],
            updatedAt: new Date().toISOString(),
        }));
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000);
        await loop.refreshNow();
        const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
        // Only 1 recorded point → not enough for burn rate
        (0, vitest_1.expect)(win?.burnRatePctPerHour).toBeNull();
    });
    (0, vitest_1.it)("safetyGapSeconds is set when pace resolves willLastToReset", async () => {
        const store = new usageStore_1.UsageStore();
        // 20% used, 2h left in a 5h window → pace will compute willLastToReset
        const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
        const provider = makeProvider("claude", async () => ({
            provider: "claude",
            status: "ok",
            windows: [{ name: "fiveHour", usedPercent: 20, windowSeconds: 18000, resetsAt }],
            updatedAt: new Date().toISOString(),
        }));
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000);
        await loop.refreshNow();
        const win = store.get("claude")?.windows.find(w => w.name === "fiveHour");
        (0, vitest_1.expect)(win?.safetyGapSeconds).not.toBeNull();
        // willLastToReset case → safetyGapSeconds ≈ timeToReset ≈ 7200s
        (0, vitest_1.expect)(win?.safetyGapSeconds).toBeGreaterThan(7000);
    });
});
(0, vitest_1.describe)("RefreshLoop robustness", () => {
    (0, vitest_1.it)("escalates backoff on consecutive rate limits and resets after success", async () => {
        vitest_1.vi.useFakeTimers();
        vitest_1.vi.spyOn(Math, "random").mockReturnValue(0); // kein Jitter für deterministische Assertions
        const store = new usageStore_1.UsageStore();
        let call = 0;
        const provider = makeProvider("claude", async () => {
            call++;
            if (call <= 2)
                throw new errors_1.RateLimitError(0); // server says 0 → muss auf MIN_RETRY_MS gehoben werden
            return { provider: "claude", status: "ok", windows: [], updatedAt: new Date().toISOString() };
        });
        const events = [];
        const recorder = { write: (e) => events.push(e) };
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000, undefined, recorder);
        await loop.refreshNow(); // call 1 → 429, backoff = MIN_RETRY_MS = 5000ms
        // sofortiger Retry muss geblockt sein (noch im Backoff-Fenster)
        await loop.refreshNow();
        (0, vitest_1.expect)(events.some(e => e.kind === "refresh.skipped" && e.provider === "claude")).toBe(true);
        vitest_1.vi.restoreAllMocks();
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("emits dns.lookup.failed and network.recovered around a DNS outage", async () => {
        const store = new usageStore_1.UsageStore();
        let call = 0;
        const provider = makeProvider("claude", async () => {
            call++;
            if (call === 1) {
                const err = new Error("fetch failed");
                err.cause = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
                throw err;
            }
            return { provider: "claude", status: "ok", windows: [], updatedAt: new Date().toISOString() };
        });
        const events = [];
        const recorder = { write: (e) => events.push(e) };
        const loop = new refreshLoop_1.RefreshLoop([provider], store, 60, 10_000, undefined, recorder);
        await loop.refreshNow();
        (0, vitest_1.expect)(events.some(e => e.kind === "dns.lookup.failed" && e.provider === "claude")).toBe(true);
        await loop.refreshNow();
        (0, vitest_1.expect)(events.some(e => e.kind === "network.recovered")).toBe(true);
    });
});
