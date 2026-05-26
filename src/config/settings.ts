import fs from "node:fs/promises";
import { ensureConfigDir } from "../main/logging";
import { getSettingsPath } from "./paths";

export type CostWindow = "7d" | "30d" | "billing";
export type ViewMode = "dashboard" | "compact";

export interface SubscriptionCosts {
  claude: number;
  codex: number;
}

export interface DebugLogSettings {
  enabled: boolean;
}

// ── Notification settings ────────────────────────────────────────────────────

export interface NotificationRuleBase {
  enabled: boolean;
  cooldownMinutes: number;
}

export interface NotificationRules {
  confirmedReset:           NotificationRuleBase;
  unexpectedReset:          NotificationRuleBase & { minPreviousPercent: number; maxNextPercent: number };
  resetSoon:                NotificationRuleBase & { minutesBeforeReset: number };
  highUsage:                NotificationRuleBase & { thresholdPercent: number };
  criticalUsage:            NotificationRuleBase & { thresholdPercent: number };
  projectedDepletion:       NotificationRuleBase & { minEarlyMinutes: number };
  farAhead:                 NotificationRuleBase & { minDeltaPercent: number };
  farBehind:                NotificationRuleBase & { minDeltaPercent: number };
  freshQuotaWorkWindow:     NotificationRuleBase & { maxUsedPercent: number };
  quotaIdleAfterReset:      NotificationRuleBase & { minutesAfterReset: number; maxUsedPercent: number };
  weeklyReserveOpportunity: NotificationRuleBase & { maxUsedPercent: number; hoursBeforeReset: number };
  rolling5hOutputSpike:     NotificationRuleBase & { baseline: string };
  rolling5hProxyLimit:      NotificationRuleBase & { thresholdPercent: number; customOutputTokenLimit: number };
  burnRateSpike:            NotificationRuleBase & { factor: number };
  cacheHitDrop:             NotificationRuleBase & { claudeThresholdPercent: number; codexThresholdPercent: number };
  expensiveModelShare:      NotificationRuleBase & { thresholdPercent: number };
  roiMilestone:             NotificationRuleBase & { milestones: number[] };
  providerDataHealth:       NotificationRuleBase & { staleMinutes: number; notifyRecovered: boolean };
}

export interface NotificationSettings {
  enabled: boolean;
  quietHours: { enabled: boolean; start: string; end: string };
  minimumGapMinutes: number;
  rules: NotificationRules;
}

export const defaultNotificationRules: NotificationRules = {
  confirmedReset:           { enabled: true,  cooldownMinutes: 30 },
  unexpectedReset:          { enabled: true,  cooldownMinutes: 30,   minPreviousPercent: 25, maxNextPercent: 5 },
  resetSoon:                { enabled: false, cooldownMinutes: 120,  minutesBeforeReset: 10 },
  highUsage:                { enabled: true,  cooldownMinutes: 60,   thresholdPercent: 80 },
  criticalUsage:            { enabled: true,  cooldownMinutes: 60,   thresholdPercent: 95 },
  projectedDepletion:       { enabled: true,  cooldownMinutes: 120,  minEarlyMinutes: 30 },
  farAhead:                 { enabled: true,  cooldownMinutes: 240,  minDeltaPercent: 12 },
  farBehind:                { enabled: false, cooldownMinutes: 720,  minDeltaPercent: 12 },
  freshQuotaWorkWindow:     { enabled: true,  cooldownMinutes: 1440, maxUsedPercent: 20 },
  quotaIdleAfterReset:      { enabled: false, cooldownMinutes: 1440, minutesAfterReset: 60, maxUsedPercent: 10 },
  weeklyReserveOpportunity: { enabled: false, cooldownMinutes: 1440, maxUsedPercent: 40, hoursBeforeReset: 48 },
  rolling5hOutputSpike:     { enabled: true,  cooldownMinutes: 180,  baseline: "p95" },
  rolling5hProxyLimit:      { enabled: true,  cooldownMinutes: 180,  thresholdPercent: 80, customOutputTokenLimit: 500_000 },
  burnRateSpike:            { enabled: true,  cooldownMinutes: 180,  factor: 2.0 },
  cacheHitDrop:             { enabled: false, cooldownMinutes: 1440, claudeThresholdPercent: 98, codexThresholdPercent: 90 },
  expensiveModelShare:      { enabled: false, cooldownMinutes: 1440, thresholdPercent: 10 },
  roiMilestone:             { enabled: false, cooldownMinutes: 10_080, milestones: [2, 5, 10] },
  providerDataHealth:       { enabled: true,  cooldownMinutes: 60,   staleMinutes: 10, notifyRecovered: true },
};

export const defaultNotificationSettings: NotificationSettings = {
  enabled: true,
  quietHours: { enabled: false, start: "22:30", end: "08:00" },
  minimumGapMinutes: 15,
  rules: defaultNotificationRules,
};

// ── Main settings ────────────────────────────────────────────────────────────

export interface Settings {
  pollIntervalSeconds: number;
  providerTimeoutMs: number;
  subscriptionCosts: SubscriptionCosts;
  pricingOfflineMode: boolean;
  costWindow: CostWindow;
  viewMode: ViewMode;
  insightsPanelOpen: boolean;
  debugLog: DebugLogSettings;
  notifications: NotificationSettings;
}

export const defaultSettings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000,
  subscriptionCosts: { claude: 20, codex: 20 },
  pricingOfflineMode: false,
  costWindow: "billing",
  viewMode: "dashboard",
  insightsPanelOpen: false,
  debugLog: { enabled: true },
  notifications: defaultNotificationSettings,
};

export async function loadSettings(overrides: Partial<Settings> = {}): Promise<Settings> {
  try {
    const parsed = JSON.parse(await fs.readFile(getSettingsPath(), "utf8")) as Partial<Settings>;
    return normalizeSettings({ ...defaultSettings, ...parsed, ...overrides });
  } catch {
    await saveSettings({ ...defaultSettings, ...overrides });
    return normalizeSettings({ ...defaultSettings, ...overrides });
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(getSettingsPath(), `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, "utf8");
}

export function normalizeSettings(settings: Settings): Settings {
  const sub = (settings.subscriptionCosts ?? {}) as Partial<SubscriptionCosts>;
  const validWindows: CostWindow[] = ["7d", "30d", "billing"];
  const costWindow: CostWindow = validWindows.includes(settings.costWindow as CostWindow)
    ? (settings.costWindow as CostWindow)
    : "billing";
  const validViewModes: ViewMode[] = ["dashboard", "compact"];
  const viewMode: ViewMode = validViewModes.includes(settings.viewMode as ViewMode)
    ? (settings.viewMode as ViewMode)
    : "dashboard";
  return {
    pollIntervalSeconds: Math.max(15, Math.floor(Number(settings.pollIntervalSeconds) || defaultSettings.pollIntervalSeconds)),
    providerTimeoutMs: Math.max(1000, Math.floor(Number(settings.providerTimeoutMs) || defaultSettings.providerTimeoutMs)),
    subscriptionCosts: {
      claude: Math.max(0, Number(sub.claude) || defaultSettings.subscriptionCosts.claude),
      codex: Math.max(0, Number(sub.codex) || defaultSettings.subscriptionCosts.codex),
    },
    pricingOfflineMode: Boolean(settings.pricingOfflineMode),
    costWindow,
    viewMode,
    insightsPanelOpen: Boolean(settings.insightsPanelOpen),
    debugLog: { enabled: settings.debugLog?.enabled !== false },
    notifications: normalizeNotificationSettings(settings.notifications),
  };
}

export function normalizeNotificationSettings(
  raw: Partial<NotificationSettings> | undefined
): NotificationSettings {
  const d = defaultNotificationSettings;
  const r = (raw ?? {}) as Partial<NotificationSettings>;
  const rawRules = (r.rules ?? {}) as Partial<NotificationRules>;
  const qh = (r.quietHours ?? {}) as Partial<NotificationSettings["quietHours"]>;

  const mergeRule = <T extends NotificationRuleBase>(
    def: T,
    incoming: Partial<T> | undefined
  ): T => ({ ...def, ...(incoming ?? {}) });

  return {
    enabled: r.enabled !== undefined ? Boolean(r.enabled) : d.enabled,
    quietHours: {
      enabled: qh.enabled !== undefined ? Boolean(qh.enabled) : d.quietHours.enabled,
      start: typeof qh.start === "string" ? qh.start : d.quietHours.start,
      end:   typeof qh.end   === "string" ? qh.end   : d.quietHours.end,
    },
    minimumGapMinutes: Math.max(0, Number(r.minimumGapMinutes) || d.minimumGapMinutes),
    rules: {
      confirmedReset:           mergeRule(d.rules.confirmedReset,           rawRules.confirmedReset as Partial<typeof d.rules.confirmedReset>),
      unexpectedReset:          mergeRule(d.rules.unexpectedReset,          rawRules.unexpectedReset as Partial<typeof d.rules.unexpectedReset>),
      resetSoon:                mergeRule(d.rules.resetSoon,                rawRules.resetSoon as Partial<typeof d.rules.resetSoon>),
      highUsage:                mergeRule(d.rules.highUsage,                rawRules.highUsage as Partial<typeof d.rules.highUsage>),
      criticalUsage:            mergeRule(d.rules.criticalUsage,            rawRules.criticalUsage as Partial<typeof d.rules.criticalUsage>),
      projectedDepletion:       mergeRule(d.rules.projectedDepletion,       rawRules.projectedDepletion as Partial<typeof d.rules.projectedDepletion>),
      farAhead:                 mergeRule(d.rules.farAhead,                 rawRules.farAhead as Partial<typeof d.rules.farAhead>),
      farBehind:                mergeRule(d.rules.farBehind,                rawRules.farBehind as Partial<typeof d.rules.farBehind>),
      freshQuotaWorkWindow:     mergeRule(d.rules.freshQuotaWorkWindow,     rawRules.freshQuotaWorkWindow as Partial<typeof d.rules.freshQuotaWorkWindow>),
      quotaIdleAfterReset:      mergeRule(d.rules.quotaIdleAfterReset,      rawRules.quotaIdleAfterReset as Partial<typeof d.rules.quotaIdleAfterReset>),
      weeklyReserveOpportunity: mergeRule(d.rules.weeklyReserveOpportunity, rawRules.weeklyReserveOpportunity as Partial<typeof d.rules.weeklyReserveOpportunity>),
      rolling5hOutputSpike:     mergeRule(d.rules.rolling5hOutputSpike,     rawRules.rolling5hOutputSpike as Partial<typeof d.rules.rolling5hOutputSpike>),
      rolling5hProxyLimit:      mergeRule(d.rules.rolling5hProxyLimit,      rawRules.rolling5hProxyLimit as Partial<typeof d.rules.rolling5hProxyLimit>),
      burnRateSpike:            mergeRule(d.rules.burnRateSpike,            rawRules.burnRateSpike as Partial<typeof d.rules.burnRateSpike>),
      cacheHitDrop:             mergeRule(d.rules.cacheHitDrop,             rawRules.cacheHitDrop as Partial<typeof d.rules.cacheHitDrop>),
      expensiveModelShare:      mergeRule(d.rules.expensiveModelShare,      rawRules.expensiveModelShare as Partial<typeof d.rules.expensiveModelShare>),
      roiMilestone:             mergeRule(d.rules.roiMilestone,             rawRules.roiMilestone as Partial<typeof d.rules.roiMilestone>),
      providerDataHealth:       mergeRule(d.rules.providerDataHealth,       rawRules.providerDataHealth as Partial<typeof d.rules.providerDataHealth>),
    },
  };
}
