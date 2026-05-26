export class AsyncResultCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  get(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) return existing;

    const created = factory().catch((error: unknown) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, created);
    return created;
  }

  clear(): void {
    this.entries.clear();
  }
}
