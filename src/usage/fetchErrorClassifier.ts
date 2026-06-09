export type FetchErrorKind = "dns" | "network" | "other";

export interface FetchErrorClass {
  kind: FetchErrorKind;
  code: string;
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ENETUNREACH", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"]);

export function classifyFetchError(error: unknown): FetchErrorClass {
  const code = causeCode(error);
  if (code && DNS_CODES.has(code)) return { kind: "dns", code };
  if (code && NETWORK_CODES.has(code)) return { kind: "network", code };
  if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
    return { kind: "network", code: "TIMEOUT" };
  }
  return { kind: "other", code: "" };
}

function causeCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const ownCode = (error as Error & { code?: unknown }).code;
  return typeof ownCode === "string" ? ownCode : null;
}
