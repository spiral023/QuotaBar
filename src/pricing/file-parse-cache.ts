import fs from "node:fs/promises";
import path from "node:path";

interface CacheEntry<T> {
  fingerprint: string;
  value: T;
}

export class FileParseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  async get(filePath: string, parse: () => Promise<T>): Promise<T> {
    const resolved = path.resolve(filePath);
    const fingerprint = await fileFingerprint(resolved);
    if (fingerprint === null) return parse();
    const existing = this.entries.get(resolved);
    if (existing?.fingerprint === fingerprint) return existing.value;

    const value = await parse();
    this.entries.set(resolved, { fingerprint, value });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

async function fileFingerprint(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}
