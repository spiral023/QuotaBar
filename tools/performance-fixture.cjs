const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

function event(index) {
  return {
    schemaVersion: 1, id: String(index).padStart(64, '0'), provider: index % 2 ? 'codex' : 'claude',
    occurredAt: new Date(Date.parse('2026-01-01T00:00:00Z') + index % 360 * 86400000 + Math.floor(index / 360) * 1000).toISOString(),
    model: index % 2 ? 'gpt-5.4' : 'claude-sonnet-4-6', sessionKey: `fixture-${index % 1000}`,
    source: index % 2 ? 'codex-log' : 'claude-log', synthetic: false,
    inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0,
    costUSD: .01, inputCostUSD: .008, outputCostUSD: .002, cacheCreationCostUSD: 0, cacheReadCostUSD: 0,
  };
}

async function fixture(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `quotabar-${prefix}-`));
  process.env.USERPROFILE = root; process.env.HOME = root;
  return { root, async cleanup() {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith(`quotabar-${prefix}-`));
    await fs.rm(root, { recursive: true, force: true });
  } };
}

const dist = () => path.resolve(process.env.QB_BENCHMARK_DIST || path.join(__dirname, '../dist'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const memory = () => Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, bytes]) => [key, Math.round(bytes / 1048576 * 100) / 100]));
module.exports = { event, fixture, dist, hash, memory };
