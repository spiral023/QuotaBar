import fs from "node:fs/promises";
import { getCodexAuthPath } from "../config/paths";
import { decodeJwtClaim } from "./jwt";

export interface CodexCredentials {
  accessToken: string;
  accountId?: string;
  email?: string;
}

const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";

export function parseCodexAuthJson(content: string): CodexCredentials | null {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const accessToken = readString(tokens?.access_token) ?? readString(parsed.access_token);
  if (!accessToken) {
    return null;
  }

  const accountId = readString(tokens?.account_id)
    ?? readString(parsed.account_id)
    ?? readString(decodeJwtClaim(accessToken, ACCOUNT_ID_CLAIM));

  const idToken = readString(tokens?.id_token) ?? readString(parsed.id_token);
  const email = idToken ? readString(decodeJwtClaim(idToken, "email")) : undefined;

  return {
    accessToken,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {})
  };
}

export async function loadCodexCredentials(): Promise<CodexCredentials | null> {
  const path = getCodexAuthPath();
  try {
    return parseCodexAuthJson(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
