import type { BackfillDayRecord, BackfillPerModelEntry } from "../reports/types";
import { normalizeModelName } from "../shared/modelNames";
import { eventId, sessionKey } from "./eventIdentity";
import {
  PORTABLE_STORE_VERSION,
  type PortableLegacyTarget,
  type PortableProvider,
  type PortableUsageEvent
} from "./types";

export const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "reasoningOutputTokens",
] as const;

export const COMPONENT_COST_FIELDS = [
  "inputCostUSD",
  "outputCostUSD",
  "cacheCreationCostUSD",
  "cacheReadCostUSD",
] as const;

export const LEGACY_RECONCILIATION_IDENTITY_NAMESPACE = "quotabar-legacy-reconciliation-event-v1";

export type TokenField = typeof TOKEN_FIELDS[number];

export type ComponentCostField = typeof COMPONENT_COST_FIELDS[number];

export interface Aggregate {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningOutputTokens: number;
  effectiveCostUSD: number;
  inputCostUSD: number;
  outputCostUSD: number;
  cacheCreationCostUSD: number;
  cacheReadCostUSD: number;
}

export interface LegacyTarget extends Aggregate {
  authoritativeTotalCost: boolean;
  presentCostComponents: Set<ComponentCostField>;
}

export function compareReconciliationItems(
  left: { date: string; provider: PortableProvider; model: string },
  right: { date: string; provider: PortableProvider; model: string },
): number {
  return compareText(
    aggregateKey(left.date, left.provider, left.model),
    aggregateKey(right.date, right.provider, right.model),
  );
}

export function canonicalizeLegacyRecords(
  records: readonly BackfillDayRecord[],
): Map<string, { date: string; provider: PortableProvider; model: string; target: LegacyTarget }> {
  if (!Array.isArray(records)) throw new Error("invalid records");
  const providerDays = new Set<string>();
  const result = new Map<string, { date: string; provider: PortableProvider; model: string; target: LegacyTarget }>();
  for (const record of records) {
    validateRecord(record);
    const providerDay = JSON.stringify([record.date, record.provider]);
    if (providerDays.has(providerDay)) throw new Error("duplicate provider day");
    providerDays.add(providerDay);
    for (const model of Object.keys(record.perModel).sort(compareText)) {
      const entry = record.perModel[model];
      const normalizedModel = normalizeModelName(model);
      const key = aggregateKey(record.date, record.provider, normalizedModel);
      const existing = result.get(key);
      if (existing) {
        existing.target = mergeLegacyTargets(existing.target, legacyTarget(entry));
      } else {
        result.set(key, {
          date: record.date,
          provider: record.provider,
          model: normalizedModel,
          target: legacyTarget(entry),
        });
      }
    }
  }
  return new Map([...result].sort(([left], [right]) => compareText(left, right)));
}

export function validateRecord(value: unknown): asserts value is BackfillDayRecord {
  if (!isPlainObject(value)) throw new Error("invalid record");
  const record = value as unknown as BackfillDayRecord;
  if (!isUtcDate(record.date) || (record.provider !== "claude" && record.provider !== "codex")) {
    throw new Error("invalid record identity");
  }
  for (const field of [
    "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens", "sessionCount",
  ] as const) {
    if (!isNonNegativeSafeInteger(record[field])) throw new Error("invalid record totals");
  }
  if (!isNonNegativeFinite(record.costUSD)
    || !Array.isArray(record.models)
    || record.models.some((model) => !isCanonicalName(model))
    || !isPlainObject(record.perModel)) throw new Error("invalid record fields");
  for (const [model, entry] of Object.entries(record.perModel)) {
    if (!isCanonicalName(model) || !isPlainObject(entry)) throw new Error("invalid model entry");
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ] as const) {
      if (!isNonNegativeSafeInteger(entry[field])) throw new Error("invalid model tokens");
    }
    if (!isNonNegativeFinite(entry.costUSD)) throw new Error("invalid model cost");
    for (const field of COMPONENT_COST_FIELDS) {
      if (entry[field] !== undefined && !isNonNegativeFinite(entry[field])) throw new Error("invalid component cost");
    }
  }
}

export function legacyTarget(entry: BackfillPerModelEntry): LegacyTarget {
  const presentCostComponents = new Set<ComponentCostField>();
  const target: LegacyTarget = {
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    cacheReadTokens: entry.cacheReadTokens,
    reasoningOutputTokens: entry.reasoningOutputTokens,
    effectiveCostUSD: 0,
    inputCostUSD: 0,
    outputCostUSD: 0,
    cacheCreationCostUSD: 0,
    cacheReadCostUSD: 0,
    authoritativeTotalCost: false,
    presentCostComponents,
  };
  for (const field of COMPONENT_COST_FIELDS) {
    if (entry[field] !== undefined) {
      presentCostComponents.add(field);
      target[field] = entry[field] as number;
    }
  }
  const componentTotal = sumComponents(target);
  // Historical Backfill records use zero when totalCostUSD was absent. Positive totals remain authoritative;
  // otherwise component costs provide the only meaningful effective total.
  target.authoritativeTotalCost = entry.costUSD > 0 || componentTotal === 0;
  target.effectiveCostUSD = target.authoritativeTotalCost ? entry.costUSD : componentTotal;
  return target;
}

export function mergeLegacyTargets(left: LegacyTarget, right: LegacyTarget): LegacyTarget {
  const merged: LegacyTarget = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    effectiveCostUSD: left.effectiveCostUSD + right.effectiveCostUSD,
    inputCostUSD: left.inputCostUSD + right.inputCostUSD,
    outputCostUSD: left.outputCostUSD + right.outputCostUSD,
    cacheCreationCostUSD: left.cacheCreationCostUSD + right.cacheCreationCostUSD,
    cacheReadCostUSD: left.cacheReadCostUSD + right.cacheReadCostUSD,
    authoritativeTotalCost: left.authoritativeTotalCost || right.authoritativeTotalCost,
    presentCostComponents: new Set([...left.presentCostComponents, ...right.presentCostComponents]),
  };
  return merged;
}

export function aggregateProviderEvents(events: readonly PortableUsageEvent[]): Map<string, Aggregate> {
  const result = new Map<string, Aggregate>();
  for (const event of events) {
    const date = utcDay(event.occurredAt);
    validateBaselineEventNumbers(event);
    if (event.source === "legacy-reconciliation") continue;
    const normalizedModel = normalizeModelName(event.model);
    const key = aggregateKey(date, event.provider, normalizedModel);
    const aggregate = result.get(key) ?? zeroAggregate();
    for (const field of TOKEN_FIELDS) aggregate[field] += event[field];
    for (const field of COMPONENT_COST_FIELDS) aggregate[field] += event[field] ?? 0;
    aggregate.effectiveCostUSD += event.costUSD ?? sumEventComponents(event);
    result.set(key, aggregate);
  }
  return result;
}

export function reconciliationEvent(
  item: { date: string; provider: PortableProvider; model: string; target: LegacyTarget },
  current = zeroAggregate(),
): PortableUsageEvent {
  const tokenDeltas: Record<TokenField, number> = {
    inputTokens: positiveIntegerDelta(item.target.inputTokens, current.inputTokens),
    outputTokens: positiveIntegerDelta(item.target.outputTokens, current.outputTokens),
    cacheCreationTokens: positiveIntegerDelta(item.target.cacheCreationTokens, current.cacheCreationTokens),
    cacheReadTokens: positiveIntegerDelta(item.target.cacheReadTokens, current.cacheReadTokens),
    reasoningOutputTokens: positiveIntegerDelta(
      item.target.reasoningOutputTokens,
      current.reasoningOutputTokens,
    ),
  };
  const componentDeltas = {} as Record<ComponentCostField, number>;
  for (const field of COMPONENT_COST_FIELDS) {
    componentDeltas[field] = positiveDecimalDelta(item.target[field], current[field]);
  }
  const totalCostDelta = positiveDecimalDelta(item.target.effectiveCostUSD, current.effectiveCostUSD);
  const identity = reconciliationIdentity(item);
  const occurredAt = identity.occurredAt;
  const event: PortableUsageEvent = {
    schemaVersion: PORTABLE_STORE_VERSION,
    id: identity.id,
    provider: item.provider,
    occurredAt,
    model: item.model,
    projectName: "Imported legacy data",
    sessionKey: identity.sessionKey,
    source: "legacy-reconciliation",
    synthetic: true,
    ...tokenDeltas,
    costUSD: totalCostDelta,
    inputCostUSD: componentDeltas.inputCostUSD,
    outputCostUSD: componentDeltas.outputCostUSD,
    cacheCreationCostUSD: componentDeltas.cacheCreationCostUSD,
    cacheReadCostUSD: componentDeltas.cacheReadCostUSD,
    legacyTarget: portableLegacyTarget(item.target),
  };
  return event;
}

export function reconciliationIdentity(item: { date: string; provider: PortableProvider; model: string }): {
  id: string;
  occurredAt: string;
  sessionKey: string;
} {
  const session = JSON.stringify([
    LEGACY_RECONCILIATION_IDENTITY_NAMESPACE,
    item.date,
    item.provider,
    item.model,
  ]);
  const occurredAt = `${item.date}T12:00:00.000Z`;
  return {
    id: eventId({
      domain: "legacy-reconciliation-v1",
      provider: item.provider,
      occurredAt,
      model: item.model,
      session,
      ordinal: 0,
    }),
    occurredAt,
    sessionKey: sessionKey(item.provider, session),
  };
}

export function portableLegacyTarget(target: LegacyTarget): PortableLegacyTarget {
  return {
    inputTokens: target.inputTokens,
    outputTokens: target.outputTokens,
    cacheCreationTokens: target.cacheCreationTokens,
    cacheReadTokens: target.cacheReadTokens,
    reasoningOutputTokens: target.reasoningOutputTokens,
    costUSD: target.effectiveCostUSD,
    inputCostUSD: target.inputCostUSD,
    outputCostUSD: target.outputCostUSD,
    cacheCreationCostUSD: target.cacheCreationCostUSD,
    cacheReadCostUSD: target.cacheReadCostUSD,
  };
}

export function legacyTargetFromPortable(target: PortableLegacyTarget): LegacyTarget {
  return {
    inputTokens: target.inputTokens,
    outputTokens: target.outputTokens,
    cacheCreationTokens: target.cacheCreationTokens,
    cacheReadTokens: target.cacheReadTokens,
    reasoningOutputTokens: target.reasoningOutputTokens,
    effectiveCostUSD: target.costUSD,
    inputCostUSD: target.inputCostUSD,
    outputCostUSD: target.outputCostUSD,
    cacheCreationCostUSD: target.cacheCreationCostUSD,
    cacheReadCostUSD: target.cacheReadCostUSD,
    authoritativeTotalCost: true,
    presentCostComponents: new Set(COMPONENT_COST_FIELDS),
  };
}

export function seedHistoricalTarget(
  provider: Aggregate,
  existing: PortableUsageEvent,
  incoming: LegacyTarget,
): LegacyTarget {
  const seeded: LegacyTarget = {
    inputTokens: provider.inputTokens + existing.inputTokens,
    outputTokens: provider.outputTokens + existing.outputTokens,
    cacheCreationTokens: provider.cacheCreationTokens + existing.cacheCreationTokens,
    cacheReadTokens: provider.cacheReadTokens + existing.cacheReadTokens,
    reasoningOutputTokens: provider.reasoningOutputTokens + existing.reasoningOutputTokens,
    effectiveCostUSD: provider.effectiveCostUSD + (existing.costUSD ?? sumEventComponents(existing)),
    inputCostUSD: provider.inputCostUSD + (existing.inputCostUSD ?? 0),
    outputCostUSD: provider.outputCostUSD + (existing.outputCostUSD ?? 0),
    cacheCreationCostUSD: provider.cacheCreationCostUSD + (existing.cacheCreationCostUSD ?? 0),
    cacheReadCostUSD: provider.cacheReadCostUSD + (existing.cacheReadCostUSD ?? 0),
    authoritativeTotalCost: true,
    presentCostComponents: new Set([
      ...incoming.presentCostComponents,
      ...COMPONENT_COST_FIELDS.filter((field) => existing[field] !== undefined),
    ]),
  };
  return seeded;
}

export function maximumLegacyTarget(left: LegacyTarget, right: LegacyTarget): LegacyTarget {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cacheCreationTokens: Math.max(left.cacheCreationTokens, right.cacheCreationTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    reasoningOutputTokens: Math.max(left.reasoningOutputTokens, right.reasoningOutputTokens),
    effectiveCostUSD: Math.max(left.effectiveCostUSD, right.effectiveCostUSD),
    inputCostUSD: Math.max(left.inputCostUSD, right.inputCostUSD),
    outputCostUSD: Math.max(left.outputCostUSD, right.outputCostUSD),
    cacheCreationCostUSD: Math.max(left.cacheCreationCostUSD, right.cacheCreationCostUSD),
    cacheReadCostUSD: Math.max(left.cacheReadCostUSD, right.cacheReadCostUSD),
    authoritativeTotalCost: left.authoritativeTotalCost || right.authoritativeTotalCost,
    presentCostComponents: new Set([...left.presentCostComponents, ...right.presentCostComponents]),
  };
}

export function zeroAggregate(): Aggregate {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningOutputTokens: 0,
    effectiveCostUSD: 0,
    inputCostUSD: 0,
    outputCostUSD: 0,
    cacheCreationCostUSD: 0,
    cacheReadCostUSD: 0,
  };
}

export function aggregateKey(date: string, provider: PortableProvider, model: string): string {
  return JSON.stringify([date, provider, model]);
}

export function sumEventComponents(event: PortableUsageEvent): number {
  return COMPONENT_COST_FIELDS.reduce((sum, field) => sum + (event[field] ?? 0), 0);
}

export function validateBaselineEventNumbers(event: PortableUsageEvent): void {
  for (const field of TOKEN_FIELDS) {
    if (!isNonNegativeFinite(event[field])) throw new Error("invalid stored token value");
  }
  if (event.costUSD !== undefined && !isNonNegativeFinite(event.costUSD)) {
    throw new Error("invalid stored total cost");
  }
  for (const field of COMPONENT_COST_FIELDS) {
    if (event[field] !== undefined && !isNonNegativeFinite(event[field])) {
      throw new Error("invalid stored component cost");
    }
  }
}

export function utcDay(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid stored timestamp");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error("invalid stored timestamp");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (month < 1 || month > 12 || day < 1 || day > daysForMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    throw new Error("invalid stored timestamp");
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("invalid stored timestamp");
  return instant.toISOString().slice(0, 10);
}

export function daysForMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function sumComponents(value: Pick<Aggregate, ComponentCostField> | Record<ComponentCostField, number>): number {
  return COMPONENT_COST_FIELDS.reduce((sum, field) => sum + value[field], 0);
}

export function positiveIntegerDelta(target: number, current: number): number {
  return Math.max(target - current, 0);
}

export function positiveDecimalDelta(target: number, current: number): number {
  const delta = Math.max(target - current, 0);
  return delta === 0 ? 0 : Number(delta.toPrecision(15));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isCanonicalName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
