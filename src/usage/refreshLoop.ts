import { UsageProvider, UsageSnapshot, errorSnapshot } from "../providers/types";
import { toErrorMessage } from "../shared/errors";
import { log } from "../main/logging";
import { UsageStore } from "./usageStore";
import { computeLinearPace, toRateWindow } from "./usagePace";
import type { PricingEngine } from "../pricing/subscription-factor";

export type RefreshListener = (snapshots: UsageSnapshot[]) => void;

export class RefreshLoop {
  private timer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  private readonly listeners = new Set<RefreshListener>();

  constructor(
    private readonly providers: UsageProvider[],
    private readonly store: UsageStore,
    private readonly intervalSeconds: number,
    private readonly timeoutMs: number,
    private readonly pricingEngine?: PricingEngine
  ) {}

  onRefresh(listener: RefreshListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    void this.refreshNow();
    this.timer = setInterval(() => void this.refreshNow(), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshNow(): Promise<UsageSnapshot[]> {
    if (this.isRefreshing) {
      return this.store.getAll();
    }

    this.isRefreshing = true;
    try {
      const snapshots = await Promise.all(this.providers.map((provider) => this.fetchWithTimeout(provider)));
      const now = new Date();
      for (const snapshot of snapshots) {
        for (const window of snapshot.windows) {
          if (window.name === "weekly") {
            window.pace = computeLinearPace(toRateWindow(window), now);
          }
        }
        if (this.pricingEngine) {
          snapshot.costFactor = await this.pricingEngine.calculateFactor(snapshot);
        }
      }
      const merged = this.store.update(snapshots);
      for (const listener of this.listeners) listener(merged);
      return merged;
    } finally {
      this.isRefreshing = false;
    }
  }

  private async fetchWithTimeout(provider: UsageProvider): Promise<UsageSnapshot> {
    try {
      return await withTimeout(provider.fetchUsage(), this.timeoutMs, `${provider.displayName} timed out`);
    } catch (error) {
      log.warn(`${provider.id} refresh failed: ${toErrorMessage(error)}`);
      return errorSnapshot(provider.id, toErrorMessage(error), "error");
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
