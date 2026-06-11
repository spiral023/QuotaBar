"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const debugRecorder_1 = require("../src/main/debugRecorder");
const debugBackfill_1 = require("../src/main/debugBackfill");
const litellm_fetcher_1 = require("../src/pricing/litellm-fetcher");
let tmpDir;
let claudeDir;
let codexDir;
async function writeClaudeJsonl(file, lines) {
    await promises_1.default.mkdir(node_path_1.default.dirname(file), { recursive: true });
    await promises_1.default.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}
async function writeCodexJsonl(file, lines) {
    await promises_1.default.mkdir(node_path_1.default.dirname(file), { recursive: true });
    await promises_1.default.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}
(0, vitest_1.beforeEach)(async () => {
    tmpDir = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "qb-backfill-"));
    claudeDir = node_path_1.default.join(tmpDir, "claude", "projects");
    codexDir = node_path_1.default.join(tmpDir, "codex", "sessions");
    await promises_1.default.mkdir(claudeDir, { recursive: true });
    await promises_1.default.mkdir(codexDir, { recursive: true });
});
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpDir, { recursive: true, force: true });
});
(0, vitest_1.describe)("runBackfill", () => {
    (0, vitest_1.it)("emits tokens.usage and tokens.daySummary into per-day backfill files", async () => {
        await writeClaudeJsonl(node_path_1.default.join(claudeDir, "proj-a", "session-1.jsonl"), [
            { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
                message: { id: "m1", model: "claude-sonnet-4-6",
                    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 } } },
            { type: "assistant", timestamp: "2026-05-21T09:00:00Z",
                message: { id: "m2", model: "claude-sonnet-4-6",
                    usage: { input_tokens: 80, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
        ]);
        const logDir = node_path_1.default.join(tmpDir, "debug");
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir });
        const result = await (0, debugBackfill_1.runBackfill)({
            recorder,
            logDir,
            claudeProjectsDirs: [claudeDir],
            codexSessionsDirs: [codexDir],
        });
        await recorder.flush();
        (0, vitest_1.expect)(result.daysWritten).toBeGreaterThanOrEqual(2);
        (0, vitest_1.expect)(result.errors).toEqual([]);
        const files = await promises_1.default.readdir(logDir);
        (0, vitest_1.expect)(files).toContain("2026-05-20.backfill.jsonl");
        (0, vitest_1.expect)(files).toContain("2026-05-21.backfill.jsonl");
        const day20 = (await promises_1.default.readFile(node_path_1.default.join(logDir, "2026-05-20.backfill.jsonl"), "utf8"))
            .trim().split("\n").map((l) => JSON.parse(l));
        (0, vitest_1.expect)(day20.some((e) => e.kind === "tokens.usage" && e.provider === "claude")).toBe(true);
        (0, vitest_1.expect)(day20.some((e) => e.kind === "tokens.daySummary" && e.provider === "claude" && e.input === 100)).toBe(true);
    });
    (0, vitest_1.it)("skips the whole run when no source file changed since last run", async () => {
        await writeClaudeJsonl(node_path_1.default.join(claudeDir, "proj", "session.jsonl"), [
            { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
                message: { id: "m1", model: "claude-sonnet-4-6",
                    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
        ]);
        const logDir = node_path_1.default.join(tmpDir, "debug");
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir });
        const opts = { recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] };
        const first = await (0, debugBackfill_1.runBackfill)(opts);
        await recorder.flush();
        const second = await (0, debugBackfill_1.runBackfill)(opts);
        await recorder.flush();
        (0, vitest_1.expect)(first.daysWritten).toBeGreaterThan(0);
        // Zweiter Lauf: Quelldatei unverändert → kompletter Skip via Manifest.
        (0, vitest_1.expect)(second.daysWritten).toBe(0);
        // Manifest wurde geschrieben.
        const files = await promises_1.default.readdir(logDir);
        (0, vitest_1.expect)(files).toContain("backfill-manifest.json");
    });
    (0, vitest_1.it)("Codex totalTokens does not double-count cachedInput", async () => {
        // input_tokens=1000 already includes cached_input_tokens=800.
        // totalTokens must be input+output+reasoning = 1000+100+0 = 1100, not 1000+800+100 = 1900.
        await writeCodexJsonl(node_path_1.default.join(codexDir, "session-cx.jsonl"), [
            { type: "turn_context", payload: { model: "gpt-5.5" } },
            { type: "event_msg", timestamp: "2026-05-20T14:00:00Z", payload: {
                    type: "token_count", info: {
                        last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100,
                            reasoning_output_tokens: 0, total_tokens: 1100 },
                    },
                } },
        ]);
        const logDir = node_path_1.default.join(tmpDir, "debug");
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir });
        await (0, debugBackfill_1.runBackfill)({ recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] });
        await recorder.flush();
        const lines = (await promises_1.default.readFile(node_path_1.default.join(logDir, "2026-05-20.backfill.jsonl"), "utf8"))
            .trim().split("\n").map((l) => JSON.parse(l));
        const summary = lines.find((e) => e.kind === "tokens.daySummary" && e.provider === "codex");
        (0, vitest_1.expect)(summary).toBeDefined();
        (0, vitest_1.expect)(summary.input).toBe(1000);
        (0, vitest_1.expect)(summary.cachedInput).toBe(800);
        (0, vitest_1.expect)(summary.output).toBe(100);
        (0, vitest_1.expect)(summary.totalTokens).toBe(1100); // must NOT be 1900
    });
    (0, vitest_1.it)("berechnet totalCostUSD wenn fetcher übergeben wird", async () => {
        // claude-sonnet-4-5 ist in den Fallback-Preisen: input=3e-6, output=15e-6, cacheRead=3e-7
        await writeClaudeJsonl(node_path_1.default.join(claudeDir, "proj", "session.jsonl"), [
            { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
                message: { id: "m1", model: "claude-sonnet-4-5",
                    usage: { input_tokens: 1000, output_tokens: 500,
                        cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 } } },
        ]);
        const logDir = node_path_1.default.join(tmpDir, "debug");
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir });
        await (0, debugBackfill_1.runBackfill)({
            recorder, logDir,
            claudeProjectsDirs: [claudeDir],
            codexSessionsDirs: [codexDir],
            fetcher: new litellm_fetcher_1.LiteLLMFetcher(true), // offline mode — verwendet Fallback-Preise
        });
        await recorder.flush();
        const lines = (await promises_1.default.readFile(node_path_1.default.join(logDir, "2026-05-20.backfill.jsonl"), "utf8"))
            .trim().split("\n").map((l) => JSON.parse(l));
        const summary = lines.find((e) => e.kind === "tokens.daySummary" && e.provider === "claude");
        (0, vitest_1.expect)(summary).toBeDefined();
        // 1000 * 3e-6 + 500 * 15e-6 + 2000 * 3e-7 = 0.003 + 0.0075 + 0.0006 = 0.0111
        (0, vitest_1.expect)(summary.totalCostUSD).toBeCloseTo(0.0111, 6);
        (0, vitest_1.expect)(summary.perModel["claude-sonnet-4-5"].costUSD).toBeCloseTo(0.0111, 6);
    });
    (0, vitest_1.it)("force=true regenerates existing backfill files", async () => {
        await writeClaudeJsonl(node_path_1.default.join(claudeDir, "proj", "session.jsonl"), [
            { type: "assistant", timestamp: "2026-05-20T14:00:00Z",
                message: { id: "m1", model: "claude-sonnet-4-6",
                    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
        ]);
        const logDir = node_path_1.default.join(tmpDir, "debug");
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir });
        const opts = { recorder, logDir, claudeProjectsDirs: [claudeDir], codexSessionsDirs: [codexDir] };
        await (0, debugBackfill_1.runBackfill)(opts);
        await recorder.flush();
        const result = await (0, debugBackfill_1.runBackfill)({ ...opts, force: true });
        await recorder.flush();
        (0, vitest_1.expect)(result.daysWritten).toBeGreaterThan(0);
    });
});
