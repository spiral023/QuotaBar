import { getClaudeProjectsDirs, getCodexConfigPaths, getCodexSessionsDirs } from "../config/paths";
import type { CostWindow, Settings } from "../config/settings";
import type { CostFactorResult, UsageSnapshot } from "../providers/types";
import { calculateCodexApiCost, findUnpricedCodexModels, readCodexSpeedTierFromPaths } from "./codex-cost-calculator";
import { readCodexTokensForPeriod } from "./codex-log-reader";
import { calculateCostFromTokens } from "./cost-calculator";
import { sharedFxFetcher } from "./fx-fetcher";
import { aggregateClaudeEntries, readClaudeUsageEntriesForPeriod } from "./jsonl-reader";
import { LiteLLMFetcher } from "./litellm-fetcher";
import { HistoricalPricingResolver } from "./historical-pricing-resolver";
import { periodSubCostUSD } from "./plan-cost";

export class PricingEngine {
  private readonly fetcher: LiteLLMFetcher;
  private readonly pricingResolver: HistoricalPricingResolver;

  constructor(
    private readonly settings: Settings,
    private readonly claudeProjectsDir?: string | string[],
    private readonly codexSessionsDir?: string | string[],
    private readonly codexConfigPath?: string | string[],
    // Optional: liefert in der Produktion immer die aktuellen Disk-Settings (z. B. nach
    // Laufzeit-Änderung des costWindow). Ohne Provider — etwa in Tests — verwendet die
    // Engine die im Konstruktor injizierten Settings, bleibt also eine reine Funktion
    // ihrer Eingaben.
    private readonly settingsProvider?: () => Promise<Settings>,
    options?: { pricingResolver?: HistoricalPricingResolver },
  ) {
    this.fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
    this.pricingResolver = options?.pricingResolver ?? new HistoricalPricingResolver(this.fetcher);
  }

  private async resolveSettings(): Promise<Settings> {
    return this.settingsProvider ? await this.settingsProvider() : this.settings;
  }

  async calculateFactor(snapshot: UsageSnapshot): Promise<CostFactorResult | undefined> {
    if (snapshot.status === "error" || snapshot.status === "not_authenticated") return undefined;
    try {
      switch (snapshot.provider) {
        case "claude": return await this.calculateClaudeFactor(snapshot);
        case "codex": return await this.calculateCodexFactor(snapshot);
        default: return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private async calculateClaudeFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const currentSettings = await this.resolveSettings();
    const { billingStart, windowLabel, windowDays, calculationMode } = resolveBillingStart(currentSettings.costWindow, snapshot, "claude");
    const entries = await readClaudeUsageEntriesForPeriod(
      this.claudeProjectsDir ?? getClaudeProjectsDirs({ claudeRoots: currentSettings.claudeRoots ?? [] }),
      billingStart,
    );
    const tokens = aggregateClaudeEntries(entries);

    let apiCostUSD = 0;
    const missingPricingModels = new Set<string>();
    // Ein Durchlauf trennt Einträge mit vorberechneten Kosten von solchen ohne
    // und summiert die bekannten Kosten — ersetzt den separaten filter+reduce.
    const entriesWithoutCost: typeof entries = [];
    for (const entry of entries) {
      if (entry.costUSD === undefined) entriesWithoutCost.push(entry);
      else apiCostUSD += entry.costUSD ?? 0;
    }
    const entriesWithoutModel = [] as typeof entries;
    for (const entry of entriesWithoutCost) {
      if (!entry.model) {
        entriesWithoutModel.push(entry);
        continue;
      }
      const pricing = await this.pricingResolver.getModelPricing(entry.model, entry.timestamp);
      if (!pricing) { missingPricingModels.add(entry.model); continue; }
      apiCostUSD += calculateCostFromTokens(
        {
          input_tokens: entry.inputTokens,
          output_tokens: entry.outputTokens,
          cache_creation_input_tokens: entry.cacheCreationTokens,
          cache_read_input_tokens: entry.cacheReadTokens,
        },
        pricing,
      );
    }
    if (entriesWithoutModel.length > 0) {
      const fallbackTokens = aggregateClaudeEntries(entriesWithoutModel);
      const fallbackModel = snapshot.model ?? "claude-sonnet-4-5";
      const fallbackTimestamp = entriesWithoutModel.map((entry) => entry.timestamp).sort()[0];
      const pricing = await this.pricingResolver.getModelPricing(fallbackModel, fallbackTimestamp);
      if (pricing) {
        apiCostUSD += calculateCostFromTokens(
          {
            input_tokens: fallbackTokens.inputTokens,
            output_tokens: fallbackTokens.outputTokens,
            cache_creation_input_tokens: fallbackTokens.cacheCreationTokens,
            cache_read_input_tokens: fallbackTokens.cacheReadTokens,
          },
          pricing,
        );
      } else {
        missingPricingModels.add(fallbackModel);
      }
    }

    const effectiveDays = windowDays > 0
      ? windowDays
      : computeActualDaysFromEntries(entries.map(e => e.timestamp));
    const sinceDay = localDayKey(billingStart.getTime() > 0 ? billingStart.getTime()
      : (entries.length ? Math.min(...entries.map(e => new Date(e.timestamp).getTime())) : Date.now()));
    const untilDay = localDayKey(Date.now());
    const needsFx = currentSettings.plans.some(p => p.provider === "claude" && p.currency === "EUR");
    if (needsFx) await sharedFxFetcher.ensureRange(sinceDay, untilDay);
    const fx = sharedFxFetcher.lookup();
    const periodSubCost = periodSubCostUSD(currentSettings.plans, "claude", sinceDay, untilDay, fx);
    const subscriptionCostUSD = periodSubCost;
    const factor = periodSubCost > 0 ? apiCostUSD / periodSubCost : null;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: false,
      windowLabel,
      windowDays: effectiveDays,
      calculationMode,
      label: formatLabel(apiCostUSD, factor, false),
      missingPricingModels: missingPricingModels.size > 0 ? [...missingPricingModels] : undefined,
      tokenUsage: {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        totalTokens: tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens,
        models: tokens.modelNames,
      },
    };
  }

  private async calculateCodexFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const currentSettings = await this.resolveSettings();
    const { billingStart, windowLabel, windowDays, calculationMode } = resolveBillingStart(currentSettings.costWindow, snapshot, "codex");
    const events = await readCodexTokensForPeriod(
      this.codexSessionsDir ?? getCodexSessionsDirs({ codexHomes: currentSettings.codexHomes ?? [] }),
      billingStart,
    );
    if (events.length === 0) {
      return {
        apiCostUSD: 0,
        subscriptionCostUSD: 0,
        factor: null,
        isEstimate: true,
        windowLabel,
        windowDays,
        calculationMode,
        label: "Keine Logs verfügbar",
      };
    }
    const configPaths = this.codexConfigPath ?? getCodexConfigPaths({ codexHomes: currentSettings.codexHomes ?? [] });
    const speedTier = await readCodexSpeedTierFromPaths(Array.isArray(configPaths) ? configPaths : [configPaths]);
    const apiCostUSD = await calculateCodexApiCost(events, this.pricingResolver, speedTier);
    const missingPricingModels = await findUnpricedCodexModels(events, this.pricingResolver);
    const effectiveDays = windowDays > 0
      ? windowDays
      : computeActualDaysFromEntries(events.map(e => e.timestamp));
    const sinceDay = localDayKey(billingStart.getTime() > 0 ? billingStart.getTime()
      : (events.length ? Math.min(...events.map(e => new Date(e.timestamp).getTime())) : Date.now()));
    const untilDay = localDayKey(Date.now());
    const needsFx = currentSettings.plans.some(p => p.provider === "codex" && p.currency === "EUR");
    if (needsFx) await sharedFxFetcher.ensureRange(sinceDay, untilDay);
    const fx = sharedFxFetcher.lookup();
    const periodSubCost = periodSubCostUSD(currentSettings.plans, "codex", sinceDay, untilDay, fx);
    const subscriptionCostUSD = periodSubCost;
    const factor = periodSubCost > 0 ? apiCostUSD / periodSubCost : null;

    let inputTokens = 0, cacheReadTokens = 0, outputTokens = 0, totalTokens = 0;
    const modelSet = new Set<string>();
    for (const e of events) {
      inputTokens += e.inputTokens;
      cacheReadTokens += e.cachedInputTokens;
      outputTokens += e.outputTokens;
      totalTokens += e.totalTokens;
      if (e.model) modelSet.add(e.model);
    }

    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: false,
      windowLabel,
      windowDays: effectiveDays,
      calculationMode,
      label: formatLabel(apiCostUSD, factor, false),
      missingPricingModels: missingPricingModels.length > 0 ? missingPricingModels : undefined,
      tokenUsage: {
        inputTokens: Math.max(0, inputTokens - cacheReadTokens), // uncached only, consistent with Claude
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens,
        totalTokens,
        models: Array.from(modelSet),
      },
    };
  }

}

function resolveBillingStart(
  costWindow: CostWindow,
  _snapshot: UsageSnapshot,
  _provider: "claude" | "codex",
): { billingStart: Date; windowLabel: string; windowDays: number; calculationMode: "fixed" | "actual-span" } {
  if (costWindow === "7d") {
    return { billingStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), windowLabel: "7d", windowDays: 7, calculationMode: "fixed" };
  }
  if (costWindow === "30d") {
    return { billingStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), windowLabel: "30d", windowDays: 30, calculationMode: "fixed" };
  }
  // "all" — epoch start; windowDays will be computed after data is fetched
  return { billingStart: new Date(0), windowLabel: "all", windowDays: 0, calculationMode: "actual-span" };
}

function computeActualDaysFromEntries(timestamps: string[]): number {
  if (timestamps.length === 0) return 30;
  const ms = timestamps.map(t => new Date(t).getTime()).filter(n => !isNaN(n));
  if (ms.length === 0) return 30;
  const spanDays = Math.ceil((Date.now() - Math.min(...ms)) / (24 * 3600 * 1000));
  return Math.max(1, spanDays);
}

function formatLabel(apiCostUSD: number, factor: number | null, isEstimate: boolean): string {
  if (factor === null) return "No plan configured";
  if (apiCostUSD === 0 && !isEstimate) return "$0.00 (no data)";
  const prefix = isEstimate ? "~" : "";
  return `${prefix}${factor.toFixed(1)}× plan`;
}

function localDayKey(ms: number): string {
  const d = new Date(ms); const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
