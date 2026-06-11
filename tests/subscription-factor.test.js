"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const subscription_factor_1 = require("../src/pricing/subscription-factor");
const settings = {
    pollIntervalSeconds: 60,
    providerTimeoutMs: 10_000,
    subscriptionCosts: { claude: 20, codex: 10 },
    pricingOfflineMode: true,
    costWindow: "billing",
};
function makeSnapshot(provider, overrides = {}) {
    return {
        provider,
        status: "ok",
        windows: [],
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}
(0, vitest_1.describe)("PricingEngine", () => {
    (0, vitest_1.it)("returns undefined for error snapshots", async () => {
        const engine = new subscription_factor_1.PricingEngine(settings, "/nonexistent/path");
        (0, vitest_1.expect)(await engine.calculateFactor(makeSnapshot("claude", { status: "error" }))).toBeUndefined();
    });
    (0, vitest_1.it)("returns undefined for not_authenticated snapshots", async () => {
        const engine = new subscription_factor_1.PricingEngine(settings, "/nonexistent/path");
        (0, vitest_1.expect)(await engine.calculateFactor(makeSnapshot("claude", { status: "not_authenticated" }))).toBeUndefined();
    });
    (0, vitest_1.it)("returns zero cost for Claude when no JSONL dir exists", async () => {
        const engine = new subscription_factor_1.PricingEngine(settings, "/nonexistent/path");
        const result = await engine.calculateFactor(makeSnapshot("claude"));
        (0, vitest_1.expect)(result).toMatchObject({
            apiCostUSD: 0,
            subscriptionCostUSD: 20,
            factor: 0,
            isEstimate: false,
        });
    });
    (0, vitest_1.it)("returns Keine Logs for Codex when sessions dir is empty", async () => {
        const engine = new subscription_factor_1.PricingEngine(settings, "/nonexistent/claude", "/nonexistent/codex", "/nonexistent/config.toml");
        const result = await engine.calculateFactor(makeSnapshot("codex"));
        (0, vitest_1.expect)(result).not.toBeUndefined();
        (0, vitest_1.expect)(result.factor).toBeNull();
        (0, vitest_1.expect)(result.isEstimate).toBe(true);
        (0, vitest_1.expect)(result.label).toBe("Keine Logs verfügbar");
        (0, vitest_1.expect)(result.apiCostUSD).toBe(0);
        (0, vitest_1.expect)(result.subscriptionCostUSD).toBe(10);
    });
    (0, vitest_1.it)("returns real cost for Codex when JSONL events exist", async () => {
        const resetsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
        const billingStart = new Date(resetsAt.getTime() - 7 * 24 * 3600 * 1000);
        const eventTime = new Date(billingStart.getTime() + 1000).toISOString(); // 1 second after billing start
        // Build a session directory path matching the billing start date
        const year = billingStart.getUTCFullYear();
        const month = String(billingStart.getUTCMonth() + 1).padStart(2, "0");
        const day = String(billingStart.getUTCDate()).padStart(2, "0");
        const sessionsDir = node_path_1.default.join(node_os_1.default.tmpdir(), `quotabar-sf-test-${Date.now()}`);
        const sessionFile = node_path_1.default.join(sessionsDir, `${year}/${month}/${day}`);
        await promises_1.default.mkdir(sessionFile, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(sessionFile, "session.jsonl"), [
            JSON.stringify({ timestamp: eventTime, type: "turn_context", payload: { model: "gpt-4o" } }),
            JSON.stringify({
                timestamp: new Date(billingStart.getTime() + 2000).toISOString(), // 2 seconds after billing start
                type: "event_msg",
                payload: {
                    type: "token_count",
                    info: {
                        last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 },
                        total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 },
                    },
                },
            }),
        ].join("\n") + "\n", "utf8");
        try {
            const engine = new subscription_factor_1.PricingEngine(settings, "/nonexistent/claude", sessionsDir, "/nonexistent/config.toml");
            const snapshot = makeSnapshot("codex", {
                windows: [{ name: "weekly", usedPercent: 5, resetsAt: resetsAt.toISOString() }],
            });
            const result = await engine.calculateFactor(snapshot);
            (0, vitest_1.expect)(result).not.toBeUndefined();
            (0, vitest_1.expect)(result.factor).not.toBeNull();
            (0, vitest_1.expect)(result.isEstimate).toBe(false);
            (0, vitest_1.expect)(result.apiCostUSD).toBeGreaterThan(0);
            (0, vitest_1.expect)(result.subscriptionCostUSD).toBe(10);
        }
        finally {
            await promises_1.default.rm(sessionsDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)("label has no ~ prefix for exact Claude result", async () => {
        const engine = new subscription_factor_1.PricingEngine(settings, "/nonexistent/path");
        const result = await engine.calculateFactor(makeSnapshot("claude"));
        (0, vitest_1.expect)(result.label).not.toMatch(/^~/);
    });
    (0, vitest_1.it)("calculates Claude cost per model separately (haiku + sonnet)", async () => {
        const claudeDir = node_path_1.default.join(node_os_1.default.tmpdir(), `quotabar-sf-claude-multimodel-${Date.now()}`);
        const projectDir = node_path_1.default.join(claudeDir, "proj1");
        await promises_1.default.mkdir(projectDir, { recursive: true });
        const billingStart = new Date("2026-05-01T00:00:00.000Z");
        await promises_1.default.writeFile(node_path_1.default.join(projectDir, "session.jsonl"), [
            // haiku entry: cache_read dominant (cheap)
            JSON.stringify({
                timestamp: "2026-05-10T10:00:00.000Z",
                message: { id: "msg_h1", model: "claude-haiku-4-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } },
            }),
            // sonnet entry: cache_read dominant (expensive, 3.75× haiku)
            JSON.stringify({
                timestamp: "2026-05-10T10:01:00.000Z",
                message: { id: "msg_s1", model: "claude-sonnet-4-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } },
            }),
        ].join("\n") + "\n", "utf8");
        try {
            const engine = new subscription_factor_1.PricingEngine(settings, claudeDir);
            const result = await engine.calculateFactor(makeSnapshot("claude", {
                windows: [{ name: "credits", resetsAt: billingStart.toISOString() }],
            }));
            (0, vitest_1.expect)(result).not.toBeUndefined();
            (0, vitest_1.expect)(result.apiCostUSD).toBeGreaterThan(0);
            // haiku cache_read: 1M × $0.08/M = $0.08
            // sonnet cache_read: 1M × $0.30/M = $0.30
            // total: $0.38
            // Using only haiku pricing for both would give $0.16 (too low)
            // Using only sonnet pricing for both would give $0.60 (too high)
            (0, vitest_1.expect)(result.apiCostUSD).toBeCloseTo(0.08 + 0.30, 2);
        }
        finally {
            await promises_1.default.rm(claudeDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)("includes windowLabel in CostFactorResult", async () => {
        const engine = new subscription_factor_1.PricingEngine({ ...settings, costWindow: "7d" }, "/nonexistent/path");
        const result = await engine.calculateFactor(makeSnapshot("claude"));
        (0, vitest_1.expect)(result).not.toBeUndefined();
        (0, vitest_1.expect)(result.windowLabel).toBe("7d");
    });
    (0, vitest_1.it)("Claude 7d: billingStart ist 7 Tage vor jetzt (näherungsweise)", async () => {
        const claudeDir = node_path_1.default.join(node_os_1.default.tmpdir(), `qb-sf-7d-${Date.now()}`);
        const projectDir = node_path_1.default.join(claudeDir, "proj1");
        await promises_1.default.mkdir(projectDir, { recursive: true });
        const recentTs = new Date(Date.now() - 1000).toISOString();
        const oldTs = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
        await promises_1.default.writeFile(node_path_1.default.join(projectDir, "session.jsonl"), [
            JSON.stringify({ timestamp: recentTs, message: { id: "msg_r1", model: "claude-haiku-4-5", usage: { output_tokens: 1000 } } }),
            JSON.stringify({ timestamp: oldTs, message: { id: "msg_o1", model: "claude-haiku-4-5", usage: { output_tokens: 9999 } } }),
        ].join("\n") + "\n", "utf8");
        try {
            const engine = new subscription_factor_1.PricingEngine({ ...settings, costWindow: "7d" }, claudeDir);
            const result = await engine.calculateFactor(makeSnapshot("claude"));
            (0, vitest_1.expect)(result.windowLabel).toBe("7d");
            // Nur recentTs-Token sollen zählen — output 1000 tokens haiku = $0.004
            (0, vitest_1.expect)(result.apiCostUSD).toBeCloseTo(1000 * 4e-6, 5);
        }
        finally {
            await promises_1.default.rm(claudeDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)("Claude 30d: billingStart ist 30 Tage vor jetzt", async () => {
        const claudeDir = node_path_1.default.join(node_os_1.default.tmpdir(), `qb-sf-30d-${Date.now()}`);
        const projectDir = node_path_1.default.join(claudeDir, "proj1");
        await promises_1.default.mkdir(projectDir, { recursive: true });
        const ts20d = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
        await promises_1.default.writeFile(node_path_1.default.join(projectDir, "session.jsonl"), [JSON.stringify({ timestamp: ts20d, message: { id: "msg_20d", model: "claude-haiku-4-5", usage: { output_tokens: 500 } } })].join("\n") + "\n", "utf8");
        try {
            const engine = new subscription_factor_1.PricingEngine({ ...settings, costWindow: "30d" }, claudeDir);
            const result = await engine.calculateFactor(makeSnapshot("claude"));
            (0, vitest_1.expect)(result.windowLabel).toBe("30d");
            (0, vitest_1.expect)(result.apiCostUSD).toBeCloseTo(500 * 4e-6, 5);
        }
        finally {
            await promises_1.default.rm(claudeDir, { recursive: true, force: true });
        }
    });
});
