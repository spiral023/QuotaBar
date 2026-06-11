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
let tmpDir;
(0, vitest_1.beforeEach)(async () => {
    tmpDir = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "qb-recorder-"));
});
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpDir, { recursive: true, force: true });
});
(0, vitest_1.describe)("DebugRecorder", () => {
    (0, vitest_1.it)("does nothing when disabled", async () => {
        const r = new debugRecorder_1.DebugRecorder({ enabled: false, logDir: tmpDir });
        r.write({ kind: "app.start", version: "x", pollIntervalSeconds: 60, noWindow: false, platform: "win32" });
        await r.flush();
        const files = await promises_1.default.readdir(tmpDir).catch(() => []);
        (0, vitest_1.expect)(files).toEqual([]);
    });
    (0, vitest_1.it)("writes one JSONL line per event with ts and kind", async () => {
        const r = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: tmpDir });
        r.write({ kind: "app.start", version: "x", pollIntervalSeconds: 60, noWindow: false, platform: "win32" });
        r.write({ kind: "refresh.start", providers: ["claude"], trigger: "interval" });
        await r.flush();
        const files = await promises_1.default.readdir(tmpDir);
        (0, vitest_1.expect)(files).toHaveLength(1);
        const content = await promises_1.default.readFile(node_path_1.default.join(tmpDir, files[0]), "utf8");
        const lines = content.trim().split("\n");
        (0, vitest_1.expect)(lines).toHaveLength(2);
        const parsed = lines.map((l) => JSON.parse(l));
        (0, vitest_1.expect)(parsed[0].kind).toBe("app.start");
        (0, vitest_1.expect)(parsed[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        (0, vitest_1.expect)(parsed[1].kind).toBe("refresh.start");
    });
    (0, vitest_1.it)("creates the debug dir if it does not exist", async () => {
        const subDir = node_path_1.default.join(tmpDir, "nested", "debug");
        const r = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: subDir });
        r.write({ kind: "app.start", version: "x", pollIntervalSeconds: 60, noWindow: false, platform: "win32" });
        await r.flush();
        const files = await promises_1.default.readdir(subDir);
        (0, vitest_1.expect)(files).toHaveLength(1);
    });
    (0, vitest_1.it)("redacts PII fields like email and accountId", async () => {
        const r = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: tmpDir });
        r.write({
            kind: "snapshot", provider: "codex", status: "ok",
            windows: [], fetchedAt: new Date().toISOString(),
            // @ts-expect-error - extending for redaction check
            identity: { email: "x@y.com", accountId: "abc" },
        });
        await r.flush();
        const files = await promises_1.default.readdir(tmpDir);
        const content = await promises_1.default.readFile(node_path_1.default.join(tmpDir, files[0]), "utf8");
        (0, vitest_1.expect)(content).toContain("<redacted>");
        (0, vitest_1.expect)(content).not.toContain("x@y.com");
        (0, vitest_1.expect)(content).not.toContain("\"abc\"");
    });
    (0, vitest_1.it)("writeBackfill writes to .backfill.jsonl with caller-supplied date", async () => {
        const r = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: tmpDir });
        r.writeBackfill("2026-05-20", { kind: "tokens.usage", provider: "claude", model: "x", session: "s", input: 1, output: 1 });
        await r.flush();
        const files = await promises_1.default.readdir(tmpDir);
        (0, vitest_1.expect)(files).toContain("2026-05-20.backfill.jsonl");
    });
    (0, vitest_1.it)("setEnabled(false) stops further writes", async () => {
        const r = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: tmpDir });
        r.write({ kind: "app.start", version: "x", pollIntervalSeconds: 60, noWindow: false, platform: "win32" });
        await r.flush();
        r.setEnabled(false);
        r.write({ kind: "refresh.start", providers: ["claude"], trigger: "interval" });
        await r.flush();
        const files = await promises_1.default.readdir(tmpDir);
        const content = await promises_1.default.readFile(node_path_1.default.join(tmpDir, files[0]), "utf8");
        (0, vitest_1.expect)(content.trim().split("\n")).toHaveLength(1);
    });
});
