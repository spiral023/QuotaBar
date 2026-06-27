import type { UsageSnapshot, UsageWindow } from "../providers/types";
import type { NotificationSettings } from "../config/settings";
import type { PaceStage } from "../usage/usagePace";
import { localISOString } from "./logging";

export type NotificationSeverity = "info" | "watch" | "warning" | "critical";

export interface NotificationEvent {
  ruleId: string;
  provider: string;
  windowName?: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  firedAt: string;
  reason: string;
}

export interface NotificationContext {
  current: UsageSnapshot[];
  previous: UsageSnapshot[];
  settings: NotificationSettings;
  now?: Date;
}

// ── State store ───────────────────────────────────────────────────────────────

export interface PersistedNotificationState {
  lastFired: Record<string, number>;
  lastGlobalFiredAt: number;
  lastPercent?: Record<string, number>; // undefined-Werte werden weggelassen
  lastResetsAt?: Record<string, string>; // geplanter Reset-Zeitpunkt (ISO) des zuletzt gesehenen Fensters
  dismissedUpdateVersion?: string | null;
}

export class NotificationStateStore {
  private readonly lastFired       = new Map<string, number>();
  private readonly lastPercent     = new Map<string, number | undefined>();
  private readonly lastResetsAt    = new Map<string, string | undefined>();
  private readonly lastPaceStage   = new Map<string, PaceStage | null | undefined>();
  private readonly lastStatus      = new Map<string, string>();
  private readonly staleStartedAt  = new Map<string, number>();
  private readonly resetDetectedAt = new Map<string, number>();
  private lastGlobalFiredAt        = 0;
  private _dismissedUpdateVersion: string | null = null;

  getDismissedUpdateVersion(): string | null {
    return this._dismissedUpdateVersion;
  }

  setDismissedUpdateVersion(version: string): void {
    this._dismissedUpdateVersion = version;
  }

  loadPersisted(saved: PersistedNotificationState): void {
    for (const [k, v] of Object.entries(saved.lastFired)) {
      this.lastFired.set(k, v);
    }
    if (typeof saved.lastGlobalFiredAt === "number") {
      this.lastGlobalFiredAt = saved.lastGlobalFiredAt;
    }
    if (saved.lastPercent) {
      for (const [k, v] of Object.entries(saved.lastPercent)) {
        this.lastPercent.set(k, v);
      }
    }
    if (saved.lastResetsAt) {
      for (const [k, v] of Object.entries(saved.lastResetsAt)) {
        this.lastResetsAt.set(k, v);
      }
    }
    if (saved.dismissedUpdateVersion !== undefined) {
      this._dismissedUpdateVersion = saved.dismissedUpdateVersion ?? null;
    }
  }

  serialize(): PersistedNotificationState {
    const lastPercent: Record<string, number> = {};
    for (const [k, v] of this.lastPercent) {
      if (typeof v === "number") lastPercent[k] = v;
    }
    const lastResetsAt: Record<string, string> = {};
    for (const [k, v] of this.lastResetsAt) {
      if (typeof v === "string") lastResetsAt[k] = v;
    }
    return {
      lastFired: Object.fromEntries(this.lastFired),
      lastGlobalFiredAt: this.lastGlobalFiredAt,
      lastPercent,
      lastResetsAt,
      dismissedUpdateVersion: this._dismissedUpdateVersion,
    };
  }

  /** Checks only the per-rule cooldown. Global gap is enforced in the engine after deduplication. */
  canFire(ruleId: string, key: string, cooldownMinutes: number): boolean {
    const mapKey = `${ruleId}:${key}`;
    const last = this.lastFired.get(mapKey) ?? 0;
    return Date.now() - last >= cooldownMinutes * 60_000;
  }

  recordFired(ruleId: string, key: string): void {
    this.lastFired.set(`${ruleId}:${key}`, Date.now());
  }

  getLastGlobalFiredAt(): number { return this.lastGlobalFiredAt; }
  recordGlobalFired(): void { this.lastGlobalFiredAt = Date.now(); }

  getLastPercent(provider: string, windowName: string): number | undefined {
    return this.lastPercent.get(`${provider}:${windowName}`);
  }

  setLastPercent(provider: string, windowName: string, value: number | undefined): void {
    this.lastPercent.set(`${provider}:${windowName}`, value);
  }

  getLastResetsAt(provider: string, windowName: string): string | undefined {
    return this.lastResetsAt.get(`${provider}:${windowName}`);
  }

  setLastResetsAt(provider: string, windowName: string, value: string | undefined): void {
    this.lastResetsAt.set(`${provider}:${windowName}`, value);
  }

  getLastPaceStage(provider: string, windowName: string): PaceStage | null | undefined {
    return this.lastPaceStage.get(`${provider}:${windowName}`);
  }

  setLastPaceStage(provider: string, windowName: string, stage: PaceStage | null | undefined): void {
    this.lastPaceStage.set(`${provider}:${windowName}`, stage);
  }

  getLastStatus(provider: string): string {
    return this.lastStatus.get(provider) ?? "ok";
  }

  setLastStatus(provider: string, status: string): void {
    this.lastStatus.set(provider, status);
  }

  getStaleStartedAt(provider: string): number | undefined {
    return this.staleStartedAt.get(provider);
  }

  setStaleStartedAt(provider: string, t: number | undefined): void {
    if (t === undefined) this.staleStartedAt.delete(provider);
    else                 this.staleStartedAt.set(provider, t);
  }

  getResetDetectedAt(provider: string, windowName: string): number | undefined {
    return this.resetDetectedAt.get(`${provider}:${windowName}`);
  }

  setResetDetectedAt(provider: string, windowName: string, t: number | undefined): void {
    const key = `${provider}:${windowName}`;
    if (t === undefined) this.resetDetectedAt.delete(key);
    else                 this.resetDetectedAt.set(key, t);
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class NotificationEngine {
  evaluate(ctx: NotificationContext, state: NotificationStateStore): NotificationEvent[] {
    const { current, previous, settings } = ctx;
    const now = ctx.now ?? new Date();

    if (!settings.enabled) return [];

    const quietNow = isQuietHours(settings.quietHours, now);
    const lastGlobalFiredAt = state.getLastGlobalFiredAt();

    const events: NotificationEvent[] = [];

    for (const next of current) {
      const prev = previous.find(p => p.provider === next.provider);
      events.push(...evaluateProvider(next, prev, settings, state, now));
    }

    let result = deduplicateEvents(events);

    // During quiet hours, suppress non-critical events
    if (quietNow) result = result.filter(e => e.severity === "critical");

    // Global minimum gap: if another notification was sent recently, suppress non-critical
    const gapMs = settings.minimumGapMinutes * 60_000;
    if (gapMs > 0 && now.getTime() - lastGlobalFiredAt < gapMs) {
      result = result.filter(e => e.severity === "critical");
    }

    if (result.length > 0) state.recordGlobalFired();
    return result;
  }
}

// ── Per-provider evaluation ───────────────────────────────────────────────────

function evaluateProvider(
  next: UsageSnapshot,
  prev: UsageSnapshot | undefined,
  settings: NotificationSettings,
  state: NotificationStateStore,
  now: Date,
): NotificationEvent[] {
  const events: NotificationEvent[] = [];

  // Rule 18 runs even when status != ok
  events.push(...evaluateProviderDataHealth(next, settings, state, now));

  // Update stale tracking
  if (next.status === "stale" || next.status === "error") {
    if (!state.getStaleStartedAt(next.provider)) {
      state.setStaleStartedAt(next.provider, now.getTime());
    }
  } else {
    state.setStaleStartedAt(next.provider, undefined);
  }
  state.setLastStatus(next.provider, next.status);

  if (next.status !== "ok") return events;

  for (const win of next.windows) {
    if (typeof win.usedPercent !== "number") continue;
    const prevWin = prev?.windows.find(w => w.name === win.name);

    events.push(...evaluateWindowRules(next, win, prevWin, settings, state, now));

    // Update per-window state after evaluating all rules so rules can still read
    // the previous resetsAt value.
    state.setLastPercent(next.provider, win.name, win.usedPercent);
    state.setLastResetsAt(next.provider, win.name, win.resetsAt);
    state.setLastPaceStage(next.provider, win.name, win.pace?.stage ?? null);
  }

  return events;
}

function evaluateWindowRules(
  snap: UsageSnapshot,
  win: UsageWindow,
  prevWin: UsageWindow | undefined,
  settings: NotificationSettings,
  state: NotificationStateStore,
  now: Date,
): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  const { rules } = settings;
  const p = cap(win.usedPercent ?? 0);
  const pPrev = prevWin !== undefined ? cap(prevWin.usedPercent ?? 0) : state.getLastPercent(snap.provider, win.name);
  const key = `${snap.provider}:${win.name}`;

  // Was a scheduled reset already due at observation time? The scheduled reset
  // timestamp comes from the previous window (in memory or persisted), not from
  // win.resetsAt, which already points to the next cycle after the reset.
  // This happens when the machine was offline across the reset and only sees the
  // drop later: the drop is expected and must not alert as an unexpected reset.
  const prevResetIso = prevWin?.resetsAt ?? state.getLastResetsAt(snap.provider, win.name);
  const prevResetMs = prevResetIso !== undefined ? new Date(prevResetIso).getTime() : NaN;
  const scheduledResetDue = !Number.isNaN(prevResetMs) && prevResetMs <= now.getTime();

  const fireConfirmedReset = (reason: string): void => {
    if (!rules.confirmedReset.enabled) return;
    if (!state.canFire("confirmedReset", key, rules.confirmedReset.cooldownMinutes)) return;
    events.push({
      ruleId: "confirmedReset",
      provider: snap.provider, windowName: win.name,
      severity: "info",
      title: `${cap1(snap.provider)} ${windowLabel(win.name)} reset`,
      body: `Quota usage is back to 0%.`,
      firedAt: localISOString(now),
      reason,
    });
    state.recordFired("confirmedReset", key);
    state.setResetDetectedAt(snap.provider, win.name, now.getTime());
  };

  // Rule 1: Confirmed limit reset (previous >= 99.5%, current <= 1%)
  if (p <= 1 && pPrev !== undefined && pPrev >= 99.5) {
    fireConfirmedReset(`usedPercent ${pPrev.toFixed(0)}% → ${p.toFixed(0)}%`);
  }

  // Rule 2: Significant drop, not a normal 99.5 reset.
  const cfg2 = rules.unexpectedReset;
  if (
    cfg2.enabled &&
    pPrev !== undefined &&
    pPrev >= cfg2.minPreviousPercent &&
    p <= cfg2.maxNextPercent &&
    !(pPrev >= 99.5) // not handled by rule 1
  ) {
    if (scheduledResetDue) {
      // Scheduled reset observed late: send a friendly reset info instead of an
      // unexpected-reset alert.
      fireConfirmedReset(`usedPercent ${pPrev.toFixed(0)}% -> ${p.toFixed(0)}% (scheduled reset observed late)`);
    } else if (state.canFire("unexpectedReset", key, cfg2.cooldownMinutes)) {
      events.push({
        ruleId: "unexpectedReset",
        provider: snap.provider, windowName: win.name,
        severity: "watch",
        title: `${cap1(snap.provider)} ${windowLabel(win.name)}: Unexpected reset`,
        body: `Usage dropped from ${pPrev.toFixed(0)}% to ${p.toFixed(0)}% outside the normal reset cycle. Possible causes: promo reset, plan change, or API maintenance.`,
        firedAt: localISOString(now),
        reason: `usedPercent ${pPrev.toFixed(0)}% -> ${p.toFixed(0)}% (outside scheduled reset)`,
      });
      state.recordFired("unexpectedReset", key);
    }
  }

  // Rule 3: Reset soon
  const cfg3 = rules.resetSoon;
  if (cfg3.enabled && win.resetsAt) {
    const minutesUntilReset = (new Date(win.resetsAt).getTime() - now.getTime()) / 60_000;
    if (minutesUntilReset > 0 && minutesUntilReset <= cfg3.minutesBeforeReset) {
      if (state.canFire("resetSoon", key, cfg3.cooldownMinutes)) {
        events.push({
          ruleId: "resetSoon",
          provider: snap.provider, windowName: win.name,
          severity: "info",
          title: `${cap1(snap.provider)} ${windowLabel(win.name)} resets soon`,
          body: `Reset in ${Math.ceil(minutesUntilReset)} minutes.`,
          firedAt: localISOString(now),
          reason: `resetsAt in ${minutesUntilReset.toFixed(0)} min`,
        });
        state.recordFired("resetSoon", key);
      }
    }
  }

  // Rule 4: High usage crossed (threshold crossing, not repeat)
  const cfg4 = rules.highUsage;
  if (cfg4.enabled && p >= cfg4.thresholdPercent && (pPrev === undefined || pPrev < cfg4.thresholdPercent)) {
    if (state.canFire("highUsage", key, cfg4.cooldownMinutes)) {
      events.push({
        ruleId: "highUsage",
        provider: snap.provider, windowName: win.name,
        severity: "warning",
        title: `${cap1(snap.provider)} ${windowLabel(win.name)}: ${p.toFixed(0)}% used`,
        body: `Quota usage has crossed ${cfg4.thresholdPercent}%.`,
        firedAt: localISOString(now),
        reason: `usedPercent crossed ${cfg4.thresholdPercent}%`,
      });
      state.recordFired("highUsage", key);
    }
  }

  // Rule 5: Critical usage crossed
  const cfg5 = rules.criticalUsage;
  if (cfg5.enabled && p >= cfg5.thresholdPercent && (pPrev === undefined || pPrev < cfg5.thresholdPercent)) {
    if (state.canFire("criticalUsage", key, cfg5.cooldownMinutes)) {
      events.push({
        ruleId: "criticalUsage",
        provider: snap.provider, windowName: win.name,
        severity: "critical",
        title: `${cap1(snap.provider)} ${windowLabel(win.name)}: ${p.toFixed(0)}% used`,
        body: `Critical threshold reached. Quota will be depleted soon.`,
        firedAt: localISOString(now),
        reason: `usedPercent crossed ${cfg5.thresholdPercent}%`,
      });
      state.recordFired("criticalUsage", key);
    }
  }

  // Rule 6: Projected depletion before reset
  const cfg6 = rules.projectedDepletion;
  if (cfg6.enabled && win.pace && !win.pace.willLastToReset && win.pace.etaSeconds !== null && win.pace.etaSeconds > 0 && win.resetsAt) {
    const minutesUntilReset = (new Date(win.resetsAt).getTime() - now.getTime()) / 60_000;
    const minutesUntilEmpty = win.pace.etaSeconds / 60;
    // Suppress ETA < 2 min because it is too short for an actionable warning.
    if (minutesUntilReset > 0 && minutesUntilEmpty >= 2 && minutesUntilEmpty < minutesUntilReset - cfg6.minEarlyMinutes) {
      if (state.canFire("projectedDepletion", key, cfg6.cooldownMinutes)) {
        events.push({
          ruleId: "projectedDepletion",
          provider: snap.provider, windowName: win.name,
          severity: "warning",
          title: `${cap1(snap.provider)} ${windowLabel(win.name)}: Quota will run out`,
          body: `At the current pace, quota will be depleted before reset.`,
          firedAt: localISOString(now),
          reason: `etaSeconds=${win.pace.etaSeconds}, minutesUntilReset=${minutesUntilReset.toFixed(0)}`,
        });
        state.recordFired("projectedDepletion", key);
      }
    }
  }

  // Rule 7: Far ahead pace transition
  const cfg7 = rules.farAhead;
  const currentStage = win.pace?.stage ?? null;
  // Use stored state as primary source; fall back to prevWin pace on first evaluation
  const prevStageStored = state.getLastPaceStage(snap.provider, win.name);
  const prevStage = prevStageStored !== undefined ? prevStageStored : (prevWin?.pace?.stage ?? null);
  if (
    cfg7.enabled &&
    currentStage === "farAhead" &&
    prevStage !== null &&
    prevStage !== "farAhead" &&
    Math.abs(win.pace?.deltaPercent ?? 0) >= cfg7.minDeltaPercent
  ) {
    if (state.canFire("farAhead", key, cfg7.cooldownMinutes)) {
      const delta = (win.pace?.deltaPercent ?? 0).toFixed(0);
      events.push({
        ruleId: "farAhead",
        provider: snap.provider, windowName: win.name,
        severity: "watch",
        title: `${cap1(snap.provider)} ${windowLabel(win.name)}: Usage well above pace`,
        body: `Usage pace is ${delta}% above the expected daily average.`,
        firedAt: localISOString(now),
        reason: `pace transitioned to farAhead (delta=${delta}%)`,
      });
      state.recordFired("farAhead", key);
    }
  }

  // Rule 8: Far behind pace transition
  const cfg8 = rules.farBehind;
  if (
    cfg8.enabled &&
    currentStage === "farBehind" &&
    prevStage !== null &&
    prevStage !== "farBehind" &&
    Math.abs(win.pace?.deltaPercent ?? 0) >= cfg8.minDeltaPercent
  ) {
    if (state.canFire("farBehind", key, cfg8.cooldownMinutes)) {
      const delta = Math.abs(win.pace?.deltaPercent ?? 0).toFixed(0);
      events.push({
        ruleId: "farBehind",
        provider: snap.provider, windowName: win.name,
        severity: "info",
        title: `${cap1(snap.provider)} ${windowLabel(win.name)}: Much more reserve than usual`,
        body: `Usage pace is ${delta}% below the weekly path. Plenty of quota remains.`,
        firedAt: localISOString(now),
        reason: `pace transitioned to farBehind (delta=-${delta}%)`,
      });
      state.recordFired("farBehind", key);
    }
  }

  return events;
}

// ── Rule 18: Provider data health ────────────────────────────────────────────

function evaluateProviderDataHealth(
  snap: UsageSnapshot,
  settings: NotificationSettings,
  state: NotificationStateStore,
  now: Date,
): NotificationEvent[] {
  const cfg = settings.rules.providerDataHealth;
  if (!cfg.enabled) return [];

  const events: NotificationEvent[] = [];
  const key = snap.provider;
  const prevStatus = state.getLastStatus(snap.provider);
  const isStaleNow = snap.status === "stale" || snap.status === "error";

  if (isStaleNow) {
    const staleStart = state.getStaleStartedAt(snap.provider) ?? now.getTime();
    const staleMinutes = (now.getTime() - staleStart) / 60_000;
    if (staleMinutes >= cfg.staleMinutes) {
      if (state.canFire("providerDataHealth:stale", key, cfg.cooldownMinutes)) {
        events.push({
          ruleId: "providerDataHealth",
          provider: snap.provider,
          severity: "watch",
          title: `${cap1(snap.provider)}: data is stale`,
          body: `Usage data has not been updated for more than ${cfg.staleMinutes} minutes.`,
          firedAt: localISOString(now),
          reason: `status=${snap.status} for ${staleMinutes.toFixed(0)} min`,
        });
        state.recordFired("providerDataHealth:stale", key);
      }
    }
  } else if ((prevStatus === "stale" || prevStatus === "error") && snap.status === "ok") {
    if (cfg.notifyRecovered && state.canFire("providerDataHealth:recovered", key, cfg.cooldownMinutes)) {
      events.push({
        ruleId: "providerDataHealth",
        provider: snap.provider,
        severity: "info",
        title: `${cap1(snap.provider)}: data is current again`,
        body: `Usage data is available again after an interruption.`,
        firedAt: localISOString(now),
        reason: `status recovered from ${prevStatus} to ok`,
      });
      state.recordFired("providerDataHealth:recovered", key);
    }
  }

  return events;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<NotificationSeverity, number> = { critical: 3, warning: 2, watch: 1, info: 0 };

function deduplicateEvents(events: NotificationEvent[]): NotificationEvent[] {
  // criticalUsage replaces highUsage for same provider+window
  const hasCritical = new Set(events.filter(e => e.ruleId === "criticalUsage").map(e => `${e.provider}:${e.windowName}`));
  // unexpectedReset replaces confirmedReset for same key
  const hasUnexpected = new Set(events.filter(e => e.ruleId === "unexpectedReset").map(e => `${e.provider}:${e.windowName}`));
  // projectedDepletion replaces farAhead for same key
  const hasDepletion = new Set(events.filter(e => e.ruleId === "projectedDepletion").map(e => `${e.provider}:${e.windowName}`));

  const filtered = events.filter(e => {
    const k = `${e.provider}:${e.windowName}`;
    if (e.ruleId === "highUsage" && hasCritical.has(k)) return false;
    if (e.ruleId === "confirmedReset" && hasUnexpected.has(k)) return false;
    if (e.ruleId === "farAhead" && hasDepletion.has(k)) return false;
    return true;
  });

  // Per provider+window: keep only highest severity
  const best = new Map<string, NotificationEvent>();
  for (const e of filtered) {
    const k = `${e.provider}:${e.windowName}`;
    const existing = best.get(k);
    if (!existing || SEVERITY_RANK[e.severity] > SEVERITY_RANK[existing.severity]) {
      best.set(k, e);
    }
  }

  // Provider-level events (no windowName) keep all
  const providerLevel = filtered.filter(e => !e.windowName);
  return [...best.values(), ...providerLevel];
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isQuietHours(qh: { enabled: boolean; start: string; end: string }, now: Date): boolean {
  if (!qh.enabled) return false;
  const [sh, sm] = qh.start.split(":").map(Number);
  const [eh, em] = qh.end.split(":").map(Number);
  const nowMin   = now.getHours() * 60 + now.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

export { isQuietHours };

function cap(v: number): number { return Math.min(100, Math.max(0, v)); }
function cap1(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }

const WINDOW_LABELS: Record<string, string> = {
  fiveHour: "5h",
  weekly:   "week",
  monthly:  "month",
  credits:  "Credits",
  session:  "Session",
};

function windowLabel(name: string): string {
  return WINDOW_LABELS[name] ?? name;
}
