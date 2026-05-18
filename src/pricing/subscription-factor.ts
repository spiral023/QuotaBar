import { getClaudeProjectsDir, getCodexConfigPath, getCodexSessionsDir } from "../config/paths";
import type { CostWindow, Settings } from "../config/settings";
import type { CostFactorResult, UsageSnapshot, UsageWindow } from "../providers/types";
import { calculateCodexApiCost, readCodexSpeedTier } from "./codex-cost-calculator";
import { readCodexTokensForPeriod } from "./codex-log-reader";
import { calculateCostFromTokens } from "./cost-calculator";
import { estimateGeminiCost } from "./gemini-estimator";
import { readClaudeTokensForPeriod } from "./jsonl-reader";
import { LiteLLMFetcher } from "./litellm-fetcher";

export class PricingEngine {
  private readonly fetcher: LiteLLMFetcher;

  constructor(
    private readonly settings: Settings,
    private readonly claudeProjectsDir: string = getClaudeProjectsDir(),
    private readonly codexSessionsDir: string = getCodexSessionsDir(),
    private readonly codexConfigPath: string = getCodexConfigPath(),
  ) {
    this.fetcher = new LiteLLMFetcher(settings.pricingOfflineMode);
  }

  async calculateFactor(snapshot: UsageSnapshot): Promise<CostFactorResult | undefined> {
    if (snapshot.status === "error" || snapshot.status === "not_authenticated") return undefined;
    try {
      switch (snapshot.provider) {
        case "claude": return await this.calculateClaudeFactor(snapshot);
        case "codex": return await this.calculateCodexFactor(snapshot);
        case "gemini": return await this.calculateGeminiFactor(snapshot);
        default: return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private async calculateClaudeFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const { billingStart, windowLabel } = resolveBillingStart(this.settings.costWindow, snapshot, "claude");
    const tokens = await readClaudeTokensForPeriod(this.claudeProjectsDir, billingStart);

    let apiCostUSD = 0;
    for (const [modelName, modelTokens] of Object.entries(tokens.perModel)) {
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
    if (Object.keys(tokens.perModel).length === 0 && tokens.inputTokens + tokens.outputTokens > 0) {
      const fallbackModel = tokens.modelNames[0] ?? snapshot.model ?? "claude-sonnet-4-5";
      const pricing = await this.fetcher.getModelPricing(fallbackModel);
      if (pricing) {
        apiCostUSD = calculateCostFromTokens(
          {
            input_tokens: tokens.inputTokens,
            output_tokens: tokens.outputTokens,
            cache_creation_input_tokens: tokens.cacheCreationTokens,
            cache_read_input_tokens: tokens.cacheReadTokens,
          },
          pricing,
        );
      }
    }

    const subscriptionCostUSD = this.settings.subscriptionCosts.claude;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: false,
      windowLabel,
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
    const { billingStart, windowLabel } = resolveBillingStart(this.settings.costWindow, snapshot, "codex");
    const events = await readCodexTokensForPeriod(this.codexSessionsDir, billingStart);
    if (events.length === 0) {
      return {
        apiCostUSD: 0,
        subscriptionCostUSD: this.settings.subscriptionCosts.codex,
        factor: null,
        isEstimate: true,
        windowLabel,
        label: "Keine Logs verfügbar",
      };
    }
    const speedTier = await readCodexSpeedTier(this.codexConfigPath);
    const apiCostUSD = await calculateCodexApiCost(events, this.fetcher, speedTier);
    const subscriptionCostUSD = this.settings.subscriptionCosts.codex;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;

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
      label: formatLabel(apiCostUSD, factor, false),
      tokenUsage: {
        inputTokens,
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens,
        totalTokens,
        models: Array.from(modelSet),
      },
    };
  }

  private async calculateGeminiFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const sessionCount = getGeminiSessionCount(snapshot);
    const apiCostUSD = await estimateGeminiCost(sessionCount, this.fetcher);
    const subscriptionCostUSD = this.settings.subscriptionCosts.gemini;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: true,
      windowLabel: undefined,
      label: formatLabel(apiCostUSD, factor, true),
    };
  }
}

function resolveBillingStart(
  costWindow: CostWindow,
  snapshot: UsageSnapshot,
  provider: "claude" | "codex",
): { billingStart: Date; windowLabel: string } {
  if (costWindow === "7d") {
    return { billingStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), windowLabel: "7d" };
  }
  if (costWindow === "30d") {
    return { billingStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), windowLabel: "30d" };
  }
  // "billing" — provider-native period
  if (provider === "claude") {
    return { billingStart: getClaudeBillingStart(snapshot), windowLabel: "billing" };
  }
  return { billingStart: getCodexBillingStart(snapshot), windowLabel: "billing" };
}

function getClaudeBillingStart(snapshot: UsageSnapshot): Date {
  const creditsWindow = snapshot.windows.find(
    (w: UsageWindow) => w.name === "credits" && w.resetsAt,
  );
  if (creditsWindow?.resetsAt) {
    const date = new Date(creditsWindow.resetsAt);
    if (!isNaN(date.getTime())) return date;
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function getCodexBillingStart(snapshot: UsageSnapshot): Date {
  const weekly = snapshot.windows.find((w: UsageWindow) => w.name === "weekly" && w.resetsAt);
  if (weekly?.resetsAt) {
    const resetsAt = new Date(weekly.resetsAt);
    if (!isNaN(resetsAt.getTime())) {
      return new Date(resetsAt.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
  }
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

function getGeminiSessionCount(snapshot: UsageSnapshot): number {
  const label = snapshot.windows[0]?.label ?? "";
  const match = /^(\d+)\s+session/i.exec(label);
  return match ? parseInt(match[1], 10) : 0;
}

function formatLabel(apiCostUSD: number, factor: number, isEstimate: boolean): string {
  if (apiCostUSD === 0 && !isEstimate) return "$0.00 (keine Daten)";
  const prefix = isEstimate ? "~" : "";
  return `${prefix}${factor.toFixed(1)}× Abo`;
}
