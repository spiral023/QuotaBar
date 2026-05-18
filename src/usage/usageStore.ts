import { UsageSnapshot } from "../providers/types";

export class UsageStore {
  private readonly snapshots = new Map<string, UsageSnapshot>();

  update(nextSnapshots: UsageSnapshot[]): UsageSnapshot[] {
    for (const next of nextSnapshots) {
      const previous = this.snapshots.get(next.provider);
      if ((next.status === "error" || next.status === "not_authenticated") && previous?.status === "ok") {
        this.snapshots.set(next.provider, {
          ...previous,
          status: "stale",
          updatedAt: next.updatedAt,
          errorMessage: next.errorMessage
        });
      } else {
        this.snapshots.set(next.provider, next);
      }
    }
    return this.getAll();
  }

  get(provider: string): UsageSnapshot | undefined {
    return this.snapshots.get(provider);
  }

  getAll(): UsageSnapshot[] {
    return Array.from(this.snapshots.values()).sort((a, b) => a.provider.localeCompare(b.provider));
  }
}
