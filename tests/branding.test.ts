import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules", "dist", "release", "package-output"]);
const textFileNames = new Set([".gitignore"]);
const textExtensions = new Set([".json", ".md", ".ts", ".yml", ".yaml"]);

function listTextFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : listTextFiles(fullPath);
    }

    return textFileNames.has(entry.name) || textExtensions.has(path.extname(entry.name)) ? [fullPath] : [];
  });
}

describe("branding", () => {
  it("does not contain previous app identifiers in tracked text files", () => {
    const previousName = ["Codex", "Bar"].join("");
    const previousSlug = previousName.toLowerCase();
    const previousEnvPrefix = [previousSlug.slice(0, 5), previousSlug.slice(5)].join("").toUpperCase();
    const forbidden = [previousName, previousSlug, previousEnvPrefix];

    const matches = listTextFiles(repoRoot).flatMap((filePath) => {
      const relativePath = path.relative(repoRoot, filePath);
      const content = fs.readFileSync(filePath, "utf8");
      return forbidden
        .filter((marker) => content.includes(marker))
        .map((marker) => `${relativePath}: ${marker}`);
    });

    expect(matches).toEqual([]);
  });
});
