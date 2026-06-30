$RepoRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $RepoRoot "tools\ai-coding.ps1"
$ScriptText = Get-Content -Path $ScriptPath -Raw

function Get-ScriptFunctionBody([string] $Name) {
  $start = $ScriptText.IndexOf("function $Name")
  if ($start -lt 0) { throw "Funktion wurde nicht gefunden: $Name" }
  $next = $ScriptText.IndexOf("`nfunction ", $start + 1)
  if ($next -lt 0) { return $ScriptText.Substring($start) }
  return $ScriptText.Substring($start, $next - $start)
}

Describe "ai-coding.ps1" {
  It "Confirm-YesNo nutzt Enter als Ja-Default" {
    $body = Get-ScriptFunctionBody "Confirm-YesNo"
    $body | Should Match '\$answer -eq ""'
    $body | Should Match 'return \$DefaultYes'
    $body | Should Match 'Read-Host \$Prompt'
  }

  It "Set-UserPathAdd fügt denselben Pfad nicht doppelt hinzu" {
    $body = Get-ScriptFunctionBody "Set-UserPathAdd"
    if ($body.IndexOf(".Split(';') -contains `$Add") -lt 0) { throw "PATH-Duplikatprüfung wurde nicht gefunden" }
    $body | Should Match "Skipped - already contains"
  }

  It "Export-WindowsCaBundle -DryRun erzeugt keine Datei" {
    $body = Get-ScriptFunctionBody "Export-WindowsCaBundle"
    $dryRunIndex = $body.IndexOf('if ($DryRun)')
    $moveIndex = $body.IndexOf('Move-Item')
    if ($dryRunIndex -lt 0) { throw "DryRun-Block wurde nicht gefunden" }
    if ($moveIndex -le $dryRunIndex) { throw "Move-Item muss nach dem DryRun-Block stehen" }
    $body | Should Match "Would create or update"
  }

  It "Get-NodeMajorMinor kann Versionsstrings auswerten" {
    $body = Get-ScriptFunctionBody "Get-NodeMajorMinor"
    $body | Should Match '\[string\] \$VersionText'
    if ($body.IndexOf("v(\d+)\.(\d+)") -lt 0) { throw "Node-Versionsregex wurde nicht gefunden" }
  }

  It "Invoke-SelectedAction routet Non-Interactive-Actions" {
    $body = Get-ScriptFunctionBody "Invoke-SelectedAction"
    @(
      "StartPx",
      "HealthCheck",
      "DiagnosticReport",
      "DryRun",
      "UpdateCaBundle",
      "InstallClaude",
      "InstallCodex",
      "InstallBoth",
      "ShowConfiguration"
    ) | ForEach-Object { $body | Should Match $_ }
  }

  It "Skript lässt sich mit PSScriptAnalyzer prüfen" {
    if (-not (Get-Command Invoke-ScriptAnalyzer -ErrorAction SilentlyContinue)) {
      Write-Warning "PSScriptAnalyzer ist nicht installiert"
      return
    }
    $settings = Join-Path $RepoRoot "PSScriptAnalyzerSettings.psd1"
    $issues = Invoke-ScriptAnalyzer -Path $ScriptPath -Settings $settings
    $issues | Should BeNullOrEmpty
  }
}
