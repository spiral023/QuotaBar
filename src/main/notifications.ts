import { Notification } from "electron";
import type { UsageSnapshot, UsageWindow } from "../providers/types";
import { detectResets, ResetEvent } from "../usage/resetDetection";

const WINDOW_LABELS: Record<UsageWindow["name"], string> = {
  fiveHour: "Five-hour",
  weekly: "Weekly",
  monthly: "Monthly",
  credits: "Credits",
  session: "Session",
};

export class NotificationService {
  private readonly previous = new Map<string, UsageSnapshot>();

  onRefresh(snapshots: UsageSnapshot[]): void {
    for (const next of snapshots) {
      const prev = this.previous.get(next.provider);
      const resets = detectResets(prev, next);
      for (const reset of resets) {
        this.notify(reset);
      }
      this.previous.set(next.provider, next);
    }
  }

  private notify(event: ResetEvent): void {
    new Notification({
      title: "QuotaBar",
      body: buildBody(event),
    }).show();
  }
}

function buildBody(event: ResetEvent): string {
  const providerLabel = capitalize(event.provider);
  const windowLabel = WINDOW_LABELS[event.windowName] ?? event.windowName;
  return `${providerLabel} limit reset: ${windowLabel} usage is back at 0%.`;
}

function capitalize(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}
