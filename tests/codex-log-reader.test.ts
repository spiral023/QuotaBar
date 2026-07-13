import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCodexTokensForPeriod } from "../src/pricing/codex-log-reader";

const tmpDir = path.join(os.tmpdir(), `quotabar-codex-test-${process.pid}`);

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeJsonl(dir: string, filename: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, filename),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

function makeTurnContext(model: string, timestamp = "2026-05-18T10:00:00.000Z") {
  return { timestamp, type: "turn_context", payload: { model, turn_id: "x" } };
}

function makeTokenCountWithLast(
  timestamp: string,
  last: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number },
) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: last, total_token_usage: last },
    },
  };
}

function makeTokenCountLastOnly(
  timestamp: string,
  last: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number },
) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: last },
    },
  };
}

function makeTokenCountTotalOnly(
  timestamp: string,
  total: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number },
) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total } },
  };
}

describe("readCodexTokensForPeriod", () => {
  it("reuses basename-only project names from session and turn metadata", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      { timestamp: "2026-05-18T09:59:00.000Z", type: "session_meta", payload: { cwd: "C:\\Users\\person\\src\\FirstProject" } },
      makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11,
      }),
      { timestamp: "2026-05-18T10:00:02.000Z", type: "turn_context", payload: { model: "gpt-5.2-codex", cwd: "/home/person/src/SecondProject" } },
      makeTokenCountWithLast("2026-05-18T10:00:03.000Z", {
        input_tokens: 20, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 22,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events.map((event) => event.projectName)).toEqual(["FirstProject", "SecondProject"]);
    expect(JSON.stringify(events.map((event) => event.projectName))).not.toContain("person");
  });

  it("clears projectName when present cwd metadata is invalid", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "clear-project.jsonl", [
      { type: "session_meta", payload: { cwd: "/home/alice/FirstProject" } },
      makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11,
      }),
      { type: "turn_context", payload: { model: "gpt-5.2-codex", cwd: ".." } },
      makeTokenCountWithLast("2026-05-18T10:00:02.000Z", {
        input_tokens: 20, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 22,
      }),
      { type: "turn_context", payload: { model: "gpt-5.2-codex" } },
      makeTokenCountWithLast("2026-05-18T10:00:03.000Z", {
        input_tokens: 30, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 33,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events.map((event) => event.projectName)).toEqual(["FirstProject", undefined, undefined]);
  });

  it("returns empty array when sessions dir does not exist", async () => {
    const result = await readCodexTokensForPeriod("/nonexistent/xyz", new Date("2026-05-01"));
    expect(result).toEqual([]);
  });

  it("parses model from turn_context and token counts from last_token_usage", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 1000,
        cached_input_tokens: 200,
        output_tokens: 100,
        reasoning_output_tokens: 50,
        total_tokens: 1100,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(1);
    expect(events[0].model).toBe("gpt-4o");
    expect(events[0].isFallback).toBe(false);
    expect(events[0].inputTokens).toBe(1000);
    expect(events[0].cachedInputTokens).toBe(200);
    expect(events[0].outputTokens).toBe(100);
    expect(events[0].reasoningOutputTokens).toBe(50);
  });

  it("computes delta when only total_token_usage is present", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountTotalOnly("2026-05-18T10:00:01.000Z", {
        input_tokens: 1000,
        cached_input_tokens: 0,
        output_tokens: 100,
        reasoning_output_tokens: 0,
        total_tokens: 1100,
      }),
      makeTokenCountTotalOnly("2026-05-18T10:00:02.000Z", {
        input_tokens: 2500,
        cached_input_tokens: 500,
        output_tokens: 300,
        reasoning_output_tokens: 100,
        total_tokens: 2800,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(2);
    expect(events[0].inputTokens).toBe(1000);
    expect(events[1].inputTokens).toBe(1500);   // 2500 - 1000
    expect(events[1].cachedInputTokens).toBe(500);
    expect(events[1].outputTokens).toBe(200);   // 300 - 100
  });

  it("clamps cachedInputTokens to inputTokens (bug protection)", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 500,
        cached_input_tokens: 9999, // buggy: larger than input
        output_tokens: 100,
        reasoning_output_tokens: 0,
        total_tokens: 600,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events[0].cachedInputTokens).toBe(500); // clamped to inputTokens
  });

  it("skips token_count events with info: null", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      { timestamp: "2026-05-18T10:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: null } },
      makeTokenCountWithLast("2026-05-18T10:00:02.000Z", {
        input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(100);
  });

  it("filters events before billingStart but still tracks totals for delta", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountTotalOnly("2026-05-17T23:59:00.000Z", {
        input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100,
      }),
      makeTokenCountTotalOnly("2026-05-18T00:00:01.000Z", {
        input_tokens: 1500, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 1700,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-18T00:00:00.000Z"));
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(500);  // 1500 - 1000 (delta from pre-billing event)
    expect(events[0].outputTokens).toBe(100); // 200 - 100
  });

  it("uses gpt-5 fallback model and sets isFallback=true when no model info", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events[0].model).toBe("gpt-5");
    expect(events[0].isFallback).toBe(true);
  });

  it("reads JSONL files from nested subdirectories", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/01"), "a.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountWithLast("2026-05-01T08:00:00.000Z", {
        input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55,
      }),
    ]);
    await writeJsonl(path.join(tmpDir, "2026/05/02"), "b.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountWithLast("2026-05-02T08:00:00.000Z", {
        input_tokens: 75, cached_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 0, total_tokens: 83,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(2);
    const totalInput = events.reduce((s, e) => s + e.inputTokens, 0);
    expect(totalInput).toBe(125);
  });

  it("handles last_token_usage-only entries (no total_token_usage)", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "session.jsonl", [
      makeTurnContext("gpt-4o"),
      makeTokenCountLastOnly("2026-05-18T10:00:01.000Z", {
        input_tokens: 800, cached_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 0, total_tokens: 880,
      }),
      makeTokenCountLastOnly("2026-05-18T10:00:02.000Z", {
        input_tokens: 600, cached_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 0, total_tokens: 660,
      }),
    ]);

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(2);
    expect(events[0].inputTokens).toBe(800);
    expect(events[1].inputTokens).toBe(600);
  });

  it("reads model from info.model when no turn_context present", async () => {
    await fs.mkdir(path.join(tmpDir, "2026/05/18"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "2026/05/18", "session.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-18T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-4o-mini",
            last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 },
          },
        },
      }) + "\n",
      "utf8",
    );

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events[0].model).toBe("gpt-4o-mini");
    expect(events[0].isFallback).toBe(false);
  });

  it("exposes a raw event id as in-memory source identity", async () => {
    await writeJsonl(path.join(tmpDir, "2026/05/18"), "source-id.jsonl", [{
      ...makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
        input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
      }),
      id: "codex-event-123",
    }]);
    const [event] = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(event.sourceEventId).toBe("codex-event-123");
  });

  it("skips invalid JSONL lines without throwing", async () => {
    await fs.mkdir(path.join(tmpDir, "2026/05/18"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "2026/05/18", "session.jsonl"),
      [
        "not-valid-json{{{{",
        JSON.stringify(makeTurnContext("gpt-4o")),
        JSON.stringify(makeTokenCountWithLast("2026-05-18T10:00:01.000Z", {
          input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110,
        })),
      ].join("\n") + "\n",
      "utf8",
    );

    const events = await readCodexTokensForPeriod(tmpDir, new Date("2026-05-01"));
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(100);
  });
});
