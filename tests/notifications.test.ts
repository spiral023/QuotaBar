import { describe, it, expect, beforeEach } from "vitest";
import {
  NotificationEngine,
  NotificationStateStore,
  isQuietHours,
} from "../src/main/notificationEngine";
import type { NotificationContext } from "../src/main/notificationEngine";
import {
  normalizeNotificationSettings,
  defaultNotificationSettings,
  defaultSettings,
  normalizeSettings,
} from "../src/config/settings";
import { buildUpdateAvailableToastXml, RELEASES_URL } from "../src/main/notifications";
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
    expect(result.rules.providerDataHealth.enabled).toBe(false);
  });

  it("merges partial rule overrides without losing other rules", () => {
    const result = normalizeNotificationSettings({
      rules: { highUsage: { enabled: false, thresholdPercent: 70, cooldownMinutes: 30 } } as never,
    });
    expect(result.rules.highUsage.enabled).toBe(false);
    expect(result.rules.highUsage.thresholdPercent).toBe(70);
    expect(result.rules.criticalUsage.enabled).toBe(true); // unchanged
  });

  it("disables not-yet-implemented (history-based) rules by default", () => {
    const r = normalizeNotificationSettings(undefined).rules;
    // These rules have UI toggles but no engine implementation yet (Phase 3).
    // They must default to off so the UI does not claim inactive protection.
    expect(r.freshQuotaWorkWindow.enabled).toBe(false);
    expect(r.rolling5hOutputSpike.enabled).toBe(false);
    expect(r.rolling5hProxyLimit.enabled).toBe(false);
    expect(r.burnRateSpike.enabled).toBe(false);
  });

  it("defaults pace delta thresholds to 12 (matches the farAhead/farBehind stage boundary)", () => {
    const result = normalizeNotificationSettings(undefined);
    expect(result.rules.farAhead.minDeltaPercent).toBe(12);
    expect(result.rules.farBehind.minDeltaPercent).toBe(12);
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

describe("NotificationStateStore persistence", () => {
  it("round-trips lastPaceStage through serialize/loadPersisted", () => {
    const store = new NotificationStateStore();
    store.setLastPaceStage("claude", "weekly", "farAhead");
    store.setLastPaceStage("codex", "fiveHour", "farBehind");

    const restored = new NotificationStateStore();
    restored.loadPersisted(store.serialize());

    expect(restored.getLastPaceStage("claude", "weekly")).toBe("farAhead");
    expect(restored.getLastPaceStage("codex", "fiveHour")).toBe("farBehind");
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

// ── Scheduled reset observed late ─────────────────────────────────────────
// Regression: when the machine was offline across the scheduled reset time,
// QuotaBar only saw the completed drop (for example 98% -> 0%) and incorrectly
// reported an unexpected reset. If the previous window's resetsAt is already in
// the past, the drop is expected and should produce friendly reset info instead.

describe("scheduled reset observed late (machine was offline)", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  const PAST   = "2020-01-01T00:00:00.000Z"; // resetsAt is safely in the past
  const FUTURE = "2999-01-01T00:00:00.000Z"; // resetsAt is safely in the future

  it("fires confirmedReset, not unexpectedReset, when the scheduled reset time has passed", () => {
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 0 }])];
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 98, resetsAt: PAST }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "confirmedReset")).toBe(true);
    expect(events.some(e => e.ruleId === "unexpectedReset")).toBe(false);
  });

  it("still fires unexpectedReset when the scheduled reset is still in the future", () => {
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 0 }])];
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 98, resetsAt: FUTURE }])];
    const events = engine.evaluate(ctx(current, previous), state);
    expect(events.some(e => e.ruleId === "unexpectedReset")).toBe(true);
    expect(events.some(e => e.ruleId === "confirmedReset")).toBe(false);
  });

  it("uses the persisted resetsAt to suppress the false alarm after a restart (no in-memory previous)", () => {
    // Machine was off: no in-memory previous, but lastPercent/lastResetsAt from
    // the previous run were loaded from disk.
    state.loadPersisted({
      lastFired: {},
      lastGlobalFiredAt: 0,
      lastPercent: { "claude:weekly": 98 },
      lastResetsAt: { "claude:weekly": PAST },
    });
    const current = [snap("claude", [{ name: "weekly", usedPercent: 0 }])];
    const events = engine.evaluate(ctx(current, []), state);
    expect(events.some(e => e.ruleId === "confirmedReset")).toBe(true);
    expect(events.some(e => e.ruleId === "unexpectedReset")).toBe(false);
  });

  it("round-trips lastResetsAt through serialize/loadPersisted", () => {
    state.setLastResetsAt("claude", "weekly", PAST);
    const restored = new NotificationStateStore();
    restored.loadPersisted(JSON.parse(JSON.stringify(state.serialize())));
    expect(restored.getLastResetsAt("claude", "weekly")).toBe(PAST);
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

  // farAhead/farBehind are disabled by default as a product decision because
  // they would otherwise be too noisy. These tests explicitly enable the rules.
  const enablePaceRules = {
    rules: {
      ...defaultNotificationSettings.rules,
      farAhead:  { ...defaultNotificationSettings.rules.farAhead,  enabled: true },
      farBehind: { ...defaultNotificationSettings.rules.farBehind, enabled: true },
    },
  };

  it("farAhead fires on transition from onTrack to farAhead", () => {
    const pace = { stage: "farAhead" as const, deltaPercent: 20, expectedUsedPercent: 30, actualUsedPercent: 50, etaSeconds: null, willLastToReset: true };
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 50, pace }])];
    const prevPace = { stage: "onTrack" as const, deltaPercent: 1, expectedUsedPercent: 30, actualUsedPercent: 31, etaSeconds: null, willLastToReset: true };
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 31, pace: prevPace }])];
    const events = engine.evaluate(ctx(current, previous, enablePaceRules), state);
    expect(events.some(e => e.ruleId === "farAhead")).toBe(true);
  });

  it("farAhead does not fire when already was farAhead", () => {
    const pace = { stage: "farAhead" as const, deltaPercent: 20, expectedUsedPercent: 30, actualUsedPercent: 50, etaSeconds: null, willLastToReset: true };
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 52, pace }])];
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 50, pace }])];
    const events = engine.evaluate(ctx(current, previous, enablePaceRules), state);
    expect(events.some(e => e.ruleId === "farAhead")).toBe(false);
  });
});

// ── Rule 18: Provider data health ────────────────────────────────────────

describe("rule: providerDataHealth", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  const enabledProviderDataHealthSettings = normalizeNotificationSettings({
    rules: {
      providerDataHealth: { ...defaultNotificationSettings.rules.providerDataHealth, enabled: true },
    } as never,
  } as never);

  it("fires stale alert after staleMinutes exceeded", () => {
    const now = new Date();
    const staleStart = new Date(now.getTime() - 15 * 60_000); // 15 min ago
    state.setStaleStartedAt("codex", staleStart.getTime());

    const current  = [snap("codex", [], "stale")];
    const previous = [snap("codex", [], "stale")];
    // set previous status as stale so it was already stale
    state.setLastStatus("codex", "stale");

    const events = engine.evaluate({ current, previous, settings: enabledProviderDataHealthSettings, now }, state);
    expect(events.some(e => e.ruleId === "providerDataHealth" && e.title.includes("data is stale"))).toBe(true);
  });

  it("emits a provider-level event exactly once (no dedup duplication)", () => {
    const now = new Date();
    state.setStaleStartedAt("codex", now.getTime() - 15 * 60_000);
    state.setLastStatus("codex", "stale");
    const current  = [snap("codex", [], "stale")];
    const previous = [snap("codex", [], "stale")];
    const events = engine.evaluate({ current, previous, settings: enabledProviderDataHealthSettings, now }, state);
    expect(events.filter(e => e.ruleId === "providerDataHealth")).toHaveLength(1);
  });

  it("fires recovered alert when going from stale to ok", () => {
    state.setLastStatus("codex", "stale");
    const current  = [snap("codex", [{ name: "fiveHour", usedPercent: 20 }], "ok")];
    const previous = [snap("codex", [], "stale")];
    const events = engine.evaluate({ current, previous, settings: enabledProviderDataHealthSettings }, state);
    expect(events.some(e => e.ruleId === "providerDataHealth" && e.body.includes("available again"))).toBe(true);
  });
});

describe("notification copy", () => {
  let engine: NotificationEngine;
  let state: NotificationStateStore;

  beforeEach(() => { engine = new NotificationEngine(); state = new NotificationStateStore(); });

  it("uses English copy for quota reset notifications", () => {
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 0 }])];
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 100 }])];

    const [event] = engine.evaluate(ctx(current, previous), state);

    expect(event).toMatchObject({
      ruleId: "confirmedReset",
      title: "Claude week reset",
      body: "Quota usage is back to 0%.",
    });
  });

  it("uses English copy for high and critical quota notifications", () => {
    const current  = [snap("codex", [{ name: "fiveHour", usedPercent: 96 }])];
    const previous = [snap("codex", [{ name: "fiveHour", usedPercent: 79 }])];

    const [event] = engine.evaluate(ctx(current, previous), state);

    expect(event).toMatchObject({
      ruleId: "criticalUsage",
      title: "Codex 5h: 96% used",
      body: "Critical threshold reached. Quota will be depleted soon.",
    });
  });

  it("uses English copy for pace notifications", () => {
    const pace = { stage: "farBehind" as const, deltaPercent: -25, expectedUsedPercent: 50, actualUsedPercent: 25, etaSeconds: null, willLastToReset: true };
    const prevPace = { stage: "onTrack" as const, deltaPercent: 0, expectedUsedPercent: 50, actualUsedPercent: 50, etaSeconds: null, willLastToReset: true };
    const rules = {
      ...defaultNotificationSettings.rules,
      farBehind: { ...defaultNotificationSettings.rules.farBehind, enabled: true },
    };
    const current  = [snap("claude", [{ name: "weekly", usedPercent: 25, pace }])];
    const previous = [snap("claude", [{ name: "weekly", usedPercent: 50, pace: prevPace }])];

    const [event] = engine.evaluate(ctx(current, previous, { rules }), state);

    expect(event).toMatchObject({
      ruleId: "farBehind",
      title: "Claude week: Well below pace",
      body: "Usage is 25% below the expected pace for the week window — plenty of quota remains.",
    });
  });

  it("rounds projected depletion ETA values in the notification reason", () => {
    const pace = {
      stage: "farAhead" as const,
      deltaPercent: 20,
      expectedUsedPercent: 50,
      actualUsedPercent: 70,
      etaSeconds: 1234.5678901234,
      willLastToReset: false,
    };
    const rules = {
      ...defaultNotificationSettings.rules,
      projectedDepletion: {
        ...defaultNotificationSettings.rules.projectedDepletion,
        enabled: true,
        cooldownMinutes: 0,
        minEarlyMinutes: 5,
      },
    };
    const now = new Date("2026-06-29T10:00:00.000Z");
    const current = [snap("codex", [{
      name: "fiveHour",
      usedPercent: 70,
      resetsAt: "2026-06-29T12:00:00.000Z",
      pace,
    }])];

    const [event] = engine.evaluate({ current, previous: [], settings: { ...defaultNotificationSettings, rules }, now }, state);

    expect(event).toMatchObject({
      ruleId: "projectedDepletion",
      reason: "etaSeconds=1235, minutesUntilReset=120",
    });
  });

  it("farBehind copy is window-aware and never says 'weekly' on a 5h window", () => {
    const pace = { stage: "farBehind" as const, deltaPercent: -20, expectedUsedPercent: 40, actualUsedPercent: 20, etaSeconds: null, willLastToReset: true };
    const prevPace = { stage: "onTrack" as const, deltaPercent: 0, expectedUsedPercent: 40, actualUsedPercent: 40, etaSeconds: null, willLastToReset: true };
    const rules = {
      ...defaultNotificationSettings.rules,
      farBehind: { ...defaultNotificationSettings.rules.farBehind, enabled: true },
    };
    const current  = [snap("codex", [{ name: "fiveHour", usedPercent: 20, pace }])];
    const previous = [snap("codex", [{ name: "fiveHour", usedPercent: 40, pace: prevPace }])];

    const [event] = engine.evaluate(ctx(current, previous, { rules }), state);

    expect(event.ruleId).toBe("farBehind");
    expect(event.body).toContain("5h");
    expect(event.body.toLowerCase()).not.toContain("week");
    expect(event.title.toLowerCase()).not.toContain("usual");
  });

  it("farAhead copy is window-aware and actionable", () => {
    const pace = { stage: "farAhead" as const, deltaPercent: 22, expectedUsedPercent: 40, actualUsedPercent: 62, etaSeconds: null, willLastToReset: true };
    const prevPace = { stage: "onTrack" as const, deltaPercent: 0, expectedUsedPercent: 40, actualUsedPercent: 40, etaSeconds: null, willLastToReset: true };
    const rules = {
      ...defaultNotificationSettings.rules,
      farAhead: { ...defaultNotificationSettings.rules.farAhead, enabled: true },
    };
    const current  = [snap("claude", [{ name: "fiveHour", usedPercent: 62, pace }])];
    const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 40, pace: prevPace }])];

    const [event] = engine.evaluate(ctx(current, previous, { rules }), state);

    expect(event.ruleId).toBe("farAhead");
    expect(event.body).toContain("5h");
    expect(event.body.toLowerCase()).not.toContain("daily average");
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

  it("treats invalid quiet-hours strings as not quiet", () => {
    expect(isQuietHours({ enabled: true, start: "bad", end: "08:00" }, new Date())).toBe(false);
    expect(isQuietHours({ enabled: true, start: "22:00", end: "bad" }, new Date())).toBe(false);
  });
});

describe("buildUpdateAvailableToastXml (manual ZIP/Portable update)", () => {
  it("points the body click at the GitHub releases page, not the app", () => {
    const xml = buildUpdateAvailableToastXml("1.3.0", true);
    expect(xml).toContain(`launch="${RELEASES_URL}"`);
    expect(xml).toContain("QuotaBar 1.3.0 available");
    // No silent download/install is implied for manual builds.
    expect(xml).not.toContain("Restart");
  });

  it("offers an Open-GitHub action and a per-version dismiss", () => {
    const xml = buildUpdateAvailableToastXml("1.3.0", true);
    expect(xml).toContain(`content="Open GitHub" activationType="protocol" arguments="${RELEASES_URL}"`);
    expect(xml).toContain("quotabar://update-dismiss?v=1.3.0");
  });

  it("omits actions when no handlers are wired", () => {
    expect(buildUpdateAvailableToastXml("1.3.0", false)).not.toContain("<actions>");
  });
});
