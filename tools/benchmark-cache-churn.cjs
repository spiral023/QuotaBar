const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { event, fixture, dist, memory } = require('./performance-fixture.cjs');

(async () => {
  assert.ok(global.gc, 'Run with --expose-gc');
  const owned = await fixture('cache-churn');
  try {
    const { FileParseCache } = require(path.join(dist(), 'pricing/file-parse-cache'));
    const cache = new FileParseCache();
    global.gc(); const baseline = memory(), samples = [];
    for (let index = 0; index < 512; index++) {
      const file = path.join(owned.root, `${index}.jsonl`); await fs.writeFile(file, String(index));
      await cache.get(file, async () => Array.from({ length: 256 }, (_, item) => event(index * 256 + item)));
      if ((index + 1) % 128 === 0) { global.gc(); samples.push({ files: index + 1, memoryMiB: memory() }); }
    }
    let reparsed = false;
    await cache.get(path.join(owned.root, '0.jsonl'), async () => { reparsed = true; return []; });
    process.stdout.write(JSON.stringify({ baseline, samples, oldestWasEvicted: reparsed }) + '\n');
    assert.ok(reparsed, 'Parse cache retains all 512 historical files instead of evicting cold entries');
    assert.ok(samples.at(-1).memoryMiB.heapUsed - samples[0].memoryMiB.heapUsed < 8, 'Parse cache heap keeps growing with historical file count');
  } finally { await owned.cleanup(); }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
