"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const snapshotCache_1 = require("../src/usage/snapshotCache");
const tmpRoot = node_path_1.default.join(node_os_1.default.tmpdir(), `quotabar-snapshot-cache-${process.pid}`);
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpRoot, { recursive: true, force: true });
});
function snapshot(provider, status = "ok") {
    return {
        provider,
        status,
        windows: [{ name: "fiveHour", usedPercent: 42 }],
        updatedAt: "2026-05-26T10:00:00.000Z",
    };
}
(0, vitest_1.describe)("snapshot cache", () => {
    (0, vitest_1.it)("round-trips usage snapshots through a JSON cache file", async () => {
        const cachePath = node_path_1.default.join(tmpRoot, "usage-snapshots.json");
        const snapshots = [snapshot("claude"), snapshot("codex", "not_authenticated")];
        await (0, snapshotCache_1.saveCachedSnapshots)(cachePath, snapshots);
        (0, vitest_1.expect)(await (0, snapshotCache_1.loadCachedSnapshots)(cachePath)).toEqual(snapshots);
    });
    (0, vitest_1.it)("returns an empty list for missing or invalid cache files", async () => {
        const missingPath = node_path_1.default.join(tmpRoot, "missing.json");
        const invalidPath = node_path_1.default.join(tmpRoot, "invalid.json");
        await promises_1.default.mkdir(tmpRoot, { recursive: true });
        await promises_1.default.writeFile(invalidPath, "{not-json", "utf8");
        (0, vitest_1.expect)(await (0, snapshotCache_1.loadCachedSnapshots)(missingPath)).toEqual([]);
        (0, vitest_1.expect)(await (0, snapshotCache_1.loadCachedSnapshots)(invalidPath)).toEqual([]);
    });
    (0, vitest_1.it)("marks cached ok snapshots as stale without changing auth failures", () => {
        const result = (0, snapshotCache_1.markSnapshotsFromCache)([
            snapshot("claude", "ok"),
            snapshot("codex", "not_authenticated"),
        ], "2026-05-26T11:00:00.000Z");
        (0, vitest_1.expect)(result[0]).toMatchObject({
            provider: "claude",
            status: "stale",
            updatedAt: "2026-05-26T11:00:00.000Z",
            errorMessage: "Showing cached data while refreshing",
        });
        (0, vitest_1.expect)(result[1]).toMatchObject({
            provider: "codex",
            status: "not_authenticated",
            updatedAt: "2026-05-26T10:00:00.000Z",
        });
    });
});
