import { getClaudeProjectsDir, getCodexConfigPath, getCodexSessionsDir } from "../config/paths";
import type { Settings } from "../config/settings";
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
    const billingStart = getClaudeBillingStart(snapshot);
    const tokens = await readClaudeTokensForPeriod(this.claudeProjectsDir, billingStart);
    const primaryModel = tokens.modelNames[0] ?? snapshot.model ?? "claude-sonnet-4-5";
    const pricing = await this.fetcher.getModelPricing(primaryModel);
    const apiCostUSD = pricing
      ? calculateCostFromTokens(
          {
            input_tokens: tokens.inputTokens,
            output_tokens: tokens.outputTokens,
            cache_creation_input_tokens: tokens.cacheCreationTokens,
            cache_read_input_tokens: tokens.cacheReadTokens,
          },
          pricing,
        )
      : 0;
    const subscriptionCostUSD = this.settings.subscriptionCosts.claude;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: false,
      label: formatLabel(apiCostUSD, factor, false),
    };
  }

  private async calculateCodexFactor(snapshot: UsageSnapshot): Promise<CostFactorResult> {
    const billingStart = getCodexBillingStart(snapshot);
    const events = await readCodexTokensForPeriod(this.codexSessionsDir, billingStart);
    if (events.length === 0) {
      return {
        apiCostUSD: 0,
        subscriptionCostUSD: this.settings.subscriptionCosts.codex,
        factor: null,
        isEstimate: true,
        label: "Keine Logs verfügbar",
      };
    }
    const speedTier = await readCodexSpeedTier(this.codexConfigPath);
    const apiCostUSD = await calculateCodexApiCost(events, this.fetcher, speedTier);
    const subscriptionCostUSD = this.settings.subscriptionCosts.codex;
    const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
    return {
      apiCostUSD,
      subscriptionCostUSD,
      factor,
      isEstimate: false,
      label: formatLabel(apiCostUSD, factor, false),
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
      label: formatLabel(apiCostUSD, factor, true),
    };
  }
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
