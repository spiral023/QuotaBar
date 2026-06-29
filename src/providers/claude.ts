import { spawn } from "node:child_process";
import { isClaudeTokenExpired, loadClaudeCredentials, ClaudeCredentials } from "../auth/claudeAuth";
import { fetchClaudeProfile } from "../auth/claudeProfile";
import { refreshClaudeToken } from "../auth/tokenRefresh";
import { log } from "../main/logging";
import { httpFetch } from "../main/httpClient";
import { NotAuthenticatedError, RateLimitError, toErrorMessage } from "../shared/errors";
import { errorSnapshot, UsageProvider, UsageSnapshot, UsageWindow } from "./types";
import type { ProviderSettingsLoader } from "./providerRegistry";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

export class ClaudeProvider implements UsageProvider {
  id = "claude";
  displayName = "Claude";

  constructor(private readonly timeoutMs = 10_000, private readonly settingsLoader?: ProviderSettingsLoader) {}

  async isAvailable(): Promise<boolean> {
    return (await loadClaudeCredentials(await this.pathContext())) !== null;
  }

  async getAuthHint(): Promise<string | null> {
    return (await this.isAvailable()) ? null : "Claude: Click to authenticate...";
  }

  async fetchUsage(): Promise<UsageSnapshot> {
    try {
      let credentials = await loadClaudeCredentials(await this.pathContext());
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
        const retryAfterMs = parseRetryAfterMs(header);
        throw new RateLimitError(retryAfterMs);
      }
      if (!response.ok) {
        throw new Error(`Claude usage returned HTTP ${response.status}`);
      }

      const snapshot = normalizeClaudeUsageResponse(await response.json(), {
        rateLimitTier: credentials.rateLimitTier
      });
      const profile = await fetchClaudeProfile(credentials.accessToken, this.timeoutMs);
      if (profile?.email || profile?.accountUuid) {
        snapshot.identity = { email: profile.email, accountId: profile.accountUuid };
      }
      return snapshot;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      const status = error instanceof NotAuthenticatedError ? "not_authenticated" : "error";
      log.warn(`Claude fetch failed: ${toErrorMessage(error)}`);
      return errorSnapshot("claude", toErrorMessage(error), status);
    }
  }

  private async pathContext(): Promise<{ claudeRoots: string[] }> {
    if (!this.settingsLoader) return { claudeRoots: [] };
    const settings = await this.settingsLoader();
    return { claudeRoots: settings.claudeRoots ?? [] };
  }
}

export function parseRetryAfterMs(header: string | null, now = new Date()): number {
  const fallbackMs = 5 * 60 * 1000;
  if (header === null) return fallbackMs;
  const trimmed = header.trim();
  if (!trimmed) return fallbackMs;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return fallbackMs;
  const deltaMs = dateMs - now.getTime();
  return deltaMs > 0 ? deltaMs : fallbackMs;
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
  return httpFetch(CLAUDE_USAGE_URL, {
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
  // Die Claude-OAuth-Usage-API liefert `utilization` als Prozentwert auf der
  // 0–100-Skala (1 = 1 %, 98 = 98 %), NICHT als 0–1-Bruch. Eine frühere
  // Heuristik multiplizierte Werte ≤ 1 mit 100, um eine vermeintliche Bruchform
  // zu unterstützen — dabei wurde ein echtes 1-%-Reading zu 100 %. Genau das
  // trat direkt nach einem 7d-Fenster-Reset auf (reale Nutzung ~1 %, angezeigt
  // 100 %), während das 5h-Fenster erst bei ~8 % stand (physikalisch kann das
  // 7d-Fenster dann nicht bei 100 % liegen). Werte werden in toClaudeWindow auf
  // [0, 100] geklemmt.
  return num;
}
