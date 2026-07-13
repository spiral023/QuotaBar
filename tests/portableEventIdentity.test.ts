import { describe, expect, it } from "vitest";
import { eventId, sessionKey } from "../src/portable/eventIdentity";

describe("portable event identity", () => {
  it("is deterministic and changes with statistical identity", () => {
    const base = {
      provider: "claude" as const,
      occurredAt: "2026-07-13T10:00:00.000Z",
      model: "m",
      session: "secret-session",
      ordinal: 2,
    };

    expect(eventId(base)).toBe(eventId(base));
    expect(eventId({ ...base, ordinal: 3 })).not.toBe(eventId(base));
  });

  it("does not expose the raw session", () => {
    expect(sessionKey("claude", "secret-session")).not.toContain("secret-session");
  });

  it("produces lowercase SHA-256 hex identities", () => {
    const sha256Hex = /^[a-f0-9]{64}$/;
    const event = eventId({
      provider: "codex",
      occurredAt: "2026-07-13T10:00:00.000Z",
      model: "m",
      session: "secret-session",
      ordinal: 2,
    });

    expect(event).toMatch(sha256Hex);
    expect(sessionKey("claude", "secret-session")).toMatch(sha256Hex);
  });

  it("namespaces sessions by provider", () => {
    expect(sessionKey("claude", "secret-session")).not.toBe(
      sessionKey("codex", "secret-session"),
    );
  });
});
