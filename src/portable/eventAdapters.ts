import type { CodexTokenEvent } from "../pricing/codex-log-reader";
import type { ClaudeUsageEntry } from "../pricing/jsonl-reader";
import { eventId, sessionKey } from "./eventIdentity";
import { PORTABLE_STORE_VERSION, type PortableProvider, type PortableUsageEvent } from "./types";

export const PORTABLE_USAGE_EVENT_KEYS: string[] = [
  "schemaVersion",
  "id",
  "provider",
  "occurredAt",
  "model",
  "projectName",
  "sessionKey",
  "source",
  "synthetic",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "reasoningOutputTokens",
  "costUSD",
  "inputCostUSD",
  "outputCostUSD",
  "cacheCreationCostUSD",
  "cacheReadCostUSD",
  "pricingVersion",
];

export function fromClaudeEntries(entries: readonly ClaudeUsageEntry[]): PortableUsageEvent[] {
  const ordinals = new Map<string, number>();
  return entries.map((entry) => {
    const occurredAt = normalizeTimestamp(entry.timestamp, "Claude");
    const ordinal = nextOrdinal(ordinals, "claude", occurredAt, entry.model, entry.session);
    const projectName = basenameAnySeparator(entry.projectName);
    return {
      schemaVersion: PORTABLE_STORE_VERSION,
      id: eventId({ provider: "claude", occurredAt, model: entry.model, session: entry.session, ordinal }),
      provider: "claude",
      occurredAt,
      model: entry.model,
      ...(projectName ? { projectName } : {}),
      sessionKey: sessionKey("claude", entry.session),
      source: "claude-log",
      synthetic: false,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      cacheReadTokens: entry.cacheReadTokens,
      reasoningOutputTokens: 0,
      ...(entry.costUSD !== undefined ? { costUSD: entry.costUSD } : {}),
    };
  });
}

export function fromCodexEvents(events: readonly CodexTokenEvent[]): PortableUsageEvent[] {
  const ordinals = new Map<string, number>();
  return events.map((entry) => {
    const occurredAt = normalizeTimestamp(entry.timestamp, "Codex");
    const ordinal = nextOrdinal(ordinals, "codex", occurredAt, entry.model, entry.session);
    const projectName = basenameAnySeparator(entry.projectName);
    return {
      schemaVersion: PORTABLE_STORE_VERSION,
      id: eventId({ provider: "codex", occurredAt, model: entry.model, session: entry.session, ordinal }),
      provider: "codex",
      occurredAt,
      model: entry.model,
      ...(projectName ? { projectName } : {}),
      sessionKey: sessionKey("codex", entry.session),
      source: "codex-log",
      synthetic: false,
      inputTokens: Math.max(entry.inputTokens - entry.cachedInputTokens, 0),
      outputTokens: entry.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: entry.cachedInputTokens,
      reasoningOutputTokens: entry.reasoningOutputTokens,
    };
  });
}

export function toClaudeEntries(events: readonly PortableUsageEvent[]): ClaudeUsageEntry[] {
  return events
    .filter((event) => event.provider === "claude")
    .map((event) => ({
      provider: "claude",
      timestamp: event.occurredAt,
      model: event.model,
      project: event.projectName ?? "Unknown project",
      ...(event.projectName ? { projectName: event.projectName } : {}),
      session: event.sessionKey,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      cacheReadTokens: event.cacheReadTokens,
      ...(event.costUSD !== undefined ? { costUSD: event.costUSD } : {}),
    }));
}

export function toCodexEvents(events: readonly PortableUsageEvent[]): CodexTokenEvent[] {
  return events
    .filter((event) => event.provider === "codex")
    .map((event) => {
      const inputTokens = event.inputTokens + event.cacheReadTokens;
      return {
        timestamp: event.occurredAt,
        model: event.model,
        isFallback: event.model === "gpt-5",
        session: event.sessionKey,
        directory: event.projectName ?? ".",
        ...(event.projectName ? { projectName: event.projectName } : {}),
        inputTokens,
        cachedInputTokens: event.cacheReadTokens,
        outputTokens: event.outputTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        totalTokens: inputTokens + event.outputTokens,
      };
    });
}

function normalizeTimestamp(value: string, provider: "Claude" | "Codex"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${provider} timestamp`);
  return date.toISOString();
}

function basenameAnySeparator(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? null;
}

function nextOrdinal(
  counters: Map<string, number>,
  provider: PortableProvider,
  occurredAt: string,
  model: string,
  rawSession: string,
): number {
  const identity = JSON.stringify([provider, occurredAt, model, rawSession]);
  const ordinal = counters.get(identity) ?? 0;
  counters.set(identity, ordinal + 1);
  return ordinal;
}
