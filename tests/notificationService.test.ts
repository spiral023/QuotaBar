import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNotificationOptions } from "../src/main/notifications";
import type { NotificationEvent } from "../src/main/notificationEngine";

function event(provider: string, title: string): NotificationEvent {
  return {
    ruleId: "highUsage",
    provider,
    windowName: "fiveHour",
    severity: "warning",
    title,
    body: "Das Kontingent hat 80 % überschritten.",
    firedAt: "2026-06-04T12:00:00.000Z",
    reason: "test",
  };
}

describe("buildNotificationOptions", () => {
  it("uses the provider-specific event title and Codex logo", () => {
    const options = buildNotificationOptions(event("codex", "Codex 5h: 82 % verbraucht"));

    expect(options.title).toBe("Codex 5h: 82 % verbraucht");
    expect(options.body).toBe("Das Kontingent hat 80 % überschritten.");
    expect(String(options.icon)).toBe(path.resolve("logos", "codex.png"));
  });

  it("uses the Claude logo for Claude events", () => {
    const options = buildNotificationOptions(event("claude", "Claude Woche: 97 % verbraucht"));

    expect(options.title).toBe("Claude Woche: 97 % verbraucht");
    expect(String(options.icon)).toBe(path.resolve("logos", "claude.png"));
  });
});
