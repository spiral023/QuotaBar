import fsSync from "node:fs";
import { getNotificationLogPath } from "../config/paths";
import { updateAppDataFile } from "../portable/appDataLock";
import { localISOString } from "./logging";
import type { NotificationEvent, NotificationSeverity } from "./notificationEngine";

const MAX_BYTES = 1_000_000;

export class NotificationLog {
  private readonly path: string;
  private pendingWrite: Promise<void> = Promise.resolve();
  private writeFailed = false;

  constructor(filePath = getNotificationLogPath()) {
    this.path = filePath;
    this.append(JSON.stringify({ t: localISOString(new Date()), evt: "start" }));
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
    if (this.writeFailed) throw new Error("Notification log persistence failed");
  }

  write(event: NotificationEvent): void {
    const entry: Record<string, string> = {
      t: event.firedAt,
      rule: event.ruleId,
      prov: event.provider,
      sev: event.severity,
      reason: event.reason,
      title: event.title,
      body: event.body,
    };
    if (event.windowName) entry.win = event.windowName;
    this.append(JSON.stringify(entry));
  }

  readRecent(limit: number): NotificationEvent[] {
    try {
      const lines = fsSync.readFileSync(this.path, "utf8").split("\n");
      const events: NotificationEvent[] = [];
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let parsed: Record<string, string>;
        try { parsed = JSON.parse(line) as Record<string, string>; } catch { continue; }
        if (parsed.evt || !parsed.rule || !parsed.t) continue;
        events.push({
          ruleId: parsed.rule,
          provider: parsed.prov ?? "",
          windowName: parsed.win,
          severity: (parsed.sev ?? "info") as NotificationSeverity,
          title: parsed.title ?? parsed.rule,
          body: parsed.body ?? parsed.reason ?? "",
          firedAt: parsed.t,
          reason: parsed.reason ?? "",
        });
      }
      return events;
    } catch {
      return [];
    }
  }

  private append(line: string): void {
    this.pendingWrite = this.pendingWrite.then(() => updateAppDataFile(this.path, (current) => {
      let existing = current ?? "";
      if (Buffer.byteLength(existing, "utf8") >= MAX_BYTES) {
        const lines = existing.split("\n").filter(Boolean);
        const keep = Math.floor(lines.length * 0.7);
        existing = lines.slice(lines.length - keep).join("\n") + "\n";
      }
      return `${existing}${line}\n`;
    })).catch(() => { this.writeFailed = true; });
  }
}
