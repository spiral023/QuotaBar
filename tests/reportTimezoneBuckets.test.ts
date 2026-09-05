import { describe, expect, it } from "vitest";
import { fromClaudeEntries } from "../src/portable/eventAdapters";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import { generateUsageReport } from "../src/reports/reportService";

// dateParts() caches a timezone's UTC offset per hour instead of calling
// Intl.formatToParts per entry. These cases pin the observable contract: every
// entry lands in the same local day Intl reports, across DST transitions and in
// zones with half- and quarter-hour offsets.
const ZONES = [
  "Europe/Vienna",
  "America/New_York",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "Asia/Kathmandu",
  "Pacific/Auckland",
  "UTC",
];

function referenceDay(timestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(timestamp));
}

function entry(timestamp: string): ClaudeUsageEntry {
  return {
    provider: "claude", timestamp, model: "claude-test",
    project: "alpha", projectName: "alpha", session: "s1",
    inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, costUSD: 0,
  };
}

/** Every minute across a window, so transitions are hit from both sides. */
function minutesAround(centerIso: string, hoursEachSide: number): string[] {
  const center = Date.parse(centerIso);
  const stamps: string[] = [];
  for (let offset = -hoursEachSide * 60; offset <= hoursEachSide * 60; offset += 1) {
    stamps.push(new Date(center + offset * 60_000).toISOString());
  }
  return stamps;
}

describe("report day bucketing across timezones", () => {
  const transitions = [
    "2026-03-29T01:00:00.000Z", // EU spring forward
    "2026-10-25T01:00:00.000Z", // EU fall back
    "2026-03-08T07:00:00.000Z", // US spring forward
    "2026-11-01T06:00:00.000Z", // US fall back
    "2026-04-04T15:30:00.000Z", // Lord Howe, mid-UTC-hour
    "2026-04-04T14:45:00.000Z", // Chatham, mid-UTC-hour
  ];

  for (const zone of ZONES) {
    it(`buckets entries into the same local day as Intl for ${zone}`, async () => {
      const stamps = transitions.flatMap((point) => minutesAround(point, 2));
      const events = fromClaudeEntries(stamps.map(entry));
      const report = await generateUsageReport(
        { type: "daily", provider: "claude", timezone: zone, order: "asc", source: "portable" },
        { usageEvents: events },
      );

      const expected = new Map<string, number>();
      for (const stamp of stamps) {
        const day = referenceDay(stamp, zone);
        expected.set(day, (expected.get(day) ?? 0) + 1);
      }

      const actual = new Map(report.rows.map((row) => [row.bucket, row.inputTokens]));
      expect(actual).toEqual(expected);
    });
  }

  it("keeps totals intact when a DST transition splits a day", async () => {
    const stamps = minutesAround("2026-10-25T01:00:00.000Z", 3);
    const events = fromClaudeEntries(stamps.map(entry));
    const report = await generateUsageReport(
      { type: "daily", provider: "claude", timezone: "Europe/Vienna", order: "asc", source: "portable" },
      { usageEvents: events },
    );
    expect(report.totals.inputTokens).toBe(stamps.length);
  });
});
