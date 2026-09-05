import { describe, expect, it } from "vitest";
import { isCurrentIngestSourceState } from "../src/portable/ingestState";

// The guard memoizes validated records because it regex-checks every event ID
// and runs inside loops over all known sources. These pin that memoization
// cannot hand out a wrong answer.

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "claude",
    path: "/home/x/.claude/projects/p/s.jsonl",
    size: "10", mtimeNs: "1", ctimeNs: "2",
    processedAt: "2026-09-05T10:00:00.000Z",
    eventIds: ["a".repeat(64), "b".repeat(64)],
    active: true,
    ...overrides,
  };
}

describe("isCurrentIngestSourceState", () => {
  it("accepts a valid record and stays stable across repeated checks", () => {
    const record = source();
    expect(isCurrentIngestSourceState(record as never)).toBe(true);
    expect(isCurrentIngestSourceState(record as never)).toBe(true);
    expect(isCurrentIngestSourceState(record as never)).toBe(true);
  });

  it("rejects a record with a malformed event ID", () => {
    expect(isCurrentIngestSourceState(source({ eventIds: ["not-hex"] }) as never)).toBe(false);
  });

  it("rejects an uppercase event ID, repeatedly", () => {
    const record = source({ eventIds: ["A".repeat(64)] });
    expect(isCurrentIngestSourceState(record as never)).toBe(false);
    expect(isCurrentIngestSourceState(record as never)).toBe(false);
  });

  it("rejects a record with a wrong-length event ID", () => {
    expect(isCurrentIngestSourceState(source({ eventIds: ["a".repeat(63)] }) as never)).toBe(false);
  });

  it("rejects records missing required fields", () => {
    for (const field of ["provider", "path", "size", "mtimeNs", "ctimeNs", "processedAt", "eventIds", "active"]) {
      const record = source();
      delete record[field];
      expect(isCurrentIngestSourceState(record as never), field).toBe(false);
    }
  });

  it("rejects undefined and non-objects", () => {
    expect(isCurrentIngestSourceState(undefined)).toBe(false);
    expect(isCurrentIngestSourceState("x" as never)).toBe(false);
    expect(isCurrentIngestSourceState(null as never)).toBe(false);
  });

  it("judges two records independently, valid and invalid", () => {
    const valid = source();
    const invalid = source({ eventIds: ["zz"] });
    expect(isCurrentIngestSourceState(valid as never)).toBe(true);
    expect(isCurrentIngestSourceState(invalid as never)).toBe(false);
    expect(isCurrentIngestSourceState(valid as never)).toBe(true);
    expect(isCurrentIngestSourceState(invalid as never)).toBe(false);
  });

  it("does not carry a verdict over to a structurally identical copy that is invalid", () => {
    const valid = source();
    expect(isCurrentIngestSourceState(valid as never)).toBe(true);
    const copy = { ...valid, eventIds: ["nope"] };
    expect(isCurrentIngestSourceState(copy as never)).toBe(false);
  });
});
