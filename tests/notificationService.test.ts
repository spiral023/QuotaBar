import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNotificationOptions, buildTestToastXml, buildToastXml } from "../src/main/notifications";
import type { NotificationEvent } from "../src/main/notificationEngine";

function event(provider: string, title: string): NotificationEvent {
  return {
    ruleId: "highUsage",
    provider,
    windowName: "fiveHour",
    severity: "warning",
    title,
    body: "Quota usage has crossed 80%.",
    firedAt: "2026-06-04T12:00:00.000Z",
    reason: "test",
  };
}

describe("buildNotificationOptions", () => {
  it("uses the provider-specific event title and Codex logo", () => {
    const options = buildNotificationOptions(event("codex", "Codex 5h: 82% used"));

    expect(options.title).toBe("Codex 5h: 82% used");
    expect(options.body).toBe("Quota usage has crossed 80%.");
    expect(String(options.icon)).toBe(path.resolve("logos", "codex.png"));
  });

  it("uses the Claude logo for Claude events", () => {
    const options = buildNotificationOptions(event("claude", "Claude week: 97% used"));

    expect(options.title).toBe("Claude week: 97% used");
    expect(String(options.icon)).toBe(path.resolve("logos", "claude.png"));
  });

  it("uses English action labels", () => {
    const options = buildNotificationOptions(event("codex", "Codex 5h: 82% used"), true);

    expect(options.actions).toEqual([
      { type: "button", text: "Open" },
      { type: "button", text: "Mute" },
    ]);
  });
});

describe("buildToastXml", () => {
  it("activates the quotabar:// protocol for body and buttons", () => {
    const xml = buildToastXml(event("claude", "Claude week: 97% used"), true);

    expect(xml).toContain('activationType="protocol"');
    expect(xml).toContain('launch="quotabar://open"');
    expect(xml).toContain('arguments="quotabar://open"');
    expect(xml).toContain("quotabar://mute?rule=highUsage");
    expect(xml).toContain("<text>Claude week: 97% used</text>");
    expect(xml).toContain('content="Open"');
    expect(xml).toContain('content="Mute"');
  });

  it("omits the actions block when no handlers are wired", () => {
    const xml = buildToastXml(event("codex", "Codex 5h: 82% used"), false);
    expect(xml).not.toContain("<actions>");
  });

  it("uses English copy for the test notification", () => {
    const xml = buildTestToastXml(true);

    expect(xml).toContain("<text>Test notification - notifications are working.</text>");
    expect(xml).toContain('content="Open"');
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
