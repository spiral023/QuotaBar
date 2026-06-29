import fs from "node:fs/promises";
import path from "node:path";
import { getClaudeCredentialsPath, type PathContext } from "../config/paths";

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  rateLimitTier?: string;
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
    return parseClaudeCredentialsJson(await fs.readFile(getClaudeCredentialsPath(context), "utf8"));
  } catch {
    return null;
  }
}

export async function saveClaudeCredentials(credentials: ClaudeCredentials): Promise<void> {
  const credentialsPath = getClaudeCredentialsPath();
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

  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  const tmpPath = `${credentialsPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmpPath, credentialsPath);
}

export function isClaudeTokenExpired(credentials: ClaudeCredentials, skewMs = 5 * 60_000): boolean {
  return Boolean(credentials.expiresAt && credentials.expiresAt.getTime() <= Date.now() + skewMs);
}

async function readExistingJson(path: string): Promise<Record<string, unknown> & { claudeAiOauth?: unknown }> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
