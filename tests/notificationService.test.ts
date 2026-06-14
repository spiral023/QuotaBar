import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNotificationOptions, buildToastXml } from "../src/main/notifications";
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

describe("buildToastXml", () => {
  it("activates the quotabar:// protocol for body and buttons", () => {
    const xml = buildToastXml(event("claude", "Claude Woche: 97 % verbraucht"), true);

    expect(xml).toContain('activationType="protocol"');
    expect(xml).toContain('launch="quotabar://open"');
    expect(xml).toContain('arguments="quotabar://open"');
    expect(xml).toContain("quotabar://mute?rule=highUsage");
    expect(xml).toContain("<text>Claude Woche: 97 % verbraucht</text>");
  });

  it("omits the actions block when no handlers are wired", () => {
    const xml = buildToastXml(event("codex", "Codex 5h: 82 % verbraucht"), false);
    expect(xml).not.toContain("<actions>");
  });

  it("escapes XML-special characters in title and body", () => {
    const evt: NotificationEvent = {
      ...event("claude", "Limit <90%> & \"hoch\""),
      body: "5 < 10 & 'ok'",
    };
    const xml = buildToastXml(evt, true);

    expect(xml).toContain("Limit &lt;90%&gt; &amp; &quot;hoch&quot;");
    expect(xml).toContain("5 &lt; 10 &amp; &apos;ok&apos;");
    expect(xml).not.toMatch(/<text>[^<]*<[^/]/); // kein unescapetes '<' im Textinhalt
  });
});
