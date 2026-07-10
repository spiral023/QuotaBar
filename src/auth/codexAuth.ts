import fs from "node:fs/promises";
import path from "node:path";
import { getCodexHomeCandidates, type PathContext } from "../config/paths";
import { decodeJwtClaim } from "./jwt";

export interface CodexCredentials {
  accessToken: string;
  accountId?: string;
  email?: string;
  /** Ablauf des Access-Tokens in Millisekunden (aus dem JWT-`exp`-Claim), falls dekodierbar. */
  expiresAt?: number;
}

export type CodexCredentialState = "ok" | "expired" | "missing";

export interface CodexCredentialResolution {
  state: CodexCredentialState;
  credentials: CodexCredentials | null;
  /** Pfad des gewählten auth.json (state "ok") bzw. des zuletzt abgelaufenen (state "expired"). */
  path?: string;
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

  const exp = decodeJwtClaim(accessToken, "exp");
  const expiresAt = typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;

  return {
    accessToken,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {})
  };
}

/**
 * Scannt alle bekannten Codex-Homes und wählt das auth.json mit einem noch gültigen
 * Access-Token (spätester Ablauf gewinnt). Tokens ohne exp-Claim gelten als nutzbar,
 * werden aber hinter Tokens mit bekanntem Ablauf gereiht.
 */
export async function resolveCodexCredentials(context: PathContext = {}, now = Date.now()): Promise<CodexCredentialResolution> {
  const candidates: Array<{ credentials: CodexCredentials; path: string }> = [];
  for (const home of getCodexHomeCandidates(context)) {
    const authPath = path.join(home, "auth.json");
    try {
      const credentials = parseCodexAuthJson(await fs.readFile(authPath, "utf8"));
      if (credentials) candidates.push({ credentials, path: authPath });
    } catch {
      // fehlende oder kaputte auth.json überspringen
    }
  }

  if (candidates.length === 0) {
    return { state: "missing", credentials: null };
  }

  const valid = candidates.filter(({ credentials }) => credentials.expiresAt === undefined || credentials.expiresAt > now);
  if (valid.length === 0) {
    return { state: "expired", credentials: null, path: candidates[0].path };
  }

  const best = valid.reduce((a, b) => rank(b.credentials) > rank(a.credentials) ? b : a);
  return { state: "ok", credentials: best.credentials, path: best.path };
}

export async function loadCodexCredentials(context: PathContext = {}): Promise<CodexCredentials | null> {
  return (await resolveCodexCredentials(context)).credentials;
}

function rank(credentials: CodexCredentials): number {
  // Bekannter, gültiger Ablauf schlägt unbekannten (nicht verifizierbaren) Ablauf.
  return credentials.expiresAt ?? -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
