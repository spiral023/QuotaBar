import { describe, expect, it } from "vitest";
import { defaultNotificationSettings, type PlanPeriod } from "../src/config/settings";
import { NotificationStateStore } from "../src/main/notificationEngine";
import { buildMissingPlanNotifications } from "../src/main/missingPlanNotifications";
import type { SystemDataReport } from "../src/main/systemData";

function reportWithLocalData(providers: Array<"claude" | "codex">): SystemDataReport {
  return {
    generatedAt: "2026-06-29T10:00:00.000Z",
    scanDurationMs: 5,
    quickStatsLoadDurationMs: null,
    app: { name: "QuotaBar", paths: [], totals: { fileCount: 0, totalBytes: 0, lastModifiedAt: null } },
    categories: [],
    totals: { fileCount: 0, totalBytes: 0, lastModifiedAt: null },
    agents: (["claude", "codex"] as const).map((provider) => ({
      id: provider,
      name: provider === "claude" ? "Claude Code" : "Codex",
      vendor: provider === "claude" ? "Anthropic" : "OpenAI",
      logo: "",
      status: providers.includes(provider) ? "detected" : "not_found",
      totals: { fileCount: providers.includes(provider) ? 3 : 0, totalBytes: 300, lastModifiedAt: "2026-06-29T09:00:00.000Z" },
      paths: [{
        id: `${provider}-logs`,
        label: "Logs",
        category: "logs",
        kind: "folder",
        path: `C:\\fake\\${provider}`,
        exists: providers.includes(provider),
        fileCount: providers.includes(provider) ? 3 : 0,
        totalBytes: providers.includes(provider) ? 300 : 0,
        lastModifiedAt: providers.includes(provider) ? "2026-06-29T09:00:00.000Z" : null,
        openPath: providers.includes(provider) ? `C:\\fake\\${provider}` : null,
      }],
    })),
  };
}

function plan(provider: "claude" | "codex"): PlanPeriod {
  return {
    id: `${provider}-plan`,
    provider,
    name: "Pro",
    amount: 20,
    currency: "USD",
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: null,
  };
}

describe("missing plan startup notifications", () => {
  it("fires for providers with local usage data but no active plan", () => {
    const state = new NotificationStateStore();
    const events = buildMissingPlanNotifications({
      report: reportWithLocalData(["claude", "codex"]),
      plans: [plan("claude")],
      settings: defaultNotificationSettings,
      state,
      now: new Date("2026-06-29T10:00:00.000Z"),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleId: "missingPlan",
      provider: "codex",
      severity: "info",
      title: "Codex plan missing",
      body: "Local Codex usage data was found, but no active subscription plan is configured. Add a plan so QuotaBar can calculate ROI.",
      reason: "local usage data found without active plan",
      openTab: "plans",
    });
  });

  it("does not fire when the missing-plan rule is muted", () => {
    const state = new NotificationStateStore();
    const events = buildMissingPlanNotifications({
      report: reportWithLocalData(["claude"]),
      plans: [],
      settings: {
        ...defaultNotificationSettings,
        rules: {
          ...defaultNotificationSettings.rules,
          missingPlan: { ...defaultNotificationSettings.rules.missingPlan, enabled: false },
        },
      },
      state,
      now: new Date("2026-06-29T10:00:00.000Z"),
    });

    expect(events).toEqual([]);
  });
});
