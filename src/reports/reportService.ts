import { getClaudeProjectsDirs, getCodexConfigPaths, getCodexSessionsDirs, getDebugLogDir } from "../config/paths";
import type { Settings } from "../config/settings";
import { defaultSettings } from "../config/settings";
import { calculateCodexApiCostBreakdown, readCodexSpeedTierFromPaths } from "../pricing/codex-cost-calculator";
import { readCodexTokensForPeriod, type CodexTokenEvent } from "../pricing/codex-log-reader";
import { calculateCostBreakdown, sumBreakdown, ZERO_BREAKDOWN } from "../pricing/cost-calculator";
import { readClaudeUsageEntriesForPeriod, type ClaudeUsageEntry } from "../pricing/jsonl-reader";
import { LiteLLMFetcher } from "../pricing/litellm-fetcher";
import { HistoricalPricingResolver } from "../pricing/historical-pricing-resolver";
import { toClaudeEntries, toCodexEvents } from "../portable/eventAdapters";
import type { PortableUsageEvent } from "../portable/types";
import { PortableUsageStore } from "../portable/usageStore";
import { readBackfillDayRecords } from "./backfill-reader";
import type { BackfillDayRecord, BackfillPerModelEntry } from "./types";
import type { CostMode, ModelBreakdown, ReportRequest, ReportResult, ReportRow, ReportTotals } from "./types";

export type { CostMode, CodexSpeed, ModelBreakdown, ReportRequest, ReportResult, ReportRow, ReportTotals, ReportType } from "./types";

export interface ReportDeps {
  settings?: Settings;
  claudeProjectsDirs?: string[];
  codexSessionsDirs?: string[];
  codexConfigPaths?: string[];
  claudeEntries?: ClaudeUsageEntry[];
  codexEvents?: CodexTokenEvent[];
  backfillLogDir?: string;
  backfillRecords?: BackfillDayRecord[];
  pricingResolver?: HistoricalPricingResolver;
  usageEvents?: PortableUsageEvent[];
  usageStore?: PortableUsageStore;
  readClaudeEntries?: typeof readClaudeUsageEntriesForPeriod;
  readCodexEvents?: typeof readCodexTokensForPeriod;
}

const ZERO_TOTALS: ReportTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costUSD: 0,
};

export async function generateUsageReport(request: ReportRequest, deps: ReportDeps = {}): Promise<ReportResult> {
  const normalized = normalizeRequest(request);

  const useBackfill = normalized.source === "legacy"
    && (deps.backfillRecords !== undefined || deps.backfillLogDir !== undefined)
    && normalized.type !== "session"
    && !normalized.project
    && !normalized.instances;

  if (useBackfill) {
    const sinceDate = normalized.since ? new Date(`${normalized.since}T00:00:00.000Z`) : undefined;
    const records = deps.backfillRecords
      ?? await readBackfillDayRecords(deps.backfillLogDir ?? getDebugLogDir(), sinceDate);
    const sorted = buildRowsFromBackfill(records, normalized).sort(
      (a, b) => normalized.order === "asc" ? a.bucket.localeCompare(b.bucket) : b.bucket.localeCompare(a.bucket),
    );
    const rows = applyLimit(sorted, normalized.limit, normalized.order);
    return {
      request: normalized,
      rows,
      totals: sumRows(rows),
      generatedAt: new Date().toISOString(),
    };
  }

  const settings = deps.settings ?? defaultSettings;
  const fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
  const pricingResolver = deps.pricingResolver ?? new HistoricalPricingResolver(fetcher);
  const rows: ReportRow[] = [];
  const start = new Date("1970-01-01T00:00:00.000Z");
  const pathContext = {
    claudeRoots: settings.claudeRoots ?? [],
    codexHomes: settings.codexHomes ?? [],
  };

  const portableEvents = normalized.source === "portable"
    ? deps.usageEvents ?? await (deps.usageStore ?? new PortableUsageStore()).read(portableReadRange(normalized.since, normalized.until))
    : undefined;

  if (normalized.provider === "all" || normalized.provider === "claude") {
    const entries = portableEvents
      ? toClaudeEntries(portableEvents)
      : deps.claudeEntries ?? await (deps.readClaudeEntries ?? readClaudeUsageEntriesForPeriod)(
        deps.claudeProjectsDirs ?? getClaudeProjectsDirs(pathContext),
        start,
      );
    rows.push(...(await buildClaudeRows(entries, normalized, pricingResolver)));
  }

  if (normalized.provider === "all" || normalized.provider === "codex") {
    const events = portableEvents
      ? toCodexEvents(portableEvents)
      : deps.codexEvents ?? await (deps.readCodexEvents ?? readCodexTokensForPeriod)(
        deps.codexSessionsDirs ?? getCodexSessionsDirs(pathContext),
        start,
      );
    const speed = normalized.codexSpeed === "auto"
      ? await readCodexSpeedTierFromPaths(deps.codexConfigPaths ?? getCodexConfigPaths(pathContext))
      : normalized.codexSpeed;
    rows.push(...(await buildCodexRows(events, normalized, pricingResolver, speed)));
  }

  const sorted = rows
    .sort((a, b) => normalized.order === "asc" ? a.bucket.localeCompare(b.bucket) : b.bucket.localeCompare(a.bucket));
  const limited = applyLimit(sorted, normalized.limit, normalized.order);

  return {
    request: normalized,
    rows: limited,
    totals: sumRows(limited),
    generatedAt: new Date().toISOString(),
  };
}

async function buildClaudeRows(
  entries: ClaudeUsageEntry[],
  request: ReturnType<typeof normalizeRequest>,
  pricingResolver: HistoricalPricingResolver,
): Promise<ReportRow[]> {
  const filtered = request.project
    ? entries.filter((entry) => entry.project === request.project)
    : entries;
  const dated = filtered.filter((entry) => entryInDateRange(entry.timestamp, request.timezone, request.since, request.until));
  const buckets = new Map<string, ClaudeUsageEntry[]>();
  for (const entry of dated) {
    const bucket = request.type === "session"
      ? `${entry.project}/${entry.session}`
      : bucketFor(entry.timestamp, request.type, request.timezone);
    const key = request.instances && request.type !== "session"
      ? `${bucket}\0${entry.project}`
      : bucket;
    const list = buckets.get(key) ?? [];
    list.push(entry);
    buckets.set(key, list);
  }

  const rows: ReportRow[] = [];
  for (const [key, list] of buckets) {
    const [bucket, project] = key.split("\0");
    const costed = await costClaudeEntries(list, request.costMode, pricingResolver);
    const lastActivity = list.map((entry) => entry.timestamp).sort().at(-1);
    rows.push({
      bucket: request.type === "session" ? localDate(lastActivity ?? list[0].timestamp, request.timezone) : bucket,
      provider: "claude",
      ...(project ? { project } : request.type === "session" || request.project ? { project: list[0].project } : {}),
      ...(request.type === "session" ? { session: list[0].session } : {}),
      ...(lastActivity ? { lastActivity } : {}),
      ...costed.totals,
      models: costed.breakdowns.map((item) => item.model),
      ...(request.breakdown ? { modelBreakdowns: costed.breakdowns } : {}),
    });
  }
  return rows;
}

async function buildCodexRows(
  events: CodexTokenEvent[],
  request: ReturnType<typeof normalizeRequest>,
  pricingResolver: HistoricalPricingResolver,
  speed: "standard" | "fast",
): Promise<ReportRow[]> {
  const filtered = request.project
    ? events.filter((event) => event.directory.includes(request.project!) || event.session.includes(request.project!))
    : events;
  const dated = filtered.filter((event) => entryInDateRange(event.timestamp, request.timezone, request.since, request.until));
  const buckets = new Map<string, CodexTokenEvent[]>();
  for (const event of dated) {
    const bucket = request.type === "session"
      ? `${event.directory}/${event.session}`
      : bucketFor(event.timestamp, request.type, request.timezone);
    const key = request.instances && request.type !== "session"
      ? `${bucket}\0${event.directory}`
      : bucket;
    const list = buckets.get(key) ?? [];
    list.push(event);
    buckets.set(key, list);
  }

  const rows: ReportRow[] = [];
  for (const [key, list] of buckets) {
    const [bucket, directory] = key.split("\0");
    const breakdowns = await costCodexBreakdowns(list, pricingResolver, speed);
    const totals = sumBreakdowns(breakdowns);
    const lastActivity = list.map((entry) => entry.timestamp).sort().at(-1);
    rows.push({
      bucket: request.type === "session" ? localDate(lastActivity ?? list[0].timestamp, request.timezone) : bucket,
      provider: "codex",
      ...(directory ? { directory } : request.type === "session" ? { directory: list[0].directory } : {}),
      ...(request.type === "session" ? { session: list[0].session } : {}),
      ...(lastActivity ? { lastActivity } : {}),
      ...totals,
      models: breakdowns.map((item) => item.model),
      isFallback: list.some((entry) => entry.isFallback),
      ...(request.breakdown ? { modelBreakdowns: breakdowns } : {}),
    });
  }
  return rows;
}

function buildRowsFromBackfill(
  records: BackfillDayRecord[],
  request: ReturnType<typeof normalizeRequest>,
): ReportRow[] {
  const filtered = records.filter((r) => {
    if (request.provider !== "all" && r.provider !== request.provider) return false;
    if (request.since && r.date < request.since) return false;
    if (request.until && r.date > request.until) return false;
    return true;
  });

  const buckets = new Map<string, BackfillDayRecord[]>();
  for (const r of filtered) {
    const timestamp = `${r.date}T12:00:00.000Z`;
    const bucket = bucketFor(timestamp, request.type, request.timezone);
    const key = `${r.provider}\0${bucket}`;
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }

  const rows: ReportRow[] = [];
  for (const [key, list] of buckets) {
    const [provider, bucket] = key.split("\0") as ["claude" | "codex", string];
    const totals = list.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
        cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        costUSD: acc.costUSD + r.costUSD,
      }),
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 },
    );

    const modelSet = new Set<string>();
    const modelAgg = new Map<string, BackfillPerModelEntry>();
    for (const r of list) {
      r.models.forEach((m) => modelSet.add(m));
      for (const [model, pm] of Object.entries(r.perModel)) {
        const acc = modelAgg.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, costUSD: 0, inputCostUSD: 0, outputCostUSD: 0, cacheCreationCostUSD: 0, cacheReadCostUSD: 0 };
        modelAgg.set(model, {
          inputTokens: acc.inputTokens + pm.inputTokens,
          outputTokens: acc.outputTokens + pm.outputTokens,
          cacheCreationTokens: acc.cacheCreationTokens + pm.cacheCreationTokens,
          cacheReadTokens: acc.cacheReadTokens + pm.cacheReadTokens,
          reasoningOutputTokens: acc.reasoningOutputTokens + pm.reasoningOutputTokens,
          totalTokens: acc.totalTokens + pm.totalTokens,
          costUSD: acc.costUSD + pm.costUSD,
          inputCostUSD: (acc.inputCostUSD ?? 0) + (pm.inputCostUSD ?? 0),
          outputCostUSD: (acc.outputCostUSD ?? 0) + (pm.outputCostUSD ?? 0),
          cacheCreationCostUSD: (acc.cacheCreationCostUSD ?? 0) + (pm.cacheCreationCostUSD ?? 0),
          cacheReadCostUSD: (acc.cacheReadCostUSD ?? 0) + (pm.cacheReadCostUSD ?? 0),
        });
      }
    }

    const row: ReportRow = {
      bucket,
      provider,
      ...totals,
      models: Array.from(modelSet),
    };

    if (request.breakdown) {
      row.modelBreakdowns = Array.from(modelAgg.entries()).map(([model, pm]) => ({
        model,
        inputTokens: pm.inputTokens,
        outputTokens: pm.outputTokens,
        cacheCreationTokens: pm.cacheCreationTokens,
        cacheReadTokens: pm.cacheReadTokens,
        totalTokens: pm.totalTokens,
        costUSD: pm.costUSD,
        inputCostUSD: pm.inputCostUSD,
        outputCostUSD: pm.outputCostUSD,
        cacheCreationCostUSD: pm.cacheCreationCostUSD,
        cacheReadCostUSD: pm.cacheReadCostUSD,
      }));
    }

    rows.push(row);
  }
  return rows;
}

async function costClaudeEntries(entries: ClaudeUsageEntry[], mode: CostMode, pricingResolver: HistoricalPricingResolver): Promise<{ totals: ReportTotals; breakdowns: ModelBreakdown[] }> {
  const byModel = new Map<string, ClaudeUsageEntry[]>();
  for (const entry of entries) {
    const list = byModel.get(entry.model) ?? [];
    list.push(entry);
    byModel.set(entry.model, list);
  }

  const breakdowns: ModelBreakdown[] = await Promise.all([...byModel].map(async ([model, list]) => {
    const totals = list.reduce((acc, entry) => addEntryTotals(acc, entry), { ...ZERO_TOTALS });
    let costUSD = 0;
    let components = { ...ZERO_BREAKDOWN };
    for (const entry of list) {
      const sourceCost = entry.costUSD;
      const useSourceCost = mode !== "calculate" && sourceCost !== undefined;
      if (useSourceCost) {
        costUSD += sourceCost;
        // Source costs are authoritative and must not cause a pricing lookup or epoch write.
        components.outputCostUSD += sourceCost;
        continue;
      }
      if (mode === "display") continue;
      const pricing = await pricingResolver.getModelPricing(model, entry.timestamp);
      const entryComponents = pricing ? calculateCostBreakdown({
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        cache_creation_input_tokens: entry.cacheCreationTokens,
        cache_read_input_tokens: entry.cacheReadTokens,
      }, pricing) : ZERO_BREAKDOWN;
      costUSD += sumBreakdown(entryComponents);
      components = {
        inputCostUSD: components.inputCostUSD + entryComponents.inputCostUSD,
        outputCostUSD: components.outputCostUSD + entryComponents.outputCostUSD,
        cacheCreationCostUSD: components.cacheCreationCostUSD + entryComponents.cacheCreationCostUSD,
        cacheReadCostUSD: components.cacheReadCostUSD + entryComponents.cacheReadCostUSD,
      };
    }
    return { model, ...totals, costUSD, ...components };
  }));
  return { totals: sumBreakdowns(breakdowns), breakdowns };
}

async function costCodexBreakdowns(events: CodexTokenEvent[], pricingResolver: HistoricalPricingResolver, speed: "standard" | "fast"): Promise<ModelBreakdown[]> {
  const byModel = new Map<string, CodexTokenEvent[]>();
  for (const event of events) {
    const list = byModel.get(event.model) ?? [];
    list.push(event);
    byModel.set(event.model, list);
  }
  const breakdowns: ModelBreakdown[] = await Promise.all([...byModel].map(async ([model, list]) => {
    const totals = list.reduce((acc, event) => ({
      // INPUT shows uncached tokens only (input − cached), consistent with the
      // Claude reader and the live-tab path in subscription-factor.ts.
      inputTokens: acc.inputTokens + Math.max(0, event.inputTokens - event.cachedInputTokens),
      outputTokens: acc.outputTokens + event.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + event.cachedInputTokens,
      totalTokens: acc.totalTokens + event.totalTokens,
      costUSD: 0,
    }), { ...ZERO_TOTALS });
    const c = await calculateCodexApiCostBreakdown(list, pricingResolver, speed);
    return {
      model,
      ...totals,
      costUSD: sumBreakdown(c),
      ...c,
    };
  }));
  return breakdowns;
}

function normalizeRequest(request: ReportRequest) {
  return {
    provider: request.provider ?? "all",
    type: request.type ?? "daily",
    since: request.since,
    until: request.until,
    timezone: request.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    project: request.project?.trim() || undefined,
    instances: Boolean(request.instances),
    costMode: request.costMode ?? "auto",
    codexSpeed: request.codexSpeed ?? "auto",
    order: request.order ?? "desc",
    breakdown: Boolean(request.breakdown),
    source: request.source ?? "portable",
    limit: request.limit ? Math.max(1, Math.floor(Number(request.limit))) : undefined,
  } as const;
}

function portableReadRange(since?: string, until?: string): { since?: string; until?: string } {
  return {
    ...(since ? { since: shiftedUtcBoundary(since, -1, false) } : {}),
    ...(until ? { until: shiftedUtcBoundary(until, 1, true) } : {}),
  };
}

function shiftedUtcBoundary(day: string, days: number, endOfDay: boolean): string {
  const date = new Date(`${day}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function bucketFor(timestamp: string, type: string, timezone: string): string {
  const date = new Date(timestamp);
  if (type === "monthly") return localDate(timestamp, timezone).slice(0, 7);
  if (type === "weekly") return isoWeekBucket(date, timezone);
  if (type === "hourly") return localHour(timestamp, timezone);
  return localDate(timestamp, timezone);
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

function hourFormatterFor(timezone: string): Intl.DateTimeFormat {
  let fmt = hourFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    hourFormatters.set(timezone, fmt);
  }
  return fmt;
}

function localHour(timestamp: string, timezone: string): string {
  const parts = hourFormatterFor(timezone).formatToParts(new Date(timestamp));
  const y = parts.find(p => p.type === "year")?.value  ?? "0000";
  const m = parts.find(p => p.type === "month")?.value ?? "01";
  const d = parts.find(p => p.type === "day")?.value   ?? "01";
  const h = parts.find(p => p.type === "hour")?.value  ?? "00";
  return `${y}-${m}-${d} ${pad(Number(h))}:00`;
}

function localDate(timestamp: string, timezone: string): string {
  const parts = dateParts(new Date(timestamp), timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function isoWeekBucket(date: Date, timezone: string): string {
  const parts = dateParts(date, timezone);
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${pad(week)}`;
}

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

function dateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = dateFormatterFor(timezone).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function entryInDateRange(timestamp: string, timezone: string, since?: string, until?: string): boolean {
  const date = localDate(timestamp, timezone);
  if (since && date < since) return false;
  if (until && date > until) return false;
  return true;
}

function addEntryTotals(acc: ReportTotals, entry: ClaudeUsageEntry): ReportTotals {
  return {
    inputTokens: acc.inputTokens + entry.inputTokens,
    outputTokens: acc.outputTokens + entry.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + entry.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + entry.cacheReadTokens,
    totalTokens: acc.totalTokens + entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens,
    costUSD: acc.costUSD,
  };
}

function sumBreakdowns(breakdowns: ModelBreakdown[]): ReportTotals {
  return breakdowns.reduce((acc, item) => ({
    inputTokens: acc.inputTokens + item.inputTokens,
    outputTokens: acc.outputTokens + item.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + item.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
    totalTokens: acc.totalTokens + item.totalTokens,
    costUSD: acc.costUSD + item.costUSD,
  }), { ...ZERO_TOTALS });
}

function sumRows(rows: ReportRow[]): ReportTotals {
  return rows.reduce((acc, row) => ({
    inputTokens: acc.inputTokens + row.inputTokens,
    outputTokens: acc.outputTokens + row.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + row.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
    totalTokens: acc.totalTokens + row.totalTokens,
    costUSD: acc.costUSD + row.costUSD,
  }), { ...ZERO_TOTALS });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function applyLimit(rows: ReportRow[], limit: number | undefined, _order: "asc" | "desc"): ReportRow[] {
  if (!limit) return rows;
  // rows are already sorted; collect unique buckets and keep the most recent `limit` of them
  const uniqueBuckets = [...new Set(rows.map(r => r.bucket))].sort();
  const kept = new Set(uniqueBuckets.slice(-limit));
  return rows.filter(r => kept.has(r.bucket));
}
