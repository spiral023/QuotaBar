import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules", "dist", "release", "package-output"]);
const textFileNames = new Set([".gitignore"]);
const textExtensions = new Set([".json", ".md", ".ts", ".yml", ".yaml"]);

function readPngFromIco(filePath: string): PNG {
  const buffer = fs.readFileSync(filePath);
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1);
  expect(buffer.readUInt16LE(4)).toBeGreaterThan(0);

  const imageSize = buffer.readUInt32LE(14);
  const imageOffset = buffer.readUInt32LE(18);
  const image = buffer.subarray(imageOffset, imageOffset + imageSize);
  return PNG.sync.read(image);
}

function pixelAt(image: PNG, x: number, y: number): [number, number, number, number] {
  const offset = (image.width * y + x) * 4;
  return [
    image.data[offset] ?? 0,
    image.data[offset + 1] ?? 0,
    image.data[offset + 2] ?? 0,
    image.data[offset + 3] ?? 0,
  ];
}

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

  it("uses the frontend logo for the packaged app and NSIS installer icons", () => {
    const builderConfig = fs.readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8");
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    expect(builderConfig).toContain("icon: assets/icon.ico");
    expect(builderConfig).toContain("installerIcon: assets/icon.ico");
    expect(builderConfig).toContain("uninstallerIcon: assets/icon.ico");
    expect(readme).toContain('<img src="assets/icon.png" width="72" height="72" alt="QuotaBar icon">');

    const icon = readPngFromIco(path.join(repoRoot, "assets", "icon.ico"));
    expect(icon.width).toBe(256);
    expect(icon.height).toBe(256);

    const [, , , cornerAlpha] = pixelAt(icon, 0, 0);
    expect(cornerAlpha).toBe(0);

    const whitePixels = icon.data.reduce((count, value, index, data) => {
      if (index % 4 !== 0) return count;
      const r = value;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      const a = data[index + 3] ?? 0;
      return count + (a > 220 && r > 220 && g > 220 && b > 220 ? 1 : 0);
    }, 0);
    expect(whitePixels).toBe(0);

    const [centerR, centerG, centerB, centerAlpha] = pixelAt(icon, 128, 128);
    expect(centerAlpha).toBe(255);
    expect(centerG).toBeGreaterThan(centerR);
    expect(centerG).toBeGreaterThan(centerB);
  });
});
