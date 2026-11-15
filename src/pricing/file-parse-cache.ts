import fs from "node:fs/promises";
import path from "node:path";

interface CacheEntry<T> {
  fingerprint: string;
  value: T;
  items: number;
}

export class FileParseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private items = 0;

  /** Array items bound parsed event retention; this is not a byte limit. */
  constructor(private readonly maxEntries = 128, private readonly maxItems = 100_000) {
    if (![maxEntries, maxItems].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Invalid parse cache capacity");
    }
  }

  get size(): number { return this.entries.size; }

  async get(filePath: string, parse: () => Promise<T>): Promise<T> {
    const resolved = path.resolve(filePath);
    const fingerprint = await fileFingerprint(resolved);
    if (fingerprint === null) { this.remove(resolved); return parse(); }
    const existing = this.entries.get(resolved);
    if (existing?.fingerprint === fingerprint) {
      this.entries.delete(resolved); this.entries.set(resolved, existing);
      return existing.value;
    }

    this.remove(resolved);
    const value = await parse();
    const items = Array.isArray(value) ? Math.max(1, value.length) : 1;
    if (items > this.maxItems) return value;
    // Another asynchronous parse may have completed for the same file meanwhile.
    this.remove(resolved);
    this.entries.set(resolved, { fingerprint, value, items }); this.items += items;
    while (this.entries.size > this.maxEntries || this.items > this.maxItems) this.remove(this.entries.keys().next().value!);
    return value;
  }

  clear(): void {
    this.entries.clear();
    this.items = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.items -= entry.items;
    this.entries.delete(key);
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
