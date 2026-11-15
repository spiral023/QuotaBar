const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const results = 'C:\\QuotaBarResults';
const feed = 'C:\\QuotaBarBuilds\\new';
const home = path.join(process.env.USERPROFILE, '.quotabar-win');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(operation, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; } catch { /* Wait for startup/relaunch. */ }
    await sleep(250);
  }
  throw new Error('Timed out waiting for installed Electron state');
}

async function connect() {
  const target = await until(async () => {
    const tabs = await (await fetch('http://127.0.0.1:18766/json/list')).json();
    await fs.writeFile(path.join(results, 'cdp-targets.json'), JSON.stringify(tabs.map(tab => ({ type: tab.type, url: tab.url })), null, 2));
    return tabs.find(tab => tab.type === 'page' && /renderer\/index\.html$/.test(tab.url));
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = message => {
    const response = JSON.parse(message.data);
    const handler = pending.get(response.id);
    if (!handler) return;
    pending.delete(response.id);
    clearTimeout(handler.timer);
    if (response.error) handler.reject(new Error('CDP command failed'));
    else handler.resolve(response.result);
  };
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP command timed out')); }, 20_000);
      pending.set(key, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
  }
  async function evaluate(expression) {
    const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error('Installed renderer evaluation failed');
    return value.result.value;
  }
  await until(() => evaluate('Boolean(window.QB?.ipc)'));
  return { command, evaluate, close: () => socket.close() };
}

async function startFeed(requests, corrupt) {
  const allowed = new Set((await fs.readdir(feed)).filter(file => /\.(exe|yml|blockmap)$/.test(file)));
  const server = http.createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
    if (!allowed.has(name)) { response.writeHead(404).end(); return; }
    requests.push({ file: name, range: Boolean(request.headers.range), corrupt: corrupt.value });
    try {
      let contents = await fs.readFile(path.join(feed, name));
      if (name.endsWith('.yml') && corrupt.value) {
        contents = Buffer.from(contents.toString().replace(/sha512: .+/g, `sha512: ${Buffer.alloc(64).toString('base64')}`));
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2] || contents.length - 1), contents.length - 1);
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${contents.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
        response.end(request.method === 'HEAD' ? undefined : contents.subarray(start, end + 1));
      } else {
        response.writeHead(200, { 'Content-Length': contents.length, 'Accept-Ranges': 'bytes' });
        response.end(request.method === 'HEAD' ? undefined : contents);
      }
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(18765, '127.0.0.1', resolve));
  return server;
}

(async () => {
  if (process.argv.includes('--seed')) {
    const eventsDir = path.join(home, 'usage', 'events');
    await fs.mkdir(eventsDir, { recursive: true });
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ pollIntervalSeconds: 3600, pinned: true,
      pricingOfflineMode: true, minModelTokenSharePct: 7, proxy: { mode: 'off', url: '' } }));
    const event = { schemaVersion: 1, id: 'update-fixture', provider: 'claude', occurredAt: '2026-01-01T12:00:00.000Z',
      model: 'claude-haiku-4-5', sessionKey: 'update-fixture', source: 'claude-log', synthetic: false,
      inputTokens: 1234, outputTokens: 42, cacheCreationTokens: 0, cacheReadTokens: 0, reasoningOutputTokens: 0, costUSD: .05 };
    const source = JSON.stringify(event) + '\n';
    await fs.writeFile(path.join(eventsDir, '2026-01.jsonl'), source);
    await fs.writeFile(path.join(results, 'usage-hash.txt'), createHash('sha256').update(source).digest('hex'));
    return;
  }
  const requests = [];
  const corrupt = { value: !process.argv.includes('--verify') };
  const server = await startFeed(requests, corrupt);
  const cdp = await connect();
  process.stdout.write('Connected to installed Electron renderer\n');
  let lastStatus;
  const state = async () => {
    const value = await cdp.evaluate("window.QB.ipc.invoke('update:get-state')");
    if (value.status !== lastStatus) {
      lastStatus = value.status;
      process.stdout.write(`Update state: ${lastStatus}\n`);
    }
    return value;
  };
  await until(async () => (await state()).status !== 'disabled');
  const screenshot = async name => {
    const image = await cdp.command('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(results, name), Buffer.from(image.data, 'base64'));
  };
  try {
    await cdp.evaluate("document.querySelector('#tab-system').click()");
    await until(() => cdp.evaluate("Boolean(document.querySelector('#sys-update-check'))"));
    if (process.argv.includes('--verify')) {
      assert.equal((await state()).currentVersion, '2.3.2');
      await until(() => cdp.evaluate("window.QB.ipc.invoke('system:get').then(report => report.app.portableDataReady)"));
      const settings = JSON.parse((await fs.readFile(path.join(home, 'settings.json'), 'utf8')).replace(/^\uFEFF/, ''));
      assert.equal(settings.minModelTokenSharePct, 7);
      assert.equal(settings.pollIntervalSeconds, 3600);
      const usage = await fs.readFile(path.join(home, 'usage', 'events', '2026-01.jsonl'));
      await fs.writeFile(path.join(results, 'usage-after-update.jsonl'), usage);
      assert.equal(createHash('sha256').update(usage).digest('hex'), await fs.readFile(path.join(results, 'usage-hash.txt'), 'utf8'));
      await cdp.evaluate("document.querySelector('#sys-update-check').click()");
      await until(async () => requests.some(request => request.file.endsWith('.yml')) && (await state()).status === 'idle');
      await screenshot('updated-system.png');
      await fs.writeFile(path.join(results, 'verified.json'), JSON.stringify({ currentVersion: '2.3.2', noNewerUpdate: true, settingsRetained: true, usageRetained: true }));
    } else {
      assert.equal((await state()).currentVersion, '2.3.1');
      await until(() => cdp.evaluate("window.QB.ipc.invoke('system:get').then(report => report.app.portableDataReady)"));
      // Startup may canonicalize JSONL before any update. Compare against that
      // settled baseline and independently verify the seeded event's values.
      const baseline = await fs.readFile(path.join(home, 'usage', 'events', '2026-01.jsonl'));
      const baselineEvents = baseline.toString().trim().split(/\r?\n/).map(line => JSON.parse(line));
      const seeded = baselineEvents.find(event => event.id === 'update-fixture');
      assert.ok(seeded, 'Synthetic usage event disappeared before update');
      assert.equal(seeded.inputTokens, 1234);
      assert.equal(seeded.outputTokens, 42);
      assert.equal(seeded.costUSD, .05);
      await fs.writeFile(path.join(results, 'usage-before-update.jsonl'), baseline);
      await fs.writeFile(path.join(results, 'usage-hash.txt'), createHash('sha256').update(baseline).digest('hex'));
      await cdp.evaluate("document.querySelector('#sys-update-check').click()");
      const rejected = await until(async () => { const value = await state(); return value.status === 'error' && value; }, 180_000);
      assert.match(rejected.error, /checksum|sha512/i, 'Corrupted download must be rejected by electron-updater');
      await screenshot('rejected-checksum.png');
      corrupt.value = false;
      await cdp.evaluate("window.QB.ipc.invoke('update:check')");
      await until(async () => (await state()).status === 'ready', 180_000);
      // The live panel must expose Install without navigation or a renderer reload.
      await until(() => cdp.evaluate("Boolean(document.querySelector('#sys-update-install'))"));
      await screenshot('ready-to-install.png');
      await fs.writeFile(path.join(results, 'download.json'), JSON.stringify({ checksumRejected: true, readyVersion: '2.3.2', downloadedFromLocalFeed: requests.some(request => request.file.endsWith('.exe') && !request.corrupt), requests }, null, 2));
      // This actual UI button invokes the production quitAndInstall handler.
      await cdp.evaluate("document.querySelector('#sys-update-install').click()");
      await sleep(3000);
    }
  } finally { cdp.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
