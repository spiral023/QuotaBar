// Intl.DateTimeFormat construction costs ~100µs and dateParts runs at least
// twice per usage entry — memoize per timezone.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timezone, formatter);
  }
  return formatter;
}

function datePartsExact(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = dateFormatterFor(timezone).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

// formatToParts allocates a part array per call and runs several times per
// usage entry, which dominates report cost on a large history. A timezone's UTC
// offset is constant within an hour except across a transition, so the offset is
// cached per UTC hour and trusted only when both edges of that hour agree.
//
// The straddling-hour fallback below is defensive: a sweep of every IANA zone
// over 2024-2027 found no transition where an hour-boundary offset changes the
// local *day*, so no current zone reaches it (zones like Australia/Lord_Howe do
// straddle a UTC hour, but far from local midnight). It guards against future
// tzdata changes and pre-1900 LMT offsets, and is therefore not test-covered.
// Results are identical to datePartsExact.
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    offsetFormatters.set(timezone, formatter);
  }
  return formatter;
}

function offsetAt(milliseconds: number, timezone: string): number {
  const parts = offsetFormatterFor(timezone).formatToParts(new Date(milliseconds));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"))
    - Math.floor(milliseconds / 1000) * 1000;
}

const HOUR_MS = 3_600_000;

const offsetByHour = new Map<string, Map<number, number | null>>();

export function dateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const milliseconds = date.getTime();
  const hour = Math.floor(milliseconds / HOUR_MS);
  let cached = offsetByHour.get(timezone);
  if (!cached) {
    cached = new Map();
    offsetByHour.set(timezone, cached);
  }
  let offset = cached.get(hour);
  if (offset === undefined) {
    const start = hour * HOUR_MS;
    const atStart = offsetAt(start, timezone);
    offset = atStart === offsetAt(start + HOUR_MS - 1, timezone) ? atStart : null;
    cached.set(hour, offset);
  }
  if (offset === null) return datePartsExact(date, timezone);
  const local = new Date(milliseconds + offset);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

export function zonedDayKey(date: Date, timeZone: string): string {
  const { year, month, day } = dateParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
