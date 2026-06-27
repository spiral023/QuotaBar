import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { buildNotificationOptions, buildTestToastXml, buildToastXml, buildUpdateToastXml } from "../src/main/notifications";
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
  const originalResourcesPath = process.resourcesPath;
  const tempDirs: string[] = [];

  afterEach(() => {
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      configurable: true,
    });
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("uses provider logos from the external resources directory for Windows toast XML", () => {
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-toast-res-"));
    tempDirs.push(resourcesDir);
    const logoDir = path.join(resourcesDir, "logos");
    fs.mkdirSync(logoDir);
    const logoPath = path.join(logoDir, "claude.png");
    fs.writeFileSync(logoPath, "png");
    Object.defineProperty(process, "resourcesPath", {
      value: resourcesDir,
      configurable: true,
    });

    const xml = buildToastXml(event("claude", "Claude week: 97% used"), false);

    expect(xml).toContain(`src="${pathToFileURL(logoPath).href}"`);
  });
});

describe("buildUpdateToastXml", () => {
  it("shows version in title and Restart Now / Later buttons with correct protocol URLs", () => {
    const xml = buildUpdateToastXml("1.2.3", true);

    expect(xml).toContain("<text>QuotaBar 1.2.3 ready to install</text>");
    expect(xml).toContain('content="Restart Now"');
    expect(xml).toContain('arguments="quotabar://update-install"');
    expect(xml).toContain('content="Later"');
    expect(xml).toContain("quotabar://update-dismiss?v=1.2.3");
    expect(xml).toContain('activationType="protocol"');
  });

  it("omits the actions block when withActions is false", () => {
    const xml = buildUpdateToastXml("1.2.3", false);

    expect(xml).not.toContain("<actions>");
    expect(xml).not.toContain("Restart Now");
  });

  it("percent-encodes the version in the dismiss URL", () => {
    // '+' in a version string (e.g. build metadata) must be encoded so the
    // URL round-trip through Windows toast → new URL() → searchParams.get() is lossless.
    const xml = buildUpdateToastXml("1.2.3+build.1", true);

    expect(xml).toContain("quotabar://update-dismiss?v=1.2.3%2Bbuild.1");
  });

  it("XML-escapes special characters in the version for the title text", () => {
    const xml = buildUpdateToastXml("1.0.0-<rc>", true);

    expect(xml).toContain("QuotaBar 1.0.0-&lt;rc&gt; ready to install");
    expect(xml).not.toContain("<text>QuotaBar 1.0.0-<rc>");
  });
});
