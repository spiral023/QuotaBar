import type { NotificationEvent } from "./notificationEngine";

const MAX_ENTRIES = 50;

export class NotificationHistory {
  private readonly entries: NotificationEvent[] = [];

  add(events: NotificationEvent[]): void {
    this.entries.unshift(...events);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(MAX_ENTRIES);
  }

  getRecent(limit = 20): NotificationEvent[] {
    return this.entries.slice(0, limit);
  }

  clear(): void {
    this.entries.splice(0);
  }
}
