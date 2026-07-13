import { createHash } from "node:crypto";

const NS = "quotabar-portable-v1";

const hash = (parts: readonly (string | number)[]): string =>
  createHash("sha256")
    .update([NS, ...parts].join("\u001f"), "utf8")
    .digest("hex");

export function sessionKey(
  provider: "claude" | "codex",
  raw: string,
): string {
  return hash(["session", provider, raw]);
}

export function eventId(input: {
  provider: "claude" | "codex";
  occurredAt: string;
  model: string;
  session: string;
  ordinal: number;
}): string {
  return hash([
    "event",
    input.provider,
    input.occurredAt,
    input.model,
    input.session,
    input.ordinal,
  ]);
}
