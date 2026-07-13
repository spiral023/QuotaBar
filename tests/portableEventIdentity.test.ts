import { describe, expect, it } from "vitest";
import { eventId, sessionKey } from "../src/portable/eventIdentity";

describe("portable event identity", () => {
  it("is deterministic and changes with each statistical identity field", () => {
    const base = {
      provider: "claude" as const,
      occurredAt: "2026-07-13T10:00:00.000Z",
      model: "m",
      session: "secret-session",
      ordinal: 2,
    };

    expect(eventId(base)).toBe(eventId(base));
    const variants = [
      { ...base, provider: "codex" as const },
      { ...base, occurredAt: "2026-07-13T10:00:00.001Z" },
      { ...base, model: "other-model" },
      { ...base, session: "other-session" },
      { ...base, ordinal: 3 },
    ];

    for (const variant of variants) {
      expect(eventId(variant)).not.toBe(eventId(base));
    }
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

  it("frames event identity fields without separator collisions", () => {
    const base = {
      provider: "claude" as const,
      occurredAt: "2026-07-13T10:00:00.000Z",
      ordinal: 2,
    };

    expect(eventId({ ...base, model: "a\u001fb", session: "c" })).not.toBe(
      eventId({ ...base, model: "a", session: "b\u001fc" }),
    );
  });

  it.each([-1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid ordinal %s",
    (ordinal) => {
      expect(() =>
        eventId({
          provider: "claude",
          occurredAt: "2026-07-13T10:00:00.000Z",
          model: "m",
          session: "secret-session",
          ordinal,
        }),
      ).toThrowError(new RangeError("ordinal must be a non-negative safe integer"));
    },
  );

  it("accepts zero as an ordinal", () => {
    expect(
      eventId({
        provider: "claude",
        occurredAt: "2026-07-13T10:00:00.000Z",
        model: "m",
        session: "secret-session",
        ordinal: 0,
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps stable golden identities for the portable format", () => {
    expect(sessionKey("claude", "secret-session")).toBe(
      "54f8fbc0eb1083a0d6dcc31e957d49410aaabd10d11ef2357a74a49128b84fc8",
    );
    expect(
      eventId({
        provider: "claude",
        occurredAt: "2026-07-13T10:00:00.000Z",
        model: "m",
        session: "secret-session",
        ordinal: 2,
      }),
    ).toBe(
      "e247161342b149e06d894410dc5f107160d67bcc0a415168da8a6ce6be153347",
    );
  });
});
