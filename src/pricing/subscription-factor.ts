import { getClaudeProjectsDirs, getCodexConfigPaths, getCodexSessionsDirs } from "../config/paths";
import type { CostWindow, Settings } from "../config/settings";
import type { CostFactorResult, UsageSnapshot, UsageWindow } from "../providers/types";
import { calculateCodexApiCost, readCodexSpeedTierFromPaths } from "./codex-cost-calculator";
import { readCodexTokensForPeriod } from "./codex-log-reader";
import { calculateCostFromTokens } from "./cost-calculator";
import { aggregateClaudeEntries, readClaudeUsageEntriesForPeriod } from "./jsonl-reader";
import { LiteLLMFetcher } from "./litellm-fetcher";

export class PricingEngine {
  private readonly fetcher: LiteLLMFetcher;

  constructor(
    private readonly settings: Settings,
    private readonly claudeProjectsDir: string | string[] = getClaudeProjectsDirs(),
    private readonly codexSessionsDir: string | string[] = getCodexSessionsDirs(),
    private readonly codexConfigPath: string | string[] = getCodexConfigPaths(),
  ) {
    this.fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
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
    const { billingStart, windowLabel, windowDays, calculationMode } = resolveBillingStart(this.settings.costWindow, snapshot, "claude");
    const entries = await readClaudeUsageEntriesForPeriod(this.claudeProjectsDir, billingStart);
    const tokens = aggregateClaudeEntries(entries);

    let apiCostUSD = 0;
    const entriesWithoutCost = entries.filter((entry) => entry.costUSD === undefined);
    apiCostUSD += entries.reduce((sum, entry) => sum + (entry.costUSD ?? 0), 0);
    const tokensToCalculate = aggregateClaudeEntries(entriesWithoutCost);
    for (const [modelName, modelTokens] of Object.entries(tokensToCalculate.perModel)) {
      const pricing = await this.fetcher.getModelPricing(modelName);
      if (!pricing) continue;
      apiCostUSD += calculateCostFromTokens(
        {
          input_tokens: modelTokens.inputTokens,
          output_tokens: modelTokens.outputTokens,
          cache_creation_input_tokens: modelTokens.cacheCreationTokens,
          cache_read_input_tokens: modelTokens.cacheReadTokens,
        },
        pricing,
      );
    }
    if (Object.keys(tokensToCalculate.perModel).length === 0 && tokensToCalculate.inputTokens + tokensToCalculate.outputTokens > 0) {
      const fallbackModel = tokensToCalculate.modelNames[0] ?? snapshot.model ?? "claude-sonnet-4-5";
      const pricing = await this.fetcher.getModelPricing(fallbackModel);
      if (pricing) {
        apiCostUSD += calculateCostFromTokens(
          {
            input_tokens: tokensToCalculate.inputTokens,
            output_tokens: tokensToCalculate.outputTokens,
            cache_creation_input_tokens: tokensToCalculate.cacheCreationTokens,
            cache_read_input_tokens: tokensToCalculate.cacheReadTokens,
          },
          pricing,
        );
      }
    }

    const subscriptionCostUSD = this.settings.subscriptionCosts.claude;
    const effectiveDays = windowDays > 0
      ? windowDays
      : computeActualDaysFromEntries(entries.map(e => e.timestamp));
    const periodSubCost = subscriptionCostUSD * effectiveDays / 30;
    const factor = periodSubCost > 0 ? apiCostUSD / periodSubCost : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: false,
      windowLabel,
      windowDays: effectiveDays,
      calculationMode,
      label: formatLabel(apiCostUSD, factor, false),
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
    const { billingStart, windowLabel, windowDays, calculationMode } = resolveBillingStart(this.settings.costWindow, snapshot, "codex");
    const events = await readCodexTokensForPeriod(this.codexSessionsDir, billingStart);
    if (events.length === 0) {
      return {
        apiCostUSD: 0,
        subscriptionCostUSD: this.settings.subscriptionCosts.codex,
        factor: null,
        isEstimate: true,
        windowLabel,
        windowDays,
        calculationMode,
        label: "Keine Logs verfügbar",
      };
    }
    const speedTier = await readCodexSpeedTierFromPaths(Array.isArray(this.codexConfigPath) ? this.codexConfigPath : [this.codexConfigPath]);
    const apiCostUSD = await calculateCodexApiCost(events, this.fetcher, speedTier);
    const subscriptionCostUSD = this.settings.subscriptionCosts.codex;
    const effectiveDays = windowDays > 0
      ? windowDays
      : computeActualDaysFromEntries(events.map(e => e.timestamp));
    const periodSubCost = subscriptionCostUSD * effectiveDays / 30;
    const factor = periodSubCost > 0 ? apiCostUSD / periodSubCost : 0;

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

function formatLabel(apiCostUSD: number, factor: number, isEstimate: boolean): string {
  if (apiCostUSD === 0 && !isEstimate) return "$0.00 (keine Daten)";
  const prefix = isEstimate ? "~" : "";
  return `${prefix}${factor.toFixed(1)}× Abo`;
}
