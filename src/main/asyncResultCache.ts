export class AsyncResultCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries = 32) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("Invalid cache capacity");
  }

  get(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }

    const created = factory().catch((error: unknown) => {
      if (this.entries.get(key) === created) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, created);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return created;
  }

  clear(): void {
    this.entries.clear();
  }
}
