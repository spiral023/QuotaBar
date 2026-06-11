"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const repoRoot = node_path_1.default.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules", "dist", "release", "package-output"]);
const textFileNames = new Set([".gitignore"]);
const textExtensions = new Set([".json", ".md", ".ts", ".yml", ".yaml"]);
function listTextFiles(directory) {
    return node_fs_1.default.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = node_path_1.default.join(directory, entry.name);
        if (entry.isDirectory()) {
            return ignoredDirectories.has(entry.name) ? [] : listTextFiles(fullPath);
        }
        return textFileNames.has(entry.name) || textExtensions.has(node_path_1.default.extname(entry.name)) ? [fullPath] : [];
    });
}
(0, vitest_1.describe)("branding", () => {
    (0, vitest_1.it)("does not contain previous app identifiers in tracked text files", () => {
        const previousName = ["Codex", "Bar"].join("");
        const previousSlug = previousName.toLowerCase();
        const previousEnvPrefix = [previousSlug.slice(0, 5), previousSlug.slice(5)].join("").toUpperCase();
        const forbidden = [previousName, previousSlug, previousEnvPrefix];
        const matches = listTextFiles(repoRoot).flatMap((filePath) => {
            const relativePath = node_path_1.default.relative(repoRoot, filePath);
            const content = node_fs_1.default.readFileSync(filePath, "utf8");
            return forbidden
                .filter((marker) => content.includes(marker))
                .map((marker) => `${relativePath}: ${marker}`);
        });
        (0, vitest_1.expect)(matches).toEqual([]);
    });
});
