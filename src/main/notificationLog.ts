import fsSync from "node:fs";
import { getNotificationLogPath } from "../config/paths";
import { localISOString } from "./logging";
import type { NotificationEvent } from "./notificationEngine";

const MAX_BYTES = 1_000_000;

export class NotificationLog {
  private readonly path: string;

  constructor() {
    this.path = getNotificationLogPath();
    this.append(JSON.stringify({ t: localISOString(new Date()), evt: "start" }));
  }

  write(event: NotificationEvent): void {
    const entry: Record<string, string> = {
      t: event.firedAt,
      rule: event.ruleId,
      prov: event.provider,
      sev: event.severity,
      reason: event.reason,
    };
    if (event.windowName) entry.win = event.windowName;
    this.append(JSON.stringify(entry));
  }

  private append(line: string): void {
    try {
      this.trimIfNeeded();
      fsSync.appendFileSync(this.path, line + "\n", "utf8");
    } catch {
      // Never crash the tray app due to logging failure
    }
  }

  private trimIfNeeded(): void {
    try {
      if (fsSync.statSync(this.path).size < MAX_BYTES) return;
      const lines = fsSync.readFileSync(this.path, "utf8").split("\n").filter(Boolean);
      const keep = Math.floor(lines.length * 0.7);
      fsSync.writeFileSync(this.path, lines.slice(lines.length - keep).join("\n") + "\n", "utf8");
    } catch {
      // File doesn't exist yet or unreadable — next append creates it fresh
    }
  }
}
