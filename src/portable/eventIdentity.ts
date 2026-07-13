import { createHash } from "node:crypto";
import type { PortableProvider } from "./types";

const NS = "quotabar-portable-v1";

const hash = (parts: readonly (string | number)[]): string =>
  createHash("sha256")
    .update(JSON.stringify([NS, ...parts]), "utf8")
    .digest("hex");

export function sessionKey(
  provider: PortableProvider,
  raw: string,
): string {
  return hash(["session", provider, raw]);
}

export function eventId(input: {
  domain?: string;
  provider: PortableProvider;
  occurredAt: string;
  model: string;
  session: string;
  ordinal: number;
}): string {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new RangeError("ordinal must be a non-negative safe integer");
  }
  if (input.domain !== undefined && input.domain.length === 0) {
    throw new RangeError("domain must be a non-empty string when provided");
  }

  // Provider adapters own timestamp normalization; identity preserves occurredAt exactly.
  if (input.domain !== undefined) {
    return hash([
      "event-domain",
      input.domain,
      input.provider,
      input.occurredAt,
      input.model,
      input.session,
      input.ordinal,
    ]);
  }
  return hash([
    "event",
    input.provider,
    input.occurredAt,
    input.model,
    input.session,
    input.ordinal,
  ]);
}
