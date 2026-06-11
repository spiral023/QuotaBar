"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const notificationEngine_1 = require("../src/main/notificationEngine");
const settings_1 = require("../src/config/settings");
// ── Helpers ────────────────────────────────────────────────────────────────
function snap(provider, windows, status = "ok") {
    return {
        provider,
        status,
        windows: windows,
        updatedAt: new Date().toISOString(),
    };
}
function ctx(current, previous, overrides = {}) {
    return {
        current,
        previous,
        settings: { ...settings_1.defaultNotificationSettings, ...overrides },
    };
}
// ── normalizeNotificationSettings ─────────────────────────────────────────
(0, vitest_1.describe)("normalizeNotificationSettings", () => {
    (0, vitest_1.it)("returns defaults for undefined input", () => {
        const result = (0, settings_1.normalizeNotificationSettings)(undefined);
        (0, vitest_1.expect)(result.enabled).toBe(true);
        (0, vitest_1.expect)(result.minimumGapMinutes).toBe(0);
        (0, vitest_1.expect)(result.rules.highUsage.thresholdPercent).toBe(80);
    });
    (0, vitest_1.it)("merges partial rule overrides without losing other rules", () => {
        const result = (0, settings_1.normalizeNotificationSettings)({
            rules: { highUsage: { enabled: false, thresholdPercent: 70, cooldownMinutes: 30 } },
        });
        (0, vitest_1.expect)(result.rules.highUsage.enabled).toBe(false);
        (0, vitest_1.expect)(result.rules.highUsage.thresholdPercent).toBe(70);
        (0, vitest_1.expect)(result.rules.criticalUsage.enabled).toBe(true); // unchanged
    });
    (0, vitest_1.it)("clamps minimumGapMinutes to 0 minimum", () => {
        const result = (0, settings_1.normalizeNotificationSettings)({ minimumGapMinutes: -5 });
        (0, vitest_1.expect)(result.minimumGapMinutes).toBe(0);
    });
    (0, vitest_1.it)("preserves quietHours settings", () => {
        const result = (0, settings_1.normalizeNotificationSettings)({
            quietHours: { enabled: true, start: "23:00", end: "07:00" },
        });
        (0, vitest_1.expect)(result.quietHours.enabled).toBe(true);
        (0, vitest_1.expect)(result.quietHours.start).toBe("23:00");
    });
});
(0, vitest_1.describe)("normalizeSettings includes notifications", () => {
    (0, vitest_1.it)("normalizeSettings includes notification defaults", () => {
        const s = (0, settings_1.normalizeSettings)(settings_1.defaultSettings);
        (0, vitest_1.expect)(s.notifications.enabled).toBe(true);
        (0, vitest_1.expect)(s.notifications.rules.confirmedReset.enabled).toBe(true);
    });
});
// ── Rule 1: Confirmed limit reset ─────────────────────────────────────────
(0, vitest_1.describe)("rule: confirmedReset", () => {
    let engine;
    let state;
    (0, vitest_1.beforeEach)(() => {
        engine = new notificationEngine_1.NotificationEngine();
        state = new notificationEngine_1.NotificationStateStore();
    });
    (0, vitest_1.it)("fires when usage drops from 99.5% to 0%", () => {
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "confirmedReset")).toBe(true);
    });
    (0, vitest_1.it)("does not fire when previous was below 99.5%", () => {
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 50 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "confirmedReset")).toBe(false);
    });
    (0, vitest_1.it)("does not fire when current usage is above 1%", () => {
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 5 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "confirmedReset")).toBe(false);
    });
    (0, vitest_1.it)("respects cooldown and does not fire twice", () => {
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
        engine.evaluate(ctx(current, previous), state);
        const events2 = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events2.filter(e => e.ruleId === "confirmedReset")).toHaveLength(0);
    });
    (0, vitest_1.it)("does not fire when master switch is off", () => {
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
        const events = engine.evaluate(ctx(current, previous, { enabled: false }), state);
        (0, vitest_1.expect)(events).toHaveLength(0);
    });
});
// ── Rule 2: Unexpected limit reset ────────────────────────────────────────
(0, vitest_1.describe)("rule: unexpectedReset", () => {
    let engine;
    let state;
    (0, vitest_1.beforeEach)(() => { engine = new notificationEngine_1.NotificationEngine(); state = new notificationEngine_1.NotificationStateStore(); });
    (0, vitest_1.it)("fires when usage drops from 42% to 0%", () => {
        const current = [snap("codex", [{ name: "fiveHour", usedPercent: 0 }])];
        const previous = [snap("codex", [{ name: "fiveHour", usedPercent: 42 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "unexpectedReset")).toBe(true);
    });
    (0, vitest_1.it)("does not fire when previous was below minPreviousPercent (25%)", () => {
        const current = [snap("codex", [{ name: "fiveHour", usedPercent: 0 }])];
        const previous = [snap("codex", [{ name: "fiveHour", usedPercent: 10 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "unexpectedReset")).toBe(false);
    });
    (0, vitest_1.it)("does not fire when current is above maxNextPercent (5%)", () => {
        const current = [snap("codex", [{ name: "fiveHour", usedPercent: 10 }])];
        const previous = [snap("codex", [{ name: "fiveHour", usedPercent: 42 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "unexpectedReset")).toBe(false);
    });
});
// ── Rule 4: High usage crossed ────────────────────────────────────────────
(0, vitest_1.describe)("rule: highUsage", () => {
    let engine;
    let state;
    (0, vitest_1.beforeEach)(() => { engine = new notificationEngine_1.NotificationEngine(); state = new notificationEngine_1.NotificationStateStore(); });
    (0, vitest_1.it)("fires when crossing 80% threshold", () => {
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 82 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 78 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "highUsage")).toBe(true);
    });
    (0, vitest_1.it)("does not fire when already above threshold in previous poll", () => {
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 85 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 82 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "highUsage")).toBe(false);
    });
    (0, vitest_1.it)("does not fire when rule is disabled", () => {
        const rules = {
            ...settings_1.defaultNotificationSettings.rules,
            highUsage: { ...settings_1.defaultNotificationSettings.rules.highUsage, enabled: false },
        };
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 82 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 78 }])];
        const events = engine.evaluate(ctx(current, previous, { rules }), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "highUsage")).toBe(false);
    });
});
// ── Rule 5: Critical usage crossed ───────────────────────────────────────
(0, vitest_1.describe)("rule: criticalUsage", () => {
    let engine;
    let state;
    (0, vitest_1.beforeEach)(() => { engine = new notificationEngine_1.NotificationEngine(); state = new notificationEngine_1.NotificationStateStore(); });
    (0, vitest_1.it)("fires when crossing 95% threshold", () => {
        const current = [snap("claude", [{ name: "weekly", usedPercent: 97 }])];
        const previous = [snap("claude", [{ name: "weekly", usedPercent: 93 }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "criticalUsage")).toBe(true);
    });
    (0, vitest_1.it)("criticalUsage replaces highUsage in same poll for same window", () => {
        const rules = {
            ...settings_1.defaultNotificationSettings.rules,
            highUsage: { ...settings_1.defaultNotificationSettings.rules.highUsage, thresholdPercent: 80, cooldownMinutes: 0 },
            criticalUsage: { ...settings_1.defaultNotificationSettings.rules.criticalUsage, thresholdPercent: 95, cooldownMinutes: 0 },
        };
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 96 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 78 }])];
        // minimumGapMinutes: 0 so both rules can be evaluated; deduplication then removes highUsage
        const events = engine.evaluate(ctx(current, previous, { rules, minimumGapMinutes: 0 }), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "criticalUsage")).toBe(true);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "highUsage")).toBe(false);
    });
});
// ── Rule 7 & 8: Pace transitions ──────────────────────────────────────────
(0, vitest_1.describe)("rule: farAhead / farBehind pace transition", () => {
    let engine;
    let state;
    (0, vitest_1.beforeEach)(() => { engine = new notificationEngine_1.NotificationEngine(); state = new notificationEngine_1.NotificationStateStore(); });
    (0, vitest_1.it)("farAhead fires on transition from onTrack to farAhead", () => {
        const pace = { stage: "farAhead", deltaPercent: 20, expectedUsedPercent: 30, actualUsedPercent: 50, etaSeconds: null, willLastToReset: true };
        const current = [snap("claude", [{ name: "weekly", usedPercent: 50, pace }])];
        const prevPace = { stage: "onTrack", deltaPercent: 1, expectedUsedPercent: 30, actualUsedPercent: 31, etaSeconds: null, willLastToReset: true };
        const previous = [snap("claude", [{ name: "weekly", usedPercent: 31, pace: prevPace }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "farAhead")).toBe(true);
    });
    (0, vitest_1.it)("farAhead does not fire when already was farAhead", () => {
        const pace = { stage: "farAhead", deltaPercent: 20, expectedUsedPercent: 30, actualUsedPercent: 50, etaSeconds: null, willLastToReset: true };
        const current = [snap("claude", [{ name: "weekly", usedPercent: 52, pace }])];
        const previous = [snap("claude", [{ name: "weekly", usedPercent: 50, pace }])];
        const events = engine.evaluate(ctx(current, previous), state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "farAhead")).toBe(false);
    });
});
// ── Rule 18: Provider data health ────────────────────────────────────────
(0, vitest_1.describe)("rule: providerDataHealth", () => {
    let engine;
    let state;
    (0, vitest_1.beforeEach)(() => { engine = new notificationEngine_1.NotificationEngine(); state = new notificationEngine_1.NotificationStateStore(); });
    (0, vitest_1.it)("fires stale alert after staleMinutes exceeded", () => {
        const now = new Date();
        const staleStart = new Date(now.getTime() - 15 * 60_000); // 15 min ago
        state.setStaleStartedAt("codex", staleStart.getTime());
        const current = [snap("codex", [], "stale")];
        const previous = [snap("codex", [], "stale")];
        // set previous status as stale so it was already stale
        state.setLastStatus("codex", "stale");
        const events = engine.evaluate({ current, previous, settings: settings_1.defaultNotificationSettings, now }, state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "providerDataHealth" && e.title.includes("veraltet"))).toBe(true);
    });
    (0, vitest_1.it)("fires recovered alert when going from stale to ok", () => {
        state.setLastStatus("codex", "stale");
        const current = [snap("codex", [{ name: "fiveHour", usedPercent: 20 }], "ok")];
        const previous = [snap("codex", [], "stale")];
        const events = engine.evaluate({ current, previous, settings: settings_1.defaultNotificationSettings }, state);
        (0, vitest_1.expect)(events.some(e => e.ruleId === "providerDataHealth" && e.body.includes("wieder verfügbar"))).toBe(true);
    });
});
// ── Quiet hours ───────────────────────────────────────────────────────────
(0, vitest_1.describe)("quiet hours", () => {
    let engine;
    let state;
    (0, vitest_1.beforeEach)(() => { engine = new notificationEngine_1.NotificationEngine(); state = new notificationEngine_1.NotificationStateStore(); });
    (0, vitest_1.it)("suppresses non-critical events during quiet hours", () => {
        const settings = (0, settings_1.normalizeNotificationSettings)({
            quietHours: { enabled: true, start: "00:00", end: "23:59" }, // always quiet
        });
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 0 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 100 }])];
        const events = engine.evaluate({ current, previous, settings }, state);
        // confirmedReset is severity 'info', should be suppressed
        (0, vitest_1.expect)(events.filter(e => e.severity !== "critical")).toHaveLength(0);
    });
    (0, vitest_1.it)("passes critical events through during quiet hours", () => {
        const settings = (0, settings_1.normalizeNotificationSettings)({
            quietHours: { enabled: true, start: "00:00", end: "23:59" },
        });
        const current = [snap("claude", [{ name: "fiveHour", usedPercent: 97 }])];
        const previous = [snap("claude", [{ name: "fiveHour", usedPercent: 93 }])];
        const events = engine.evaluate({ current, previous, settings }, state);
        (0, vitest_1.expect)(events.some(e => e.severity === "critical")).toBe(true);
    });
});
