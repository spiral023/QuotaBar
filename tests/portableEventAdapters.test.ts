import { describe, expect, it } from "vitest";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";
import { sessionKey } from "../src/portable/eventIdentity";
import {
  PORTABLE_USAGE_EVENT_KEYS,
  fromClaudeEntries,
  fromCodexEvents,
  toClaudeEntries,
  toCodexEvents,
} from "../src/portable/eventAdapters";

const portableKeys = [
  "schemaVersion", "id", "provider", "occurredAt", "model", "projectName",
  "sessionKey", "source", "synthetic", "inputTokens", "outputTokens",
  "cacheCreationTokens", "cacheReadTokens", "reasoningOutputTokens", "costUSD",
  "inputCostUSD", "outputCostUSD", "cacheCreationCostUSD", "cacheReadCostUSD",
  "pricingVersion",
];

function claude(overrides: Partial<ClaudeUsageEntry> = {}): ClaudeUsageEntry {
  return {
    provider: "claude",
    timestamp: "2026-07-13T12:34:56+02:00",
    model: "claude-sonnet-4-6",
    project: "legacy-project",
    projectName: "QuotaBar",
    session: "raw-claude-session",
    inputTokens: 11,
    outputTokens: 12,
    cacheCreationTokens: 13,
    cacheReadTokens: 14,
    costUSD: 0.42,
    ...overrides,
  };
}

function codex(overrides: Partial<CodexTokenEvent> = {}): CodexTokenEvent {
  return {
    timestamp: "2026-07-13T12:34:56+02:00",
    model: "gpt-5.2-codex",
    isFallback: false,
    session: "raw-codex-session",
    directory: "C:\\Users\\person\\secret\\QuotaBar",
    projectName: "QuotaBar",
    inputTokens: 101,
    cachedInputTokens: 40,
    outputTokens: 23,
    reasoningOutputTokens: 7,
    totalTokens: 124,
    ...overrides,
  };
}

describe("portable event adapters", () => {
  it("normalizes Claude usage without persisting raw session or paths", () => {
    const [event] = fromClaudeEntries([claude({
      project: "/home/person/secret/QuotaBar",
      projectName: "/home/person/secret/QuotaBar",
    })]);

    expect(event).toMatchObject({
      schemaVersion: 1,
      provider: "claude",
      occurredAt: "2026-07-13T10:34:56.000Z",
      model: "claude-sonnet-4-6",
      projectName: "QuotaBar",
      sessionKey: sessionKey("claude", "raw-claude-session"),
      source: "claude-log",
      synthetic: false,
      inputTokens: 11,
      outputTokens: 12,
      cacheCreationTokens: 13,
      cacheReadTokens: 14,
      reasoningOutputTokens: 0,
      costUSD: 0.42,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("raw-claude-session");
    expect(serialized).not.toContain("/home/person/secret");
  });

  it("normalizes Codex usage and reconstructs fallback state", () => {
    const [event] = fromCodexEvents([codex({
      inputTokens: 30,
      cachedInputTokens: 40,
      model: "gpt-5",
      isFallback: true,
      projectName: "C:\\Users\\person\\secret\\QuotaBar",
    })]);

    expect(event).toMatchObject({
      provider: "codex",
      occurredAt: "2026-07-13T10:34:56.000Z",
      model: "gpt-5",
      projectName: "QuotaBar",
      sessionKey: sessionKey("codex", "raw-codex-session"),
      source: "codex-log",
      synthetic: false,
      inputTokens: 0,
      cacheReadTokens: 40,
      cacheCreationTokens: 0,
      outputTokens: 23,
      reasoningOutputTokens: 7,
    });
    expect(toCodexEvents([event])[0].isFallback).toBe(true);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("raw-codex-session");
    expect(serialized).not.toContain("C:\\\\Users");
    expect(serialized).not.toContain("secret");
  });

  it("reverse-adapts provider events into report reader shapes without paths", () => {
    const portable = [...fromClaudeEntries([claude()]), ...fromCodexEvents([codex()])];

    expect(toClaudeEntries(portable)).toEqual([{
      provider: "claude",
      timestamp: "2026-07-13T10:34:56.000Z",
      model: "claude-sonnet-4-6",
      project: "QuotaBar",
      projectName: "QuotaBar",
      session: portable[0].sessionKey,
      inputTokens: 11,
      outputTokens: 12,
      cacheCreationTokens: 13,
      cacheReadTokens: 14,
      costUSD: 0.42,
    }]);
    expect(toCodexEvents(portable)).toEqual([{
      timestamp: "2026-07-13T10:34:56.000Z",
      model: "gpt-5.2-codex",
      isFallback: false,
      session: portable[1].sessionKey,
      directory: "QuotaBar",
      projectName: "QuotaBar",
      inputTokens: 101,
      cachedInputTokens: 40,
      outputTokens: 23,
      reasoningOutputTokens: 7,
      totalTokens: 124,
    }]);
  });

  it("uses safe reverse-adapter project fallbacks", () => {
    const claudeEvent = { ...fromClaudeEntries([claude()])[0], projectName: undefined };
    const codexEvent = { ...fromCodexEvents([codex()])[0], projectName: undefined };
    const [claudeEntry] = toClaudeEntries([claudeEvent]);
    expect(claudeEntry.project).toBe("Unknown project");
    expect(claudeEntry).not.toHaveProperty("projectName");
    expect(toCodexEvents([codexEvent])[0].directory).toBe(".");
  });

  it.each([
    ["C:\\Users\\Alice\\Secret\\QuotaBar", "QuotaBar"],
    ["/home/alice/Secret/QuotaBar", "QuotaBar"],
  ])("derives a safe Claude project name from legacy project labels (%s)", (project, expected) => {
    const [event] = fromClaudeEntries([claude({ projectName: undefined, project })]);
    expect(event.projectName).toBe(expected);
    expect(JSON.stringify(event)).not.toContain("Secret");
  });

  it("uses Unknown project when Claude project metadata has no basename", () => {
    const [event] = fromClaudeEntries([claude({ projectName: "", project: "" })]);
    expect(event.projectName).toBe("Unknown project");
  });

  it.each([
    ["C:\\Users\\Alice\\Secret\\QuotaBar", "QuotaBar"],
    ["/home/alice/Secret/QuotaBar", "QuotaBar"],
  ])("sanitizes reverse-adapter project names (%s)", (projectName, expected) => {
    const claudeEvent = { ...fromClaudeEntries([claude()])[0], projectName };
    const codexEvent = { ...fromCodexEvents([codex()])[0], projectName };

    const [claudeEntry] = toClaudeEntries([claudeEvent]);
    const [codexEntry] = toCodexEvents([codexEvent]);
    expect(claudeEntry.project).toBe(expected);
    expect(claudeEntry.projectName).toBe(expected);
    expect(codexEntry.directory).toBe(expected);
    expect(codexEntry.projectName).toBe(expected);
    expect(JSON.stringify([claudeEntry.project, codexEntry.directory])).not.toContain("Secret");
  });

  it("emits only the exact portable allowlist and omits undefined optionals", () => {
    expect(PORTABLE_USAGE_EVENT_KEYS).toEqual(portableKeys);
    const [event] = fromClaudeEntries([claude({ projectName: undefined, costUSD: undefined })]);
    expect(Object.keys(event).every((key) => PORTABLE_USAGE_EVENT_KEYS.includes(key))).toBe(true);
    expect(event.projectName).toBe("legacy-project");
    expect(event).not.toHaveProperty("costUSD");
    expect(event).not.toHaveProperty("project");
    expect(event).not.toHaveProperty("session");
  });

  it("keeps IDs stable when an unrelated earlier entry is inserted", () => {
    const target = claude({ timestamp: "2026-07-13T11:00:00Z" });
    const unrelated = claude({ timestamp: "2026-07-13T10:00:00Z", session: "other" });
    expect(fromClaudeEntries([target])[0].id).toBe(fromClaudeEntries([unrelated, target])[1].id);
  });

  it("assigns distinct ordinal IDs to duplicate identities", () => {
    const duplicate = codex();
    const events = fromCodexEvents([duplicate, duplicate]);
    expect(events[0].id).not.toBe(events[1].id);
  });

  it.each([
    ["Claude", () => fromClaudeEntries([claude({ timestamp: "not-a-date" })])],
    ["Codex", () => fromCodexEvents([codex({ timestamp: "not-a-date" })])],
  ])("rejects invalid %s timestamps", (provider, convert) => {
    expect(convert).toThrow(`Invalid ${provider} timestamp`);
  });
});
