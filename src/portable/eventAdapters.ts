import type { CodexTokenEvent } from "../pricing/codex-log-reader";
import type { ClaudeUsageEntry } from "../pricing/jsonl-reader";
import { basenameAnySeparator, plainClaudeProjectName } from "../shared/projectName";
import { eventId, sessionKey } from "./eventIdentity";
import { PORTABLE_STORE_VERSION, type PortableProvider, type PortableUsageEvent } from "./types";

const reverseProvenance = new WeakMap<object, { id: string; sessionKey: string }>();

export const PORTABLE_USAGE_EVENT_KEYS = Object.freeze([
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
  "legacyTarget",
] as const satisfies readonly (keyof PortableUsageEvent)[]);

export function fromClaudeEntries(entries: readonly ClaudeUsageEntry[]): PortableUsageEvent[] {
  const ordinals = new Map<string, number>();
  return entries.map((entry) => {
    const provenance = reverseProvenance.get(entry);
    const occurredAt = normalizeTimestamp(entry.timestamp, "Claude");
    const identitySession = providerIdentitySession(entry.session, entry.sourceEventId);
    const ordinal = entry.sourceEventId ? 0 : nextOrdinal(ordinals, "claude", occurredAt, entry.model, identitySession);
    const projectName = basenameAnySeparator(entry.projectName) ?? plainClaudeProjectName(entry.project) ?? "Unknown project";
    return {
      schemaVersion: PORTABLE_STORE_VERSION,
      id: provenance?.id ?? eventId({ provider: "claude", occurredAt, model: entry.model, session: identitySession, ordinal }),
      provider: "claude",
      occurredAt,
      model: entry.model,
      projectName,
      sessionKey: provenance?.sessionKey ?? sessionKey("claude", entry.session),
      source: "claude-log",
      synthetic: false,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      cacheReadTokens: entry.cacheReadTokens,
      reasoningOutputTokens: 0,
      ...(entry.costUSD !== undefined ? { costUSD: entry.costUSD } : {}),
      ...(entry.inputCostUSD !== undefined ? { inputCostUSD: entry.inputCostUSD } : {}),
      ...(entry.outputCostUSD !== undefined ? { outputCostUSD: entry.outputCostUSD } : {}),
      ...(entry.cacheCreationCostUSD !== undefined ? { cacheCreationCostUSD: entry.cacheCreationCostUSD } : {}),
      ...(entry.cacheReadCostUSD !== undefined ? { cacheReadCostUSD: entry.cacheReadCostUSD } : {}),
      ...(entry.pricingVersion !== undefined ? { pricingVersion: entry.pricingVersion } : {}),
    };
  });
}

export function fromCodexEvents(events: readonly CodexTokenEvent[]): PortableUsageEvent[] {
  const ordinals = new Map<string, number>();
  return events.map((entry) => {
    requireValidCodexTokens(entry);
    const provenance = reverseProvenance.get(entry);
    const occurredAt = normalizeTimestamp(entry.timestamp, "Codex");
    const identitySession = providerIdentitySession(entry.session, entry.sourceEventId);
    const ordinal = entry.sourceEventId ? 0 : nextOrdinal(ordinals, "codex", occurredAt, entry.model, identitySession);
    const projectName = basenameAnySeparator(entry.projectName);
    return {
      schemaVersion: PORTABLE_STORE_VERSION,
      id: provenance?.id ?? eventId({ provider: "codex", occurredAt, model: entry.model, session: identitySession, ordinal }),
      provider: "codex",
      occurredAt,
      model: entry.model,
      ...(projectName ? { projectName } : {}),
      sessionKey: provenance?.sessionKey ?? sessionKey("codex", entry.session),
      source: "codex-log",
      synthetic: false,
      inputTokens: Math.max(entry.inputTokens - entry.cachedInputTokens, 0),
      outputTokens: entry.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: entry.cachedInputTokens,
      reasoningOutputTokens: entry.reasoningOutputTokens,
      ...(entry.costUSD !== undefined ? { costUSD: entry.costUSD } : {}),
      ...(entry.inputCostUSD !== undefined ? { inputCostUSD: entry.inputCostUSD } : {}),
      ...(entry.outputCostUSD !== undefined ? { outputCostUSD: entry.outputCostUSD } : {}),
      ...(entry.cacheCreationCostUSD !== undefined ? { cacheCreationCostUSD: entry.cacheCreationCostUSD } : {}),
      ...(entry.cacheReadCostUSD !== undefined ? { cacheReadCostUSD: entry.cacheReadCostUSD } : {}),
      ...(entry.pricingVersion !== undefined ? { pricingVersion: entry.pricingVersion } : {}),
    };
  });
}

export function toClaudeEntries(events: readonly PortableUsageEvent[]): ClaudeUsageEntry[] {
  return events
    .filter((event) => event.provider === "claude" && !isNeutralInternalMarker(event))
    .map((event) => {
      const projectName = basenameAnySeparator(event.projectName);
      const componentCost = sumFiniteCosts([
        event.inputCostUSD,
        event.outputCostUSD,
        event.cacheCreationCostUSD,
        event.cacheReadCostUSD,
      ]);
      const costUSD = event.costUSD ?? componentCost;
      const entry: ClaudeUsageEntry = {
        provider: "claude",
        timestamp: event.occurredAt,
        model: event.model,
        project: projectName ?? "Unknown project",
        ...(projectName ? { projectName } : {}),
        session: event.sessionKey,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        cacheReadTokens: event.cacheReadTokens,
        ...(costUSD !== undefined ? { costUSD } : {}),
        ...(event.inputCostUSD !== undefined ? { inputCostUSD: event.inputCostUSD } : {}),
        ...(event.outputCostUSD !== undefined ? { outputCostUSD: event.outputCostUSD } : {}),
        ...(event.cacheCreationCostUSD !== undefined ? { cacheCreationCostUSD: event.cacheCreationCostUSD } : {}),
        ...(event.cacheReadCostUSD !== undefined ? { cacheReadCostUSD: event.cacheReadCostUSD } : {}),
        ...(event.pricingVersion !== undefined ? { pricingVersion: event.pricingVersion } : {}),
      };
      reverseProvenance.set(entry, { id: event.id, sessionKey: event.sessionKey });
      return entry;
    });
}

export function toCodexEvents(events: readonly PortableUsageEvent[]): CodexTokenEvent[] {
  return events
    .filter((event) => event.provider === "codex" && !isNeutralInternalMarker(event))
    .map((event) => {
      const inputTokens = event.inputTokens + event.cacheReadTokens;
      const projectName = basenameAnySeparator(event.projectName);
      const entry: CodexTokenEvent = {
        timestamp: event.occurredAt,
        model: event.model,
        isFallback: event.model === "gpt-5",
        session: event.sessionKey,
        directory: projectName ?? ".",
        ...(projectName ? { projectName } : {}),
        inputTokens,
        cachedInputTokens: event.cacheReadTokens,
        outputTokens: event.outputTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        totalTokens: inputTokens + event.outputTokens,
        ...(event.costUSD !== undefined ? { costUSD: event.costUSD } : {}),
        ...(event.inputCostUSD !== undefined ? { inputCostUSD: event.inputCostUSD } : {}),
        ...(event.outputCostUSD !== undefined ? { outputCostUSD: event.outputCostUSD } : {}),
        ...(event.cacheCreationCostUSD !== undefined ? { cacheCreationCostUSD: event.cacheCreationCostUSD } : {}),
        ...(event.cacheReadCostUSD !== undefined ? { cacheReadCostUSD: event.cacheReadCostUSD } : {}),
        ...(event.pricingVersion !== undefined ? { pricingVersion: event.pricingVersion } : {}),
      };
      reverseProvenance.set(entry, { id: event.id, sessionKey: event.sessionKey });
      return entry;
    });
}

export function isNeutralInternalMarker(event: PortableUsageEvent): boolean {
  return event.source === "legacy-reconciliation"
    && event.legacyTarget !== undefined
    && event.inputTokens === 0
    && event.outputTokens === 0
    && event.cacheCreationTokens === 0
    && event.cacheReadTokens === 0
    && event.reasoningOutputTokens === 0
    && [
      event.costUSD,
      event.inputCostUSD,
      event.outputCostUSD,
      event.cacheCreationCostUSD,
      event.cacheReadCostUSD,
    ].every((cost) => cost === undefined || cost === 0);
}

function normalizeTimestamp(value: string, provider: "Claude" | "Codex"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid ${provider} timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offset = zone === "Z" ? null : zone.slice(1).split(":").map(Number);
  const daysInMonth = daysForMonth(year, month);
  const invalidOffset = offset && (offset[0] > 14 || offset[1] > 59 || (offset[0] === 14 && offset[1] !== 0));
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || invalidOffset) {
    throw new Error(`Invalid ${provider} timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${provider} timestamp`);
  return date.toISOString();
}

function daysForMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function providerIdentitySession(rawSession: string, sourceEventId: string | undefined): string {
  // Prefer immutable provider source IDs. Coarse encounter ordinals are a retention-first fallback when IDs are absent:
  // shifted/reordered records can gain new IDs, and ingestion deliberately retains the older events rather than deleting history.
  return sourceEventId
    ? JSON.stringify(["provider-session", rawSession, "source-event", sourceEventId])
    : rawSession;
}

function requireValidCodexTokens(entry: CodexTokenEvent): void {
  const values = [entry.inputTokens, entry.cachedInputTokens, entry.outputTokens, entry.reasoningOutputTokens, entry.totalTokens];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Invalid Codex token counts");
  }
}

function sumFiniteCosts(costs: readonly (number | undefined)[]): number | undefined {
  const defined = costs.filter((cost): cost is number => cost !== undefined && Number.isFinite(cost));
  return defined.length > 0 ? defined.reduce((sum, cost) => sum + cost, 0) : undefined;
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
