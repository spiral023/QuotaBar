import fs from "node:fs/promises";
import { getClaudeCredentialsPath, type PathContext } from "../config/paths";
import { retryTransient, writeFileAtomic } from "../shared/atomicFile";
import { errnoSuffix } from "../shared/errors";

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  rateLimitTier?: string;
  /** File the credentials were read from; a refresh writes back there. Absent for env tokens. */
  sourcePath?: string;
}

/**
 * The credentials file cannot be updated safely. It belongs to Claude Code and
 * may hold more than our OAuth entry, so QuotaBar never rewrites it from a
 * partial or guessed state. Messages are path- and token-free.
 */
export class ClaudeCredentialsWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCredentialsWriteError";
  }
}

export function parseClaudeCredentialsJson(content: string): ClaudeCredentials | null {
  const parsed = JSON.parse(content) as { claudeAiOauth?: Record<string, unknown> };
  const oauth = parsed.claudeAiOauth;
  if (!oauth) {
    return null;
  }

  const accessToken = readString(oauth.accessToken);
  if (!accessToken) {
    return null;
  }

  const expiresAtMs = typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined;
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];

  return {
    accessToken,
    ...(readString(oauth.refreshToken) ? { refreshToken: readString(oauth.refreshToken) } : {}),
    ...(expiresAtMs ? { expiresAt: new Date(expiresAtMs) } : {}),
    scopes,
    ...(readString(oauth.rateLimitTier) ? { rateLimitTier: readString(oauth.rateLimitTier) } : {})
  };
}

export async function loadClaudeCredentials(context: PathContext = {}): Promise<ClaudeCredentials | null> {
  const envToken = process.env.QUOTABAR_CLAUDE_OAUTH_TOKEN?.trim();
  if (envToken) {
    return {
      accessToken: envToken,
      scopes: ["user:profile"]
    };
  }

  try {
    return await readClaudeCredentialsFile(getClaudeCredentialsPath(context));
  } catch {
    return null;
  }
}

/** Reads and parses one credentials file; throws on I/O or JSON errors. */
export async function readClaudeCredentialsFile(credentialsPath: string): Promise<ClaudeCredentials | null> {
  const parsed = parseClaudeCredentialsJson(await retryTransient(() => fs.readFile(credentialsPath, "utf8")));
  return parsed ? { ...parsed, sourcePath: credentialsPath } : null;
}

/**
 * Merges refreshed tokens into the credentials file they were read from,
 * keeping every other key. Throws ClaudeCredentialsWriteError - and writes
 * nothing - if the file is missing, unreadable or not a JSON object.
 */
export async function saveClaudeCredentials(credentials: ClaudeCredentials): Promise<void> {
  const credentialsPath = credentials.sourcePath ?? getClaudeCredentialsPath();
  const existing = await readExistingJson(credentialsPath);
  const previousOauth = existing.claudeAiOauth && typeof existing.claudeAiOauth === "object"
    ? existing.claudeAiOauth as Record<string, unknown>
    : {};
  const nextOauth: Record<string, unknown> = {
    ...previousOauth,
    accessToken: credentials.accessToken,
    scopes: credentials.scopes,
  };
  if (credentials.refreshToken !== undefined) nextOauth.refreshToken = credentials.refreshToken;
  if (credentials.expiresAt !== undefined) nextOauth.expiresAt = credentials.expiresAt.getTime();
  if (credentials.rateLimitTier !== undefined) nextOauth.rateLimitTier = credentials.rateLimitTier;
  existing.claudeAiOauth = nextOauth;

  await writeFileAtomic(credentialsPath, `${JSON.stringify(existing, null, 2)}\n`, {
    createParent: true,
    fsync: true,
    mode: 0o600,
  });
}

export function isClaudeTokenExpired(credentials: ClaudeCredentials, skewMs = 5 * 60_000): boolean {
  return Boolean(credentials.expiresAt && credentials.expiresAt.getTime() <= Date.now() + skewMs);
}

async function readExistingJson(credentialsPath: string): Promise<Record<string, unknown> & { claudeAiOauth?: unknown }> {
  let text: string;
  try {
    text = await retryTransient(() => fs.readFile(credentialsPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      // Logged out meanwhile: recreating the file would resurrect the session.
      throw new ClaudeCredentialsWriteError("Claude credentials file disappeared; refreshed token not saved");
    }
    throw new ClaudeCredentialsWriteError(`Claude credentials file could not be read${errnoSuffix(error)}; refreshed token not saved`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClaudeCredentialsWriteError("Claude credentials file is not valid JSON; refreshed token not saved");
  }
  return parsed as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
