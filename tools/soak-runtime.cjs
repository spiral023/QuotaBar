// Real elapsed-time retention/load test, not a clock-accelerated longevity claim.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const { event, fixture, dist, memory } = require('./performance-fixture.cjs');

(async () => {
  assert.ok(global.gc, 'Run with --expose-gc');
  const minutes = Number(process.argv[2] || 30), count = Number(process.argv[3] || 100000);
  assert.ok(Number.isFinite(minutes) && minutes >= 1 && minutes <= 120);
  assert.ok(Number.isSafeInteger(count) && count >= 100000);
  const owned = await fixture('runtime-soak');
  const output = path.resolve('package-output/performance-ingestion/runtime-soak.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  try {
    const { PortableUsageStore } = require(path.join(dist(), 'portable/usageStore'));
    const { aggregateDaily } = require(path.join(dist(), 'portable/dailyRollups'));
    const { FileParseCache } = require(path.join(dist(), 'pricing/file-parse-cache'));
    const { AsyncResultCache } = require(path.join(dist(), 'main/asyncResultCache'));
    const { AsyncLogWriter } = require(path.join(dist(), 'main/asyncLogWriter'));
    const store = new PortableUsageStore(path.join(owned.root, 'app/usage'));
    await store.upsert(Array.from({ length: count }, (_, index) => event(index)));
    await store.readDaily('UTC');
    const files = new FileParseCache(), main = new AsyncResultCache(), logger = new AsyncLogWriter();
    const logPath = path.join(owned.root, 'app/quotabar.log');
    let invokes = 0;
    const QB = { isPortableDataPreparing: () => false, ipc: { invoke: async (_, query) => {
      invokes++; return main.get(JSON.stringify(query), async () => ({ rows: await store.readDaily('UTC') }));
    } } };
    vm.runInNewContext(await fs.readFile('src/renderer/tabs/analytics-data.js', 'utf8'), { QB });
    const renderer = QB.createAnalyticsData();
    const started = performance.now(), samples = []; let cycles = 0, inserted = 0, nextSample = started;
    const round = value => JSON.stringify(value, (_, item) => typeof item === 'number' ? Math.round(item * 1e6) / 1e6 : item);
    let previousCpu = process.cpuUsage(), previousSample = started;
    while (performance.now() - started < minutes * 60000) {
      const cycleStarted = performance.now();
      if (cycles % 10 === 0) {
        const result = await store.reconcile([{ ...event(count + inserted), occurredAt: '2026-12-30T12:00:00.000Z' }]);
        assert.equal(result.inserted, 1); inserted++; main.clear(); renderer.clear();
      }
      for (let item = 0; item < 4; item++) {
        const key = cycles * 4 + item, file = path.join(owned.root, `source-${key}.jsonl`);
        await fs.writeFile(file, String(key));
        await files.get(file, async () => Array.from({ length: 256 }, (_, index) => event(key * 256 + index)));
        await fs.unlink(file); // Model rotating sources without retaining all old parsed arrays.
        const query = { since: new Date(Date.parse('2026-01-01T00:00:00Z') + key * 60000).toISOString(),
          until: '2026-12-31T23:59:59.999Z', timeZone: 'UTC' };
        await renderer.load(query); const before = invokes; await renderer.load(query);
        assert.equal(invokes, before, 'Warm renderer lookup missed its cache');
      }
      for (let index = 0; index < 200; index++) logger.write(logPath, `fixture cycle=${cycles} item=${index} ${'x'.repeat(200)}\n`);
      await logger.flush(); cycles++;
      assert.ok(files.size <= 128, 'Parsed-file cache exceeded its capacity');
      if (performance.now() >= nextSample) {
        const rows = await store.readDaily('UTC');
        assert.equal(rows.reduce((sum, row) => sum + row.count, 0), count + inserted);
        const stat = await fs.stat(logPath); assert.ok(stat.size <= 5000000, 'Log rotation exceeded its file limit');
        global.gc(); const cachedMemory = memory();
        renderer.clear(); main.clear(); global.gc(); const afterInvalidationMiB = memory();
        const now = performance.now(), cpu = process.cpuUsage(previousCpu); previousCpu = process.cpuUsage();
        samples.push({ seconds: Math.round((now - started) / 1000), cycles, inserted, fileCacheEntries: files.size,
          memoryMiB: cachedMemory, afterInvalidationMiB, cpuPercent: Math.round((cpu.user + cpu.system) / ((now - previousSample) * 10)),
          eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6), eventLoopMaxMs: Math.round(delay.max / 1e6), logBytes: stat.size });
        previousSample = now; delay.reset(); nextSample = now + 60000;
        await fs.writeFile(output, JSON.stringify({ minutes, count, samples }, null, 2));
        process.stdout.write(JSON.stringify(samples.at(-1)) + '\n');
      }
      await pause(Math.max(1, 2000 - (performance.now() - cycleStarted)));
    }
    await (async () => {
      const actual = await store.read(), rows = await store.readDaily('UTC');
      assert.equal(actual.length, count + inserted);
      assert.equal(round(rows), round(aggregateDaily(actual, 'UTC')), 'Soak rollups diverged from canonical events');
    })();
    assert.ok((await fs.readFile(logPath, 'utf8')).includes(`cycle=${cycles - 1} item=199`), 'Final log batch was lost');
    renderer.clear(); main.clear(); global.gc(); const final = memory();
    const steady = samples.filter(value => value.seconds >= Math.min(180, minutes * 20000));
    if (steady.length >= 3) {
      const heaps = steady.map(value => value.afterInvalidationMiB.heapUsed);
      assert.ok(Math.max(...heaps) - Math.min(...heaps) < 16, 'Live post-GC heap kept growing after cache warmup');
      assert.ok(final.heapUsed - heaps[0] < 16, 'Post-GC heap kept growing after cache warmup');
    }
    const result = { passed: true, minutes, elapsedSeconds: Math.round((performance.now() - started) / 1000), count, cycles, inserted, samples, finalMemoryMiB: final };
    await fs.writeFile(output, JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify({ ...result, samples: undefined }) + '\n');
  } finally { delay.disable(); await owned.cleanup(); }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
