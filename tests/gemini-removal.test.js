"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const repoRoot = node_path_1.default.resolve(__dirname, "..");
const ignoredDirs = new Set([".git", ".claude", ".superpowers", ".vscode", ".worktrees", "node_modules", "dist", "release", "package-output"]);
const textExtensions = new Set([".json", ".md", ".ts", ".html", ".yml", ".yaml"]);
function listTextFiles(dir) {
    return node_fs_1.default.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = node_path_1.default.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (ignoredDirs.has(entry.name))
                return [];
            if (node_path_1.default.relative(repoRoot, fullPath).startsWith(`docs${node_path_1.default.sep}superpowers`))
                return [];
            return listTextFiles(fullPath);
        }
        return textExtensions.has(node_path_1.default.extname(entry.name)) ? [fullPath] : [];
    });
}
(0, vitest_1.describe)("Gemini removal", () => {
    (0, vitest_1.it)("does not reference Gemini in tracked source, tests, docs, or package metadata", () => {
        const matches = listTextFiles(repoRoot)
            .filter((filePath) => !filePath.endsWith(node_path_1.default.join("tests", "gemini-removal.test.ts")))
            .filter((filePath) => !filePath.endsWith(node_path_1.default.join("docs", "how-quotabar-calculates.md")))
            .flatMap((filePath) => {
            const content = node_fs_1.default.readFileSync(filePath, "utf8");
            return /gemini/i.test(content) ? [node_path_1.default.relative(repoRoot, filePath)] : [];
        });
        (0, vitest_1.expect)(matches).toEqual([]);
    });
});
