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
    expect(toCodexEvents([event])[0]).toMatchObject({ isFallback: true, inputTokens: 40, cachedInputTokens: 40 });
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
    ["C:\\Users\\Alice\\Secret\\QuotaBar", "Unknown project"],
    ["/home/alice/Secret/QuotaBar", "Unknown project"],
  ])("rejects non-plain Claude legacy project labels (%s)", (project, expected) => {
    const [event] = fromClaudeEntries([claude({ projectName: undefined, project })]);
    expect(event.projectName).toBe(expected);
    expect(JSON.stringify(event)).not.toContain("Secret");
  });

  it.each([
    "C--Users-alice-Documents-GitHub-QuotaBar",
    "D--Work-Alice-QuotaBar",
    "C--src-private-QuotaBar",
    "-home-alice-projects-QuotaBar",
    "-workspace-alice-QuotaBar",
  ])("rejects path-encoded Claude project labels (%s)", (project) => {
    const [event] = fromClaudeEntries([claude({ projectName: undefined, project })]);
    expect(event.projectName).toBe("Unknown project");
    expect(JSON.stringify(event)).not.toMatch(/alice|Documents|home/);
  });

  it("keeps a plain legacy Claude project label recognizable", () => {
    expect(fromClaudeEntries([claude({ projectName: undefined, project: "QuotaBar" })])[0].projectName).toBe("QuotaBar");
  });

  it.each([
    "D--Work-Alice-QuotaBar",
    "C--src-private-QuotaBar",
    "-workspace-alice-QuotaBar",
    "C:secret",
  ])("does not reverse unsafe encoded project names (%s)", (projectName) => {
    const claudeEvent = { ...fromClaudeEntries([claude()])[0], projectName };
    const codexEvent = { ...fromCodexEvents([codex()])[0], projectName };
    const claudeEntry = toClaudeEntries([claudeEvent])[0];
    const codexEntry = toCodexEvents([codexEvent])[0];
    expect(claudeEntry.project).toBe("Unknown project");
    expect(codexEntry.directory).toBe(".");
    expect(JSON.stringify([claudeEntry.project, codexEntry.directory])).not.toContain(projectName);
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

  it("keeps IDs stable across insertion, deletion, and permutation of distinct statistical records", () => {
    const a = claude({ sourceEventId: "source-a", inputTokens: 1, outputTokens: 2, costUSD: 0.1 });
    const b = claude({ sourceEventId: "source-b", inputTokens: 3, outputTokens: 4, costUSD: 0.2 });
    const c = claude({ sourceEventId: "source-c", inputTokens: 5, outputTokens: 6, costUSD: 0.3 });
    const idByInput = (entries: ClaudeUsageEntry[]) => new Map(fromClaudeEntries(entries).map((event) => [event.inputTokens, event.id]));
    const baseline = idByInput([a, b]);
    const inserted = idByInput([c, a, b]);
    const permuted = idByInput([b, a]);
    expect([inserted.get(1), inserted.get(3)]).toEqual([baseline.get(1), baseline.get(3)]);
    expect([permuted.get(1), permuted.get(3)]).toEqual([baseline.get(1), baseline.get(3)]);
    expect(idByInput([a]).get(1)).toBe(baseline.get(1));
  });

  it("keeps source event identity stable when mutable statistics and pricing change", () => {
    const before = claude({ sourceEventId: "immutable-source", inputTokens: 1, costUSD: 0.1, pricingVersion: "v1" });
    const after = claude({ sourceEventId: "immutable-source", inputTokens: 999, outputCostUSD: 4.2, costUSD: 9, pricingVersion: "v2" });
    expect(fromClaudeEntries([before])[0].id).toBe(fromClaudeEntries([after])[0].id);
  });

  it("uses deterministic coarse ordinals when provider source IDs are unavailable", () => {
    const entries = [claude({ inputTokens: 1 }), claude({ inputTokens: 2 })];
    expect(fromClaudeEntries(entries).map((event) => event.id)).toEqual(fromClaudeEntries(entries).map((event) => event.id));
  });

  it("keeps existing duplicate IDs when an exact copy is added", () => {
    const duplicate = claude();
    const before = new Set(fromClaudeEntries([duplicate, duplicate]).map((event) => event.id));
    const after = new Set(fromClaudeEntries([duplicate, duplicate, duplicate]).map((event) => event.id));
    expect(after.size).toBe(3);
    expect([...before].every((id) => after.has(id))).toBe(true);
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

  it.each([
    "2026-02-30T10:00:00Z",
    "2026-13-01T10:00:00Z",
    "2026-01-01T25:00:00Z",
    "2026-01-01T10:00:00+15:00",
    "2026-01-01T10:00:00+25:00",
    "2026-01-01",
  ])("strictly rejects malformed ISO timestamps (%s)", (timestamp) => {
    expect(() => fromClaudeEntries([claude({ timestamp })])).toThrow("Invalid Claude timestamp");
  });

  it.each([
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
    ["2026-07-13T12:34:56+02:00", "2026-07-13T10:34:56.000Z"],
  ])("accepts and normalizes strict ISO timestamps (%s)", (timestamp, expected) => {
    expect(fromClaudeEntries([claude({ timestamp })])[0].occurredAt).toBe(expected);
  });

  it("preserves component-only costs and pricing metadata through reverse paths", () => {
    const claudeEntry = claude({
      costUSD: undefined,
      inputCostUSD: 0.1,
      outputCostUSD: 0.2,
      cacheCreationCostUSD: 0.3,
      cacheReadCostUSD: 0.4,
      pricingVersion: "2026-07-13",
    });
    const claudePortable = fromClaudeEntries([claudeEntry])[0];
    const claudeRoundtrip = toClaudeEntries([claudePortable])[0];
    expect(claudePortable).toMatchObject({ inputCostUSD: 0.1, outputCostUSD: 0.2, cacheCreationCostUSD: 0.3, cacheReadCostUSD: 0.4, pricingVersion: "2026-07-13" });
    expect(claudeRoundtrip).toMatchObject({ costUSD: 1, inputCostUSD: 0.1, outputCostUSD: 0.2, cacheCreationCostUSD: 0.3, cacheReadCostUSD: 0.4, pricingVersion: "2026-07-13" });

    const codexPortable = fromCodexEvents([codex({ inputCostUSD: 0.5, outputCostUSD: 0.6, costUSD: 1.1, pricingVersion: "v2" })])[0];
    expect(toCodexEvents([codexPortable])[0]).toMatchObject({ inputCostUSD: 0.5, outputCostUSD: 0.6, costUSD: 1.1, pricingVersion: "v2" });
  });

  it("preserves portable identity through provider report shapes", () => {
    const originalClaude = fromClaudeEntries([claude()])[0];
    const originalCodex = fromCodexEvents([codex()])[0];
    const claudeRoundtrip = fromClaudeEntries(toClaudeEntries([originalClaude]))[0];
    const codexRoundtrip = fromCodexEvents(toCodexEvents([originalCodex]))[0];
    expect([claudeRoundtrip.id, claudeRoundtrip.sessionKey]).toEqual([originalClaude.id, originalClaude.sessionKey]);
    expect([codexRoundtrip.id, codexRoundtrip.sessionKey]).toEqual([originalCodex.id, originalCodex.sessionKey]);
  });

  it("ignores structurally injected provenance fields", () => {
    const injected = claude() as ClaudeUsageEntry & { portableEventId: string; portableSessionKey: string };
    injected.portableEventId = "a".repeat(64);
    injected.portableSessionKey = "b".repeat(64);
    const [event] = fromClaudeEntries([injected]);
    expect(event.id).not.toBe(injected.portableEventId);
    expect(event.sessionKey).not.toBe(injected.portableSessionKey);
  });

  it("keeps reverse provenance private and loses it across JSON clones", () => {
    const original = fromClaudeEntries([claude()])[0];
    const [reversed] = toClaudeEntries([original]);
    expect(Object.keys(reversed)).not.toContain("portableEventId");
    expect(Object.keys(reversed)).not.toContain("portableSessionKey");
    const direct = fromClaudeEntries([reversed])[0];
    const cloned = fromClaudeEntries([JSON.parse(JSON.stringify(reversed)) as ClaudeUsageEntry])[0];
    expect([direct.id, direct.sessionKey]).toEqual([original.id, original.sessionKey]);
    expect([cloned.id, cloned.sessionKey]).not.toEqual([original.id, original.sessionKey]);
  });

  it.each([
    { inputTokens: -1 },
    { inputTokens: Number.NaN },
    { outputTokens: Number.POSITIVE_INFINITY },
    { totalTokens: -1 },
  ])("rejects malformed Codex token events (%o)", (overrides) => {
    expect(() => fromCodexEvents([codex(overrides)])).toThrow("Invalid Codex token counts");
  });

  it("allows cached Codex input to exceed total input at the adapter boundary", () => {
    const [event] = fromCodexEvents([codex({ inputTokens: 30, cachedInputTokens: 40 })]);
    expect(event).toMatchObject({ inputTokens: 0, cacheReadTokens: 40 });
    expect(toCodexEvents([event])[0].inputTokens).toBe(40);
  });

  it("exposes an immutable exact key allowlist", () => {
    expect(Object.isFrozen(PORTABLE_USAGE_EVENT_KEYS)).toBe(true);
    expect(() => (PORTABLE_USAGE_EVENT_KEYS as unknown as string[]).push("session")).toThrow();
  });
});
