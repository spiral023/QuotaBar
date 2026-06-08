import { getClaudeProjectsDirs, getCodexConfigPaths, getCodexSessionsDirs, getDebugLogDir } from "../config/paths";
import type { Settings } from "../config/settings";
import { defaultSettings } from "../config/settings";
import { calculateCodexApiCost, readCodexSpeedTierFromPaths } from "../pricing/codex-cost-calculator";
import { readCodexTokensForPeriod, type CodexTokenEvent } from "../pricing/codex-log-reader";
import { calculateCostFromTokens } from "../pricing/cost-calculator";
import { readClaudeUsageEntriesForPeriod, type ClaudeUsageEntry } from "../pricing/jsonl-reader";
import { LiteLLMFetcher } from "../pricing/litellm-fetcher";
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

  const useBackfill = normalized.source === "backfill"
    && normalized.type !== "session"
    && !normalized.project
    && !normalized.instances;

  if (useBackfill) {
    const sinceDate = normalized.since ? new Date(`${normalized.since}T00:00:00.000Z`) : undefined;
    const records = deps.backfillRecords
      ?? await readBackfillDayRecords(deps.backfillLogDir ?? getDebugLogDir(), sinceDate);
    const rows = buildRowsFromBackfill(records, normalized).sort(
      (a, b) => normalized.order === "asc" ? a.bucket.localeCompare(b.bucket) : b.bucket.localeCompare(a.bucket),
    );
    return {
      request: normalized,
      rows,
      totals: sumRows(rows),
      generatedAt: new Date().toISOString(),
    };
  }

  const settings = deps.settings ?? defaultSettings;
  const fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
  const rows: ReportRow[] = [];
  const start = new Date("1970-01-01T00:00:00.000Z");

  if (normalized.provider === "all" || normalized.provider === "claude") {
    const entries = deps.claudeEntries ?? await readClaudeUsageEntriesForPeriod(deps.claudeProjectsDirs ?? getClaudeProjectsDirs(), start);
    rows.push(...(await buildClaudeRows(entries, normalized, fetcher)));
  }

  if (normalized.provider === "all" || normalized.provider === "codex") {
    const events = deps.codexEvents ?? await readCodexTokensForPeriod(deps.codexSessionsDirs ?? getCodexSessionsDirs(), start);
    const speed = normalized.codexSpeed === "auto"
      ? await readCodexSpeedTierFromPaths(deps.codexConfigPaths ?? getCodexConfigPaths())
      : normalized.codexSpeed;
    rows.push(...(await buildCodexRows(events, normalized, fetcher, speed)));
  }

  const filtered = rows
    .sort((a, b) => normalized.order === "asc" ? a.bucket.localeCompare(b.bucket) : b.bucket.localeCompare(a.bucket));

  return {
    request: normalized,
    rows: filtered,
    totals: sumRows(filtered),
    generatedAt: new Date().toISOString(),
  };
}

async function buildClaudeRows(
  entries: ClaudeUsageEntry[],
  request: ReturnType<typeof normalizeRequest>,
  fetcher: LiteLLMFetcher,
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
    const costed = await costClaudeEntries(list, request.costMode, fetcher);
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
  fetcher: LiteLLMFetcher,
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
    const breakdowns = await costCodexBreakdowns(list, fetcher, speed);
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
        const acc = modelAgg.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 };
        modelAgg.set(model, {
          inputTokens: acc.inputTokens + pm.inputTokens,
          outputTokens: acc.outputTokens + pm.outputTokens,
          cacheCreationTokens: acc.cacheCreationTokens + pm.cacheCreationTokens,
          cacheReadTokens: acc.cacheReadTokens + pm.cacheReadTokens,
          totalTokens: acc.totalTokens + pm.totalTokens,
          costUSD: acc.costUSD + pm.costUSD,
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
      }));
    }

    rows.push(row);
  }
  return rows;
}

async function costClaudeEntries(entries: ClaudeUsageEntry[], mode: CostMode, fetcher: LiteLLMFetcher): Promise<{ totals: ReportTotals; breakdowns: ModelBreakdown[] }> {
  const byModel = new Map<string, ClaudeUsageEntry[]>();
  for (const entry of entries) {
    byModel.set(entry.model, [...(byModel.get(entry.model) ?? []), entry]);
  }

  const breakdowns: ModelBreakdown[] = [];
  for (const [model, list] of byModel) {
    const totals = list.reduce((acc, entry) => addEntryTotals(acc, entry), { ...ZERO_TOTALS });
    let costUSD = 0;
    if (mode !== "calculate") {
      costUSD += list.reduce((sum, entry) => sum + (entry.costUSD ?? 0), 0);
    }
    if (mode !== "display") {
      const missing = mode === "calculate" ? list : list.filter((entry) => entry.costUSD === undefined);
      const tokens = missing.reduce((acc, entry) => addEntryTotals(acc, entry), { ...ZERO_TOTALS });
      const pricing = await fetcher.getModelPricing(model);
      if (pricing) {
        costUSD += calculateCostFromTokens({
          input_tokens: tokens.inputTokens,
          output_tokens: tokens.outputTokens,
          cache_creation_input_tokens: tokens.cacheCreationTokens,
          cache_read_input_tokens: tokens.cacheReadTokens,
        }, pricing);
      }
    }
    breakdowns.push({ model, ...totals, costUSD });
  }
  return { totals: sumBreakdowns(breakdowns), breakdowns };
}

async function costCodexBreakdowns(events: CodexTokenEvent[], fetcher: LiteLLMFetcher, speed: "standard" | "fast"): Promise<ModelBreakdown[]> {
  const byModel = new Map<string, CodexTokenEvent[]>();
  for (const event of events) {
    byModel.set(event.model, [...(byModel.get(event.model) ?? []), event]);
  }
  const breakdowns: ModelBreakdown[] = [];
  for (const [model, list] of byModel) {
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
    breakdowns.push({
      model,
      ...totals,
      costUSD: await calculateCodexApiCost(list, fetcher, speed),
    });
  }
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
    source: request.source ?? "live",
  } as const;
}

function bucketFor(timestamp: string, type: string, timezone: string): string {
  const date = new Date(timestamp);
  if (type === "monthly") return localDate(timestamp, timezone).slice(0, 7);
  if (type === "weekly") return isoWeekBucket(date, timezone);
  return localDate(timestamp, timezone);
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

function dateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
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
