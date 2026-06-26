<#
.SYNOPSIS
  QuotaBar - interactive setup for a corporate Windows machine (Px proxy + TLS
  inspection, no WSL2). Installs/reinstalls Claude Code and Codex CLI, starts Px,
  and provides a health check. User data (login, history, JSONL) is preserved.

.DESCRIPTION
  A single menu script:
    - Px is started automatically when needed.
    - Reinstall only replaces program files, never ~/.claude, ~/.claude.json, or
      ~/.codex, so conversation history, JSONL logs, and auth are preserved.
    - Proxy/CA are configured for the relevant runtime:
        Claude (Node): trusts the OS certificate store automatically; proxy via
                       ~/.claude/settings.json for CLI and VS Code extension.
        Codex (Rust): does not trust the OS store; export corporate CA as PEM
                      and set CODEX_CA_CERTIFICATE; proxy via persistent env.
  Each step prints status messages. Runs in Windows PowerShell 5.1 and pwsh 7.

.NOTES
  This file is UTF-8 with BOM so Windows PowerShell 5.1 handles text correctly.
#>
[CmdletBinding()]
param(
  [string] $NpmPrefix    = "C:\Entwicklung\npm",
  [string] $NpmCache     = "C:\Entwicklung\npm-cache",
  [string] $PxExe        = "C:\Entwicklung\PX\px-v0.10.2-windows-amd64\px.exe",
  [string] $PxIni        = "C:\Entwicklung\PX\px-v0.10.2-windows-amd64\px.ini",
  [string] $PxAddr       = "127.0.0.1",
  [int]    $PxPort       = 3128,
  [string] $CaBundlePath = "C:\Entwicklung\certs\windows-ca-bundle.pem"
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$px      = "http://${PxAddr}:${PxPort}"
$noProxy = "localhost,127.0.0.1,::1"
$claudePkg = "@anthropic-ai/claude-code"
$codexPkg  = "@openai/codex"

# -- Output helpers ------------------------------------------------------------
function Write-Head([string] $t) { Write-Host "`n$t" -ForegroundColor Cyan; Write-Host ("-" * $t.Length) -ForegroundColor DarkCyan }
function Write-Ok  ([string] $m) { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Write-Warn([string] $m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err ([string] $m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Write-Info([string] $m) { Write-Host "  - $m" -ForegroundColor Gray }
function Pause-Menu { Write-Host ""; Read-Host "Press [Enter] to continue" | Out-Null }

# -- General helpers -----------------------------------------------------------
function Test-Port([string] $a, [int] $p) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($a, $p, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(500)
    if ($ok -and $c.Connected) { $c.EndConnect($iar); return $true }
    return $false
  } catch { return $false } finally { if ($c) { $c.Close() } }
}

function Get-NodeVersion {
  try { $r = (& node --version) 2>$null; if ($r -match 'v(\d+\.\d+\.\d+)') { return [version]$Matches[1] } } catch { }
  return $null
}

function Test-CmdExists([string] $name) {
  try { return [bool](Get-Command $name -ErrorAction SilentlyContinue) } catch { return $false }
}

function Set-UserPathAdd([string] $Add) {
  $cur = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @(); if ($cur) { $parts = $cur -split ';' | Where-Object { $_ -ne '' } }
  if ($parts -notcontains $Add) {
    [Environment]::SetEnvironmentVariable("Path", (@($Add) + $parts) -join ';', "User")
    Write-Ok "Added to user PATH: $Add"
  } else { Write-Info "User PATH already contains: $Add" }
  if (($env:Path -split ';') -notcontains $Add) { $env:Path = "$Add;$env:Path" }
}

function ConvertTo-HashtableDeep($obj) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) { $h = @{}; foreach ($k in $obj.Keys) { $h[$k] = ConvertTo-HashtableDeep $obj[$k] }; return $h }
  if ($obj -is [pscustomobject]) { $h = @{}; foreach ($pr in $obj.PSObject.Properties) { $h[$pr.Name] = ConvertTo-HashtableDeep $pr.Value }; return $h }
  if (($obj -is [System.Collections.IEnumerable]) -and ($obj -isnot [string])) { return @($obj | ForEach-Object { ConvertTo-HashtableDeep $_ }) }
  return $obj
}

function Set-SessionProxyEnv {
  $env:HTTP_PROXY  = $px ; $env:http_proxy  = $px
  $env:HTTPS_PROXY = $px ; $env:https_proxy = $px
  $env:NO_PROXY    = $noProxy ; $env:no_proxy = $noProxy
  $env:NODE_USE_SYSTEM_CA = "1"
}

function Set-NpmConfig {
  New-Item -ItemType Directory -Force -Path $NpmPrefix, $NpmCache | Out-Null
  & npm config set prefix      $NpmPrefix --global | Out-Null
  & npm config set cache       $NpmCache  --global | Out-Null
  & npm config set proxy       $px        --global | Out-Null
  & npm config set https-proxy $px        --global | Out-Null
  Write-Ok "Configured npm (prefix=$NpmPrefix, cache=$NpmCache, proxy set)"
}

# Exports all Windows root/CA certificates as a PEM bundle, including corporate CA roots.
function Export-WindowsCaBundle([string] $OutFile) {
  $stores = @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\CA', 'Cert:\CurrentUser\CA')
  $seen = @{}; $sb = New-Object System.Text.StringBuilder
  foreach ($s in $stores) {
    if (-not (Test-Path $s)) { continue }
    foreach ($cert in (Get-ChildItem $s -ErrorAction SilentlyContinue)) {
      if ($seen.ContainsKey($cert.Thumbprint)) { continue }
      $seen[$cert.Thumbprint] = $true
      $der = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
      $b64 = [Convert]::ToBase64String($der, [System.Base64FormattingOptions]::InsertLineBreaks)
      [void]$sb.AppendLine("# Subject: $($cert.Subject)")
      [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")
      [void]$sb.AppendLine($b64)
      [void]$sb.AppendLine("-----END CERTIFICATE-----")
    }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $OutFile -Parent) | Out-Null
  [System.IO.File]::WriteAllText($OutFile, $sb.ToString(), (New-Object System.Text.ASCIIEncoding))
  return $seen.Count
}

# -- Ensure Px is running ------------------------------------------------------
function Ensure-Px {
  if (Test-Port $PxAddr $PxPort) { Write-Ok "Px is already running on ${PxAddr}:${PxPort}"; return $true }
  if (-not (Test-Path $PxExe)) { Write-Err "px.exe not found: $PxExe"; return $false }
  if (-not (Test-Path $PxIni)) { Write-Err "px.ini not found: $PxIni"; return $false }
  Write-Info "Starting Px hidden in the background ..."
  Start-Process -FilePath $PxExe -ArgumentList @("--config=$PxIni") -WorkingDirectory (Split-Path $PxExe -Parent) -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) { if (Test-Port $PxAddr $PxPort) { Write-Ok "Px started and reachable on ${PxAddr}:${PxPort}"; return $true }; Start-Sleep -Milliseconds 250 }
  Write-Err "Px is not listening on ${PxAddr}:${PxPort} (timeout). Check px.ini/logs."
  return $false
}

# -- Write settings.json without BOM because JSON parsers reject a leading BOM --
function Write-JsonNoBom([string] $Path, $Object) {
  $json = ($Object | ConvertTo-Json -Depth 12)
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# -- Install/reinstall Claude Code --------------------------------------------
function Install-ClaudeCode {
  Write-Head "Install / reinstall Claude Code"
  if (-not (Test-CmdExists "npm")) { Write-Err "npm/Node not found. Install Node 18+ from nodejs.org."; return }
  if (-not (Ensure-Px)) { Write-Err "Installation requires a running Px proxy."; return }

  Set-SessionProxyEnv
  $nv = Get-NodeVersion
  if ($nv -and $nv -lt [version]"22.15.0") { Write-Warn "Node $nv < 22.15: NODE_USE_SYSTEM_CA may not work. If npm TLS fails, create a CA bundle (menu 4) and run 'npm config set cafile'." }

  # Remove only the competing native installation, never user data.
  foreach ($p in @((Join-Path $env:USERPROFILE ".local\bin\claude.exe"), (Join-Path $env:USERPROFILE ".local\share\claude"))) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Info "Removed competing native installation: $p" }
  }
  Set-UserPathAdd $NpmPrefix
  Set-NpmConfig

  Write-Info "npm install -g $claudePkg@latest ..."
  try { & npm uninstall -g $claudePkg 2>$null | Out-Null } catch { }
  & npm install -g "$claudePkg@latest"
  if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed (exit $LASTEXITCODE). Check proxy/CA settings."; return }
  Write-Ok "Claude Code installed."

  # Proxy in ~/.claude/settings.json env block for CLI and VS Code extension.
  $claudeDir = Join-Path $env:USERPROFILE ".claude"
  New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
  $settingsPath = Join-Path $claudeDir "settings.json"
  $settings = @{}
  if (Test-Path $settingsPath) {
    $raw = Get-Content $settingsPath -Raw
    if (-not [string]::IsNullOrWhiteSpace($raw)) { try { $settings = ConvertTo-HashtableDeep ($raw | ConvertFrom-Json) } catch { Write-Warn "settings.json could not be read; recreating it."; $settings = @{} } }
  }
  if ($settings['env'] -isnot [hashtable]) { $settings['env'] = @{} }
  $settings['env']['HTTPS_PROXY'] = $px
  $settings['env']['HTTP_PROXY']  = $px
  $settings['env']['NO_PROXY']    = $noProxy
  Write-JsonNoBom $settingsPath $settings
  Write-Ok "Proxy set in ~/.claude/settings.json; history/login unchanged."

  [Environment]::SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1", "User")
  Write-Info "Tip: start 'claude' in a NEW shell and log in. Fully restart VS Code afterwards."
}

# -- Install/reinstall Codex CLI ----------------------------------------------
function Install-CodexCli {
  Write-Head "Install / reinstall Codex CLI"
  if (-not (Test-CmdExists "npm")) { Write-Err "npm/Node not found. Install Node 22+ from nodejs.org."; return }
  $nv = Get-NodeVersion
  if ($nv -and $nv -lt [version]"22.0.0") { Write-Warn "Node $nv < 22: Codex CLI requires Node 22+. Please update Node." }
  if (-not (Ensure-Px)) { Write-Err "Installation requires a running Px proxy."; return }

  # Provide corporate CA bundle because Codex/Rust does not trust the OS store.
  if (-not (Test-Path $CaBundlePath)) {
    $n = Export-WindowsCaBundle $CaBundlePath
    Write-Ok "Created CA bundle: $CaBundlePath ($n certificates)"
  } else { Write-Info "CA bundle already exists: $CaBundlePath (refresh via menu 4)" }

  Set-SessionProxyEnv
  $env:CODEX_CA_CERTIFICATE = $CaBundlePath
  $env:SSL_CERT_FILE        = $CaBundlePath
  Set-UserPathAdd $NpmPrefix
  Set-NpmConfig

  Write-Info "npm install -g $codexPkg@latest ..."
  try { & npm uninstall -g $codexPkg 2>$null | Out-Null } catch { }
  & npm install -g "$codexPkg@latest"
  if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed (exit $LASTEXITCODE). Check proxy/CA settings."; return }
  Write-Ok "Codex CLI installed."

  # Codex has no settings.json env block, so proxy and CA are persisted as user env vars.
  [Environment]::SetEnvironmentVariable("CODEX_CA_CERTIFICATE", $CaBundlePath, "User")
  [Environment]::SetEnvironmentVariable("NODE_USE_SYSTEM_CA", "1", "User")
  [Environment]::SetEnvironmentVariable("HTTP_PROXY",  $px, "User")
  [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $px, "User")
  [Environment]::SetEnvironmentVariable("NO_PROXY",    $noProxy, "User")
  Write-Ok "Persisted CODEX_CA_CERTIFICATE and proxy env vars; Px must be running."
  Write-Info "Tip: run 'codex login' in a NEW shell. Fully restart VS Code afterwards. ~/.codex is unchanged."
}

function Update-CaBundle {
  Write-Head "Refresh corporate CA bundle"
  $n = Export-WindowsCaBundle $CaBundlePath
  [Environment]::SetEnvironmentVariable("CODEX_CA_CERTIFICATE", $CaBundlePath, "User")
  Write-Ok "Updated CA bundle: $CaBundlePath ($n certificates)"
}

# -- Health check --------------------------------------------------------------
function Invoke-HealthCheck {
  Write-Head "Health check"

  # Px
  if (Test-Port $PxAddr $PxPort) { Write-Ok "Px reachable ($px)" } else { Write-Err "Px NOT reachable ($px) - start via menu 1" }

  # Node / npm
  $nv = Get-NodeVersion
  if ($nv) { Write-Ok "Node $nv" } else { Write-Err "Node/npm not found" }
  if (Test-CmdExists "npm") {
    try { $npmProxy = (& npm config get proxy) 2>$null } catch { $npmProxy = "" }
    if ($npmProxy -and $npmProxy -ne "null") { Write-Ok "npm proxy: $npmProxy" } else { Write-Warn "npm proxy is not set" }
  }

  # PATH-Prefix
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ';') -contains $NpmPrefix) { Write-Ok "User PATH contains $NpmPrefix" } else { Write-Warn "User PATH does not contain $NpmPrefix - 'claude'/'codex' may not be found" }

  # Claude
  if (Test-CmdExists "claude") {
    try { $cv = (& claude --version) 2>$null } catch { $cv = "" }
    Write-Ok "Claude Code: $cv  ($((Get-Command claude).Source))"
  } else { Write-Warn "Claude Code is not installed (menu 2)" }
  $claudeCreds = Join-Path $env:USERPROFILE ".claude\.credentials.json"
  if (Test-Path $claudeCreds) { Write-Ok "Claude logged in (.credentials.json exists)" } else { Write-Warn "Claude not logged in - run 'claude' and log in" }
  $claudeSettings = Join-Path $env:USERPROFILE ".claude\settings.json"
  if (Test-Path $claudeSettings) {
    try { $hasProxy = ((Get-Content $claudeSettings -Raw | ConvertFrom-Json).env.HTTPS_PROXY) } catch { $hasProxy = $null }
    if ($hasProxy) { Write-Ok "Claude settings.json proxy: $hasProxy" } else { Write-Warn "Claude settings.json has no proxy env" }
  }

  # Codex
  if (Test-CmdExists "codex") {
    try { $xv = (& codex --version) 2>$null } catch { $xv = "" }
    Write-Ok "Codex CLI: $xv  ($((Get-Command codex).Source))"
  } else { Write-Warn "Codex CLI is not installed (menu 3)" }
  $codexAuth = Join-Path $env:USERPROFILE ".codex\auth.json"
  if (Test-Path $codexAuth) { Write-Ok "Codex logged in (auth.json exists)" } else { Write-Warn "Codex not logged in - run 'codex login'" }
  $codexCa = [Environment]::GetEnvironmentVariable("CODEX_CA_CERTIFICATE", "User")
  if ($codexCa -and (Test-Path $codexCa)) { Write-Ok "CODEX_CA_CERTIFICATE -> $codexCa" }
  elseif ($codexCa) { Write-Err "CODEX_CA_CERTIFICATE is set, but the file is missing: $codexCa (menu 4)" }
  else { Write-Warn "CODEX_CA_CERTIFICATE is not set - Codex fails behind TLS inspection" }

  # Connectivity through Px
  if (Test-Port $PxAddr $PxPort) {
    foreach ($u in @("https://api.anthropic.com", "https://auth.openai.com")) {
      try {
        $code = (& curl.exe -s -o NUL -w "%{http_code}" --max-time 10 --proxy $px $u) 2>$null
        if ($code -match '^\d{3}$') { Write-Ok "Reachable via Px: $u -> HTTP $code" } else { Write-Warn "No HTTP response: $u (code='$code')" }
      } catch { Write-Err "Test failed: $u - $($_.Exception.Message)" }
    }
  }
}

# -- Menu ---------------------------------------------------------------------
function Show-Menu {
  try { Clear-Host } catch { }
  Write-Host "==================================================" -ForegroundColor Cyan
  Write-Host "  QuotaBar - Setup (Claude / Codex hinter Px)" -ForegroundColor Cyan
  Write-Host "==================================================" -ForegroundColor Cyan
  $pxState = if (Test-Port $PxAddr $PxPort) { "running" } else { "stopped" }
  $cl = if (Test-CmdExists "claude") { "installed" } else { "missing" }
  $cx = if (Test-CmdExists "codex")  { "installed" } else { "missing" }
  Write-Host ("  User     : {0}" -f $env:USERNAME) -ForegroundColor DarkGray
  Write-Host ("  Px       : {0} ({1})" -f $pxState, $px) -ForegroundColor DarkGray
  Write-Host ("  Claude   : {0}" -f $cl) -ForegroundColor DarkGray
  Write-Host ("  Codex    : {0}" -f $cx) -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  1) Start / check Px proxy"
  Write-Host "  2) Install / reinstall Claude Code"
  Write-Host "  3) Install / reinstall Codex CLI"
  Write-Host "  4) Refresh corporate CA bundle (Codex)"
  Write-Host "  5) Install both (Claude + Codex)"
  Write-Host "  6) Health check"
  Write-Host "  0) Exit"
  Write-Host ""
  Write-Host "  User data (login, history, JSONL) is preserved for all actions." -ForegroundColor DarkGray
}

do {
  Show-Menu
  $choice = (Read-Host "Choice").Trim()
  switch ($choice) {
    "1" { Write-Head "Px proxy"; try { Ensure-Px | Out-Null } catch { Write-Err $_.Exception.Message }; Pause-Menu }
    "2" { try { Install-ClaudeCode } catch { Write-Err $_.Exception.Message }; Pause-Menu }
    "3" { try { Install-CodexCli }   catch { Write-Err $_.Exception.Message }; Pause-Menu }
    "4" { try { Update-CaBundle }    catch { Write-Err $_.Exception.Message }; Pause-Menu }
    "5" { try { Install-ClaudeCode; Install-CodexCli } catch { Write-Err $_.Exception.Message }; Pause-Menu }
    "6" { try { Invoke-HealthCheck } catch { Write-Err $_.Exception.Message }; Pause-Menu }
    "0" { Write-Host "`nExiting." -ForegroundColor Cyan }
    default { Write-Warn "Invalid choice: '$choice'"; Start-Sleep -Milliseconds 800 }
  }
} while ($choice -ne "0")
