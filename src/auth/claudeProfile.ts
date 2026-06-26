import { httpFetch } from "../main/httpClient";

const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

export interface ClaudeProfile {
  email?: string;
  accountUuid?: string;
  displayName?: string;
  organizationName?: string;
}

// Module-level single-entry cache. We also cache null results to avoid
// hammering a failing endpoint on every poll cycle.
let cachedToken: string | null = null;
let cachedProfile: ClaudeProfile | null = null;

export function clearClaudeProfileCache(): void {
  cachedToken = null;
  cachedProfile = null;
}

export async function fetchClaudeProfile(accessToken: string, timeoutMs: number): Promise<ClaudeProfile | null> {
  if (accessToken === cachedToken) {
    return cachedProfile;
  }

  let profile: ClaudeProfile | null = null;

  try {
    const response = await httpFetch(CLAUDE_PROFILE_URL, {
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "User-Agent": "QuotaBar for Windows"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      cachedToken = accessToken;
      cachedProfile = null;
      return null;
    }

    const body = await response.json() as unknown;
    profile = parseProfile(body);
  } catch {
    cachedToken = accessToken;
    cachedProfile = null;
    return null;
  }

  cachedToken = accessToken;
  cachedProfile = profile;
  return profile;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseProfile(body: unknown): ClaudeProfile | null {
  try {
    const root = asRecord(body);
    const account = asRecord(root.account);
    const organization = asRecord(root.organization);

    const profile: ClaudeProfile = {};
    const email = str(account.email);
    const accountUuid = str(account.uuid);
    const displayName = str(account.display_name);
    const organizationName = str(organization.name);

    if (email !== undefined) profile.email = email;
    if (accountUuid !== undefined) profile.accountUuid = accountUuid;
    if (displayName !== undefined) profile.displayName = displayName;
    if (organizationName !== undefined) profile.organizationName = organizationName;

    return profile;
  } catch {
    return null;
  }
}
