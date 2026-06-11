"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const backfillManifest_1 = require("../src/main/backfillManifest");
let tmp;
(0, vitest_1.beforeEach)(async () => {
    tmp = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "qb-manifest-"));
});
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmp, { recursive: true, force: true });
});
(0, vitest_1.describe)("backfillManifest", () => {
    (0, vitest_1.it)("returns an empty manifest when none exists", async () => {
        const m = await (0, backfillManifest_1.loadManifest)(tmp);
        (0, vitest_1.expect)(m.version).toBe(1);
        (0, vitest_1.expect)(m.sources).toEqual({});
    });
    (0, vitest_1.it)("returns an empty manifest when the file is corrupt", async () => {
        await promises_1.default.writeFile(node_path_1.default.join(tmp, "backfill-manifest.json"), "{ not json", "utf8");
        const m = await (0, backfillManifest_1.loadManifest)(tmp);
        (0, vitest_1.expect)(m.sources).toEqual({});
    });
    (0, vitest_1.it)("round-trips a saved manifest", async () => {
        await (0, backfillManifest_1.saveManifest)(tmp, { version: 1, sources: { "/a.jsonl": "10:123" }, lastRunAt: "2026-06-09T00:00:00.000Z" });
        const m = await (0, backfillManifest_1.loadManifest)(tmp);
        (0, vitest_1.expect)(m.sources["/a.jsonl"]).toBe("10:123");
    });
    (0, vitest_1.it)("computes a size:mtime signature for an existing file", async () => {
        const f = node_path_1.default.join(tmp, "x.jsonl");
        await promises_1.default.writeFile(f, "hello", "utf8");
        const sig = await (0, backfillManifest_1.fileSignature)(f);
        (0, vitest_1.expect)(sig).toMatch(/^\d+:\d+$/);
    });
    (0, vitest_1.it)("returns null signature for a missing file", async () => {
        (0, vitest_1.expect)(await (0, backfillManifest_1.fileSignature)(node_path_1.default.join(tmp, "nope.jsonl"))).toBeNull();
    });
    (0, vitest_1.it)("diffSources reports changed and unchanged files", async () => {
        const prev = { "/a.jsonl": "1:100", "/b.jsonl": "2:200" };
        const current = { "/a.jsonl": "1:100", "/b.jsonl": "9:999", "/c.jsonl": "3:300" };
        const { changed, unchanged } = (0, backfillManifest_1.diffSources)(prev, current);
        (0, vitest_1.expect)(changed.sort()).toEqual(["/b.jsonl", "/c.jsonl"]);
        (0, vitest_1.expect)(unchanged).toEqual(["/a.jsonl"]);
    });
});
