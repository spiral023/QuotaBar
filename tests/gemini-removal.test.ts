import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const ignoredDirs = new Set([".git", "node_modules", "dist", "release", "package-output"]);
const textExtensions = new Set([".json", ".md", ".ts", ".html", ".yml", ".yaml"]);

function listTextFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) return [];
      if (path.relative(repoRoot, fullPath).startsWith(`docs${path.sep}superpowers`)) return [];
      return listTextFiles(fullPath);
    }
    return textExtensions.has(path.extname(entry.name)) ? [fullPath] : [];
  });
}

describe("Gemini removal", () => {
  it("does not reference Gemini in tracked source, tests, docs, or package metadata", () => {
    const matches = listTextFiles(repoRoot)
      .filter((filePath) => !filePath.endsWith(path.join("tests", "gemini-removal.test.ts")))
      .flatMap((filePath) => {
        const content = fs.readFileSync(filePath, "utf8");
        return /gemini/i.test(content) ? [path.relative(repoRoot, filePath)] : [];
      });

    expect(matches).toEqual([]);
  });
});
