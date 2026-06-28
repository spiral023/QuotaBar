import type { NotificationSettings, PlanPeriod } from "../config/settings";
import type { NotificationEvent, NotificationStateStore } from "./notificationEngine";
import type { SystemAgentData, SystemDataReport } from "./systemData";
import { localISOString } from "./logging";

export interface MissingPlanNotificationInput {
  report: SystemDataReport;
  plans: PlanPeriod[];
  settings: NotificationSettings;
  state: NotificationStateStore;
  now?: Date;
}

export function buildMissingPlanNotifications(input: MissingPlanNotificationInput): NotificationEvent[] {
  const rule = input.settings.rules.missingPlan;
  if (!input.settings.enabled || !rule.enabled) return [];

  const now = input.now ?? new Date();
  const events: NotificationEvent[] = [];
  for (const agent of input.report.agents) {
    if (agent.id !== "claude" && agent.id !== "codex") continue;
    if (!hasLocalUsageData(agent)) continue;
    if (hasActivePlan(input.plans, agent.id, now)) continue;
    if (!input.state.canFire("missingPlan", agent.id, rule.cooldownMinutes)) continue;

    events.push({
      ruleId: "missingPlan",
      provider: agent.id,
      severity: "info",
      title: `${agent.id === "claude" ? "Claude" : "Codex"} plan missing`,
      body: `Local ${agent.id === "claude" ? "Claude" : "Codex"} usage data was found, but no active subscription plan is configured. Add a plan so QuotaBar can calculate ROI.`,
      firedAt: localISOString(now),
      reason: "local usage data found without active plan",
      openTab: "plans",
    });
    input.state.recordFired("missingPlan", agent.id);
  }
  return events;
}

function hasLocalUsageData(agent: SystemAgentData): boolean {
  return agent.paths.some((item) =>
    item.category === "logs" &&
    item.exists &&
    item.fileCount > 0
  );
}

function hasActivePlan(plans: PlanPeriod[], provider: "claude" | "codex", now: Date): boolean {
  const t = now.getTime();
  return plans.some((plan) =>
    plan.provider === provider &&
    new Date(plan.startsAt).getTime() <= t &&
    (!plan.endsAt || new Date(plan.endsAt).getTime() > t)
  );
}
