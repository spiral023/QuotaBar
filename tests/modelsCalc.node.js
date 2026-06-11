#!/usr/bin/env node
/**
 * Direct Node.js test for models-calc UMD module
 * Tests that the module is importable via require() as per spec
 */

const {
  filterWindow,
  previousWindow,
  metricOf,
  isoWeek,
} = require("../src/renderer/tabs/models-calc.js");

const assert = require("assert");

function day(date, model, over = {}) {
  return {
    date,
    model,
    provider: model.startsWith("claude") ? "claude" : "codex",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 150,
    costUSD: 1,
    ...over,
  };
}

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push(() => {
    try {
      fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`✗ ${name}`);
      console.error(`  ${e.message}`);
      failed++;
    }
  });
}

// filterWindow tests
const days = [
  day("2026-01-01", "gpt-5.5"),
  day("2026-03-01", "gpt-5.5"),
  day("2026-03-10", "gpt-5.5"),
];

test("filterWindow('all') returns everything", () => {
  assert.strictEqual(filterWindow(days, "all", "2026-03-10").length, 3);
});

test("filterWindow('30d') keeps the last 30 days", () => {
  const result = filterWindow(days, "30d", "2026-03-10");
  const dates = result.map((d) => d.date);
  assert.deepStrictEqual(dates, ["2026-03-01", "2026-03-10"]);
});

test("previousWindow('30d') returns empty when no prior data", () => {
  const prev = previousWindow(days, "30d", "2026-03-10");
  assert.strictEqual(prev.length, 0);
});

test("previousWindow('all') always returns empty", () => {
  const prev = previousWindow(days, "all", "2026-03-10");
  assert.strictEqual(prev.length, 0);
});

// metricOf tests
const d = day("2026-01-01", "gpt-5.5", {
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationTokens: 3,
  cacheReadTokens: 4,
  totalTokens: 10,
  costUSD: 5,
});

test("metricOf(d, 'input')", () => {
  assert.strictEqual(metricOf(d, "input"), 1);
});

test("metricOf(d, 'output')", () => {
  assert.strictEqual(metricOf(d, "output"), 2);
});

test("metricOf(d, 'cacheCreation')", () => {
  assert.strictEqual(metricOf(d, "cacheCreation"), 3);
});

test("metricOf(d, 'cacheRead')", () => {
  assert.strictEqual(metricOf(d, "cacheRead"), 4);
});

test("metricOf(d, 'total')", () => {
  assert.strictEqual(metricOf(d, "total"), 10);
});

test("metricOf(d, 'cost')", () => {
  assert.strictEqual(metricOf(d, "cost"), 5);
});

test("metricOf(d, 'unknown') defaults to totalTokens", () => {
  assert.strictEqual(metricOf(d, "unknown"), 10);
});

// isoWeek tests
test("isoWeek('2026-01-01') => '2026-W01'", () => {
  assert.strictEqual(isoWeek("2026-01-01"), "2026-W01");
});

test("isoWeek('2025-12-29') => '2026-W01'", () => {
  assert.strictEqual(isoWeek("2025-12-29"), "2026-W01");
});

test("isoWeek('2025-09-24') => '2025-W39'", () => {
  assert.strictEqual(isoWeek("2025-09-24"), "2025-W39");
});

// Run all tests
tests.forEach(t => t());
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
