import { existsSync } from "node:fs";
import path from "node:path";
import { Notification } from "electron";
import type { NotificationConstructorOptions } from "electron";
import type { UsageSnapshot } from "../providers/types";
import type { NotificationSettings } from "../config/settings";
import { NotificationEngine, NotificationStateStore } from "./notificationEngine";
import type { NotificationEvent } from "./notificationEngine";
import { NotificationHistory } from "./notificationHistory";
import { NotificationLog } from "./notificationLog";

export { NotificationEvent };

const PROVIDER_LOGO_FILES: Record<string, string> = {
  claude: "claude.png",
  codex: "codex.png",
};

export class NotificationService {
  private readonly engine  = new NotificationEngine();
  private readonly state   = new NotificationStateStore();
  readonly history         = new NotificationHistory();
  private readonly notifLog = new NotificationLog();

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
      this.notifLog.write(event);
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
    new Notification(buildNotificationOptions(event)).show();
  }
}

export function buildNotificationOptions(event: NotificationEvent): NotificationConstructorOptions {
  const icon = getProviderLogoPath(event.provider);
  return {
    title: event.title,
    body: event.body,
    ...(icon ? { icon } : {}),
  };
}

function getProviderLogoPath(provider: string): string | undefined {
  const logoFile = PROVIDER_LOGO_FILES[provider.toLowerCase()];
  if (!logoFile) return undefined;

  const logoPath = path.resolve(__dirname, "..", "..", "logos", logoFile);
  return existsSync(logoPath) ? logoPath : undefined;
}
