import { Notification } from "electron";
import type { UsageSnapshot } from "../providers/types";
import type { NotificationSettings } from "../config/settings";
import { NotificationEngine, NotificationStateStore } from "./notificationEngine";
import type { NotificationEvent } from "./notificationEngine";
import { NotificationHistory } from "./notificationHistory";

export { NotificationEvent };

export class NotificationService {
  private readonly engine  = new NotificationEngine();
  private readonly state   = new NotificationStateStore();
  readonly history         = new NotificationHistory();

  private previous: UsageSnapshot[] = [];
  private settings: NotificationSettings;

  constructor(settings: NotificationSettings) {
    this.settings = settings;
  }

  updateSettings(settings: NotificationSettings): void {
    this.settings = settings;
  }

  onRefresh(snapshots: UsageSnapshot[]): void {
    const events = this.engine.evaluate({
      current: snapshots,
      previous: this.previous,
      settings: this.settings,
    }, this.state);

    this.previous = snapshots;

    for (const event of events) {
      this.show(event);
    }

    if (events.length > 0) {
      this.history.add(events);
    }
  }

  sendTest(): void {
    new Notification({
      title: "QuotaBar",
      body: "Testbenachrichtigung – Benachrichtigungen funktionieren.",
    }).show();
  }

  private show(event: NotificationEvent): void {
    new Notification({
      title: "QuotaBar",
      body: event.body,
    }).show();
  }
}
