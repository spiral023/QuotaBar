import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "tools", "ai-coding.ps1");
const script = fs.readFileSync(scriptPath, "utf8");

function functionBody(name: string): string {
  const start = script.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = script.indexOf("\nfunction ", start + 1);
  return script.slice(start, next === -1 ? undefined : next);
}

describe("ai-coding PowerShell setup script", () => {
  it("uses centralized ai-coding naming and does not expose Px autostart anymore", () => {
    expect(script).toContain('$AppName = "ai-coding"');
    expect(script).not.toContain("Px-Autostart");
    expect(script).not.toContain("Px autostart");
    expect(script).not.toContain("Test-PxAutostart");
    expect(script).not.toContain("Enable-PxAutostart");
    expect(script).not.toContain("Disable-PxAutostart");
    expect(script).not.toContain("QuotaBar Px Proxy");
    expect(script).not.toContain("quotabar-px.cmd");
  });

  it("discovers Px from px.ini under C:\\Entwicklung instead of hard-coding a Px version", () => {
    expect(script).toContain("function Resolve-PxPath");
    expect(script).toContain("[string] $PxExe        = \"\"");
    expect(script).toContain("[string] $PxIni        = \"\"");
    expect(script).toContain("Get-ChildItem -Path $DevRoot -Filter \"px.ini\" -Recurse");
    expect(script).not.toMatch(/px-v\d+\.\d+\.\d+-windows-amd64/i);
  });

  it("contains grouped German menu actions and visible user guidance", () => {
    [
      "Px-Proxy starten / prüfen",
      "Installation & Aktualisierung",
      "Diagnose & Status",
      "Werkzeuge & Ordner",
      "Claude Code installieren / neu installieren",
      "Codex CLI installieren / neu installieren",
      "Diagnosebericht exportieren",
      "Aktuelle Konfiguration anzeigen",
      "Wichtige Ordner öffnen",
      "Dry Run / geplante Änderungen anzeigen",
      "Healthcheck",
      "Px-Downloadseite öffnen",
      "WICHTIGE NÄCHSTE SCHRITTE",
      "QuotaBar auf diesem PC",
      "http://quotabar-zip.sp23.online",
      "https://github.com/spiral023/QuotaBar",
    ].forEach((text) => expect(script).toContain(text));

    expect(script).not.toContain("QuotaBar-Daten:");
    expect(script).not.toContain("Px-Autostart bei Anmeldung");
  });

  it("defines logging, change journal, diagnostic report, dry run, and summary helpers", () => {
    [
      "Initialize-Logging",
      "Write-Log",
      "Write-Change",
      "Write-ExternalCommandLog",
      "Reset-ActionCounter",
      "Show-ActionSummary",
      "Export-DiagnosticReport",
      "Show-CurrentConfiguration",
      "Open-ImportantFoldersMenu",
      "Invoke-DryRun",
    ].forEach((name) => expect(script).toContain(`function ${name}`));

    expect(script).not.toContain("function Invoke-SystemSelfCheck");
    expect(script).not.toContain("System-Selbsttest");

    expect(script).toContain("$Script:ChangedCount");
    expect(script).toContain("$Script:SkippedCount");
    expect(script).toContain("$Script:FailedCount");
    expect(script).toContain("$Script:WarningCount");
    expect(script).toContain("DRYRUN CHANGE");
    expect(script).toContain('${ts}_${AppName}-diagnostic.txt');
    expect(script).toContain('"$AppName.log"');
    expect(script).not.toContain('${ts}_${AppName}.log');
    expect(functionBody("Write-ConsoleLine")).not.toContain("Write-Log");
    expect(functionBody("Reset-ActionCounter")).not.toContain("Write-Log");
  });

  it("does not remove Claude or Codex user data directories or auth files", () => {
    const removeTargets = [...script.matchAll(/Remove-Item\s+([^\r\n]+)/gi)].map((match) => match[1]);
    const forbidden = [/\.claude(\\|\/|\b)/i, /\.claude\.json/i, /\.codex(\\|\/|\b)/i];

    const unsafe = removeTargets.filter((target) => forbidden.some((pattern) => pattern.test(target)));
    expect(unsafe).toEqual([]);
  });

  it("supports non-interactive actions and keeps menu as the default action", () => {
    expect(script).toContain('[ValidateSet("Menu", "StartPx", "HealthCheck", "DiagnosticReport", "DryRun", "UpdateCaBundle", "InstallClaude", "InstallCodex", "InstallBoth", "UpdateAll", "ShowConfiguration")]');
    expect(script).toContain('[string] $Action = "Menu"');
    expect(script).toContain("[switch] $DryRun");
    expect(script).toContain("[switch] $AssumeYes");
    expect(script).toContain("function Invoke-SelectedAction");
    [
      '"StartPx"',
      '"HealthCheck"',
      '"DiagnosticReport"',
      '"DryRun"',
      '"UpdateCaBundle"',
      '"InstallClaude"',
      '"InstallCodex"',
      '"InstallBoth"',
      '"UpdateAll"',
      '"ShowConfiguration"',
    ].forEach((action) => expect(functionBody("Invoke-SelectedAction")).toContain(action));
  });

  it("asks before removing native Claude installs and keeps dry run non-destructive", () => {
    expect(script).toContain("function Confirm-YesNo");
    expect(script).toContain("Native Claude-Installation wurde gefunden. Entfernen? [J/n]");
    expect(functionBody("Remove-CompetingClaudeNativeInstall")).toContain("Confirm-YesNo");
    expect(functionBody("Remove-CompetingClaudeNativeInstall")).toContain("Skipped - user declined");
    expect(functionBody("Remove-CompetingClaudeNativeInstall")).toContain("Would remove");
  });

  it("exports the CA bundle through a temporary file before replacing the existing file", () => {
    const body = functionBody("Export-WindowsCaBundle");
    expect(body).toContain('Test-CmdExist "certutil"');
    expect(body).toContain("$tmpRoot");
    expect(body).toContain("$tmpOut");
    expect(body).toContain("Move-Item");
    expect(body).toContain("-----BEGIN CERTIFICATE-----");
    expect(body).not.toContain("Set-Content -Path $OutFile -Value \"\"");
  });

  it("extends healthcheck and tools without changing default proxy variables", () => {
    const health = functionBody("Invoke-HealthCheck");
    const pxIni = functionBody("Get-PxIniSettingsText");
    const diagnostic = functionBody("Export-DiagnosticReport");
    [
      "Windows-Version",
      "winget vorhanden",
      "git vorhanden",
      "pwsh vorhanden",
      "Native Claude",
      "npm prefix",
      "npm cache",
      ".codex vorhanden",
      "config.toml",
      "CA-Bundle",
      "px.ini settings",
      "node --version",
      "npm --version",
      "claude --version",
      "codex --version",
    ].forEach((text) => expect(health).toContain(text));

    [
      "server",
      "pac",
      "listen",
      "port",
      "noproxy",
      "client_auth",
      "idle",
      "proxyreload",
    ].forEach((text) => expect(pxIni).toContain(text));

    expect(health).toContain("px.ini settings");
    expect(diagnostic).toContain("px.ini settings: $(Get-PxIniSettingsText)");

    expect(script).toContain("function Set-OptionalNodeEnvMenu");
    expect(script).toContain("NODE_USE_ENV_PROXY");
    expect(script).toContain("NODE_EXTRA_CA_CERTS");
    expect(script).toContain("function Set-NpmCacheFolder");
  });

  it("adds PowerShell quality check scaffolding", () => {
    const pesterPath = path.join(repoRoot, "tests", "ai-coding.Tests.ps1");
    const analyzerPath = path.join(repoRoot, "PSScriptAnalyzerSettings.psd1");
    const qualityPath = path.join(repoRoot, "Invoke-QualityCheck.ps1");

    expect(fs.existsSync(pesterPath)).toBe(true);
    expect(fs.existsSync(analyzerPath)).toBe(true);
    expect(fs.existsSync(qualityPath)).toBe(true);

    const pester = fs.readFileSync(pesterPath, "utf8");
    [
      "Confirm-YesNo",
      "Set-UserPathAdd",
      "Export-WindowsCaBundle -DryRun",
      "Get-NodeMajorMinor",
      "Invoke-SelectedAction",
      "Invoke-ScriptAnalyzer",
    ].forEach((text) => expect(pester).toContain(text));
  });

  it("does not mutate session environment during install dry runs", () => {
    const claude = functionBody("Install-ClaudeCode");
    const codex = functionBody("Install-CodexCli");

    expect(claude).toContain("if (-not $DryRun) { Set-SessionProxyEnv }");
    expect(codex).toContain("if (-not $DryRun) {");
    expect(codex).toContain("Set-SessionProxyEnv");
    expect(codex).toContain('$env:CODEX_CA_CERTIFICATE = $CaBundlePath');
    expect(codex).toContain('$env:SSL_CERT_FILE = $CaBundlePath');
  });

  it("persists Codex-specific CA variables and checks chatgpt.com connectivity", () => {
    const codex = functionBody("Install-CodexCli");
    const updateCa = functionBody("Update-CaBundle");
    const health = functionBody("Invoke-HealthCheck");
    const diagnostic = functionBody("Export-DiagnosticReport");

    [
      'Set-PersistentEnv "CODEX_CA_CERTIFICATE" $CaBundlePath',
      'Set-PersistentEnv "SSL_CERT_FILE" $CaBundlePath',
      'Set-PersistentEnv "NODE_EXTRA_CA_CERTS" $CaBundlePath',
      'Set-PersistentEnv "NODE_USE_ENV_PROXY" "1"',
    ].forEach((text) => {
      expect(codex).toContain(text);
      expect(updateCa).toContain(text);
    });

    [
      '$env:CODEX_CA_CERTIFICATE = $CaBundlePath',
      '$env:SSL_CERT_FILE = $CaBundlePath',
      '$env:NODE_EXTRA_CA_CERTS = $CaBundlePath',
      '$env:NODE_USE_ENV_PROXY = "1"',
    ].forEach((text) => expect(codex).toContain(text));

    expect(health).toContain('"https://chatgpt.com"');
    expect(health).toContain('"https://chatgpt.com/backend-api/codex/responses"');
    expect(diagnostic).toContain("SSL_CERT_FILE");
    expect(diagnostic).toContain("NODE_EXTRA_CA_CERTS");
    expect(diagnostic).toContain("NODE_USE_ENV_PROXY");
  });
});
