"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const paths_1 = require("../src/config/paths");
const tmpRoot = node_path_1.default.join(node_os_1.default.tmpdir(), `quotabar-paths-${process.pid}`);
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpRoot, { recursive: true, force: true });
});
(0, vitest_1.describe)("data path resolution", () => {
    (0, vitest_1.it)("combines current and legacy Claude project directories by default", async () => {
        const home = node_path_1.default.join(tmpRoot, "home");
        const current = node_path_1.default.join(home, ".config", "claude", "projects");
        const legacy = node_path_1.default.join(home, ".claude", "projects");
        await promises_1.default.mkdir(current, { recursive: true });
        await promises_1.default.mkdir(legacy, { recursive: true });
        (0, vitest_1.expect)((0, paths_1.getClaudeProjectsDirs)({ homeDir: home, env: {} })).toEqual([current, legacy]);
    });
    (0, vitest_1.it)("uses comma-separated CLAUDE_CONFIG_DIR roots and skips duplicates and missing dirs", async () => {
        const rootA = node_path_1.default.join(tmpRoot, "claude-a");
        const rootB = node_path_1.default.join(tmpRoot, "claude-b");
        await promises_1.default.mkdir(node_path_1.default.join(rootA, "projects"), { recursive: true });
        await promises_1.default.mkdir(node_path_1.default.join(rootB, "projects"), { recursive: true });
        (0, vitest_1.expect)((0, paths_1.getClaudeProjectsDirs)({
            homeDir: tmpRoot,
            env: { CLAUDE_CONFIG_DIR: `${rootA},${rootA},${node_path_1.default.join(tmpRoot, "missing")},${rootB}` },
        })).toEqual([node_path_1.default.join(rootA, "projects"), node_path_1.default.join(rootB, "projects")]);
    });
    (0, vitest_1.it)("uses comma-separated CODEX_HOME roots for sessions and configs", async () => {
        const homeA = node_path_1.default.join(tmpRoot, "codex-a");
        const homeB = node_path_1.default.join(tmpRoot, "codex-b");
        await promises_1.default.mkdir(node_path_1.default.join(homeA, "sessions"), { recursive: true });
        await promises_1.default.mkdir(node_path_1.default.join(homeB, "sessions"), { recursive: true });
        const ctx = { homeDir: tmpRoot, env: { CODEX_HOME: `${homeA},${homeB},${homeA}` } };
        (0, vitest_1.expect)((0, paths_1.getCodexHomes)(ctx)).toEqual([homeA, homeB]);
        (0, vitest_1.expect)((0, paths_1.getCodexSessionsDirs)(ctx)).toEqual([
            node_path_1.default.join(homeA, "sessions"),
            node_path_1.default.join(homeB, "sessions"),
        ]);
        (0, vitest_1.expect)((0, paths_1.getCodexConfigPaths)(ctx)).toEqual([
            node_path_1.default.join(homeA, "config.toml"),
            node_path_1.default.join(homeB, "config.toml"),
        ]);
    });
});
(0, vitest_1.describe)("debug log paths", () => {
    (0, vitest_1.it)("returns debug subdir under app config dir", () => {
        (0, vitest_1.expect)((0, paths_1.getDebugLogDir)()).toMatch(/[\\/]\.quotabar-win[\\/]debug$/);
    });
    (0, vitest_1.it)("returns usage snapshot cache path under app cache dir", () => {
        (0, vitest_1.expect)((0, paths_1.getUsageSnapshotCachePath)()).toMatch(/[\\/]\.quotabar-win[\\/]cache[\\/]usage-snapshots\.json$/);
    });
    (0, vitest_1.it)("returns YYYY-MM-DD.jsonl filename for a given date", () => {
        const d = new Date(Date.UTC(2026, 4, 26, 14, 23, 0));
        (0, vitest_1.expect)((0, paths_1.getDebugLogPath)(d)).toMatch(/[\\/]debug[\\/]2026-05-26\.jsonl$/);
    });
    (0, vitest_1.it)("returns YYYY-MM-DD.backfill.jsonl filename for a given date", () => {
        const d = new Date(Date.UTC(2026, 4, 26, 14, 23, 0));
        (0, vitest_1.expect)((0, paths_1.getDebugBackfillPath)(d)).toMatch(/[\\/]debug[\\/]2026-05-26\.backfill\.jsonl$/);
    });
    (0, vitest_1.it)("uses UTC day boundary, not local", () => {
        const d = new Date(Date.UTC(2026, 4, 26, 23, 30, 0));
        (0, vitest_1.expect)((0, paths_1.getDebugLogPath)(d)).toMatch(/2026-05-26\.jsonl$/);
    });
});
