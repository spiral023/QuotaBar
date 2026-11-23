import path from "node:path";
import { ClaudeCredentials, isClaudeTokenExpired, readClaudeCredentialsFile, saveClaudeCredentials } from "./claudeAuth";
import { httpFetch } from "../main/httpClient";
import { errnoSuffix, NotAuthenticatedError } from "../shared/errors";

const CLAUDE_OAUTH_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface ClaudeTokenRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface RefreshClaudeTokenOptions {
  /** Cancels the refresh before the token request starts (see below). */
  signal?: AbortSignal;
}

/** One refresh per credentials file at a time; later callers share the running one. */
const inflight = new Map<string, Promise<ClaudeCredentials>>();

/**
 * Refreshes the Claude OAuth token and writes it back to the file it came from.
 *
 * Concurrent callers for the same file share one refresh: a refresh token may
 * be rotated by the server, so two parallel refreshes could leave the file
 * holding an already-consumed token. Before refreshing, the file is re-read;
 * if Claude Code has stored a newer, still valid token meanwhile, that token
 * is returned and the refresh token is not spent again.
 */
export function refreshClaudeToken(
  credentials: ClaudeCredentials,
  timeoutMs = 10_000,
  options: RefreshClaudeTokenOptions = {},
): Promise<ClaudeCredentials> {
  const key = credentials.sourcePath ? canonicalPath(credentials.sourcePath) : "";
  const running = inflight.get(key);
  if (running) return running;
  const refresh = refreshExclusive(credentials, timeoutMs, options.signal).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, refresh);
  return refresh;
}

async function refreshExclusive(
  credentials: ClaudeCredentials,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ClaudeCredentials> {
  signal?.throwIfAborted();
  const current = await currentCredentials(credentials);
  if (current.accessToken !== credentials.accessToken && !isClaudeTokenExpired(current)) return current;
  if (!current.refreshToken) {
    throw new Error("Claude OAuth refresh token missing. Run `claude login` to authenticate.");
  }
  signal?.throwIfAborted();

  // Unofficial/fragile: mirrors Claude Code OAuth refresh behavior and may change without notice.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID
  });

  // Deliberately not tied to the caller's signal: once the server may have
  // rotated the refresh token, aborting would drop the only copy of the new
  // one. The request is bounded by its own timeout and the single-flight map
  // keeps a later refresh cycle from starting a second, parallel refresh.
  const response = await httpFetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
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
    ...current,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? current.refreshToken,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000)
  };

  await saveClaudeCredentials(refreshed);
  return refreshed;
}

/** The file's current credentials, or the given ones when they did not come from a file. */
async function currentCredentials(credentials: ClaudeCredentials): Promise<ClaudeCredentials> {
  if (!credentials.sourcePath) return credentials;
  let latest: ClaudeCredentials | null;
  try {
    latest = await readClaudeCredentialsFile(credentials.sourcePath);
  } catch (error) {
    // Refreshing now would rotate a token we could not write back.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Claude credentials could not be re-read before refresh${errnoSuffix(error)}`);
  }
  if (!latest) throw new NotAuthenticatedError("Claude OAuth credentials not found");
  return latest;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
