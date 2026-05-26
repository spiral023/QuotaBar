import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBackfillDayRecords } from "../src/reports/backfill-reader";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-bfr-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeBackfill(filePath: string, events: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // jeder Event bekommt ein ts-Feld (wie echter Recorder), nur kind/date etc. zählen
  await fs.writeFile(
    filePath,
    events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e as object })).join("\n") + "\n",
    "utf8",
  );
}

describe("readBackfillDayRecords", () => {
  it("gibt [] zurück wenn Verzeichnis nicht existiert", async () => {
    const result = await readBackfillDayRecords(path.join(tmpDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("gibt [] zurück wenn Verzeichnis leer ist", async () => {
    const result = await readBackfillDayRecords(tmpDir);
    expect(result).toEqual([]);
  });

  it("parst Claude-daySummary korrekt", async () => {
    await writeBackfill(path.join(tmpDir, "2026-05-20.backfill.jsonl"), [
      {
        kind: "tokens.daySummary", provider: "claude", date: "2026-05-20",
        input: 1000, output: 500, cacheCreation: 200, cacheRead: 3000,
        totalTokens: 4700, totalCostUSD: 0.025, sessionCount: 3,
        models: ["claude-sonnet-4-6"],
        perModel: {
          "claude-sonnet-4-6": { input: 1000, output: 500, cacheCreation: 200, cacheRead: 3000, costUSD: 0.025 },
        },
      },
    ]);

    const records = await readBackfillDayRecords(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      date: "2026-05-20",
      provider: "claude",
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 200,
      cacheReadTokens: 3000,
      totalTokens: 4700,
      costUSD: 0.025,
      sessionCount: 3,
      models: ["claude-sonnet-4-6"],
    });
    expect(records[0].perModel["claude-sonnet-4-6"]).toMatchObject({
      inputTokens: 1000, outputTokens: 500,
      cacheCreationTokens: 200, cacheReadTokens: 3000,
      totalTokens: 4700, costUSD: 0.025,
    });
  });

  it("parst Codex-daySummary korrekt (cachedInput → cacheReadTokens)", async () => {
    await writeBackfill(path.join(tmpDir, "2026-05-21.backfill.jsonl"), [
      {
        kind: "tokens.daySummary", provider: "codex", date: "2026-05-21",
        input: 50000, output: 800, cachedInput: 47000, reasoningOutput: 200,
        totalTokens: 51000, totalCostUSD: 1.23, sessionCount: 2,
        models: ["gpt-5.5"],
        perModel: {
          "gpt-5.5": { input: 50000, output: 800, cachedInput: 47000, reasoningOutput: 200, costUSD: 1.23 },
        },
      },
    ]);

    const records = await readBackfillDayRecords(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      date: "2026-05-21", provider: "codex",
      inputTokens: 50000, outputTokens: 800,
      cacheReadTokens: 47000,   // cachedInput landet hier
      cacheCreationTokens: 0,
      totalTokens: 51000, costUSD: 1.23,
    });
    expect(records[0].perModel["gpt-5.5"].cacheReadTokens).toBe(47000);
  });

  it("filtert nach since-Datum", async () => {
    await writeBackfill(path.join(tmpDir, "2026-05-18.backfill.jsonl"), [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-18",
        input: 1, output: 1, totalTokens: 2, totalCostUSD: 0, sessionCount: 1, models: [], perModel: {} },
    ]);
    await writeBackfill(path.join(tmpDir, "2026-05-20.backfill.jsonl"), [
      { kind: "tokens.daySummary", provider: "claude", date: "2026-05-20",
        input: 2, output: 2, totalTokens: 4, totalCostUSD: 0, sessionCount: 1, models: [], perModel: {} },
    ]);

    const since = new Date("2026-05-19T00:00:00.000Z");
    const records = await readBackfillDayRecords(tmpDir, since);
    expect(records).toHaveLength(1);
    expect(records[0].date).toBe("2026-05-20");
  });

  it("ignoriert non-daySummary-Zeilen und ungültiges JSON", async () => {
    await writeBackfill(path.join(tmpDir, "2026-05-20.backfill.jsonl"), [
      { kind: "tokens.usage", provider: "claude", model: "x", session: "s", input: 1, output: 1 },
      { kind: "backfill.start", days: [] },
    ]);
    // eine ungültige Zeile direkt hinzufügen
    await fs.appendFile(path.join(tmpDir, "2026-05-20.backfill.jsonl"), "not-json\n", "utf8");

    const records = await readBackfillDayRecords(tmpDir);
    expect(records).toHaveLength(0);
  });
});
