const REDACTED = "[REDACTED]";

const patterns: Array<[RegExp, string]> = [
  [/(Authorization\s*:\s*Bearer\s+)[^\s\r\n]+/gi, `$1${REDACTED}`],
  [/(Cookie\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  [/((?:^|[?&\s])(?:access_token|refresh_token|api_key|apikey|client_secret|token|code)=)[^&#\s]+/gi, `$1${REDACTED}`],
  [/("?(?:access_token|refresh_token|api_key|apiKey|client_secret|authorization|cookie|token)"?\s*[:=]\s*")[^"]+(")/gi, `$1${REDACTED}$2`],
  [/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, REDACTED],
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED]
];

export function redactSecrets(input: string): string {
  return patterns.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), input);
}

export function redactObject(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(value));
  } catch {
    return redactSecrets(String(value));
  }
}

const PII_KEYS = new Set(["email", "account_id", "accountId", "user_id", "userId"]);

export function redactPII<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(walk);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = PII_KEYS.has(k) ? "<redacted>" : walk(v);
  }
  return out;
}
