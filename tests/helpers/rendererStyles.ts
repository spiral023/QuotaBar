import { readFileSync } from "node:fs";
import path from "node:path";

export function rendererStyles(): string {
  const root = path.resolve("src/renderer");
  const entry = readFileSync(path.join(root, "styles.css"), "utf8");
  return [...entry.matchAll(/@import url\("([^"]+)"\);/g)].map(match => readFileSync(path.join(root, match[1]), "utf8")).join("\n");
}
