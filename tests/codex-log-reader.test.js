"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const codex_log_reader_1 = require("../src/pricing/codex-log-reader");
const tmpDir = node_path_1.default.join(node_os_1.default.tmpdir(), `quotabar-codex-test-${process.pid}`);
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpDir, { recursive: true, force: true });
});
async function writeJsonl(dir, filename, lines) {
    await promises_1.default.mkdir(dir, { recursive: true });
    await promises_1.default.writeFile(node_path_1.default.join(dir, filename), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}
function makeTurnContext(model, timestamp = "2026-05-18T10:00:00.000Z") {
    return { timestamp, type: "turn_context", payload: { model, turn_id: "x" } };
}
function makeTokenCountWithLast(timestamp, last) {
    return {
        timestamp,
        type: "event_msg",
        payload: {
            type: "token_count",
            info: { last_token_usage: last, total_token_usage: last },
        },
    };
}
function makeTokenCountLastOnly(timestamp, last) {
    return {
        timestamp,
        type: "event_msg",
        payload: {
            type: "token_count",
            info: { last_token_usage: last },
        },
    };
}
function makeTokenCountTotalOnly(timestamp, total) {
    return {
        timestamp,
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: total } },
    };
}
(0, vitest_1.describe)("readCodexTokensForPeriod", () => {
    (0, vitest_1.it)("returns empty array when sessions dir does not exist", async () => {
        const result = await (0, codex_log_reader_1.readCodexTokensForPeriod)("/nonexistent/xyz", new Date("2026-05-01"));
        (0, vitest_1.expect)(result).toEqual([]);
    });
    (0, vitest_1.it)("parses model from turn_context and token counts from last_token_usage", async () => {
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/18"), "session.jsonl", [
            makeTurnContext("gpt-4o"),
            makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
                input_tokens: 1000,
                cached_input_tokens: 200,
                output_tokens: 100,
                reasoning_output_tokens: 50,
                total_tokens: 1100,
            }),
        ]);
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events).toHaveLength(1);
        (0, vitest_1.expect)(events[0].model).toBe("gpt-4o");
        (0, vitest_1.expect)(events[0].isFallback).toBe(false);
        (0, vitest_1.expect)(events[0].inputTokens).toBe(1000);
        (0, vitest_1.expect)(events[0].cachedInputTokens).toBe(200);
        (0, vitest_1.expect)(events[0].outputTokens).toBe(100);
        (0, vitest_1.expect)(events[0].reasoningOutputTokens).toBe(50);
    });
    (0, vitest_1.it)("computes delta when only total_token_usage is present", async () => {
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/18"), "session.jsonl", [
            makeTurnContext("gpt-4o"),
            makeTokenCountTotalOnly("2026-05-18T10:00:01.000Z", {
                input_tokens: 1000,
                cached_input_tokens: 0,
                output_tokens: 100,
                reasoning_output_tokens: 0,
                total_tokens: 1100,
            }),
            makeTokenCountTotalOnly("2026-05-18T10:00:02.000Z", {
                input_tokens: 2500,
                cached_input_tokens: 500,
                output_tokens: 300,
                reasoning_output_tokens: 100,
                total_tokens: 2800,
            }),
        ]);
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events).toHaveLength(2);
        (0, vitest_1.expect)(events[0].inputTokens).toBe(1000);
        (0, vitest_1.expect)(events[1].inputTokens).toBe(1500); // 2500 - 1000
        (0, vitest_1.expect)(events[1].cachedInputTokens).toBe(500);
        (0, vitest_1.expect)(events[1].outputTokens).toBe(200); // 300 - 100
    });
    (0, vitest_1.it)("clamps cachedInputTokens to inputTokens (bug protection)", async () => {
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/18"), "session.jsonl", [
            makeTurnContext("gpt-4o"),
            makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
                input_tokens: 500,
                cached_input_tokens: 9999, // buggy: larger than input
                output_tokens: 100,
                reasoning_output_tokens: 0,
                total_tokens: 600,
            }),
        ]);
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events[0].cachedInputTokens).toBe(500); // clamped to inputTokens
    });
    (0, vitest_1.it)("skips token_count events with info: null", async () => {
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/18"), "session.jsonl", [
            makeTurnContext("gpt-4o"),
            { timestamp: "2026-05-18T10:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: null } },
            makeTokenCountWithLast("2026-05-18T10:00:02.000Z", {
                input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
            }),
        ]);
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events).toHaveLength(1);
        (0, vitest_1.expect)(events[0].inputTokens).toBe(100);
    });
    (0, vitest_1.it)("filters events before billingStart but still tracks totals for delta", async () => {
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/18"), "session.jsonl", [
            makeTurnContext("gpt-4o"),
            makeTokenCountTotalOnly("2026-05-17T23:59:00.000Z", {
                input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100,
            }),
            makeTokenCountTotalOnly("2026-05-18T00:00:01.000Z", {
                input_tokens: 1500, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 1700,
            }),
        ]);
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-18T00:00:00.000Z"));
        (0, vitest_1.expect)(events).toHaveLength(1);
        (0, vitest_1.expect)(events[0].inputTokens).toBe(500); // 1500 - 1000 (delta from pre-billing event)
        (0, vitest_1.expect)(events[0].outputTokens).toBe(100); // 200 - 100
    });
    (0, vitest_1.it)("uses gpt-5 fallback model and sets isFallback=true when no model info", async () => {
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/18"), "session.jsonl", [
            makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
                input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
            }),
        ]);
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events[0].model).toBe("gpt-5");
        (0, vitest_1.expect)(events[0].isFallback).toBe(true);
    });
    (0, vitest_1.it)("reads JSONL files from nested subdirectories", async () => {
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/01"), "a.jsonl", [
            makeTurnContext("gpt-4o"),
            makeTokenCountWithLast("2026-05-01T08:00:00.000Z", {
                input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55,
            }),
        ]);
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/02"), "b.jsonl", [
            makeTurnContext("gpt-4o"),
            makeTokenCountWithLast("2026-05-02T08:00:00.000Z", {
                input_tokens: 75, cached_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0, total_tokens: 83,
            }),
        ]);
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events).toHaveLength(2);
        const totalInput = events.reduce((s, e) => s + e.inputTokens, 0);
        (0, vitest_1.expect)(totalInput).toBe(125);
    });
    (0, vitest_1.it)("handles last_token_usage-only entries (no total_token_usage)", async () => {
        await writeJsonl(node_path_1.default.join(tmpDir, "2026/05/18"), "session.jsonl", [
            makeTurnContext("gpt-4o"),
            makeTokenCountLastOnly("2026-05-18T10:00:01.000Z", {
                input_tokens: 800, cached_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 0, total_tokens: 880,
            }),
            makeTokenCountLastOnly("2026-05-18T10:00:02.000Z", {
                input_tokens: 600, cached_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 0, total_tokens: 660,
            }),
        ]);
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events).toHaveLength(2);
        (0, vitest_1.expect)(events[0].inputTokens).toBe(800);
        (0, vitest_1.expect)(events[1].inputTokens).toBe(600);
    });
    (0, vitest_1.it)("reads model from info.model when no turn_context present", async () => {
        await promises_1.default.mkdir(node_path_1.default.join(tmpDir, "2026/05/18"), { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(tmpDir, "2026/05/18", "session.jsonl"), JSON.stringify({
            timestamp: "2026-05-18T10:00:01.000Z",
            type: "event_msg",
            payload: {
                type: "token_count",
                info: {
                    model: "gpt-4o-mini",
                    last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 },
                },
            },
        }) + "\n", "utf8");
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events[0].model).toBe("gpt-4o-mini");
        (0, vitest_1.expect)(events[0].isFallback).toBe(false);
    });
    (0, vitest_1.it)("skips invalid JSONL lines without throwing", async () => {
        await promises_1.default.mkdir(node_path_1.default.join(tmpDir, "2026/05/18"), { recursive: true });
        await promises_1.default.writeFile(node_path_1.default.join(tmpDir, "2026/05/18", "session.jsonl"), [
            "not-valid-json{{{{",
            JSON.stringify(makeTurnContext("gpt-4o")),
            JSON.stringify(makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
                input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
            })),
        ].join("\n") + "\n", "utf8");
        const events = await (0, codex_log_reader_1.readCodexTokensForPeriod)(tmpDir, new Date("2026-05-01"));
        (0, vitest_1.expect)(events).toHaveLength(1);
        (0, vitest_1.expect)(events[0].inputTokens).toBe(100);
    });
});
