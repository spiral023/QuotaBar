import { describe, it, expect, beforeEach } from "vitest";
import {
  NotificationEngine,
  NotificationStateStore,
} from "../src/main/notificationEngine";
import type { NotificationContext } from "../src/main/notificationEngine";
import {
  normalizeNotificationSettings,
  defaultNotificationSettings,
  defaultSettings,
  normalizeSettings,
} from "../src/config/settings";
import type { UsageSnapshot } from "../src/providers/types";

// ── Helpers ────────────────────────────────────────────────────────────────

function snap(
  provider: string,
  windows: { name: string; usedPercent?: number; resetsAt?: string; pace?: object }[],
  status: UsageSnapshot["status"] = "ok"
): UsageSnapshot {
  return {
    provider,
    status,
    windows: windows as UsageSnapshot["windows"],
    updatedAt: new Date().toISOString(),
  };
}

function ctx(
  current: UsageSnapshot[],
  previous: UsageSnapshot[],
  overrides: object = {}
): NotificationContext {
  return {
    current,
    previous,
    settings: { ...defaultNotificationSettings, ...overrides },
  };
}

// ── normalizeNotificationSettings ─────────────────────────────────────────

describe("normalizeNotificationSettings", () => {
  it("returns defaults for undefined input", () => {
    const result = normalizeNotificationSettings(undefined);
    expect(result.enabled).toBe(true);
    expect(result.minimumGapMinutes).toBe(0);
    expect(result.rules.highUsage.thresholdPercent).toBe(80);
  });

  it("merges partial rule overrides without losing other rules", () => {
    const result = normalizeNotificationSettings({
      rules: { highUsage: { enabled: false, thresholdPercent: 70, cooldownMinutes: 30 } } as never,
    });
    expect(result.rules.highUsage.enabled).toBe(false);
    expect(result.rules.highUsage.thresholdPercent).toBe(70);
    expect(result.rules.criticalUsage.enabled).toBe(true); // unchanged
  });

  it("clamps minimumGapMinutes to 0 minimum", () => {
    const result = normalizeNotificationSettings({ minimumGapMinutes: -5 } as never);
    expect(result.minimumGapMinutes).toBe(0);
  });

  it("preserves quietHours settings", () => {
    const result = normalizeNotificationSettings({
      quietHours: { enabled: true, start: "23:00", end: "07:00" },
    } as never);
    expect(result.quietHours.enabled).toBe(true);
    expect(result.quietHours.start).toBe("23:00");
  });
});

describe("normalizeSettings includes notifications", () => {
  it("normalizeSettings includes notification defaults", () => {
    const s = normalizeSettings(defaultSettings);
    expect(s.notifications.enabled).toBe(true);
    expect(s.notifications.rules.confirmedReset.enabled).toBe(true);
  });
});

// ── Rule 1: Confirmed limit reset ─────────────────────────────────────────

describe("rule: confirmedReset", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => {
    engine = new NotificationEngine();
    state = new NotificationStateStore();
  });

  it("fires when usage drops from 99.5% to 0%", () => {
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "confirmedReset")).toBe(true);
  });

  it("does not fire when previous was below 99.5%", () => {
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 50 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "confirmedReset")).toBe(false);
  });

  it("does not fire when current usage is above 1%", () => {
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 5 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "confirmedReset")).toBe(false);
  });

  it("respects cooldown and does not fire twice", () => {
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
    engine.evaluate(ctx(current, previous), state);
    const events2 = engine.evaluate(ctx(current, previous), state);
    expect(events2.filter(e => e.ruleId === "confirmedReset")).toHaveLength(0);
  });

  it("does not fire when master switch is off", () => {
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
    const events = engine.evaluate(ctx(current, previous, { enabled: false }), state);
    expect(events).toHaveLength(0);
  });
});

// ── Rule 2: Unexpected limit reset ────────────────────────────────────────

describe("rule: unexpectedReset", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  it("fires when usage drops from 42% to 0%", () => {
    const current  = [snap("codex", [{ name: "fiveHour", usedPercent: 0 }])];
    const previous = [snap("codex", [{ name: "fiveHour", usedPercent: 42 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "unexpectedReset")).toBe(true);
  });

  it("does not fire when previous was below minPreviousPercent (25%)", () => {
    const current  = [snap("codex", [{ name: "fiveHour", usedPercent: 0 }])];
    const previous = [snap("codex", [{ name: "fiveHour", usedPercent: 10 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "unexpectedReset")).toBe(false);
  });

  it("does not fire when current is above maxNextPercent (5%)", () => {
    const current  = [snap("codex", [{ name: "fiveHour", usedPercent: 10 }])];
    const previous = [snap("codex", [{ name: "fiveHour", usedPercent: 42 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "unexpectedReset")).toBe(false);
  });
});

// ── Rule 4: High usage crossed ────────────────────────────────────────────

describe("rule: highUsage", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  it("fires when crossing 80% threshold", () => {
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 82 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 78 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "highUsage")).toBe(true);
  });

  it("does not fire when already above threshold in previous poll", () => {
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 85 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 82 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "highUsage")).toBe(false);
  });

  it("does not fire when rule is disabled", () => {
    const rules = {
      ...defaultNotificationSettings.rules,
      highUsage: { ...defaultNotificationSettings.rules.highUsage, enabled: false },
    };
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 82 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 78 }])];
    const events = engine.evaluate(ctx(current, previous, { rules }), state);
    expect(events.some(e => e.ruleId === "highUsage")).toBe(false);
  });
});

// ── Rule 5: Critical usage crossed ───────────────────────────────────────

describe("rule: criticalUsage", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  it("fires when crossing 95% threshold", () => {
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 97 }])];
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 93 }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "criticalUsage")).toBe(true);
  });

  it("criticalUsage replaces highUsage in same poll for same window", () => {
    const rules = {
      ...defaultNotificationSettings.rules,
      highUsage:    { ...defaultNotificationSettings.rules.highUsage,    thresholdPercent: 80, cooldownMinutes: 0 },
      criticalUsage:{ ...defaultNotificationSettings.rules.criticalUsage, thresholdPercent: 95, cooldownMinutes: 0 },
    };
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 96 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 78 }])];
    // minimumGapMinutes: 0 so both rules can be evaluated; deduplication then removes highUsage
    const events = engine.evaluate(ctx(current, previous, { rules, minimumGapMinutes: 0 }), state);
    expect(events.some(e => e.ruleId === "criticalUsage")).toBe(true);
    expect(events.some(e => e.ruleId === "highUsage")).toBe(false);
  });
});

// ── Rule 7 & 8: Pace transitions ──────────────────────────────────────────

describe("rule: farAhead / farBehind pace transition", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  it("farAhead fires on transition from onTrack to farAhead", () => {
    const pace = { stage: "farAhead" as const, deltaPercent: 20, expectedUsedPercent: 30, actualUsedPercent: 50, etaSeconds: null, willLastToReset: true };
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 50, pace }])];
    const prevPace = { stage: "onTrack" as const, deltaPercent: 1, expectedUsedPercent: 30, actualUsedPercent: 31, etaSeconds: null, willLastToReset: true };
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 31, pace: prevPace }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "farAhead")).toBe(true);
  });

  it("farAhead does not fire when already was farAhead", () => {
    const pace = { stage: "farAhead" as const, deltaPercent: 20, expectedUsedPercent: 30, actualUsedPercent: 50, etaSeconds: null, willLastToReset: true };
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 52, pace }])];
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 50, pace }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "farAhead")).toBe(false);
  });
});

// ── Rule 18: Provider data health ────────────────────────────────────────

describe("rule: providerDataHealth", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  it("fires stale alert after staleMinutes exceeded", () => {
    const now = new Date();
    const staleStart = new Date(now.getTime() - 15 * 60_000); // 15 min ago
    state.setStaleStartedAt("codex", staleStart.getTime());

    const current  = [snap("codex", [], "stale")];
    const previous = [snap("codex", [], "stale")];
    // set previous status as stale so it was already stale
    state.setLastStatus("codex", "stale");

    const events = engine.evaluate({ current, previous, settings: defaultNotificationSettings, now }, state);
    expect(events.some(e => e.ruleId === "providerDataHealth" && e.title.includes("veraltet"))).toBe(true);
  });

  it("fires recovered alert when going from stale to ok", () => {
    state.setLastStatus("codex", "stale");
    const current  = [snap("codex", [{ name: "fiveHour", usedPercent: 20 }], "ok")];
    const previous = [snap("codex", [], "stale")];
    const events = engine.evaluate({ current, previous, settings: defaultNotificationSettings }, state);
    expect(events.some(e => e.ruleId === "providerDataHealth" && e.body.includes("wieder verfügbar"))).toBe(true);
  });
});

// ── Quiet hours ───────────────────────────────────────────────────────────

describe("quiet hours", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  it("suppresses non-critical events during quiet hours", () => {
    const settings = normalizeNotificationSettings({
      quietHours: { enabled: true, start: "00:00", end: "23:59" }, // always quiet
    } as never);
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
    const events = engine.evaluate({ current, previous, settings }, state);
    // confirmedReset is severity 'info', should be suppressed
    expect(events.filter(e => e.severity !== "critical")).toHaveLength(0);
  });

  it("passes critical events through during quiet hours", () => {
    const settings = normalizeNotificationSettings({
      quietHours: { enabled: true, start: "00:00", end: "23:59" },
    } as never);
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 97 }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 93 }])];
    const events = engine.evaluate({ current, previous, settings }, state);
    expect(events.some(e => e.severity === "critical")).toBe(true);
  });
});
