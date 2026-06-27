<#
.SYNOPSIS
  QuotaBar - interactive setup for a corporate Windows machine (Px proxy + TLS
  inspection, no WSL2). Installs/reinstalls Claude Code and Codex CLI, starts Px,
  and provides a health check. User data (login, history, JSONL) is preserved.

.DESCRIPTION
  Constrained-Language-Mode safe: uses only allowed cmdlets and external programs
  (no 'New-Object' for .NET types, no static [Type]::Method calls), so it runs even
  under PowerShell Constrained Language Mode. No admin required - all changes are in
  the user scope (HKCU, setx, npm prefix under C:\Entwicklung).

  Reinstall only replaces program files, never ~/.claude, ~/.claude.json, or
  ~/.codex, so conversation history, JSONL logs, and auth are preserved.

  Proxy/CA:
    Claude (Node): trusts the OS certificate store automatically; proxy via
                   ~/.claude/settings.json for CLI and VS Code extension.
    Codex (Rust):  does not trust the OS store; export corporate CA as PEM
                   (CODEX_CA_CERTIFICATE) and set proxy via persistent env.

.NOTES
  Runs in Windows PowerShell 5.1 and pwsh 7.
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
# Static property set is blocked under CLM; the try/catch keeps it harmless there.
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

# -- General helpers (all CLM-safe) --------------------------------------------

# Local listener check. Prefer Get-NetTCPConnection (clean, locale-independent;
# its signed NetTCPIP module loads under policy-enforced CLM). If the module cannot
# load on a locked-down host, fall back to external netstat and detect a listening
# socket by its foreign address ":0" - this is locale-independent, whereas the state
# word is localized (German Windows prints "ABHOEREN", not "LISTENING").
# System.Net.Sockets.TcpClient is avoided because CLM blocks it.
function Test-Port([string] $a, [int] $p) {
  try {
    if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { return $true }
    return $false
  } catch {
    try {
      $out = & netstat -ano 2>$null
      return [bool]($out | Where-Object { ($_ -match (":" + $p + "\s")) -and (($_ -match "0\.0\.0\.0:0\s") -or ($_ -match "\[::\]:0\s")) })
    } catch { return $false }
  }
}

# Node version as @(major, minor) ints (no [version] cast, CLM-safe).
function Get-NodeMajorMinor {
  try { $r = (& node --version) 2>$null; if ($r -match 'v(\d+)\.(\d+)') { return @([int]$Matches[1], [int]$Matches[2]) } } catch { }
  return $null
}

function Test-CmdExists([string] $name) {
  try { return [bool](Get-Command $name -ErrorAction SilentlyContinue) } catch { return $false }
}

function Get-CmdSource([string] $name) {
  try { return (Get-Command $name -ErrorAction SilentlyContinue).Source } catch { return $null }
}

# Persist a user env var: setx (external, CLM-safe, no admin) + update this session.
function Set-PersistentEnv([string] $Name, [string] $Value) {
  & setx $Name $Value | Out-Null
  Set-Item -Path ("Env:\" + $Name) -Value $Value
}

# Prepend the prefix to the user PATH via registry cmdlets (CLM-safe, no .NET).
function Set-UserPathAdd([string] $Add) {
  $key = "HKCU:\Environment"
  $cur = (Get-ItemProperty -Path $key -Name Path -ErrorAction SilentlyContinue).Path
  if ($cur -and ($cur.Split(';') -contains $Add)) {
    Write-Info "User PATH already contains: $Add"
  } else {
    $new = if ($cur) { "$Add;$cur" } else { $Add }
    New-ItemProperty -Path $key -Name Path -Value $new -PropertyType ExpandString -Force | Out-Null
    Write-Ok "Added to user PATH: $Add (takes effect in a NEW shell)"
  }
  if (($env:Path -split ';') -notcontains $Add) { $env:Path = "$Add;$env:Path" }
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

# Export Windows root CAs as a PEM bundle (superset incl. the corporate root CA).
# CLM-safe: Export-Certificate (cmdlet) + certutil -encode (external); no .NET APIs.
function Export-WindowsCaBundle([string] $OutFile) {
  $tmp = Join-Path $env:TEMP "qb-ca-export"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Get-ChildItem -Path $tmp -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Split-Path $OutFile -Parent) | Out-Null
  Set-Content -Path $OutFile -Value "" -Encoding ascii

  $seen = @{}; $i = 0
  foreach ($store in @("Cert:\LocalMachine\Root", "Cert:\CurrentUser\Root")) {
    if (-not (Test-Path $store)) { continue }
    foreach ($cert in (Get-ChildItem -Path $store -ErrorAction SilentlyContinue)) {
      if ($seen.ContainsKey($cert.Thumbprint)) { continue }
      $seen[$cert.Thumbprint] = $true
      $i++
      $cer = Join-Path $tmp "$i.cer"
      $pem = Join-Path $tmp "$i.pem"
      try {
        $cert | Export-Certificate -FilePath $cer -Type CERT -Force | Out-Null
        & certutil -encode $cer $pem 2>$null | Out-Null
        if (Test-Path $pem) { Add-Content -Path $OutFile -Value (Get-Content -Path $pem) -Encoding ascii }
      } catch { }
    }
  }
  Get-ChildItem -Path $tmp -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  return $seen.Count
}

# Persist the proxy env vars used by both Claude and Codex. Claude Code honors
# HTTPS_PROXY directly, so we deliberately do NOT rewrite ~/.claude/settings.json:
# round-tripping that file through ConvertFrom-Json/ConvertTo-Json under CLM
# corrupts existing array values (a verified failure), which would damage user
# settings. Env vars are safe and leave settings.json untouched.
function Set-ProxyEnvPersistent {
  Set-PersistentEnv "HTTP_PROXY"  $px
  Set-PersistentEnv "HTTPS_PROXY" $px
  Set-PersistentEnv "NO_PROXY"    $noProxy
  Set-PersistentEnv "NODE_USE_SYSTEM_CA" "1"
}

# -- Ensure Px is running ------------------------------------------------------
function Ensure-Px {
  if (Test-Port $PxAddr $PxPort) { Write-Ok "Px is already running on ${PxAddr}:${PxPort}"; return $true }
  if (-not (Test-Path $PxExe)) { Write-Err "px.exe not found: $PxExe"; return $false }
  if (-not (Test-Path $PxIni)) { Write-Err "px.ini not found: $PxIni"; return $false }
  Write-Info "Starting Px hidden in the background ..."
  Start-Process -FilePath $PxExe -ArgumentList @("--config=$PxIni") -WorkingDirectory (Split-Path $PxExe -Parent) -WindowStyle Hidden | Out-Null
  for ($n = 0; $n -lt 60; $n++) {
    if (Test-Port $PxAddr $PxPort) { Write-Ok "Px started and reachable on ${PxAddr}:${PxPort}"; return $true }
    Start-Sleep -Milliseconds 250
  }
  Write-Err "Px is not listening on ${PxAddr}:${PxPort} (timeout). Check px.ini/logs."
  return $false
}

# -- Install/reinstall Claude Code --------------------------------------------
function Install-ClaudeCode {
  Write-Head "Install / reinstall Claude Code"
  if (-not (Test-CmdExists "npm")) { Write-Err "npm/Node not found. Install Node 18+ from nodejs.org."; return }
  if (-not (Ensure-Px)) { Write-Err "Installation requires a running Px proxy."; return }

  Set-SessionProxyEnv
  $nv = Get-NodeMajorMinor
  if ($nv -and ($nv[0] -lt 22 -or ($nv[0] -eq 22 -and $nv[1] -lt 15))) {
    Write-Warn "Node $($nv[0]).$($nv[1]) < 22.15: NODE_USE_SYSTEM_CA may not work. If npm TLS fails, create a CA bundle (menu 4) and run 'npm config set cafile'."
  }

  # Remove only the competing native installation, never user data.
  foreach ($p in @((Join-Path $env:USERPROFILE ".local\bin\claude.exe"), (Join-Path $env:USERPROFILE ".local\share\claude"))) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Info "Removed competing native installation: $p" }
  }
  Set-UserPathAdd $NpmPrefix
  Set-NpmConfig

  # Install @latest directly (replaces any existing version; no removal gap).
  Write-Info "npm install -g $claudePkg@latest ..."
  & npm install -g "$claudePkg@latest"
  if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed (exit $LASTEXITCODE). Check proxy/CA settings."; return }
  Write-Ok "Claude Code installed."

  Set-ProxyEnvPersistent
  Write-Ok "Proxy + NODE_USE_SYSTEM_CA persisted as env vars (Claude honors HTTPS_PROXY; settings.json untouched; Px must be running)."
  Write-Info "Tip: start 'claude' in a NEW shell and log in. Fully restart VS Code afterwards."
}

# -- Install/reinstall Codex CLI ----------------------------------------------
function Install-CodexCli {
  Write-Head "Install / reinstall Codex CLI"
  if (-not (Test-CmdExists "npm")) { Write-Err "npm/Node not found. Install Node 22+ from nodejs.org."; return }
  $nv = Get-NodeMajorMinor
  if ($nv -and $nv[0] -lt 22) { Write-Warn "Node $($nv[0]).$($nv[1]) < 22: Codex CLI requires Node 22+. Please update Node." }
  if (-not (Ensure-Px)) { Write-Err "Installation requires a running Px proxy."; return }

  # Provide corporate CA bundle because Codex/Rust does not trust the OS store.
  if (-not (Test-Path $CaBundlePath)) {
    Write-Info "Exporting corporate CA bundle (may take ~10s) ..."
    $n = Export-WindowsCaBundle $CaBundlePath
    Write-Ok "Created CA bundle: $CaBundlePath ($n certificates)"
  } else { Write-Info "CA bundle already exists: $CaBundlePath (refresh via menu 4)" }

  Set-SessionProxyEnv
  $env:CODEX_CA_CERTIFICATE = $CaBundlePath
  $env:SSL_CERT_FILE        = $CaBundlePath
  Set-UserPathAdd $NpmPrefix
  Set-NpmConfig

  Write-Info "npm install -g $codexPkg@latest ..."
  & npm install -g "$codexPkg@latest"
  if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed (exit $LASTEXITCODE). Check proxy/CA settings."; return }
  Write-Ok "Codex CLI installed."

  # Codex (like Claude here) reads proxy/CA from env, so persist them as user env vars.
  Set-PersistentEnv "CODEX_CA_CERTIFICATE" $CaBundlePath
  Set-ProxyEnvPersistent
  Write-Ok "Persisted CODEX_CA_CERTIFICATE and proxy env vars; Px must be running."
  Write-Info "Tip: run 'codex login' in a NEW shell. Fully restart VS Code afterwards. ~/.codex is unchanged."
}

function Update-CaBundle {
  Write-Head "Refresh corporate CA bundle"
  Write-Info "Exporting ... (may take ~10s)"
  $n = Export-WindowsCaBundle $CaBundlePath
  Set-PersistentEnv "CODEX_CA_CERTIFICATE" $CaBundlePath
  Write-Ok "Updated CA bundle: $CaBundlePath ($n certificates)"
}

# -- Health check --------------------------------------------------------------
function Invoke-HealthCheck {
  Write-Head "Health check"
  Write-Info "PowerShell language mode: $($ExecutionContext.SessionState.LanguageMode)"
  $key = "HKCU:\Environment"

  if (Test-Port $PxAddr $PxPort) { Write-Ok "Px reachable ($px)" } else { Write-Err "Px NOT reachable ($px) - start via menu 1" }

  $nv = Get-NodeMajorMinor
  if ($nv) { Write-Ok "Node $($nv[0]).$($nv[1])" } else { Write-Err "Node/npm not found" }
  if (Test-CmdExists "npm") {
    try { $npmProxy = (& npm config get proxy) 2>$null } catch { $npmProxy = "" }
    if ($npmProxy -and $npmProxy -ne "null") { Write-Ok "npm proxy: $npmProxy" } else { Write-Warn "npm proxy is not set" }
  }

  $userPath = (Get-ItemProperty -Path $key -Name Path -ErrorAction SilentlyContinue).Path
  if ($userPath -and ($userPath.Split(';') -contains $NpmPrefix)) { Write-Ok "User PATH contains $NpmPrefix" } else { Write-Warn "User PATH does not contain $NpmPrefix - 'claude'/'codex' may not be found" }

  $envProxy = (Get-ItemProperty -Path $key -Name HTTPS_PROXY -ErrorAction SilentlyContinue).HTTPS_PROXY
  if ($envProxy) { Write-Ok "Persistent HTTPS_PROXY: $envProxy" } else { Write-Warn "Persistent HTTPS_PROXY not set - Claude/Codex won't use Px in new shells" }

  # Claude
  if (Test-CmdExists "claude") {
    try { $cv = (& claude --version) 2>$null } catch { $cv = "" }
    $src = Get-CmdSource "claude"
    Write-Ok "Claude Code: $cv  ($src)"
    if ($src -and ($src -notlike "$NpmPrefix*")) { Write-Warn "Claude is NOT under $NpmPrefix - possible old/conflicting install" }
  } else { Write-Warn "Claude Code is not installed (menu 2)" }
  if (Test-Path (Join-Path $env:USERPROFILE ".claude\.credentials.json")) { Write-Ok "Claude logged in (.credentials.json exists)" } else { Write-Warn "Claude not logged in - run 'claude' and log in" }

  # Codex
  if (Test-CmdExists "codex") {
    try { $xv = (& codex --version) 2>$null } catch { $xv = "" }
    $src = Get-CmdSource "codex"
    Write-Ok "Codex CLI: $xv  ($src)"
    if ($src -and ($src -notlike "$NpmPrefix*")) { Write-Warn "Codex is NOT under $NpmPrefix - possible old/conflicting install" }
  } else { Write-Warn "Codex CLI is not installed (menu 3)" }
  if (Test-Path (Join-Path $env:USERPROFILE ".codex\auth.json")) { Write-Ok "Codex logged in (auth.json exists)" } else { Write-Warn "Codex not logged in - run 'codex login'" }
  $codexCa = (Get-ItemProperty -Path $key -Name CODEX_CA_CERTIFICATE -ErrorAction SilentlyContinue).CODEX_CA_CERTIFICATE
  if ($codexCa -and (Test-Path $codexCa)) { Write-Ok "CODEX_CA_CERTIFICATE -> $codexCa" }
  elseif ($codexCa) { Write-Err "CODEX_CA_CERTIFICATE is set, but the file is missing: $codexCa (menu 4)" }
  else { Write-Warn "CODEX_CA_CERTIFICATE is not set - Codex fails behind TLS inspection" }

  # Connectivity through Px (curl.exe is external -> CLM-safe)
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
  Write-Host "  QuotaBar - Setup (Claude / Codex behind Px)" -ForegroundColor Cyan
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
