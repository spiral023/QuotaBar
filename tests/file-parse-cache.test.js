"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const file_parse_cache_1 = require("../src/pricing/file-parse-cache");
const tmpRoot = node_path_1.default.join(node_os_1.default.tmpdir(), `quotabar-file-cache-${process.pid}`);
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpRoot, { recursive: true, force: true });
});
(0, vitest_1.describe)("FileParseCache", () => {
    (0, vitest_1.it)("reuses parsed output while path, mtime, and size stay unchanged", async () => {
        const filePath = node_path_1.default.join(tmpRoot, "session.jsonl");
        await promises_1.default.mkdir(tmpRoot, { recursive: true });
        await promises_1.default.writeFile(filePath, "one\n", "utf8");
        const cache = new file_parse_cache_1.FileParseCache();
        let parseCount = 0;
        const first = await cache.get(filePath, async () => {
            parseCount++;
            return ["parsed"];
        });
        const second = await cache.get(filePath, async () => {
            parseCount++;
            return ["parsed-again"];
        });
        (0, vitest_1.expect)(first).toEqual(["parsed"]);
        (0, vitest_1.expect)(second).toBe(first);
        (0, vitest_1.expect)(parseCount).toBe(1);
    });
    (0, vitest_1.it)("invalidates cached output when the file changes", async () => {
        const filePath = node_path_1.default.join(tmpRoot, "session.jsonl");
        await promises_1.default.mkdir(tmpRoot, { recursive: true });
        await promises_1.default.writeFile(filePath, "one\n", "utf8");
        const cache = new file_parse_cache_1.FileParseCache();
        await cache.get(filePath, async () => ["old"]);
        await promises_1.default.writeFile(filePath, "one\ntwo\n", "utf8");
        const updated = await cache.get(filePath, async () => ["new"]);
        (0, vitest_1.expect)(updated).toEqual(["new"]);
    });
    (0, vitest_1.it)("falls back to parsing when file metadata cannot be read", async () => {
        const filePath = node_path_1.default.join(tmpRoot, "missing.jsonl");
        const cache = new file_parse_cache_1.FileParseCache();
        const result = await cache.get(filePath, async () => []);
        (0, vitest_1.expect)(result).toEqual([]);
    });
});
