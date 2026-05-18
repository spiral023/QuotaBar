import { spawn } from "node:child_process";
import { isClaudeTokenExpired, loadClaudeCredentials, ClaudeCredentials } from "../auth/claudeAuth";
import { refreshClaudeToken } from "../auth/tokenRefresh";
import { log } from "../main/logging";
import { NotAuthenticatedError, RateLimitError, toErrorMessage } from "../shared/errors";
import { errorSnapshot, UsageProvider, UsageSnapshot, UsageWindow } from "./types";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

export class ClaudeProvider implements UsageProvider {
  id = "claude";
  displayName = "Claude";

  constructor(private readonly timeoutMs = 10_000) {}

  async isAvailable(): Promise<boolean> {
    return (await loadClaudeCredentials()) !== null;
  }

  async getAuthHint(): Promise<string | null> {
    return (await this.isAvailable()) ? null : "Claude: Click to authenticate...";
  }

  async fetchUsage(): Promise<UsageSnapshot> {
    try {
      let credentials = await loadClaudeCredentials();
      if (!credentials) {
        throw new NotAuthenticatedError("Claude OAuth credentials not found");
      }

      if (isClaudeTokenExpired(credentials) && credentials.refreshToken) {
        credentials = await refreshClaudeToken(credentials, this.timeoutMs);
      }

      let response = await requestClaudeUsage(credentials, this.timeoutMs);
      if (response.status === 401 && credentials.refreshToken) {
        credentials = await refreshClaudeToken(credentials, this.timeoutMs);
        response = await requestClaudeUsage(credentials, this.timeoutMs);
      }

      if (response.status === 401 || response.status === 403) {
        throw new NotAuthenticatedError(`Claude usage returned HTTP ${response.status}`);
      }
      if (response.status === 429) {
        const header = response.headers.get("Retry-After");
        const retryAfterMs = header !== null ? parseInt(header, 10) * 1000 : 5 * 60 * 1000;
        throw new RateLimitError(retryAfterMs);
      }
      if (!response.ok) {
        throw new Error(`Claude usage returned HTTP ${response.status}`);
      }

      return normalizeClaudeUsageResponse(await response.json(), {
        rateLimitTier: credentials.rateLimitTier
      });
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      const status = error instanceof NotAuthenticatedError ? "not_authenticated" : "error";
      log.warn(`Claude fetch failed: ${toErrorMessage(error)}`);
      return errorSnapshot("claude", toErrorMessage(error), status);
    }
  }
}

export function normalizeClaudeUsageResponse(input: unknown, identity: { rateLimitTier?: string } = {}): UsageSnapshot {
  const root = asRecord(input);
  const windows: UsageWindow[] = [];

  const fiveHour = asRecord(root.fiveHour ?? root.five_hour);
  const sevenDay = asRecord(root.sevenDay ?? root.seven_day);
  const extraUsage = asRecord(root.extraUsage ?? root.extra_usage);

  if (fiveHour) windows.push(toClaudeWindow(fiveHour, "fiveHour", 5 * 60 * 60));
  if (sevenDay) windows.push(toClaudeWindow(sevenDay, "weekly", 7 * 24 * 60 * 60));
  if (extraUsage) {
    const used = numberFrom(extraUsage.usedCredits ?? extraUsage.used_credits);
    const limit = numberFrom(extraUsage.monthlyLimit ?? extraUsage.monthly_limit);
    if (used !== undefined && limit && limit > 0) {
      windows.push({ name: "credits", label: "Extra usage", usedPercent: Math.min(100, (used / limit) * 100) });
    }
  }

  return {
    provider: "claude",
    status: "ok",
    planType: identity.rateLimitTier,
    windows,
    updatedAt: new Date().toISOString()
  };
}

export function openClaudeLoginTerminal(): void {
  const command = "Write-Host 'Run claude login, then restart or refresh QuotaBar.'; Write-Host ''; claude login";
  spawn("powershell.exe", ["-NoExit", "-Command", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  }).unref();
}

async function requestClaudeUsage(credentials: ClaudeCredentials, timeoutMs: number): Promise<Response> {
  // Unofficial/fragile: Claude Code OAuth endpoint; schema and scope rules can change without notice.
  return fetch(CLAUDE_USAGE_URL, {
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.accessToken}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
      "User-Agent": "QuotaBar for Windows"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function toClaudeWindow(window: Record<string, unknown>, name: UsageWindow["name"], windowSeconds: number): UsageWindow {
  const used = percentFromUtilization(window.utilization);
  const resetValue = window.resetsAt ?? window.resets_at;
  const reset = typeof resetValue === "string" ? resetValue : undefined;
  return {
    name,
    windowSeconds,
    ...(typeof used === "number" ? { usedPercent: Math.max(0, Math.min(100, used)) } : {}),
    ...(reset ? { resetsAt: reset } : {})
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percentFromUtilization(value: unknown): number | undefined {
  const num = numberFrom(value);
  if (num === undefined) return undefined;
  return num > 0 && num <= 1 ? num * 100 : num;
}
