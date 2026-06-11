"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const jsonl_reader_1 = require("../src/pricing/jsonl-reader");
const tmpDir = node_path_1.default.join(node_os_1.default.tmpdir(), `quotabar-test-${process.pid}`);
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpDir, { recursive: true, force: true });
});
async function writeJsonl(dir, filename, entries) {
    await promises_1.default.mkdir(dir, { recursive: true });
    await promises_1.default.writeFile(node_path_1.default.join(dir, filename), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
(0, vitest_1.describe)("readClaudeTokensForPeriod", () => {
    (0, vitest_1.it)("returns zeros when directory does not exist", async () => {
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)("/nonexistent/path/xyz", new Date("2026-05-01"));
        (0, vitest_1.expect)(result).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            costUSD: 0,
            hasCostUSD: false,
            modelNames: [],
            perModel: {},
        });
    });
    (0, vitest_1.it)("aggregates tokens from entries within billing period", async () => {
        const projectDir = node_path_1.default.join(tmpDir, "proj1");
        await writeJsonl(projectDir, "session.jsonl", [
            {
                timestamp: "2026-05-10T10:00:00.000Z",
                message: { model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } },
            },
            {
                timestamp: "2026-05-15T12:00:00.000Z",
                message: { model: "claude-sonnet-4-5", usage: { input_tokens: 200, output_tokens: 80 } },
            },
        ]);
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)(tmpDir, new Date("2026-05-01T00:00:00.000Z"));
        (0, vitest_1.expect)(result.inputTokens).toBe(300);
        (0, vitest_1.expect)(result.outputTokens).toBe(130);
        (0, vitest_1.expect)(result.cacheCreationTokens).toBe(20);
        (0, vitest_1.expect)(result.cacheReadTokens).toBe(30);
        (0, vitest_1.expect)(result.modelNames).toContain("claude-sonnet-4-5");
    });
    (0, vitest_1.it)("excludes entries before billing period", async () => {
        const projectDir = node_path_1.default.join(tmpDir, "proj1");
        await writeJsonl(projectDir, "session.jsonl", [
            {
                timestamp: "2026-04-30T23:59:59.000Z",
                message: { model: "claude-sonnet-4-5", usage: { input_tokens: 999, output_tokens: 999 } },
            },
            {
                timestamp: "2026-05-01T00:00:00.001Z",
                message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } },
            },
        ]);
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)(tmpDir, new Date("2026-05-01T00:00:00.000Z"));
        (0, vitest_1.expect)(result.inputTokens).toBe(10);
        (0, vitest_1.expect)(result.outputTokens).toBe(5);
    });
    (0, vitest_1.it)("skips invalid JSONL lines without throwing", async () => {
        const projectDir = node_path_1.default.join(tmpDir, "proj1");
        await promises_1.default.mkdir(projectDir, { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(projectDir, "session.jsonl"), [
            "not valid json{{{{",
            JSON.stringify({ timestamp: "2026-05-10T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 50, output_tokens: 25 } } }),
        ].join("\n") + "\n", "utf8");
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(result.inputTokens).toBe(50);
        (0, vitest_1.expect)(result.outputTokens).toBe(25);
    });
    (0, vitest_1.it)("reads JSONL files from nested subdirectories", async () => {
        const nested = node_path_1.default.join(tmpDir, "proj", "subdir");
        await writeJsonl(nested, "chat.jsonl", [
            { timestamp: "2026-05-12T08:00:00.000Z", message: { model: "claude-opus-4", usage: { input_tokens: 77, output_tokens: 33 } } },
        ]);
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(result.inputTokens).toBe(77);
        (0, vitest_1.expect)(result.modelNames).toContain("claude-opus-4");
    });
    (0, vitest_1.it)("deduplicates model names", async () => {
        const projectDir = node_path_1.default.join(tmpDir, "proj1");
        await writeJsonl(projectDir, "session.jsonl", [
            { timestamp: "2026-05-10T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } } },
            { timestamp: "2026-05-11T10:00:00.000Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 } } },
        ]);
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(result.modelNames.filter((m) => m === "claude-sonnet-4-5").length).toBe(1);
    });
    (0, vitest_1.it)("deduplicates entries with the same message.id (streaming snapshots)", async () => {
        const projectDir = node_path_1.default.join(tmpDir, "proj1");
        await writeJsonl(projectDir, "session.jsonl", [
            {
                timestamp: "2026-05-10T10:00:00.000Z",
                message: { id: "msg_abc123", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 10000 } },
            },
            // Same API response stored again as a different streaming snapshot
            {
                timestamp: "2026-05-10T10:00:00.000Z",
                message: { id: "msg_abc123", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 10000 } },
            },
            // Different API call — should be counted
            {
                timestamp: "2026-05-10T10:01:00.000Z",
                message: { id: "msg_def456", model: "claude-sonnet-4-6", usage: { input_tokens: 3, output_tokens: 50, cache_read_input_tokens: 8000 } },
            },
        ]);
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(result.inputTokens).toBe(8); // 5 + 3 (not 5+5+3)
        (0, vitest_1.expect)(result.outputTokens).toBe(250); // 200 + 50
        (0, vitest_1.expect)(result.cacheReadTokens).toBe(18000); // 10000 + 8000
    });
    (0, vitest_1.it)("counts entries without message.id (no deduplication possible)", async () => {
        const projectDir = node_path_1.default.join(tmpDir, "proj1");
        await writeJsonl(projectDir, "session.jsonl", [
            { timestamp: "2026-05-10T10:00:00.000Z", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 20 } } },
            { timestamp: "2026-05-10T10:01:00.000Z", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 15, output_tokens: 25 } } },
        ]);
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(result.inputTokens).toBe(25);
        (0, vitest_1.expect)(result.outputTokens).toBe(45);
    });
    (0, vitest_1.it)("tracks tokens per model separately in perModel", async () => {
        const projectDir = node_path_1.default.join(tmpDir, "proj1");
        await writeJsonl(projectDir, "session.jsonl", [
            {
                timestamp: "2026-05-10T10:00:00.000Z",
                message: { id: "msg_001", model: "claude-haiku-4-5", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000 } },
            },
            {
                timestamp: "2026-05-10T10:01:00.000Z",
                message: { id: "msg_002", model: "claude-sonnet-4-6", usage: { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 1000 } },
            },
            {
                timestamp: "2026-05-10T10:02:00.000Z",
                message: { id: "msg_003", model: "claude-haiku-4-5", usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 2000 } },
            },
        ]);
        const result = await (0, jsonl_reader_1.readClaudeTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(result.perModel["claude-haiku-4-5"]).toEqual({ inputTokens: 150, outputTokens: 70, cacheCreationTokens: 0, cacheReadTokens: 7000 });
        (0, vitest_1.expect)(result.perModel["claude-sonnet-4-6"]).toEqual({ inputTokens: 200, outputTokens: 80, cacheCreationTokens: 1000, cacheReadTokens: 0 });
        // Overall totals should still be consistent
        (0, vitest_1.expect)(result.inputTokens).toBe(350);
        (0, vitest_1.expect)(result.outputTokens).toBe(150);
        (0, vitest_1.expect)(result.cacheCreationTokens).toBe(1000);
        (0, vitest_1.expect)(result.cacheReadTokens).toBe(7000);
    });
});
