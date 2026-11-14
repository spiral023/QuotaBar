import {
  PORTABLE_STORE_VERSION,
  type PortableLegacyTarget,
  type PortableUsageEvent
} from "./types";

export const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "reasoningOutputTokens",
] as const;

export const COST_FIELDS = [
  "costUSD",
  "inputCostUSD",
  "outputCostUSD",
  "cacheCreationCostUSD",
  "cacheReadCostUSD",
] as const;

export const LEGACY_TARGET_KEYS = [
  ...TOKEN_FIELDS,
  "costUSD",
  "inputCostUSD",
  "outputCostUSD",
  "cacheCreationCostUSD",
  "cacheReadCostUSD",
] as const;

export interface SanitizedResult {
  event?: PortableUsageEvent;
  problem?: string;
}

export function sanitizePortableEvent(value: unknown): SanitizedResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "expected an object" };
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== PORTABLE_STORE_VERSION) return { problem: "schemaVersion must be 1" };
  if (item.provider !== "claude" && item.provider !== "codex") return { problem: "provider is not supported" };
  if (!isNonEmptyString(item.id)) return { problem: "id must be a non-empty string" };
  if (!isIsoTimestamp(item.occurredAt)) return { problem: "occurredAt must be an ISO timestamp" };
  if (!isNonEmptyString(item.model)) return { problem: "model must be a non-empty string" };
  if (!isNonEmptyString(item.sessionKey)) return { problem: "sessionKey must be a non-empty string" };
  if (item.source !== "claude-log" && item.source !== "codex-log" && item.source !== "legacy-reconciliation") {
    return { problem: "source is not supported" };
  }
  if (typeof item.synthetic !== "boolean") return { problem: "synthetic must be a boolean" };
  for (const field of TOKEN_FIELDS) {
    if (!isNonNegativeFiniteNumber(item[field])) return { problem: `${field} must be finite and non-negative` };
  }
  for (const field of COST_FIELDS) {
    if (item[field] !== undefined && !isNonNegativeFiniteNumber(item[field])) {
      return { problem: `${field} must be finite and non-negative` };
    }
  }
  if (item.projectName !== undefined && typeof item.projectName !== "string") {
    return { problem: "projectName must be a string" };
  }
  if (item.pricingVersion !== undefined && !isNonEmptyString(item.pricingVersion)) {
    return { problem: "pricingVersion must be a non-empty string" };
  }
  let legacyTarget: PortableLegacyTarget | undefined;
  if (item.legacyTarget !== undefined) {
    if (item.source !== "legacy-reconciliation") {
      return { problem: "legacyTarget is allowed only for legacy reconciliation events" };
    }
    const sanitizedTarget = sanitizeLegacyTarget(item.legacyTarget);
    if (typeof sanitizedTarget === "string") return { problem: sanitizedTarget };
    legacyTarget = sanitizedTarget;
  }

  const event: PortableUsageEvent = {
    schemaVersion: PORTABLE_STORE_VERSION,
    id: item.id,
    provider: item.provider,
    occurredAt: item.occurredAt,
    model: item.model,
    sessionKey: item.sessionKey,
    source: item.source,
    synthetic: item.synthetic,
    inputTokens: item.inputTokens as number,
    outputTokens: item.outputTokens as number,
    cacheCreationTokens: item.cacheCreationTokens as number,
    cacheReadTokens: item.cacheReadTokens as number,
    reasoningOutputTokens: item.reasoningOutputTokens as number,
  };
  if (item.projectName !== undefined) event.projectName = item.projectName;
  for (const field of COST_FIELDS) {
    if (item[field] !== undefined) event[field] = item[field] as number;
  }
  if (item.pricingVersion !== undefined) event.pricingVersion = item.pricingVersion;
  if (legacyTarget !== undefined) event.legacyTarget = legacyTarget;
  return { event };
}

export function validatePortableEventForArchive(value: unknown): PortableUsageEvent {
  const event = requirePortableEvent(value);
  const raw = value as Record<string, unknown>;
  const optional = [
    "projectName", "costUSD", "inputCostUSD", "outputCostUSD",
    "cacheCreationCostUSD", "cacheReadCostUSD", "pricingVersion", "legacyTarget",
  ].filter((key) => raw[key] !== undefined);
  const required = [
    "schemaVersion", "id", "provider", "occurredAt", "model", "sessionKey", "source", "synthetic",
    "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "reasoningOutputTokens",
  ];
  if (!hasExactRecordKeys(raw, [...required, ...optional])
    || !/^[a-f0-9]{64}$/.test(event.id)
    || !/^[a-f0-9]{64}$/.test(event.sessionKey)
    || event.occurredAt !== new Date(event.occurredAt).toISOString()
    || (event.projectName !== undefined
      && (!event.projectName.trim() || /[\\/\0\r\n]/.test(event.projectName)))
    || (event.source === "legacy-reconciliation") !== event.synthetic) {
    throw new Error("Invalid portable usage event");
  }
  return event;
}

export function hasExactRecordKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return keys.length === canonical.length && keys.every((key, index) => key === canonical[index]);
}

export function sanitizeLegacyTarget(value: unknown): PortableLegacyTarget | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "legacyTarget must be an object";
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length !== LEGACY_TARGET_KEYS.length || keys.some((key) =>
    !(LEGACY_TARGET_KEYS as readonly string[]).includes(key))) {
    return "legacyTarget has invalid fields";
  }
  for (const field of TOKEN_FIELDS) {
    if (!isNonNegativeFiniteNumber(item[field])) {
      return "legacyTarget tokens must be finite and non-negative";
    }
  }
  for (const field of COST_FIELDS) {
    if (!isNonNegativeFiniteNumber(item[field])) {
      return "legacyTarget costs must be finite and non-negative";
    }
  }
  return {
    inputTokens: item.inputTokens as number,
    outputTokens: item.outputTokens as number,
    cacheCreationTokens: item.cacheCreationTokens as number,
    cacheReadTokens: item.cacheReadTokens as number,
    reasoningOutputTokens: item.reasoningOutputTokens as number,
    costUSD: item.costUSD as number,
    inputCostUSD: item.inputCostUSD as number,
    outputCostUSD: item.outputCostUSD as number,
    cacheCreationCostUSD: item.cacheCreationCostUSD as number,
    cacheReadCostUSD: item.cacheReadCostUSD as number,
  };
}

export function requirePortableEvent(value: unknown): PortableUsageEvent {
  const result = sanitizePortableEvent(value);
  if (!result.event) throw new Error(`Invalid portable usage event: ${result.problem}`);
  return result.event;
}

export function canonicalSerialize(event: PortableUsageEvent): string {
  return JSON.stringify(event);
}

export function clonePortableEvent(event: PortableUsageEvent): PortableUsageEvent {
  return {
    ...event,
    ...(event.legacyTarget ? { legacyTarget: { ...event.legacyTarget } } : {}),
  };
}

export function compareCanonicalEvents(left: PortableUsageEvent, right: PortableUsageEvent): number {
  return compareOccurredAt(left.occurredAt, right.occurredAt)
    || compareText(left.id, right.id)
    || compareText(canonicalSerialize(left), canonicalSerialize(right));
}

export function compareOccurredAt(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === right.length) return left < right ? -1 : 1;
  return Date.parse(left) - Date.parse(right);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function monthKeyOf(occurredAt: string): string {
  return occurredAt.endsWith("Z") ? occurredAt.slice(0, 7) : monthKey(new Date(occurredAt));
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
