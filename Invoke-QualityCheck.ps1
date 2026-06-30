[CmdletBinding()]
param(
  [switch] $SkipPester,
  [switch] $SkipScriptAnalyzer
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSCommandPath
$ScriptPath = Join-Path $Root "tools\ai-coding.ps1"
$PesterPath = Join-Path $Root "tests\ai-coding.Tests.ps1"
$AnalyzerSettings = Join-Path $Root "PSScriptAnalyzerSettings.psd1"

if (-not $SkipPester) {
  if (Get-Command Invoke-Pester -ErrorAction SilentlyContinue) {
    $result = Invoke-Pester -Path $PesterPath -PassThru
    if ($result -and $result.FailedCount -gt 0) {
      throw "Pester-Tests fehlgeschlagen: $($result.FailedCount)"
    }
  } else {
    Write-Warning "Pester ist nicht installiert. Überspringe Pester-Tests."
  }
}

if (-not $SkipScriptAnalyzer) {
  if (Get-Command Invoke-ScriptAnalyzer -ErrorAction SilentlyContinue) {
    Invoke-ScriptAnalyzer -Path $ScriptPath -Settings $AnalyzerSettings
  } else {
    Write-Warning "PSScriptAnalyzer ist nicht installiert. Überspringe ScriptAnalyzer-Prüfung."
  }
}
