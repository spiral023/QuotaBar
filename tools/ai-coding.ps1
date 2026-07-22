<#
.SYNOPSIS
  ai-coding - interaktives Setup für Claude Code und Codex CLI hinter Corporate
  Proxy, Px und TLS Inspection.

.DESCRIPTION
  Das Script unterstützt Windows PowerShell 5.1 und PowerShell 7, benötigt keine
  Adminrechte und ändert nur benutzerbezogene Einstellungen. Claude- und Codex-
  Benutzerdaten bleiben unangetastet: ~/.claude, ~/.claude.json und ~/.codex
  werden nicht gelöscht oder umgeschrieben.

  Das Script bleibt möglichst Constrained-Language-Mode-safe: einfache Cmdlets
  und externe Windows-Tools werden bevorzugt; .NET-Konstrukte werden vermieden,
  außer sie sind bereits vorhanden und defensiv per try/catch abgesichert.
#>
[CmdletBinding()]
param(
  [string] $NpmPrefix    = "C:\Entwicklung\npm",
  [string] $NpmCache     = "C:\Entwicklung\npm-cache",
  [string] $PxExe        = "",
  [string] $PxIni        = "",
  [string] $PxAddr       = "127.0.0.1",
  [int]    $PxPort       = 3128,
  [string] $CaBundlePath = "C:\Entwicklung\certs\windows-ca-bundle.pem",
  [string] $LogRoot      = "C:\Entwicklung\ai-coding",
  [string] $ReportRoot   = "C:\Entwicklung\ai-coding",
  [ValidateSet("Menu", "StartPx", "StopPx", "HealthCheck", "DiagnosticReport", "DryRun", "UpdateCaBundle", "InstallClaude", "InstallCodex", "InstallBoth", "UpdateAll", "ShowConfiguration")]
  [string] $Action = "Menu",
  [switch] $DryRun,
  [switch] $AssumeYes
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose "Konnte Console-Encoding nicht setzen: $($_.Exception.Message)" }

$AppName = "ai-coding"
$DevRoot = "C:\Entwicklung"
$px      = "http://${PxAddr}:${PxPort}"
$noProxy = "localhost,127.0.0.1,::1"
$claudePkg = "@anthropic-ai/claude-code"
$codexPkg  = "@openai/codex"
$Script:LogFile = $null
$Script:ActionName = ""
$Script:ChangedCount = 0
$Script:SkippedCount = 0
$Script:FailedCount = 0
$Script:WarningCount = 0
$Script:RestartNeeded = $false
$Script:IsInteractive = ($Action -eq "Menu")
$Script:AssumeYes = [bool]$AssumeYes
$Script:ClaudeStatus = $null
$Script:CodexStatus = $null

function Format-Value([string] $Value) {
  if ($null -eq $Value -or $Value -eq "") { return "<not set>" }
  return $Value
}

function Write-Log([string] $Message) {
  if ($Script:LogFile) {
    try { Add-Content -Path $Script:LogFile -Value $Message -Encoding UTF8 } catch { Write-Verbose "Konnte nicht in Logdatei schreiben: $($_.Exception.Message)" }
  }
}

function Initialize-Directory([string] $Path, [switch] $DryRun) {
  $exists = Test-Path $Path
  if ($exists) {
    Write-Change "Ordner $Path" "present" "present" "Skipped - already exists" -DryRun:$DryRun
    return
  }
  if ($DryRun) {
    Write-Change "Ordner $Path" "<not present>" "present" "Would create" -DryRun
    return
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $after = if (Test-Path $Path) { "present" } else { "<not present>" }
  $result = if ($after -eq "present") { "Changed" } else { "Failed" }
  Write-Change "Ordner $Path" "<not present>" $after $result
}

function Initialize-Logging {
  if ($Script:LogFile) { return }
  $hadLogRoot = Test-Path $LogRoot
  New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
  $Script:LogFile = Join-Path $LogRoot "$AppName.log"
  if (-not (Test-Path $Script:LogFile)) {
    Set-Content -Path $Script:LogFile -Value "$AppName Änderungsjournal" -Encoding UTF8
  }
  if (-not $hadLogRoot) {
    Write-Log "CHANGE Ordner $LogRoot"
    Write-Log "Old    : <not present>"
    Write-Log "New    : present"
    Write-Log "Result : Changed"
    Write-Log ""
  }
}

function Write-ConsoleLine([string] $Message, [string] $Color) {
  if ($Color) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message }
}

function Write-Head([string] $t) {
  Write-ConsoleLine "`n$t" "Cyan"
  Write-ConsoleLine ("-" * $t.Length) "DarkCyan"
}

function Write-Ok([string] $m) { Write-ConsoleLine "  [ OK ] $m" "Green" }
function Write-Warn([string] $m) { $Script:WarningCount++; Write-ConsoleLine "  [WARN] $m" "Yellow" }
function Write-Err([string] $m) { $Script:FailedCount++; Write-ConsoleLine "  [FAIL] $m" "Red" }
function Write-Info([string] $m) { Write-ConsoleLine "  - $m" "Gray" }

function Write-Change([string] $Name, [string] $Old, [string] $New, [string] $Result, [switch] $DryRun) {
  $prefix = if ($DryRun) { "DRYRUN CHANGE" } else { "CHANGE" }
  Write-Log "$prefix $Name"
  Write-Log ("Old    : {0}" -f (Format-Value $Old))
  Write-Log ("New    : {0}" -f (Format-Value $New))
  Write-Log ("Result : {0}" -f $Result)
  Write-Log ""
  if ($DryRun) {
    Write-Info "$prefix $Name -> $Result"
    return
  }
  if ($Result -like "Changed*") { $Script:ChangedCount++ }
  elseif ($Result -like "Skipped*") { $Script:SkippedCount++ }
  elseif ($Result -like "Failed*") { $Script:FailedCount++ }
}

function Write-ExternalCommandLog([string] $CommandLine, [int] $ExitCode, [string] $Result) {
  Write-Log "COMMAND $CommandLine"
  Write-Log "ExitCode : $ExitCode"
  Write-Log "Result   : $Result"
  Write-Log ""
}

function Invoke-ExternalCommand([string] $Command, [string[]] $Arguments, [string] $DisplayName) {
  $cmdLine = "$Command $($Arguments -join ' ')"
  Write-Info $DisplayName
  try {
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & $Command @Arguments 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $savedEAP
    if ($out) {
      foreach ($line in $out) {
        $text = "$line"
        Write-ConsoleLine "    $text" "DarkGray"
      }
    }
    if ($code -eq 0) {
      Write-ExternalCommandLog $cmdLine $code "OK"
    } else {
      Write-ExternalCommandLog $cmdLine $code "Failed"
      $Script:FailedCount++
    }
    return $code
  } catch {
    Write-ExternalCommandLog $cmdLine 999 "Failed - $($_.Exception.Message)"
    $Script:FailedCount++
    return 999
  }
}

function Wait-Menu {
  Write-ConsoleLine "" ""
  Read-Host "Weiter mit [Enter]" | Out-Null
}

function Confirm-YesNo([string] $Prompt, [bool] $DefaultYes = $true) {
  if ($Script:AssumeYes) {
    Write-Info "$Prompt Ja (-AssumeYes)"
    return $true
  }
  if (-not $Script:IsInteractive) {
    $defaultText = if ($DefaultYes) { "Ja" } else { "Nein" }
    Write-Info "$Prompt $defaultText (Non-Interactive Default)"
    return $DefaultYes
  }
  $answer = (Read-Host $Prompt).Trim()
  if ($answer -eq "") { return $DefaultYes }
  if ($answer -match '^(j|ja|y|yes)$') { return $true }
  if ($answer -match '^(n|nein|no)$') { return $false }
  $defaultText = if ($DefaultYes) { "Ja" } else { "Nein" }
  Write-Warn "Ungültige Antwort '$answer'. Verwende Default: $defaultText."
  return $DefaultYes
}

function Reset-ActionCounter([string] $Name) {
  $Script:ActionName = $Name
  $Script:ChangedCount = 0
  $Script:SkippedCount = 0
  $Script:FailedCount = 0
  $Script:WarningCount = 0
  $Script:RestartNeeded = $false
}

function Show-ActionSummary {
  $reachable = if (Test-Port $PxAddr $PxPort) { "ja" } else { "nein" }
  $restart = if ($Script:RestartNeeded) { "ja" } else { "nein" }
  Write-ConsoleLine "`nSummary:" "Cyan"
  Write-ConsoleLine ("- Action        : {0}" -f $Script:ActionName) "Gray"
  Write-ConsoleLine ("- Changes       : {0} changed, {1} skipped, {2} failed, {3} warnings" -f $Script:ChangedCount, $Script:SkippedCount, $Script:FailedCount, $Script:WarningCount) "Gray"
  Write-ConsoleLine ("- Px reachable  : {0}" -f $reachable) "Gray"
  Write-ConsoleLine ("- Restart needed: {0}" -f $restart) "Gray"
  Write-ConsoleLine ("- Log file      : {0}" -f $Script:LogFile) "Gray"
}

function Show-RestartNotice {
  $Script:RestartNeeded = $true
  Write-ConsoleLine "`nWICHTIGE NÄCHSTE SCHRITTE:" "Yellow"
  Write-ConsoleLine "1) Öffne ein NEUES PowerShell-Fenster." "Yellow"
  Write-ConsoleLine "2) Starte VS Code vollständig neu." "Yellow"
  Write-ConsoleLine "3) Führe danach aus:" "Yellow"
  Write-ConsoleLine "   claude" "Yellow"
  Write-ConsoleLine "   codex login" "Yellow"
}

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

function Get-PxStatus {
  $listening = Test-Port $PxAddr $PxPort
  $owners = @()
  try {
    $ids = @(Get-NetTCPConnection -LocalPort $PxPort -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
    if ($ids.Count -gt 0) { $owners = @(Get-Process -Id $ids -ErrorAction SilentlyContinue) }
  } catch { Write-Verbose "Konnte Port-Owner für Port $PxPort nicht ermitteln: $($_.Exception.Message)" }
  $pxOwner = @($owners | Where-Object { $_.ProcessName -ieq "px" })
  $pxByName = @(Get-Process -Name "px" -ErrorAction SilentlyContinue)
  $pxRunning = ($pxByName.Count -gt 0) -or ($pxOwner.Count -gt 0)
  $pxProcessId = if ($pxOwner.Count -gt 0) { $pxOwner[0].Id } elseif ($pxByName.Count -gt 0) { $pxByName[0].Id } else { $null }
  $ownerText = if ($owners.Count -gt 0) { ($owners | ForEach-Object { "{0} (PID {1})" -f $_.ProcessName, $_.Id }) -join ", " } else { "unbekannter Prozess" }
  return [pscustomobject]@{
    Listening = $listening
    PxRunning = $pxRunning
    PxPid     = $pxProcessId
    OwnerText = $ownerText
  }
}

function Get-NodeMajorMinor([string] $VersionText) {
  try {
    $r = $VersionText
    if (-not $r) { $r = (& node --version) 2>$null }
    if ($r -match 'v(\d+)\.(\d+)') { return @([int]$Matches[1], [int]$Matches[2]) }
  } catch { Write-Verbose "Konnte Node-Version nicht ermitteln: $($_.Exception.Message)" }
  return $null
}

function Test-CmdExist([string] $name) {
  try { return [bool](Get-Command $name -ErrorAction SilentlyContinue) } catch { return $false }
}

function Get-CmdSource([string] $name) {
  try { return (Get-Command $name -ErrorAction SilentlyContinue).Source } catch { return $null }
}

function Get-UserEnvValue([string] $Name) {
  try { return (Get-ItemProperty -Path "HKCU:\Environment" -Name $Name -ErrorAction SilentlyContinue).$Name } catch { return $null }
}

function Set-PersistentEnv([string] $Name, [string] $Value, [switch] $DryRun) {
  $old = Get-UserEnvValue $Name
  if ($old -eq $Value) {
    Write-Change "UserEnv $Name" $old $Value "Skipped - already correct" -DryRun:$DryRun
    return
  }
  if ($DryRun) {
    Write-Change "UserEnv $Name" $old $Value "Would change" -DryRun
    return
  }
  $code = Invoke-ExternalCommand "setx" @($Name, $Value) "setx $Name ..."
  if ($code -eq 0) {
    Set-Item -Path ("Env:\" + $Name) -Value $Value
    $new = Get-UserEnvValue $Name
    Write-Change "UserEnv $Name" $old $new "Changed"
    $Script:RestartNeeded = $true
  } else {
    Write-Change "UserEnv $Name" $old $Value "Failed - setx exit $code"
  }
}

function Set-UserPathAdd([string] $Add, [switch] $DryRun) {
  $key = "HKCU:\Environment"
  $cur = (Get-ItemProperty -Path $key -Name Path -ErrorAction SilentlyContinue).Path
  if ($cur -and ($cur.Split(';') -contains $Add)) {
    Write-Change "User-PATH" $cur $cur "Skipped - already contains $Add" -DryRun:$DryRun
  } else {
    $new = if ($cur) { "$Add;$cur" } else { $Add }
    if ($DryRun) {
      Write-Change "User-PATH" $cur $new "Would change" -DryRun
    } else {
      New-ItemProperty -Path $key -Name Path -Value $new -PropertyType ExpandString -Force | Out-Null
      Write-Change "User-PATH" $cur ((Get-ItemProperty -Path $key -Name Path -ErrorAction SilentlyContinue).Path) "Changed"
      $Script:RestartNeeded = $true
    }
  }
  if (-not $DryRun -and (($env:Path -split ';') -notcontains $Add)) { $env:Path = "$Add;$env:Path" }
}

function Set-SessionProxyEnv {
  foreach ($pair in @(
    @("HTTP_PROXY", $px), @("http_proxy", $px),
    @("HTTPS_PROXY", $px), @("https_proxy", $px),
    @("NO_PROXY", $noProxy), @("no_proxy", $noProxy),
    @("NODE_USE_SYSTEM_CA", "1")
  )) {
    $name = $pair[0]
    $value = $pair[1]
    $old = (Get-Item -Path ("Env:\" + $name) -ErrorAction SilentlyContinue).Value
    if ($old -eq $value) {
      Write-Change "SessionEnv $name" $old $value "Skipped - already correct"
    } else {
      Set-Item -Path ("Env:\" + $name) -Value $value
      Write-Change "SessionEnv $name" $old $value "Changed"
    }
  }
}

function Get-NpmConfigValue([string] $Name) {
  try {
    $value = (& npm config get $Name --global) 2>$null
    if ($value -eq "null" -or $value -eq "undefined") { return $null }
    return "$value"
  } catch { return $null }
}

function Set-NpmConfigValue([string] $Name, [string] $Value, [switch] $DryRun) {
  $old = Get-NpmConfigValue $Name
  if ($old -eq $Value) {
    Write-Change "npm $Name" $old $Value "Skipped - already correct" -DryRun:$DryRun
    return
  }
  if ($DryRun) {
    Write-Change "npm $Name" $old $Value "Would change" -DryRun
    return
  }
  $code = Invoke-ExternalCommand "npm" @("config", "set", $Name, $Value, "--global") "npm config set $Name ..."
  if ($code -eq 0) {
    Write-Change "npm $Name" $old (Get-NpmConfigValue $Name) "Changed"
  } else {
    Write-Change "npm $Name" $old $Value "Failed - npm exit $code"
  }
}

function Set-NpmConfig([switch] $DryRun) {
  Initialize-Directory $NpmPrefix -DryRun:$DryRun
  Initialize-Directory $NpmCache -DryRun:$DryRun
  Set-NpmConfigValue "prefix" $NpmPrefix -DryRun:$DryRun
  Set-NpmConfigValue "cache" $NpmCache -DryRun:$DryRun
  Set-NpmConfigValue "proxy" $px -DryRun:$DryRun
  Set-NpmConfigValue "https-proxy" $px -DryRun:$DryRun
  Set-NpmConfigValue "allow-scripts" $claudePkg -DryRun:$DryRun
  if (-not $DryRun) { Write-Ok "npm wurde konfiguriert." }
}

function Export-WindowsCaBundle([string] $OutFile, [switch] $DryRun) {
  $old = if (Test-Path $OutFile) { "present" } else { "<not present>" }
  if ($DryRun) {
    Write-Change "CA-Bundle $OutFile" $old "present" "Would create or update" -DryRun
    return 0
  }
  if (-not (Test-CmdExist "certutil")) {
    Write-Err "certutil wurde nicht gefunden. CA-Bundle kann nicht exportiert werden."
    Write-Change "CA-Bundle $OutFile" $old $old "Failed - certutil missing"
    return 0
  }

  $stamp = Get-Date -Format "yyyyMMddHHmmssfff"
  $tmpRoot = Join-Path $env:TEMP "$AppName-ca-export-$stamp-$PID"
  $tmpOut = Join-Path $tmpRoot "windows-ca-bundle.pem"
  $seen = @{}
  $exported = 0
  try {
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
    Set-Content -Path $tmpOut -Value "" -Encoding ascii

    # Root- UND CA-Stores (Intermediates) exportieren. TLS-inspizierende Firmenproxys
    # praesentieren oft ein Leaf, das von einer Issuing-/Intermediate-CA signiert ist
    # (z. B. GRZ-ISSUING-CA-31), deren Zertifikat nur im \CA-Store liegt. Fehlt es im
    # Bundle, scheitert Codex (rustls) mit "invalid peer certificate: UnknownIssuer".
    foreach ($store in @("Cert:\LocalMachine\Root", "Cert:\CurrentUser\Root", "Cert:\LocalMachine\CA", "Cert:\CurrentUser\CA")) {
      if (-not (Test-Path $store)) { continue }
      foreach ($cert in (Get-ChildItem -Path $store -ErrorAction SilentlyContinue)) {
        if ($seen.ContainsKey($cert.Thumbprint)) { continue }
        $seen[$cert.Thumbprint] = $true
        $cer = Join-Path $tmpRoot "$($seen.Count).cer"
        $pem = Join-Path $tmpRoot "$($seen.Count).pem"
        try {
          $cert | Export-Certificate -FilePath $cer -Type CERT -Force | Out-Null
          & certutil -encode $cer $pem 2>$null | Out-Null
          $code = $LASTEXITCODE
          Write-ExternalCommandLog "certutil -encode $cer $pem" $code $(if ($code -eq 0) { "OK" } else { "Failed" })
          if ($code -eq 0 -and (Test-Path $pem)) {
            Add-Content -Path $tmpOut -Value (Get-Content -Path $pem) -Encoding ascii
            $exported++
          }
        } catch { Write-Verbose "Zertifikat $($cert.Thumbprint) konnte nicht exportiert werden: $($_.Exception.Message)" }
      }
    }

    $hasPem = $false
    try { $hasPem = [bool](Select-String -Path $tmpOut -Pattern "-----BEGIN CERTIFICATE-----" -SimpleMatch -Quiet -ErrorAction SilentlyContinue) } catch { $hasPem = $false }
    if ($exported -lt 1 -or -not $hasPem) {
      Write-Err "CA-Bundle-Export ist fehlgeschlagen oder leer. Bestehende Datei bleibt unverändert."
      Write-Change "CA-Bundle $OutFile" $old $old "Failed - no valid PEM output"
      return 0
    }

    Initialize-Directory (Split-Path $OutFile -Parent)
    Move-Item -Path $tmpOut -Destination $OutFile -Force
    $finalHasPem = $false
    try { $finalHasPem = [bool](Select-String -Path $OutFile -Pattern "-----BEGIN CERTIFICATE-----" -SimpleMatch -Quiet -ErrorAction SilentlyContinue) } catch { $finalHasPem = $false }
    if (-not $finalHasPem) {
      Write-Err "CA-Bundle wurde nicht gültig geschrieben."
      Write-Change "CA-Bundle $OutFile" $old "<invalid>" "Failed - final PEM validation failed"
      return 0
    }
    $size = 0
    try { $size = (Get-Item -Path $OutFile -ErrorAction Stop).Length } catch { Write-Verbose "Konnte Dateigröße von $OutFile nicht ermitteln: $($_.Exception.Message)" }
    Write-Change "CA-Bundle $OutFile" $old "present ($exported certificates, $size bytes)" "Changed"
    return $exported
  } finally {
    if ($tmpRoot -and (Test-Path $tmpRoot)) {
      Get-ChildItem -Path $tmpRoot -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
      Remove-Item -Path $tmpRoot -Force -ErrorAction SilentlyContinue
    }
  }
}

function Set-ProxyEnvPersistent([switch] $DryRun) {
  Set-PersistentEnv "HTTP_PROXY" $px -DryRun:$DryRun
  Set-PersistentEnv "HTTPS_PROXY" $px -DryRun:$DryRun
  Set-PersistentEnv "NO_PROXY" $noProxy -DryRun:$DryRun
  Set-PersistentEnv "NODE_USE_SYSTEM_CA" "1" -DryRun:$DryRun
}

function Resolve-PxPath {
  if ($PxIni -and (Test-Path $PxIni)) {
    $dir = Split-Path $PxIni -Parent
    $candidateExe = Join-Path $dir "px.exe"
    if ((-not $PxExe -or -not (Test-Path $PxExe)) -and (Test-Path $candidateExe)) { Set-Variable -Scope Script -Name PxExe -Value $candidateExe }
    return ((Test-Path $PxIni) -and $PxExe -and (Test-Path $PxExe))
  }

  if ($PxExe -and (Test-Path $PxExe)) {
    $dir = Split-Path $PxExe -Parent
    $candidateIni = Join-Path $dir "px.ini"
    if (Test-Path $candidateIni) {
      Set-Variable -Scope Script -Name PxIni -Value $candidateIni
      return $true
    }
  }

  if (-not (Test-Path $DevRoot)) { return $false }

  $found = $null
  $fallback = $null
  try {
    foreach ($item in (Get-ChildItem -Path $DevRoot -Filter "px.ini" -Recurse -ErrorAction SilentlyContinue)) {
      if (-not $fallback) { $fallback = $item }
      $candidateExe = Join-Path $item.DirectoryName "px.exe"
      if (Test-Path $candidateExe) {
        $found = $item
        break
      }
    }
  } catch { Write-Verbose "Suche nach px.ini unter $DevRoot fehlgeschlagen: $($_.Exception.Message)" }

  if (-not $found) { $found = $fallback }
  if (-not $found) { return $false }

  Set-Variable -Scope Script -Name PxIni -Value $found.FullName
  Set-Variable -Scope Script -Name PxExe -Value (Join-Path $found.DirectoryName "px.exe")
  return (Test-Path $PxExe)
}

function Show-PxHelp {
  Resolve-PxPath | Out-Null
  $dir = if ($PxExe) { Split-Path $PxExe -Parent } else { $DevRoot }
  Write-Info "Px ist eine einmalige manuelle Voraussetzung."
  Write-Info "1) Lade Px herunter: https://github.com/genotrance/px/releases"
  Write-Info "   Verwende die Windows-amd64-ZIP."
  Write-Info "2) Entpacke Px unter C:\Entwicklung. Der genaue Versionsordner ist egal."
  Write-Info "   Das Script sucht gezielt unter C:\Entwicklung nach px.ini und erwartet px.exe im selben Ordner."
  Write-Info "   Aktuell erkannter Px-Ordner: $dir"
  Write-Info "   Du kannst den Pfad weiterhin mit -PxExe und -PxIni explizit überschreiben."
  Write-Info "3) Lege px.ini neben px.exe ab, mindestens mit:"
  Write-Info "     [proxy]"
  Write-Info "     server = dein-proxy-host:8080"
  Write-Info "     listen = 127.0.0.1"
  Write-Info "     port   = $PxPort"
  Write-Info "Nutze Werkzeuge & Ordner > Px-Downloadseite öffnen, um die Px-Downloadseite zu öffnen."
}

function Initialize-Px {
  $status = Get-PxStatus
  if ($status.Listening) {
    if ($status.PxRunning) {
      $pidText = if ($status.PxPid) { " (PID $($status.PxPid))" } else { "" }
      Write-Ok "Px läuft bereits auf ${PxAddr}:${PxPort}$pidText."
      return $true
    }
    Write-Err "Port ${PxAddr}:${PxPort} ist belegt, aber es läuft kein px-Prozess. Belegt durch: $($status.OwnerText)."
    Write-Info "Beende den fremden Prozess oder nutze einen anderen Port (-PxPort), damit Px gestartet werden kann."
    return $false
  }
  if (-not (Resolve-PxPath)) { Write-Err "px.ini und px.exe wurden unter $DevRoot nicht gemeinsam gefunden."; Show-PxHelp; return $false }
  if (-not (Test-Path $PxExe)) { Write-Err "px.exe wurde nicht gefunden: $PxExe"; Show-PxHelp; return $false }
  if (-not (Test-Path $PxIni)) { Write-Err "px.ini wurde nicht gefunden: $PxIni"; Show-PxHelp; return $false }
  Write-Info "Px wird im Hintergrund gestartet ..."
  $proc = Start-Process -FilePath $PxExe -ArgumentList @("--config=$PxIni") -WorkingDirectory (Split-Path $PxExe -Parent) -WindowStyle Hidden -PassThru
  for ($n = 0; $n -lt 60; $n++) {
    if (Test-Port $PxAddr $PxPort) { Write-Ok "Px wurde gestartet und ist erreichbar auf ${PxAddr}:${PxPort} (PID $($proc.Id))."; return $true }
    # px.exe kann per fork/daemonize einen Kindprozess hinterlassen; nur Fehler, wenn gar kein px mehr läuft
    if ($proc.HasExited -and -not (Get-Process -Name "px" -ErrorAction SilentlyContinue)) {
      Write-Err "px.exe wurde unerwartet beendet (ExitCode $($proc.ExitCode)). Prüfe px.ini und Px-Logs."
      return $false
    }
    Start-Sleep -Milliseconds 250
  }
  Write-Err "Px lauscht nicht auf ${PxAddr}:${PxPort}. Prüfe px.ini und Px-Logs."
  return $false
}

function Stop-Px {
  Write-Head "Px-Proxy stoppen"
  $status = Get-PxStatus
  if (-not $status.Listening -and -not $status.PxRunning) {
    Write-Ok "Px läuft nicht - es ist nichts zu stoppen."
    return
  }
  # px-Prozesse per Name sammeln ...
  $targets = @{}
  foreach ($p in @(Get-Process -Name "px" -ErrorAction SilentlyContinue)) { $targets[[int]$p.Id] = $p }
  # ... plus den tatsaechlichen Port-Listener (px daemonisiert per fork; der Owner kann ein Kind sein).
  $ownerIds = @()
  try {
    $ownerIds = @(Get-NetTCPConnection -LocalPort $PxPort -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
  } catch { Write-Verbose "Konnte Port-Owner für Port $PxPort nicht ermitteln: $($_.Exception.Message)" }
  # Kein px-Prozess, aber der Port ist belegt: fremder Prozess - nicht blind beenden (analog Initialize-Px).
  if ($targets.Count -eq 0 -and $ownerIds.Count -gt 0) {
    Write-Warn "Port ${PxAddr}:${PxPort} ist belegt, aber es läuft kein px-Prozess. Belegt durch: $($status.OwnerText)."
    Write-Info "Dieser fremde Prozess wird nicht automatisch beendet. Beende ihn bei Bedarf selbst."
    return
  }
  foreach ($id in $ownerIds) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc) { $targets[[int]$proc.Id] = $proc }
  }
  foreach ($proc in $targets.Values) {
    try {
      Stop-Process -Id $proc.Id -Force -ErrorAction Stop
      Write-Change "Px-Prozess $($proc.ProcessName) (PID $($proc.Id))" "läuft" "gestoppt" "Changed"
    } catch {
      Write-Err "Konnte Prozess $($proc.ProcessName) (PID $($proc.Id)) nicht beenden: $($_.Exception.Message)"
    }
  }
  Start-Sleep -Milliseconds 400
  if (Test-Port $PxAddr $PxPort) {
    Write-Warn "Port ${PxAddr}:${PxPort} ist weiterhin belegt. Ggf. sind Adminrechte nötig oder der Prozess wurde neu gestartet."
  } else {
    Write-Ok "Px wurde gestoppt."
  }
}

function Remove-CompetingClaudeNativeInstall([switch] $DryRun) {
  $targets = @((Join-Path $env:USERPROFILE ".local\bin\claude.exe"), (Join-Path $env:USERPROFILE ".local\share\claude"))
  $found = @()
  foreach ($p in $targets) {
    if (Test-Path $p) {
      $found += $p
    } else {
      Write-Change "Konkurrierende Claude-Installation $p" "<not present>" "<not present>" "Skipped - not present" -DryRun:$DryRun
    }
  }
  if ($found.Count -eq 0) { return }
  if ($DryRun) {
    foreach ($p in $found) { Write-Change "Konkurrierende Claude-Installation $p" "present" "<not present>" "Would remove" -DryRun }
    return
  }
  if (-not (Confirm-YesNo "Native Claude-Installation wurde gefunden. Entfernen? [J/n]" $true)) {
    foreach ($p in $found) { Write-Change "Konkurrierende Claude-Installation $p" "present" "present" "Skipped - user declined" }
    return
  }
  foreach ($p in $found) {
    if ($DryRun) {
      Write-Change "Konkurrierende Claude-Installation $p" "present" "<not present>" "Would remove" -DryRun
      continue
    }
    Remove-Item $p -Recurse -Force
    $after = if (Test-Path $p) { "present" } else { "<not present>" }
    $result = if ($after -eq "<not present>") { "Changed" } else { "Failed" }
    Write-Change "Konkurrierende Claude-Installation $p" "present" $after $result
  }
}

function Install-ClaudeCode([switch] $DryRun) {
  Write-Head "Claude Code installieren / neu installieren"
  if (-not (Test-CmdExist "npm")) { Write-Err "npm/Node wurde nicht gefunden. Installiere Node 18+."; return }
  if (-not $DryRun -and -not (Initialize-Px)) { Write-Err "Die Installation benötigt einen laufenden Px-Proxy."; return }
  if (-not $DryRun) { Set-SessionProxyEnv }
  $nv = Get-NodeMajorMinor
  if ($nv -and ($nv[0] -lt 22 -or ($nv[0] -eq 22 -and $nv[1] -lt 15))) {
    Write-Warn "Node $($nv[0]).$($nv[1]) ist kleiner als 22.15; NODE_USE_SYSTEM_CA kann dadurch eingeschränkt sein."
  }
  Remove-CompetingClaudeNativeInstall -DryRun:$DryRun
  Set-UserPathAdd $NpmPrefix -DryRun:$DryRun
  Set-NpmConfig -DryRun:$DryRun
  if ($DryRun) {
    Write-Change "npm install $claudePkg@latest" "<not run>" "would run" "Would execute" -DryRun
    return
  }
  $code = Invoke-ExternalCommand "npm" @("install", "-g", "$claudePkg@latest") "npm install -g $claudePkg@latest ..."
  Write-Change "npm install $claudePkg@latest" "<not run>" "exit $code" $(if ($code -eq 0) { "Changed" } else { "Failed - npm exit $code" })
  if ($code -ne 0) { Write-Err "npm install ist fehlgeschlagen. Prüfe Proxy- und CA-Einstellungen."; return }
  Write-Ok "Claude Code wurde installiert."
  Initialize-AgentVersionCache
  Set-ProxyEnvPersistent
  Write-Ok "Proxy und NODE_USE_SYSTEM_CA wurden als Benutzer-Umgebungsvariablen gespeichert."
  Write-Info "Nach der Installation funktionieren die Claude CLI und die Claude-Erweiterung in einem neu gestarteten VS Code mit diesen Einstellungen."
  Show-RestartNotice
}

function Install-CodexCli([switch] $DryRun) {
  Write-Head "Codex CLI installieren / neu installieren"
  if (-not (Test-CmdExist "npm")) { Write-Err "npm/Node wurde nicht gefunden. Installiere Node 22+."; return }
  $nv = Get-NodeMajorMinor
  if ($nv -and $nv[0] -lt 22) { Write-Warn "Node $($nv[0]).$($nv[1]) ist kleiner als 22; Codex CLI benötigt Node 22+." }
  if (-not $DryRun -and -not (Initialize-Px)) { Write-Err "Die Installation benötigt einen laufenden Px-Proxy."; return }
  if (-not (Test-Path $CaBundlePath)) {
    Write-Info "CA-Bundle wird erstellt ..."
    $caCount = Export-WindowsCaBundle $CaBundlePath -DryRun:$DryRun
    if (-not $DryRun -and $caCount -lt 1) { Write-Err "Die Codex-Installation wird abgebrochen, weil kein gültiges CA-Bundle erstellt wurde."; return }
  } else {
    Write-Change "CA-Bundle $CaBundlePath" "present" "present" "Skipped - already exists" -DryRun:$DryRun
  }
  if (-not $DryRun) {
    Set-SessionProxyEnv
    $env:CODEX_CA_CERTIFICATE = $CaBundlePath
    $env:SSL_CERT_FILE = $CaBundlePath
    $env:NODE_EXTRA_CA_CERTS = $CaBundlePath
    $env:NODE_USE_ENV_PROXY = "1"
  }
  Set-UserPathAdd $NpmPrefix -DryRun:$DryRun
  Set-NpmConfig -DryRun:$DryRun
  if ($DryRun) {
    Write-Change "npm install $codexPkg@latest" "<not run>" "would run" "Would execute" -DryRun
    return
  }
  $code = Invoke-ExternalCommand "npm" @("install", "-g", "$codexPkg@latest") "npm install -g $codexPkg@latest ..."
  Write-Change "npm install $codexPkg@latest" "<not run>" "exit $code" $(if ($code -eq 0) { "Changed" } else { "Failed - npm exit $code" })
  if ($code -ne 0) { Write-Err "npm install ist fehlgeschlagen. Prüfe Proxy- und CA-Einstellungen."; return }
  Write-Ok "Codex CLI wurde installiert."
  Initialize-AgentVersionCache
  Set-PersistentEnv "CODEX_CA_CERTIFICATE" $CaBundlePath
  Set-PersistentEnv "SSL_CERT_FILE" $CaBundlePath
  Set-PersistentEnv "NODE_EXTRA_CA_CERTS" $CaBundlePath
  Set-PersistentEnv "NODE_USE_ENV_PROXY" "1"
  Set-ProxyEnvPersistent
  Write-Info "Nach der Installation funktionieren Codex CLI, Codex Login, die VS Code Extension und die MS Store App mit laufendem Px und diesen Benutzer-Umgebungsvariablen."
  Show-RestartNotice
}

function Update-CaBundle([switch] $DryRun) {
  Write-Head "Corporate-CA-Bundle aktualisieren"
  $n = Export-WindowsCaBundle $CaBundlePath -DryRun:$DryRun
  if (-not $DryRun) {
    if ($n -lt 1) { Write-Err "CA-Bundle wurde nicht aktualisiert."; return }
    Set-PersistentEnv "CODEX_CA_CERTIFICATE" $CaBundlePath
    Set-PersistentEnv "SSL_CERT_FILE" $CaBundlePath
    Set-PersistentEnv "NODE_EXTRA_CA_CERTS" $CaBundlePath
    Set-PersistentEnv "NODE_USE_ENV_PROXY" "1"
    Write-Ok "CA-Bundle wurde aktualisiert: $CaBundlePath ($n Zertifikate)"
    Show-RestartNotice
  }
}

function Update-AllTools([switch] $DryRun) {
  Write-Head "Alle Tools auf neueste Version aktualisieren"
  if (-not (Test-CmdExist "npm")) { Write-Err "npm/Node wurde nicht gefunden. Installiere Node 22+."; return }
  if (-not $DryRun -and -not (Initialize-Px)) { Write-Err "Das Update benötigt einen laufenden Px-Proxy."; return }
  if (-not $DryRun) { Set-SessionProxyEnv }
  $tools = @(
    @{ Label = "Claude Code"; Package = $claudePkg },
    @{ Label = "Codex CLI"; Package = $codexPkg }
  )
  foreach ($tool in $tools) {
    if ($DryRun) {
      Write-Change "npm install $($tool.Package)@latest" "<not run>" "would run" "Would execute" -DryRun
      continue
    }
    $code = Invoke-ExternalCommand "npm" @("install", "-g", "$($tool.Package)@latest") "npm install -g $($tool.Package)@latest ..."
    Write-Change "npm install $($tool.Package)@latest" "<not run>" "exit $code" $(if ($code -eq 0) { "Changed" } else { "Failed - npm exit $code" })
    if ($code -ne 0) { Write-Err "$($tool.Label): Update ist fehlgeschlagen. Prüfe Proxy- und CA-Einstellungen." }
  }
  if (-not $DryRun) { Show-CodingAgentUpdate }
}

function Test-UrlViaPx([string] $Url) {
  if (-not (Test-Port $PxAddr $PxPort)) { return "nicht getestet, Px läuft nicht" }
  if (-not (Test-CmdExist "curl.exe")) { return "nicht getestet, curl.exe fehlt" }
  try {
    $code = (& curl.exe -s -o NUL -w "%{http_code}" --max-time 10 --proxy $px $Url) 2>$null
    if ($code -match '^\d{3}$') { return "HTTP $code" }
    return "keine HTTP-Antwort ($code)"
  } catch { return "Fehler: $($_.Exception.Message)" }
}

function Test-QuotaBarInstalled {
  $paths = @(
    (Join-Path $env:USERPROFILE ".quotabar-win"),
    (Join-Path $env:APPDATA "QuotaBar"),
    (Join-Path $env:LOCALAPPDATA "QuotaBar")
  )
  foreach ($p in $paths) { if (Test-Path $p) { return $true } }
  return $false
}

function Get-QuotaBarStatusLine {
  if (Test-QuotaBarInstalled) {
    return @("QuotaBar auf diesem PC: ja")
  }
  return @(
    "QuotaBar auf diesem PC: nein",
    "ZIP-Version: http://quotabar-zip.sp23.online",
    "GitHub Repo: https://github.com/spiral023/QuotaBar"
  )
}

function Write-SelfCheck([string] $Name, [string] $State, [string] $Detail) {
  if ($State -eq "OK") { Write-Ok "$Name - $Detail" }
  elseif ($State -eq "WARN") { Write-Warn "$Name - $Detail" }
  else { Write-Err "$Name - $Detail" }
}

function Get-PowerShellLanguageModeText {
  $current = "<not detected>"
  try {
    if ($ExecutionContext.SessionState.LanguageMode) { $current = "$($ExecutionContext.SessionState.LanguageMode)" }
  } catch { Write-Verbose "Konnte aktuellen PowerShell LanguageMode nicht ermitteln: $($_.Exception.Message)" }

  $parts = @("current=$current")
  foreach ($cmd in @("powershell.exe", "pwsh")) {
    if (-not (Test-CmdExist $cmd)) {
      $parts += "$cmd=<not found>"
      continue
    }
    try {
      $out = (& $cmd -NoProfile -NonInteractive -Command '$ExecutionContext.SessionState.LanguageMode') 2>$null
      $mode = (($out | Select-Object -First 1) -join " ").Trim()
      if (-not $mode) { $mode = "<empty>" }
      $parts += "$cmd=$mode"
    } catch {
      $parts += "$cmd=<error>"
    }
  }
  return ($parts -join "; ")
}

function Get-PxIniSettingsText {
  if (-not $PxIni -or -not (Test-Path $PxIni)) { return "<not set>" }
  $keys = @("server", "pac", "listen", "port", "noproxy", "client_auth", "idle", "proxyreload")
  $seen = @{}
  $values = @()
  try {
    foreach ($line in (Get-Content -Path $PxIni -ErrorAction SilentlyContinue)) {
      if ($line -match '^\s*(server|pac|listen|port|noproxy|client_auth|idle|proxyreload)\s*=\s*(.*)\s*$') {
        $key = $Matches[1].ToLowerInvariant()
        $value = $Matches[2].Trim()
        if ($value -eq "") { $value = "<empty>" }
        $seen[$key] = $value
      }
    }
  } catch { Write-Verbose "Konnte $PxIni nicht lesen: $($_.Exception.Message)" }
  foreach ($key in $keys) {
    if ($seen.ContainsKey($key)) { $values += "$key = $($seen[$key])" }
  }
  if ($values.Count -gt 0) { return ($values -join "; ") }
  return "<not set>"
}

function Test-PemFile([string] $Path) {
  if (-not $Path -or -not (Test-Path $Path)) { return $false }
  try { return [bool](Select-String -Path $Path -Pattern "-----BEGIN CERTIFICATE-----" -SimpleMatch -Quiet -ErrorAction SilentlyContinue) } catch { return $false }
}

function Get-PemCertificateCount([string] $Path) {
  if (-not $Path -or -not (Test-Path $Path)) { return 0 }
  try {
    $m = Select-String -Path $Path -Pattern "-----BEGIN CERTIFICATE-----" -SimpleMatch -ErrorAction SilentlyContinue
    if (-not $m) { return 0 }
    return ($m | Measure-Object).Count
  } catch { return 0 }
}

function Find-OpenSslPath {
  foreach ($c in @("C:\Program Files\Git\usr\bin\openssl.exe", "C:\Program Files\Git\mingw64\bin\openssl.exe")) {
    if (Test-Path $c) { return $c }
  }
  foreach ($name in @("openssl", "openssl.exe")) {
    $src = Get-CmdSource $name
    if ($src) { return $src }
  }
  return $null
}

# Aktiver End-to-End-Test des Codex-Trust-Pfads: baut ueber Px eine TLS-Verbindung zum Ziel auf und
# laesst openssl die praesentierte Kette gegen das CA-Bundle verifizieren. Faengt genau den Fall, den
# der reine "ist-gesetzt/ist-PEM"-Check nicht sieht: eine unvollstaendige Kette (fehlendes Intermediate).
function Test-TlsChainViaPx([string] $HostName, [string] $CaFile) {
  if (-not $CaFile -or -not (Test-Path $CaFile)) { return "nicht getestet, CA-Bundle fehlt" }
  if (-not (Test-Port $PxAddr $PxPort)) { return "nicht getestet, Px laeuft nicht" }
  $openssl = Find-OpenSslPath
  if (-not $openssl) { return "nicht pruefbar, openssl (z. B. aus Git) fehlt" }
  try {
    # openssl schreibt harmlose Statusinfos ("Connecting to ...") auf stderr; unter dem global
    # gesetzten $ErrorActionPreference = "Stop" wuerde 2>&1 daraus eine terminating Exception machen.
    # Lokal auf "Continue" stellen (funktions-scoped), damit stderr nur eingesammelt statt geworfen wird.
    $ErrorActionPreference = "Continue"
    $out = ("Q" | & $openssl s_client -connect "${HostName}:443" -servername $HostName -proxy "${PxAddr}:${PxPort}" -CAfile $CaFile 2>&1) -join "`n"
    if ($out -match "Verify return code:\s*0\b") { return "Kette vollstaendig, Verify OK ($HostName)" }
    if ($out -match "Verify return code:\s*(\d+[^\r\n]*)") { return "Verify-Fehler ($HostName): $($Matches[1])" }
    return "keine Verify-Antwort ($HostName)"
  } catch { return "Fehler: $($_.Exception.Message)" }
}

# Das CA-Bundle, das Codex tatsaechlich verwendet - in derselben Reihenfolge, in der Codex sucht:
# CODEX_CA_CERTIFICATE vor SSL_CERT_FILE, sonst der Script-Default. So prueft der Healthcheck das
# real genutzte Bundle und nicht bloss den Default (der User darf legitim ein eigenes Bundle setzen).
function Get-EffectiveCaBundle {
  foreach ($n in @("CODEX_CA_CERTIFICATE", "SSL_CERT_FILE")) {
    $v = Get-UserEnvValue $n
    if ($v -and (Test-Path $v)) { return $v }
  }
  return $CaBundlePath
}

# Die drei CA-Variablen sollen KONSISTENT sein: alle gesetzt, alle vorhanden, alle auf denselben Pfad.
# Es wird bewusst NICHT gegen den Script-Default verglichen - ein eigenes vollstaendiges Bundle ist ok.
# Gemeldet werden nur echte Inkonsistenzen (leer / fehlende Datei / unterschiedliche Pfade), denn
# genau die - z. B. leeres SSL_CERT_FILE - waren Ursache schwer auffindbarer Codex-TLS-Fehler.
function Get-CaVarDivergence {
  $problems = @()
  $setValues = @()
  foreach ($n in @("CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS")) {
    $v = Get-UserEnvValue $n
    if (-not $v) { $problems += "$n=<leer>" }
    elseif (-not (Test-Path $v)) { $problems += "$n=$v (Datei fehlt)" }
    else { $setValues += $v }
  }
  $distinct = @($setValues | Select-Object -Unique)
  if ($distinct.Count -gt 1) { $problems += "unterschiedliche Pfade: $($distinct -join ' vs ')" }
  return $problems
}

function Invoke-HealthCheck {
  Write-Head "Healthcheck"
  Resolve-PxPath | Out-Null
  Write-Info "Windows-Version / Build: $((cmd.exe /c ver) -join ' ')"
  $psMajor = $PSVersionTable.PSVersion.Major
  if ($psMajor -ge 5) { Write-SelfCheck "PowerShell-Version" "OK" "$($PSVersionTable.PSVersion)" } else { Write-SelfCheck "PowerShell-Version" "FAIL" "$($PSVersionTable.PSVersion)" }
  Write-SelfCheck "LanguageMode" "OK" (Get-PowerShellLanguageModeText)
  if (Test-Path $DevRoot) {
    try {
      Get-Item -Path $DevRoot -ErrorAction Stop | Out-Null
      Write-SelfCheck "Schreibzugriff auf $DevRoot" "WARN" "Ordner ist vorhanden; der Healthcheck schreibt keine Testdatei"
    } catch { Write-SelfCheck "Schreibzugriff auf $DevRoot" "FAIL" $_.Exception.Message }
  } else { Write-SelfCheck "Schreibzugriff auf $DevRoot" "WARN" "Ordner existiert nicht" }
  foreach ($cmd in @("setx", "curl.exe", "certutil", "schtasks", "node", "npm")) {
    if (Test-CmdExist $cmd) { Write-SelfCheck "$cmd vorhanden" "OK" (Get-CmdSource $cmd) } else { Write-SelfCheck "$cmd vorhanden" "FAIL" "nicht gefunden" }
  }
  if (Test-CmdExist "winget") { Write-SelfCheck "winget vorhanden" "OK" (Get-CmdSource "winget") } else { Write-SelfCheck "winget vorhanden" "WARN" "nicht gefunden" }
  if (Test-CmdExist "git") { Write-SelfCheck "git vorhanden" "OK" (Get-CmdSource "git") } else { Write-SelfCheck "git vorhanden" "WARN" "nicht gefunden" }
  if (Test-CmdExist "pwsh") { Write-SelfCheck "pwsh vorhanden" "OK" (Get-CmdSource "pwsh") } else { Write-SelfCheck "pwsh vorhanden" "WARN" "PowerShell 7 wurde nicht gefunden" }
  Write-Info "node --version: $(Get-VersionOutput 'node' @('--version'))"
  Write-Info "npm --version: $(Get-VersionOutput 'npm' @('--version'))"
  $nv = Get-NodeMajorMinor
  if ($nv -and $nv[0] -ge 22) { Write-SelfCheck "Node-Version ausreichend" "OK" "$($nv[0]).$($nv[1])" }
  elseif ($nv) { Write-SelfCheck "Node-Version ausreichend" "WARN" "$($nv[0]).$($nv[1]) ist kleiner als 22" }
  else { Write-SelfCheck "Node-Version ausreichend" "FAIL" "nicht gefunden" }
  if ($PxExe -and (Test-Path $PxExe)) { Write-SelfCheck "PxExe vorhanden" "OK" $PxExe } else { Write-SelfCheck "PxExe vorhanden" "WARN" "$(Format-Value $PxExe)" }
  if ($PxIni -and (Test-Path $PxIni)) { Write-SelfCheck "PxIni vorhanden" "OK" $PxIni } else { Write-SelfCheck "PxIni vorhanden" "WARN" "$(Format-Value $PxIni)" }
  Write-Info "PxExe bekannt: $(Format-Value $PxExe)"
  Write-Info "PxIni bekannt: $(Format-Value $PxIni)"
  Write-Info "px.ini settings: $(Get-PxIniSettingsText)"
  $pxStatus = Get-PxStatus
  if ($pxStatus.Listening) { Write-SelfCheck "Px erreichbar" "OK" $px } else { Write-SelfCheck "Px erreichbar" "WARN" $px }
  if ($pxStatus.PxRunning) { Write-SelfCheck "Px-Prozess läuft" "OK" ("PID {0}" -f $pxStatus.PxPid) }
  elseif ($pxStatus.Listening) { Write-SelfCheck "Px-Prozess läuft" "WARN" ("Port belegt durch: {0}" -f $pxStatus.OwnerText) }
  else { Write-SelfCheck "Px-Prozess läuft" "WARN" "kein px-Prozess gefunden" }
  if ($pxStatus.Listening) { Write-Info "Px-Port-Owner: $($pxStatus.OwnerText)" }
  try {
    Get-ItemProperty -Path "HKCU:\Environment" -ErrorAction Stop | Out-Null
    Write-SelfCheck "HKCU:\Environment lesbar/schreibbar" "WARN" "lesbar; der Healthcheck schreibt keine Registry-Testwerte"
  } catch { Write-SelfCheck "HKCU:\Environment lesbar/schreibbar" "FAIL" $_.Exception.Message }
  if (Test-CmdExist "claude") { Write-Ok "Claude Code vorhanden: $(Get-CmdSource 'claude')" } else { Write-Warn "Claude Code ist nicht installiert." }
  Write-Info "claude --version: $(Get-VersionOutput 'claude' @('--version'))"
  if (Test-CmdExist "codex") { Write-Ok "Codex CLI vorhanden: $(Get-CmdSource 'codex')" } else { Write-Warn "Codex CLI ist nicht installiert." }
  Write-Info "codex --version: $(Get-VersionOutput 'codex' @('--version'))"
  foreach ($nativePath in @((Join-Path $env:USERPROFILE ".local\bin\claude.exe"), (Join-Path $env:USERPROFILE ".local\share\claude"))) {
    if (Test-Path $nativePath) { Write-SelfCheck "Native Claude-Installation" "WARN" "vorhanden: $nativePath" } else { Write-SelfCheck "Native Claude-Installation" "OK" "nicht vorhanden: $nativePath" }
  }
  $npmPrefixCurrent = Get-NpmConfigValue "prefix"
  if ($npmPrefixCurrent -eq $NpmPrefix) { Write-SelfCheck "npm prefix" "OK" "$npmPrefixCurrent" } else { Write-SelfCheck "npm prefix" "WARN" "$(Format-Value $npmPrefixCurrent) (erwartet: $NpmPrefix)" }
  $npmCacheCurrent = Get-NpmConfigValue "cache"
  if ($npmCacheCurrent -eq $NpmCache) { Write-SelfCheck "npm cache" "OK" "$npmCacheCurrent" } else { Write-SelfCheck "npm cache" "WARN" "$(Format-Value $npmCacheCurrent) (erwartet: $NpmCache)" }
  $userPath = Get-UserEnvValue "Path"
  if ($userPath -and ($userPath.Split(';') -contains $NpmPrefix)) { Write-Ok "User-PATH enthält $NpmPrefix" } else { Write-Warn "User-PATH enthält $NpmPrefix nicht." }
  $envProxy = Get-UserEnvValue "HTTPS_PROXY"
  if ($envProxy) { Write-Ok "Persistentes HTTPS_PROXY: $envProxy" } else { Write-Warn "Persistentes HTTPS_PROXY ist nicht gesetzt." }
  $codexDir = Join-Path $env:USERPROFILE ".codex"
  $codexConfig = Join-Path $codexDir "config.toml"
  if (Test-Path $codexDir) { Write-SelfCheck ".codex vorhanden" "OK" $codexDir } else { Write-SelfCheck ".codex vorhanden" "WARN" "nicht vorhanden" }
  if (Test-Path $codexConfig) { Write-SelfCheck "Codex config.toml" "OK" $codexConfig } else { Write-SelfCheck "Codex config.toml" "WARN" "nicht vorhanden" }
  $codexCa = Get-UserEnvValue "CODEX_CA_CERTIFICATE"
  if ($codexCa -and (Test-Path $codexCa)) { Write-Ok "CODEX_CA_CERTIFICATE zeigt auf vorhandene Datei: $codexCa" }
  elseif ($codexCa) { Write-Err "CODEX_CA_CERTIFICATE ist gesetzt, aber die Datei fehlt: $codexCa" }
  else { Write-Warn "CODEX_CA_CERTIFICATE ist nicht gesetzt." }
  foreach ($name in @("SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS")) {
    $value = Get-UserEnvValue $name
    if ($value -and (Test-Path $value)) { Write-Ok "$name zeigt auf vorhandene Datei: $value" }
    elseif ($value) { Write-Err "$name ist gesetzt, aber die Datei fehlt: $value" }
    else { Write-Warn "$name ist nicht gesetzt." }
  }
  $nodeEnvProxy = Get-UserEnvValue "NODE_USE_ENV_PROXY"
  if ($nodeEnvProxy -eq "1") { Write-Ok "NODE_USE_ENV_PROXY ist gesetzt." } else { Write-Warn "NODE_USE_ENV_PROXY ist nicht auf 1 gesetzt." }
  if (Test-Path $CaBundlePath) {
    $caSize = 0
    try { $caSize = (Get-Item -Path $CaBundlePath -ErrorAction Stop).Length } catch { Write-Verbose "Konnte Dateigröße von $CaBundlePath nicht ermitteln: $($_.Exception.Message)" }
    $caCerts = Get-PemCertificateCount $CaBundlePath
    if (Test-PemFile $CaBundlePath) { Write-SelfCheck "CA-Bundle" "OK" "$CaBundlePath ($caSize Bytes, $caCerts Zertifikate)" } else { Write-SelfCheck "CA-Bundle" "FAIL" "$CaBundlePath ($caSize Bytes, kein PEM erkannt)" }
  } else { Write-SelfCheck "CA-Bundle" "WARN" "nicht vorhanden: $CaBundlePath" }
  # Die drei CA-Variablen sollten konsistent sein (alle gesetzt, vorhanden, gleicher Pfad).
  $effectiveBundle = Get-EffectiveCaBundle
  $caVarDivergence = Get-CaVarDivergence
  if ($caVarDivergence.Count -eq 0) { Write-Ok "CA-Variablen konsistent - Codex nutzt: $effectiveBundle" }
  else { Write-Warn "CA-Variablen inkonsistent: $($caVarDivergence -join '; ')" }
  # Aktiver Ketten-Verify gegen das tatsaechlich genutzte Bundle - fuer Login- (auth.openai.com)
  # UND Nutzungs-Endpoint (chatgpt.com).
  foreach ($h in @("auth.openai.com", "chatgpt.com")) {
    $chainResult = Test-TlsChainViaPx $h $effectiveBundle
    if ($chainResult -match "Verify OK") { Write-SelfCheck "TLS-Kette $h (Codex-Pfad)" "OK" $chainResult }
    elseif ($chainResult -match "nicht getestet|nicht pruefbar") { Write-SelfCheck "TLS-Kette $h (Codex-Pfad)" "WARN" $chainResult }
    else { Write-SelfCheck "TLS-Kette $h (Codex-Pfad)" "FAIL" $chainResult }
  }
  Write-Info "Hinweis: 'Falling back from WebSockets to HTTPS transport' (403 am Firmenproxy) ist kein CA-Fehler - Codex nutzt dann den HTTPS-Fallback und funktioniert normal."
  foreach ($line in (Get-QuotaBarStatusLine)) { Write-Info $line }
  foreach ($u in @("https://api.anthropic.com", "https://auth.openai.com", "https://chatgpt.com", "https://chatgpt.com/backend-api/codex/responses")) { Write-Info "Verbindung via Px: $u -> $(Test-UrlViaPx $u)" }
}

function Get-VersionOutput([string] $Command, [string[]] $Arguments) {
  try { return ((& $Command @Arguments) 2>$null) -join " " } catch { return "" }
}

function Get-SemVer([string] $Text) {
  if ($Text -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
  return $null
}

function Get-NpmLatestVersion([string] $Package) {
  try {
    $value = (& npm view $Package version 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $value) { return $null }
    return (Get-SemVer "$value")
  } catch { return $null }
}

function Get-AgentVersionStatus([string] $Command, [string] $Package) {
  if (-not (Test-CmdExist $Command)) {
    return [pscustomobject]@{ State = "missing"; Text = "fehlt"; Installed = $null; Latest = $null }
  }
  $installed = Get-SemVer (Get-VersionOutput $Command @("--version"))
  $latest = Get-NpmLatestVersion $Package
  if (-not $installed -or -not $latest) {
    $text = if ($installed) { "installiert ($installed), Update-Check nicht möglich" } else { "installiert, Update-Check nicht möglich" }
    return [pscustomobject]@{ State = "unknown"; Text = $text; Installed = $installed; Latest = $latest }
  }
  $isNewer = $false
  try { $isNewer = ([version]$latest -gt [version]$installed) } catch { $isNewer = ($latest -ne $installed) }
  if ($isNewer) {
    return [pscustomobject]@{ State = "update"; Text = "Update verfügbar ($installed -> $latest)"; Installed = $installed; Latest = $latest }
  }
  return [pscustomobject]@{ State = "current"; Text = "aktuell ($installed)"; Installed = $installed; Latest = $latest }
}

function Initialize-AgentVersionCache {
  $Script:ClaudeStatus = Get-AgentVersionStatus "claude" $claudePkg
  $Script:CodexStatus = Get-AgentVersionStatus "codex" $codexPkg
}

function Show-CodingAgentUpdate {
  Initialize-AgentVersionCache
  $agents = @(
    @{ Label = "Claude Code"; Status = $Script:ClaudeStatus; Package = $claudePkg },
    @{ Label = "Codex CLI"; Status = $Script:CodexStatus; Package = $codexPkg }
  )
  foreach ($agent in $agents) {
    $s = $agent.Status
    if ($s.State -eq "missing") { continue }
    if ($s.State -eq "unknown") {
      Write-Info "$($agent.Label): Versionsvergleich nicht möglich (installiert: $(Format-Value $s.Installed), aktuell: $(Format-Value $s.Latest))."
    } elseif ($s.State -eq "update") {
      Write-Warn "$($agent.Label): Update verfügbar ($($s.Installed) -> $($s.Latest)). Menüpunkt u oder npm install -g $($agent.Package)@latest ausführen."
    } else {
      Write-Ok "$($agent.Label): aktuell ($($s.Installed))."
    }
  }
}

function Export-DiagnosticReport {
  Write-Head "Diagnosebericht exportieren"
  Resolve-PxPath | Out-Null
  Initialize-Directory $ReportRoot
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $report = Join-Path $ReportRoot "${ts}_${AppName}-diagnostic.txt"
  $userPath = Get-UserEnvValue "Path"
  $pathHasPrefix = if ($userPath -and ($userPath.Split(';') -contains $NpmPrefix)) { "ja" } else { "nein" }
  $lines = @()
  $lines += "$AppName Diagnosebericht"
  $lines += "Zeit: $ts"
  $lines += "User: $env:USERNAME"
  $lines += "Computername: $env:COMPUTERNAME"
  $lines += "Windows-Version: $((cmd.exe /c ver) -join ' ')"
  $lines += "PowerShell-Version: $($PSVersionTable.PSVersion)"
  $lines += "PowerShell LanguageMode: $(Get-PowerShellLanguageModeText)"
  $lines += "Scriptpfad: $PSCommandPath"
  $lines += ""
  $lines += "Aktuelle Script-Konfiguration:"
  $lines += "AppName: $AppName"
  $lines += "NpmPrefix: $NpmPrefix"
  $lines += "NpmCache: $NpmCache"
  $lines += "PxExe: $PxExe"
  $lines += "PxIni: $PxIni"
  $lines += "px.ini settings: $(Get-PxIniSettingsText)"
  $lines += "CaBundlePath: $CaBundlePath"
  $lines += ""
  $pxStatus = Get-PxStatus
  $lines += "Px erreichbar: $(if ($pxStatus.Listening) { 'ja' } else { 'nein' })"
  $lines += "Px-Prozess: $(if ($pxStatus.PxRunning) { "läuft (PID $($pxStatus.PxPid))" } else { 'läuft nicht' })"
  $lines += "Px-Port-Owner: $(if ($pxStatus.Listening) { $pxStatus.OwnerText } else { '<not listening>' })"
  $lines += "Node-Version: $(Get-VersionOutput 'node' @('--version'))"
  $lines += "npm-Version: $(Get-VersionOutput 'npm' @('--version'))"
  foreach ($name in @("prefix", "cache", "proxy", "https-proxy")) { $lines += "npm ${name}: $(Format-Value (Get-NpmConfigValue $name))" }
  $lines += "User-PATH enthält NpmPrefix: $pathHasPrefix"
  foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS")) { $lines += "UserEnv ${name}: $(Format-Value (Get-UserEnvValue $name))" }
  $lines += "Claude installiert: $(if (Test-CmdExist 'claude') { 'ja' } else { 'nein' })"
  $lines += "Claude Version: $(Get-VersionOutput 'claude' @('--version'))"
  $lines += "Claude Pfad: $(Format-Value (Get-CmdSource 'claude'))"
  $lines += "Codex installiert: $(if (Test-CmdExist 'codex') { 'ja' } else { 'nein' })"
  $lines += "Codex Version: $(Get-VersionOutput 'codex' @('--version'))"
  $lines += "Codex Pfad: $(Format-Value (Get-CmdSource 'codex'))"
  $effectiveBundle = Get-EffectiveCaBundle
  $lines += "CA-Bundle (Default) vorhanden: $(if (Test-Path $CaBundlePath) { 'ja' } else { 'nein' })"
  $lines += "CA-Bundle (Default) Zertifikate: $(Get-PemCertificateCount $CaBundlePath)"
  $lines += "CA-Bundle von Codex genutzt: $effectiveBundle ($(Get-PemCertificateCount $effectiveBundle) Zertifikate)"
  $caVarDivergence = Get-CaVarDivergence
  $lines += "CA-Variablen konsistent: $(if ($caVarDivergence.Count -eq 0) { 'ja' } else { "nein ($($caVarDivergence -join '; '))" })"
  foreach ($h in @("auth.openai.com", "chatgpt.com")) { $lines += "TLS-Kette $h (Codex-Pfad): $(Test-TlsChainViaPx $h $effectiveBundle)" }
  $lines += "Connectivity https://api.anthropic.com: $(Test-UrlViaPx 'https://api.anthropic.com')"
  $lines += "Connectivity https://auth.openai.com: $(Test-UrlViaPx 'https://auth.openai.com')"
  $lines += "Connectivity https://chatgpt.com: $(Test-UrlViaPx 'https://chatgpt.com')"
  $lines += "Connectivity https://chatgpt.com/backend-api/codex/responses: $(Test-UrlViaPx 'https://chatgpt.com/backend-api/codex/responses')"
  $lines += ""
  foreach ($line in (Get-QuotaBarStatusLine)) { $lines += $line }
  Set-Content -Path $report -Value $lines -Encoding UTF8
  Write-Change "Diagnosebericht $report" "<not present>" "present" "Changed"
  Write-Ok "Diagnosebericht gespeichert: $report"
}

function Show-CurrentConfiguration {
  Write-Head "Aktuelle Konfiguration"
  Resolve-PxPath | Out-Null
  foreach ($line in @(
    "AppName      : $AppName",
    "NpmPrefix    : $NpmPrefix",
    "NpmCache     : $NpmCache",
    "PxExe        : $PxExe",
    "PxIni        : $PxIni",
    "PxAddr       : $PxAddr",
    "PxPort       : $PxPort",
    "Proxy URL    : $px",
    "CaBundlePath : $CaBundlePath",
    "LogRoot      : $LogRoot",
    "ReportRoot   : $ReportRoot"
  )) { Write-Info $line }
}

function Set-UserEnvFromPrompt([string] $Name, [string] $DefaultValue) {
  $old = Get-UserEnvValue $Name
  Write-Info "Aktueller Wert für ${Name}: $(Format-Value $old)"
  if ($DefaultValue) { Write-Info "Vorschlag: $DefaultValue" }
  $new = Read-Host "Neuer Wert für $Name (leer = abbrechen)"
  if ($new -eq "") {
    Write-Change "UserEnv $Name" $old $old "Skipped - user cancelled"
    return
  }
  Set-PersistentEnv $Name $new
}

function Set-OptionalNodeEnvMenu {
  do {
    Write-Head "Benutzer-Umgebungsvariablen anpassen"
    Write-ConsoleLine "  1) HTTP_PROXY" ""
    Write-ConsoleLine "  2) HTTPS_PROXY" ""
    Write-ConsoleLine "  3) NO_PROXY" ""
    Write-ConsoleLine "  4) NODE_USE_SYSTEM_CA" ""
    Write-ConsoleLine "  5) CODEX_CA_CERTIFICATE" ""
    Write-ConsoleLine "  6) NODE_USE_ENV_PROXY" ""
    Write-ConsoleLine "  7) NODE_EXTRA_CA_CERTS" ""
    Write-ConsoleLine "  0) Zurück" ""
    $c = (Read-Host "Auswahl").Trim()
    switch ($c) {
      "1" { Set-UserEnvFromPrompt "HTTP_PROXY" $px }
      "2" { Set-UserEnvFromPrompt "HTTPS_PROXY" $px }
      "3" { Set-UserEnvFromPrompt "NO_PROXY" $noProxy }
      "4" { Set-UserEnvFromPrompt "NODE_USE_SYSTEM_CA" "1" }
      "5" { Set-UserEnvFromPrompt "CODEX_CA_CERTIFICATE" $CaBundlePath }
      "6" { Set-UserEnvFromPrompt "NODE_USE_ENV_PROXY" "1" }
      "7" { Set-UserEnvFromPrompt "NODE_EXTRA_CA_CERTS" $CaBundlePath }
      "0" { }
      default { Write-Warn "Ungültige Auswahl: '$c'" }
    }
  } while ($c -ne "0")
}

function Set-NpmCacheFolder {
  Write-Head "npm-cache-Ordner ändern"
  Write-Info "Aktueller Scriptwert: $NpmCache"
  Write-Info "Aktueller npm-Wert: $(Format-Value (Get-NpmConfigValue 'cache'))"
  $newCache = Read-Host "Neuer npm-cache-Ordner (leer = abbrechen)"
  if ($newCache -eq "") {
    Write-Change "ScriptConfig NpmCache" $NpmCache $NpmCache "Skipped - user cancelled"
    return
  }
  $oldCache = $NpmCache
  Set-Variable -Scope Script -Name NpmCache -Value $newCache
  Write-Change "ScriptConfig NpmCache" $oldCache $NpmCache "Changed"
  Initialize-Directory $NpmCache
  Set-NpmConfigValue "cache" $NpmCache
}

function Open-FolderIfExist([string] $Path) {
  if (-not (Test-Path $Path)) { Write-Warn "Ordner existiert nicht: $Path"; return }
  Write-Info "Öffne Ordner: $Path"
  Start-Process "explorer.exe" $Path | Out-Null
}

function Open-ImportantFoldersMenu {
  do {
    Write-Head "Wichtige Ordner öffnen"
    Write-ConsoleLine "  1) npm-prefix-Ordner öffnen" ""
    Write-ConsoleLine "  2) npm-cache-Ordner öffnen" ""
    Write-ConsoleLine "  3) Px-Ordner öffnen" ""
    Write-ConsoleLine "  4) CA-Bundle-Ordner öffnen" ""
    Write-ConsoleLine "  5) Log-Ordner öffnen" ""
    Write-ConsoleLine "  6) Report-Ordner öffnen" ""
    Write-ConsoleLine "  0) Zurück" ""
    $c = (Read-Host "Auswahl").Trim()
    switch ($c) {
      "1" { Open-FolderIfExist $NpmPrefix }
      "2" { Open-FolderIfExist $NpmCache }
      "3" { Resolve-PxPath | Out-Null; if ($PxExe) { Open-FolderIfExist (Split-Path $PxExe -Parent) } else { Write-Warn "Px-Ordner wurde nicht gefunden. Lege px.ini und px.exe unter $DevRoot ab." } }
      "4" { Open-FolderIfExist (Split-Path $CaBundlePath -Parent) }
      "5" { Open-FolderIfExist $LogRoot }
      "6" { Open-FolderIfExist $ReportRoot }
      "0" { }
      default { Write-Warn "Ungültige Auswahl: '$c'" }
    }
  } while ($c -ne "0")
}

function Invoke-DryRun {
  Write-Head "Dry Run / geplante Änderungen anzeigen"
  Set-ProxyEnvPersistent -DryRun
  Set-UserPathAdd $NpmPrefix -DryRun
  Set-NpmConfig -DryRun
  Export-WindowsCaBundle $CaBundlePath -DryRun | Out-Null
  Remove-CompetingClaudeNativeInstall -DryRun
  Write-Change "npm install $claudePkg@latest" "<not run>" "would run" "Would execute" -DryRun
  Write-Change "npm install $codexPkg@latest" "<not run>" "would run" "Would execute" -DryRun
  Write-Ok "Dry Run abgeschlossen. Es wurden keine echten Änderungen durchgeführt."
}

function Open-PxDownloadPage {
  Write-Head "Px-Downloadseite öffnen"
  Start-Process "https://github.com/genotrance/px/releases"
  Write-Ok "Px-Downloadseite wurde geöffnet."
}

function Show-InstallMenu {
  do {
    Write-Head "Installation & Aktualisierung"
    Write-ConsoleLine "  1) Claude Code installieren / neu installieren" ""
    Write-ConsoleLine "  2) Codex CLI installieren / neu installieren" ""
    Write-ConsoleLine "  3) Beide installieren (Claude + Codex)" ""
    Write-ConsoleLine "  4) Corporate-CA-Bundle aktualisieren (Codex)" ""
    Write-ConsoleLine "  0) Zurück" ""
    $c = (Read-Host "Auswahl").Trim()
    switch ($c) {
      "1" { Invoke-MenuAction "Claude Code installieren / neu installieren" { Install-ClaudeCode } }
      "2" { Invoke-MenuAction "Codex CLI installieren / neu installieren" { Install-CodexCli } }
      "3" { Invoke-MenuAction "Beide installieren" { Install-ClaudeCode; Install-CodexCli } }
      "4" { Invoke-MenuAction "Corporate-CA-Bundle aktualisieren" { Update-CaBundle } }
      "0" { }
      default { Write-Warn "Ungültige Auswahl: '$c'"; Start-Sleep -Milliseconds 800 }
    }
  } while ($c -ne "0")
}

function Show-DiagnosticsMenu {
  do {
    Write-Head "Diagnose & Status"
    Write-ConsoleLine "  1) Healthcheck" ""
    Write-ConsoleLine "  2) Diagnosebericht exportieren" ""
    Write-ConsoleLine "  3) Aktuelle Konfiguration anzeigen" ""
    Write-ConsoleLine "  4) Dry Run / geplante Änderungen anzeigen" ""
    Write-ConsoleLine "  0) Zurück" ""
    $c = (Read-Host "Auswahl").Trim()
    switch ($c) {
      "1" { Invoke-MenuAction "Healthcheck" { Invoke-HealthCheck } }
      "2" { Invoke-MenuAction "Diagnosebericht exportieren" { Export-DiagnosticReport } }
      "3" { Invoke-MenuAction "Aktuelle Konfiguration anzeigen" { Show-CurrentConfiguration } }
      "4" { Invoke-MenuAction "Dry Run / geplante Änderungen anzeigen" { Invoke-DryRun } }
      "0" { }
      default { Write-Warn "Ungültige Auswahl: '$c'"; Start-Sleep -Milliseconds 800 }
    }
  } while ($c -ne "0")
}

function Show-ToolsMenu {
  do {
    Write-Head "Werkzeuge & Ordner"
    Write-ConsoleLine "  1) Wichtige Ordner öffnen" ""
    Write-ConsoleLine "  2) Benutzer-Umgebungsvariablen anpassen" ""
    Write-ConsoleLine "  3) npm-cache-Ordner ändern" ""
    Write-ConsoleLine "  4) Px-Downloadseite öffnen" ""
    Write-ConsoleLine "  0) Zurück" ""
    $c = (Read-Host "Auswahl").Trim()
    switch ($c) {
      "1" { Invoke-MenuAction "Wichtige Ordner öffnen" { Open-ImportantFoldersMenu } }
      "2" { Invoke-MenuAction "Benutzer-Umgebungsvariablen anpassen" { Set-OptionalNodeEnvMenu } }
      "3" { Invoke-MenuAction "npm-cache-Ordner ändern" { Set-NpmCacheFolder } }
      "4" { Invoke-MenuAction "Px-Downloadseite öffnen" { Open-PxDownloadPage } }
      "0" { }
      default { Write-Warn "Ungültige Auswahl: '$c'"; Start-Sleep -Milliseconds 800 }
    }
  } while ($c -ne "0")
}

function Show-Menu {
  try { Clear-Host } catch { Write-Verbose "Konnte Konsole nicht leeren: $($_.Exception.Message)" }
  Write-ConsoleLine "==================================================" "Cyan"
  Write-ConsoleLine "  $AppName - Setup für Claude / Codex hinter Px" "Cyan"
  Write-ConsoleLine "==================================================" "Cyan"
  $pxStatus = Get-PxStatus
  $pxState = if ($pxStatus.PxRunning) { "läuft" } elseif ($pxStatus.Listening) { "Port belegt, px.exe läuft nicht" } else { "gestoppt" }
  if (-not $Script:ClaudeStatus -or -not $Script:CodexStatus) { Initialize-AgentVersionCache }
  $clColor = if ($Script:ClaudeStatus.State -eq "update") { "Yellow" } else { "DarkGray" }
  $cxColor = if ($Script:CodexStatus.State -eq "update") { "Yellow" } else { "DarkGray" }
  $qbInstalled = Test-QuotaBarInstalled
  $qb = if ($qbInstalled) { "vorhanden" } else { "fehlt" }
  Write-ConsoleLine ("  Benutzer : {0}" -f $env:USERNAME) "DarkGray"
  Write-ConsoleLine ("  Px       : {0} ({1})" -f $pxState, $px) "DarkGray"
  Write-ConsoleLine ("  Claude   : {0}" -f $Script:ClaudeStatus.Text) $clColor
  Write-ConsoleLine ("  Codex    : {0}" -f $Script:CodexStatus.Text) $cxColor
  Write-ConsoleLine ("  QuotaBar : {0}" -f $qb) "DarkGray"
  Write-ConsoleLine "" ""
  Write-ConsoleLine "  1) Px-Proxy starten / prüfen" ""
  Write-ConsoleLine "  s) Px-Proxy stoppen" ""
  Write-ConsoleLine "  2) Installation & Aktualisierung" ""
  Write-ConsoleLine "  3) Diagnose & Status" ""
  Write-ConsoleLine "  4) Werkzeuge & Ordner" ""
  Write-ConsoleLine "  u) Alle Tools auf neueste Version aktualisieren" ""
  Write-ConsoleLine "  0) Beenden" ""
  Write-ConsoleLine "  q) Beenden und Px-Proxy stoppen" ""
  if (-not $qbInstalled) {
    Write-ConsoleLine "" ""
    Write-ConsoleLine "  QuotaBar herunterladen:" "DarkGray"
    Write-ConsoleLine "  ZIP-Version: http://quotabar-zip.sp23.online" "DarkGray"
    Write-ConsoleLine "  GitHub Repo: https://github.com/spiral023/QuotaBar" "DarkGray"
  }
}

function Invoke-MenuAction([string] $Name, [scriptblock] $Action) {
  Reset-ActionCounter $Name
  try { & $Action } catch { Write-Err $_.Exception.Message }
  Show-ActionSummary
  Wait-Menu
}

function Invoke-SelectedAction([string] $SelectedAction, [switch] $DryRun) {
  Reset-ActionCounter $SelectedAction
  try {
    switch ($SelectedAction) {
      "StartPx" { Write-Head "Px-Proxy"; if (Initialize-Px) { Show-CodingAgentUpdate } else { Write-Err "Action StartPx ist fehlgeschlagen." } }
      "StopPx" { Stop-Px }
      "HealthCheck" { Invoke-HealthCheck }
      "DiagnosticReport" { Export-DiagnosticReport }
      "DryRun" { Invoke-DryRun }
      "UpdateCaBundle" { Update-CaBundle -DryRun:$DryRun }
      "InstallClaude" { Install-ClaudeCode -DryRun:$DryRun }
      "InstallCodex" { Install-CodexCli -DryRun:$DryRun }
      "InstallBoth" { Install-ClaudeCode -DryRun:$DryRun; if ($Script:FailedCount -eq 0) { Install-CodexCli -DryRun:$DryRun } }
      "UpdateAll" { Update-AllTools -DryRun:$DryRun }
      "ShowConfiguration" { Show-CurrentConfiguration }
      default { Write-Err "Unbekannte Action: $SelectedAction"; Show-ActionSummary; return $false }
    }
  } catch {
    Write-Err "Action $SelectedAction ist fehlgeschlagen: $($_.Exception.Message)"
  }
  Show-ActionSummary
  if ($Script:FailedCount -gt 0) { return $false }
  return $true
}

Initialize-Logging

if ($Action -eq "Menu") {
  Write-ConsoleLine "Prüfe installierte Versionen ..." "DarkGray"
  Initialize-AgentVersionCache
  do {
    Show-Menu
    $choice = (Read-Host "Auswahl").Trim()
    switch ($choice) {
      "1" { Invoke-MenuAction "Px-Proxy starten / prüfen" { Write-Head "Px-Proxy"; if (Initialize-Px) { Show-CodingAgentUpdate } } }
      "s" { Invoke-MenuAction "Px-Proxy stoppen" { Stop-Px } }
      "2" { Show-InstallMenu }
      "3" { Show-DiagnosticsMenu }
      "4" { Show-ToolsMenu }
      "u" { Invoke-MenuAction "Alle Tools aktualisieren" { Update-AllTools } }
      "0" { Write-ConsoleLine "`nBeendet." "Cyan" }
      "q" { Reset-ActionCounter "Beenden und Px-Proxy stoppen"; Stop-Px; Write-ConsoleLine "`nBeendet." "Cyan" }
      default { Write-Warn "Ungültige Auswahl: '$choice'"; Start-Sleep -Milliseconds 800 }
    }
  } while ($choice -ne "0" -and $choice -ne "q")
} else {
  $ok = Invoke-SelectedAction $Action -DryRun:$DryRun
  if (-not $ok) { exit 1 }
}
