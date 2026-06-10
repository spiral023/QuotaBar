import { UsageProvider, UsageSnapshot, errorSnapshot } from "../providers/types";
import { RateLimitError, toErrorMessage } from "../shared/errors";
import { log } from "../main/logging";
import { UsageStore } from "./usageStore";
import { computeLinearPace, toRateWindow, computeSafetyGap } from "./usagePace";
import { BurnRateTracker } from "./burnRateTracker";
import type { PricingEngine } from "../pricing/subscription-factor";
import type { DebugRecorder } from "../main/debugRecorder";
import { snapshotEvent } from "../main/debugEvents";
import { computeBackoffMs } from "./backoff";
import { classifyFetchError } from "./fetchErrorClassifier";

export type RefreshListener = (snapshots: UsageSnapshot[]) => void;

export class RefreshLoop {
  private timer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  private readonly listeners = new Set<RefreshListener>();
  private readonly backoff = new Map<string, number>(); // provider.id → expiry timestamp (ms)
  private readonly skipLoggedUntil = new Map<string, number>(); // provider.id → backoff expiry that was already skip-logged
  private readonly burnRateTracker = new BurnRateTracker();
  private readonly consecutiveRateLimits = new Map<string, number>();
  private offline = false;
  private lastCostWindow: string | undefined;

  constructor(
    private readonly providers: UsageProvider[],
    private readonly store: UsageStore,
    private readonly intervalSeconds: number,
    private readonly timeoutMs: number,
    private readonly pricingEngine?: PricingEngine,
    private readonly recorder?: DebugRecorder
  ) {}

  onRefresh(listener: RefreshListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    void this.refreshNow("interval");
    this.timer = setInterval(() => void this.refreshNow("interval"), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshNow(trigger: "interval" | "manual" | "dashboard" = "interval"): Promise<UsageSnapshot[]> {
    if (this.isRefreshing) {
      return this.store.getAll();
    }

    this.isRefreshing = true;
    try {
      const nowMs = Date.now();
      const active = this.providers.filter((p) => {
        const until = this.backoff.get(p.id);
        if (until === undefined || nowMs >= until) {
          this.skipLoggedUntil.delete(p.id);
          return true;
        }
        if (this.skipLoggedUntil.get(p.id) !== until) {
          const remainingSeconds = Math.ceil((until - nowMs) / 1000);
          log.info(`${p.id} rate-limited, skipping refresh (${remainingSeconds}s remaining)`);
          this.recorder?.write({ kind: "refresh.skipped", provider: p.id, reason: "rate-limited", remainingSeconds });
          this.skipLoggedUntil.set(p.id, until);
        }
        return false;
      });
      this.recorder?.write({ kind: "refresh.start", providers: active.map((p) => p.id), trigger });
      const snapshots = await Promise.all(active.map((provider) => this.fetchWithTimeout(provider)));
      const now = new Date();
      for (const snapshot of snapshots) {
        for (const window of snapshot.windows) {
          if (window.name === "weekly" || window.name === "fiveHour") {
            window.pace = computeLinearPace(toRateWindow(window), now);
          }
          if (typeof window.usedPercent === "number" && window.resetsAt) {
            this.burnRateTracker.record(snapshot.provider, window.name, window.usedPercent, now);
            window.burnRatePctPerHour = this.burnRateTracker.getBurnRate(snapshot.provider, window.name);
          }
          if (window.pace && window.resetsAt) {
            window.safetyGapSeconds = computeSafetyGap(window.resetsAt, window.pace, now);
          }
        }
        if (this.pricingEngine) {
          snapshot.costFactor = await this.pricingEngine.calculateFactor(snapshot);
          const win = snapshot.costFactor?.windowLabel;
          if (win) {
            if (this.lastCostWindow !== undefined && this.lastCostWindow !== win) {
              this.recorder?.write({ kind: "cost.window.changed", from: this.lastCostWindow, to: win, reason: "settings" });
              log.info(`cost window changed from ${this.lastCostWindow} to ${win}`);
            }
            this.lastCostWindow = win;
          }
        }
        this.recorder?.write(snapshotEvent(snapshot));
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
      const snapshot = await withTimeout(provider.fetchUsage(), this.timeoutMs, `${provider.displayName} timed out`);
      this.consecutiveRateLimits.delete(provider.id);
      if (this.offline) {
        this.offline = false;
        this.recorder?.write({ kind: "network.recovered" });
        log.info("network recovered");
      }
      return snapshot;
    } catch (error) {
      if (error instanceof RateLimitError) {
        const consecutive = (this.consecutiveRateLimits.get(provider.id) ?? 0) + 1;
        this.consecutiveRateLimits.set(provider.id, consecutive);
        const backoffMs = computeBackoffMs(error.retryAfterMs, consecutive);
        this.backoff.set(provider.id, Date.now() + backoffMs);
        this.skipLoggedUntil.delete(provider.id);
        log.warn(`${provider.id} rate-limited (#${consecutive}), backing off for ${Math.round(backoffMs / 1000)}s`);
        return errorSnapshot(provider.id, toErrorMessage(error), "error");
      }
      const cls = classifyFetchError(error);
      if (cls.kind === "dns") {
        this.offline = true;
        this.recorder?.write({ kind: "dns.lookup.failed", provider: provider.id, code: cls.code });
      } else if (cls.kind === "network") {
        this.offline = true;
        this.recorder?.write({ kind: "network.check.failed", provider: provider.id, code: cls.code });
      }
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
