"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const backfill_reader_1 = require("../src/reports/backfill-reader");
let tmpDir;
(0, vitest_1.beforeEach)(async () => {
    tmpDir = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "qb-bfr-"));
});
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpDir, { recursive: true, force: true });
});
async function writeBackfill(filePath, events) {
    await promises_1.default.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    // jeder Event bekommt ein ts-Feld (wie echter Recorder), nur kind/date etc. zählen
    await promises_1.default.writeFile(filePath, events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e })).join("\n") + "\n", "utf8");
}
(0, vitest_1.describe)("readBackfillDayRecords", () => {
    (0, vitest_1.it)("gibt [] zurück wenn Verzeichnis nicht existiert", async () => {
        const result = await (0, backfill_reader_1.readBackfillDayRecords)(node_path_1.default.join(tmpDir, "nonexistent"));
        (0, vitest_1.expect)(result).toEqual([]);
    });
    (0, vitest_1.it)("gibt [] zurück wenn Verzeichnis leer ist", async () => {
        const result = await (0, backfill_reader_1.readBackfillDayRecords)(tmpDir);
        (0, vitest_1.expect)(result).toEqual([]);
    });
    (0, vitest_1.it)("parst Claude-daySummary korrekt", async () => {
        await writeBackfill(node_path_1.default.join(tmpDir, "2026-05-20.backfill.jsonl"), [
            {
                kind: "tokens.daySummary", provider: "claude", date: "2026-05-20",
                input: 1000, output: 500, cacheCreation: 200, cacheRead: 3000,
                totalTokens: 4700, totalCostUSD: 0.025, sessionCount: 3,
                models: ["claude-sonnet-4-6"],
                perModel: {
                    "claude-sonnet-4-6": { input: 1000, output: 500, cacheCreation: 200, cacheRead: 3000, costUSD: 0.025 },
                },
            },
        ]);
        const records = await (0, backfill_reader_1.readBackfillDayRecords)(tmpDir);
        (0, vitest_1.expect)(records).toHaveLength(1);
        (0, vitest_1.expect)(records[0]).toMatchObject({
            date: "2026-05-20",
            provider: "claude",
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreationTokens: 200,
            cacheReadTokens: 3000,
            totalTokens: 4700,
            costUSD: 0.025,
            sessionCount: 3,
            models: ["claude-sonnet-4-6"],
        });
        (0, vitest_1.expect)(records[0].perModel["claude-sonnet-4-6"]).toMatchObject({
            inputTokens: 1000, outputTokens: 500,
            cacheCreationTokens: 200, cacheReadTokens: 3000,
            totalTokens: 4700, costUSD: 0.025,
        });
    });
    (0, vitest_1.it)("parst Codex-daySummary korrekt (cachedInput → cacheReadTokens)", async () => {
        await writeBackfill(node_path_1.default.join(tmpDir, "2026-05-21.backfill.jsonl"), [
            {
                kind: "tokens.daySummary", provider: "codex", date: "2026-05-21",
                input: 50000, output: 800, cachedInput: 47000, reasoningOutput: 200,
                totalTokens: 51000, totalCostUSD: 1.23, sessionCount: 2,
                models: ["gpt-5.5"],
                perModel: {
                    "gpt-5.5": { input: 50000, output: 800, cachedInput: 47000, reasoningOutput: 200, costUSD: 1.23 },
                },
            },
        ]);
        const records = await (0, backfill_reader_1.readBackfillDayRecords)(tmpDir);
        (0, vitest_1.expect)(records).toHaveLength(1);
        (0, vitest_1.expect)(records[0]).toMatchObject({
            date: "2026-05-21", provider: "codex",
            inputTokens: 3000, outputTokens: 800, // 50000 − 47000 cached = ungecacht
            cacheReadTokens: 47000, // cachedInput landet hier
            cacheCreationTokens: 0,
            totalTokens: 51000, costUSD: 1.23,
        });
        (0, vitest_1.expect)(records[0].perModel["gpt-5.5"]).toMatchObject({
            inputTokens: 3000, cacheReadTokens: 47000, totalTokens: 51000,
        });
    });
    (0, vitest_1.it)("filtert nach since-Datum", async () => {
        await writeBackfill(node_path_1.default.join(tmpDir, "2026-05-18.backfill.jsonl"), [
            { kind: "tokens.daySummary", provider: "claude", date: "2026-05-18",
                input: 1, output: 1, totalTokens: 2, totalCostUSD: 0, sessionCount: 1, models: [], perModel: {} },
        ]);
        await writeBackfill(node_path_1.default.join(tmpDir, "2026-05-20.backfill.jsonl"), [
            { kind: "tokens.daySummary", provider: "claude", date: "2026-05-20",
                input: 2, output: 2, totalTokens: 4, totalCostUSD: 0, sessionCount: 1, models: [], perModel: {} },
        ]);
        const since = new Date("2026-05-19T00:00:00.000Z");
        const records = await (0, backfill_reader_1.readBackfillDayRecords)(tmpDir, since);
        (0, vitest_1.expect)(records).toHaveLength(1);
        (0, vitest_1.expect)(records[0].date).toBe("2026-05-20");
    });
    (0, vitest_1.it)("ignoriert non-daySummary-Zeilen und ungültiges JSON", async () => {
        await writeBackfill(node_path_1.default.join(tmpDir, "2026-05-20.backfill.jsonl"), [
            { kind: "tokens.usage", provider: "claude", model: "x", session: "s", input: 1, output: 1 },
            { kind: "backfill.start", days: [] },
        ]);
        // eine ungültige Zeile direkt hinzufügen
        await promises_1.default.appendFile(node_path_1.default.join(tmpDir, "2026-05-20.backfill.jsonl"), "not-json\n", "utf8");
        const records = await (0, backfill_reader_1.readBackfillDayRecords)(tmpDir);
        (0, vitest_1.expect)(records).toHaveLength(0);
    });
});
