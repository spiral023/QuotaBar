import { loadCodexCredentials, CodexCredentials } from "../auth/codexAuth";
import { log } from "../main/logging";
import { redactObject } from "../shared/redaction";
import { NotAuthenticatedError, toErrorMessage } from "../shared/errors";
import { errorSnapshot, UsageProvider, UsageSnapshot, UsageWindow } from "./types";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export class CodexProvider implements UsageProvider {
  id = "codex";
  displayName = "Codex";

  constructor(private readonly timeoutMs = 10_000) {}

  async isAvailable(): Promise<boolean> {
    return (await loadCodexCredentials()) !== null;
  }

  async getAuthHint(): Promise<string | null> {
    return (await this.isAvailable()) ? null : "Codex: Run 'codex login' to authenticate";
  }

  async fetchUsage(): Promise<UsageSnapshot> {
    try {
      const credentials = await loadCodexCredentials();
      if (!credentials) {
        throw new NotAuthenticatedError("Codex auth.json not found or has no access token");
      }

      // Unofficial/fragile: ChatGPT backend API used by Codex CLI/web; shape can change without notice.
      const response = await fetch(CODEX_USAGE_URL, {
        headers: buildHeaders(credentials),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (response.status === 401 || response.status === 403) {
        throw new NotAuthenticatedError(`Codex usage returned HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`Codex usage returned HTTP ${response.status}`);
      }

      const json = await response.json();
      log.debug(`Codex usage payload shape: ${redactObject(summarizeShape(json))}`);
      return normalizeCodexUsageResponse(json, { accountId: credentials.accountId });
    } catch (error) {
      const status = error instanceof NotAuthenticatedError ? "not_authenticated" : "error";
      log.warn(`Codex fetch failed: ${toErrorMessage(error)}`);
      return errorSnapshot("codex", toErrorMessage(error), status);
    }
  }
}

export function normalizeCodexUsageResponse(input: unknown, identity: { accountId?: string } = {}): UsageSnapshot {
  const root = asRecord(input) ?? {};
  const rateLimit = asRecord(root.rate_limit);
  const windows: UsageWindow[] = [];
  const primary = rateLimit ? asRecord(rateLimit.primary_window) : undefined;
  const secondary = rateLimit ? asRecord(rateLimit.secondary_window) : undefined;
  const credits = asRecord(root.credits);

  if (primary) windows.push(toUsageWindow(primary, "fiveHour"));
  if (secondary) windows.push(toUsageWindow(secondary, "weekly"));
  if (windows.length === 0) {
    const used = numberFrom(root.used_percent) ?? numberFrom(root.usage_percent);
    if (typeof used === "number") windows.push({ name: "fiveHour", usedPercent: clampPercent(used) });
  }
  if (credits && numberFrom(credits.balance) !== undefined) {
    windows.push({ name: "credits", label: "Credits", remainingPercent: undefined });
  }

  return {
    provider: "codex",
    status: "ok",
    planType: stringFrom(root.plan_type),
    identity: identity.accountId ? { accountId: identity.accountId } : undefined,
    windows,
    updatedAt: new Date().toISOString()
  };
}

function buildHeaders(credentials: CodexCredentials): HeadersInit {
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Authorization": `Bearer ${credentials.accessToken}`,
    "User-Agent": "CodexBar for Windows"
  };
  if (credentials.accountId) {
    headers["ChatGPT-Account-Id"] = credentials.accountId;
  }
  return headers;
}

function toUsageWindow(window: Record<string, unknown>, name: UsageWindow["name"]): UsageWindow {
  const used = numberFrom(window.used_percent) ?? numberFrom(window.usage_percent) ?? percentFromUtilization(window.utilization);
  const reset = normalizeReset(window.reset_at ?? window.resetsAt);
  const seconds = numberFrom(window.limit_window_seconds) ?? numberFrom(window.windowSeconds);
  return {
    name,
    ...(typeof used === "number" ? { usedPercent: clampPercent(used) } : {}),
    ...(reset ? { resetsAt: reset } : {}),
    ...(typeof seconds === "number" ? { windowSeconds: seconds } : {})
  };
}

function normalizeReset(value: unknown): string | undefined {
  if (typeof value === "number") return new Date((value < 10_000_000_000 ? value * 1000 : value)).toISOString();
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function summarizeShape(value: unknown): unknown {
  if (!value || typeof value !== "object") return typeof value;
  return Object.keys(value as Record<string, unknown>).sort();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function percentFromUtilization(value: unknown): number | undefined {
  const num = numberFrom(value);
  if (num === undefined) return undefined;
  return num > 0 && num <= 1 ? num * 100 : num;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
