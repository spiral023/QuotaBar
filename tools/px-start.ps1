<#
.SYNOPSIS
  Starts the local Px proxy if needed and sets proxy environment variables for
  the current shell so Claude/Codex CLI can use Px for corporate network egress.

.DESCRIPTION
  Px listens on 127.0.0.1:3128 and handles Kerberos/NTLM authentication to the
  upstream corporate proxy. Tools that honor HTTPS_PROXY (Claude, Codex, curl,
  git) work from this shell after the script completes.

  QuotaBar does not need these environment variables: proxy mode "Auto" detects
  a local Px instance on 127.0.0.1:3128 automatically. This script only needs to
  run so Px itself is active.

.PARAMETER Stop
  Stops a running Px process instead of starting one.

.PARAMETER Debug
  Starts Px in the foreground with log output for troubleshooting.

.EXAMPLE
  .\px-start.ps1            # Start Px and set environment variables
  .\px-start.ps1 -Debug     # Start Px visibly with logs
  .\px-start.ps1 -Stop      # Stop Px
#>
[CmdletBinding()]
param(
  [string] $PxExe   = "C:\Entwicklung\PX\px-v0.10.2-windows-amd64\px.exe",
  [string] $PxIni   = "C:\Entwicklung\PX\px-v0.10.2-windows-amd64\px.ini",
  [string] $BindAddr = "127.0.0.1",
  [int]    $BindPort = 3128,
  [int]    $StartTimeoutSec = 15,
  [switch] $Stop,
  [switch] $Debug
)

$ErrorActionPreference = "Stop"

function Test-Port([string] $Addr, [int] $Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($Addr, $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400)
    if ($ok -and $c.Connected) { $c.EndConnect($iar); return $true }
    return $false
  } catch { return $false }
  finally { if ($c) { $c.Close() } }
}

function Wait-Port([string] $Addr, [int] $Port, [int] $TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $Addr $Port) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# -- Stop mode ----------------------------------------------------------------
if ($Stop) {
  $procs = Get-Process -Name "px" -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -eq $PxExe }
  if (-not $procs) { $procs = Get-Process -Name "px" -ErrorAction SilentlyContinue }
  if ($procs) {
    $procs | Stop-Process -Force
    Write-Host "Stopped Px ($($procs.Count) process(es))." -ForegroundColor Yellow
  } else {
    Write-Host "No running Px process found." -ForegroundColor DarkGray
  }
  return
}

# -- Preconditions ------------------------------------------------------------
if (-not (Test-Path $PxExe)) { throw "px.exe not found: $PxExe" }
if (-not (Test-Path $PxIni)) { throw "px.ini not found: $PxIni" }

# -- Start Px if needed -------------------------------------------------------
if (Test-Port $BindAddr $BindPort) {
  Write-Host "Px is already running on ${BindAddr}:${BindPort}." -ForegroundColor Green
} else {
  Write-Host "Starting Px on ${BindAddr}:${BindPort} ..." -ForegroundColor Yellow
  $pxArgs = @("--config=$PxIni")
  $startOpts = @{
    FilePath         = $PxExe
    ArgumentList     = $pxArgs
    WorkingDirectory = (Split-Path $PxExe -Parent)
  }
  if ($Debug) {
    # Visible foreground process with stdout logs for troubleshooting.
    $startOpts.ArgumentList += @("--foreground", "--log=4")
    $startOpts.WindowStyle = "Normal"
  } else {
    # Hidden background process that survives closing this shell.
    $startOpts.WindowStyle = "Hidden"
  }
  Start-Process @startOpts | Out-Null

  if (-not (Wait-Port $BindAddr $BindPort $StartTimeoutSec)) {
    throw "Px is not listening on ${BindAddr}:${BindPort} (timeout ${StartTimeoutSec}s). Start with -Debug and check the log."
  }
  Write-Host "Px is reachable on ${BindAddr}:${BindPort}." -ForegroundColor Green
}

# -- Proxy environment for this shell (Claude/Codex/curl/git) -----------------
$px = "http://${BindAddr}:${BindPort}"
$noProxy = "localhost,127.0.0.1,::1"

$env:HTTP_PROXY  = $px ; $env:http_proxy  = $px
$env:HTTPS_PROXY = $px ; $env:https_proxy = $px
$env:ALL_PROXY   = $px ; $env:all_proxy   = $px
$env:NO_PROXY    = $noProxy ; $env:no_proxy = $noProxy

# Node-basierte CLIs hinter TLS-Inspection: dem Windows-Zertifikatsspeicher vertrauen.
$env:NODE_USE_SYSTEM_CA = "1"

Write-Host "Environment set: HTTPS_PROXY=$px  NO_PROXY=$noProxy  NODE_USE_SYSTEM_CA=1" -ForegroundColor Cyan

# -- Quick connectivity check -------------------------------------------------
try {
  $head = curl.exe -s -o NUL -w "%{http_code}" --max-time 10 --proxy $px https://auth.openai.com 2>$null
  if ($head -match '^\d{3}$') {
    Write-Host "Test OK: auth.openai.com -> HTTP $head via Px." -ForegroundColor Green
  } else {
    Write-Host "Test inconclusive: no HTTP response from auth.openai.com (code='$head')." -ForegroundColor DarkYellow
  }
} catch {
  Write-Host "Test failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "Ready. Claude/Codex in THIS shell use the proxy environment." -ForegroundColor Green
Write-Host "QuotaBar detects Px by itself in 'Auto' mode; no environment variables are needed."  -ForegroundColor DarkGray
