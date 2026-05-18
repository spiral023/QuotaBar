import { ClaudeCredentials, saveClaudeCredentials } from "./claudeAuth";

const CLAUDE_OAUTH_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface ClaudeTokenRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function refreshClaudeToken(credentials: ClaudeCredentials, timeoutMs = 10_000): Promise<ClaudeCredentials> {
  if (!credentials.refreshToken) {
    throw new Error("Claude OAuth refresh token missing. Run `claude login` to authenticate.");
  }

  // Unofficial/fragile: mirrors Claude Code OAuth refresh behavior and may change without notice.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID
  });

  const response = await fetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Claude OAuth refresh failed with HTTP ${response.status}`);
  }

  const payload = await response.json() as ClaudeTokenRefreshResponse;
  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new Error("Claude OAuth refresh returned an unknown payload");
  }

  const refreshed: ClaudeCredentials = {
    ...credentials,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? credentials.refreshToken,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000)
  };

  await saveClaudeCredentials(refreshed);
  return refreshed;
}
