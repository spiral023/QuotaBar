// Runs real NSIS auto-updates exclusively inside Windows Sandbox.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

(async () => {
  assert.equal(process.platform, 'win32', 'Windows Sandbox requires Windows');
  const root = path.resolve('package-output/update-smoke');
  const results = path.join(root, `results-${Date.now()}`);
  await fs.mkdir(results, { recursive: true });
  for (const [name, version] of process.argv.includes('--reuse-builds') ? [] : [['old', '2.3.1'], ['new', '2.3.2']]) {
    const config = path.join(root, `${name}.cjs`);
    await fs.writeFile(config, `module.exports = ${JSON.stringify({
      extends: path.resolve('electron-builder.yml'),
      publish: [{ provider: 'generic', url: 'http://127.0.0.1:18765' }],
      directories: { output: path.join(root, name) }, extraMetadata: { version },
    })};\n`);
    const build = spawnSync(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--win', 'nsis', '--publish', 'never', '--config', config],
      { stdio: 'inherit', timeout: 300_000, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    assert.equal(build.status, 0, `Failed to build ${name} update fixture`);
  }
  const asar = require('@electron/asar');
  async function runtimeFiles(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const lists = await Promise.all(entries.map(entry => entry.isDirectory() ? runtimeFiles(path.join(directory, entry.name))
      : entry.name.endsWith('.d.ts') || entry.name.endsWith('.map') ? [] : [path.join(directory, entry.name)]));
    return lists.flat();
  }
  const files = (await Promise.all(['dist', 'src/renderer', 'src/config', 'assets'].map(runtimeFiles))).flat();
  for (const name of ['old', 'new']) {
    for (const file of files) {
      const packed = asar.extractFile(path.join(root, name, 'win-unpacked/resources/app.asar'), path.normalize(file));
      const current = await fs.readFile(file);
      const text = /\.(js|json|html|css|md|txt)$/i.test(file);
      assert.ok(packed.equals(current) || (text && packed.toString('utf8').replaceAll('\r\n', '\n') === current.toString('utf8').replaceAll('\r\n', '\n')),
        `Stale ${name} fixture: ${file}`);
    }
  }
  process.stdout.write(`Verified ${files.length} runtime files in both installers\n`);
  // Update metadata is generated locally; publishing stays disabled.
  await fs.copyFile(process.execPath, path.join(root, 'node.exe'));
  await fs.copyFile('tools/update-smoke-driver.cjs', path.join(root, 'driver.cjs'));
  await fs.copyFile('tools/update-smoke-sandbox.ps1', path.join(results, 'run.ps1'));
  const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const configuration = path.join(results, 'update-test.wsb');
  await fs.writeFile(configuration, String.raw`<Configuration>
<Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection>
<AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput>
<MappedFolders>
<MappedFolder><HostFolder>${escapeXml(root)}</HostFolder><SandboxFolder>C:\QuotaBarBuilds</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
<MappedFolder><HostFolder>${escapeXml(results)}</HostFolder><SandboxFolder>C:\QuotaBarResults</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
</MappedFolders>
<LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\QuotaBarResults\run.ps1</Command></LogonCommand>
</Configuration>`);
  // PowerShell is used only to launch a hidden Windows Sandbox window.
  const launch = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$process = Start-Process -FilePath "$env:WINDIR\\System32\\WindowsSandbox.exe" -ArgumentList '"${configuration.replaceAll("'", "''")}"' -WindowStyle Hidden -PassThru; $process.Id`], { encoding: 'utf8' });
  assert.equal(launch.status, 0, 'Could not launch Windows Sandbox');
  const pid = Number(launch.stdout.trim());
  process.stdout.write(`Windows Sandbox started; results: ${results}\n`);
  const deadline = Date.now() + 600_000;
  let result;
  while (Date.now() < deadline) {
    try { result = JSON.parse((await fs.readFile(path.join(results, 'result.json'), 'utf8')).replace(/^\uFEFF/, '')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  if (result) {
    // The guest has already requested shutdown. Close only the client we launched.
    setTimeout(() => {
      const cleanup = spawn('powershell.exe', ['-NoProfile', '-Command',
        `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($process -and $process.ProcessName -eq 'WindowsSandbox') { $process | Stop-Process }; if (-not (Get-Process -Name WindowsSandboxServer -ErrorAction SilentlyContinue)) { Get-CimInstance Win32_Process -Filter "Name = 'WindowsSandboxRemoteSession.exe'" | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } }`], { windowsHide: true });
      cleanup.unref();
    }, 5000);
  }
  assert.ok(result, 'Windows Sandbox update test timed out');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  assert.equal(result.success, true, 'Real installed update test failed; inspect sandbox results');
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
