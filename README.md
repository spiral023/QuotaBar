# QuotaBar for Windows

<p>
  <img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-0078D4">
  <img alt="Runtime: Electron" src="https://img.shields.io/badge/runtime-Electron-47848F">
  <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="Tests: Vitest" src="https://img.shields.io/badge/tests-Vitest-6E9F18">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green">
</p>

**A small Windows tray app for tracking AI coding quota usage across Claude, Codex, and local Gemini state.**

QuotaBar runs quietly in the system tray, reads credentials from known local CLI locations, and keeps your current AI coding usage one click away. It is intentionally narrow: no main window, no broad disk scans, and no account dashboard.

## At A Glance

| Area | What QuotaBar does |
| --- | --- |
| **Tray-first UI** | Shows provider status from the Windows system tray |
| **Multi-provider** | Supports Claude, Codex, and local Gemini session state |
| **Background refresh** | Updates usage periodically, with manual refresh in the tray menu |
| **Defensive fetches** | Keeps the last successful snapshot when a provider endpoint fails |
| **Privacy-aware** | Reads only known paths and redacts sensitive values before logging |

## Provider Support

| Provider | Support level | Source | Notes |
| --- | --- | --- | --- |
| <img alt="Claude" src="https://img.shields.io/badge/Claude-usage_windows-8A5CF6"> | Usage windows | `~/.claude/.credentials.json` | Uses Claude Code OAuth credentials |
| <img alt="Codex" src="https://img.shields.io/badge/Codex-usage_windows-111827"> | Usage windows | `~/.codex/auth.json` | Uses Codex CLI OAuth credentials |
| <img alt="Gemini" src="https://img.shields.io/badge/Gemini-local_sessions-4285F4"> | Local summary | `~/.gemini/settings.json`, `~/.gemini/tmp/` | Counts local `session-*.json` files |

> [!IMPORTANT]
> Claude and Codex quota data currently depends on unofficial or internal provider endpoints. These endpoints can change without notice. QuotaBar handles failures defensively, but provider behavior may break until the integration is updated.

## Features

<p>
  <img alt="No main window" src="https://img.shields.io/badge/UI-tray_only-blue">
  <img alt="Runtime icon rendering" src="https://img.shields.io/badge/icon-dynamic_PNG-blue">
  <img alt="Startup toggle" src="https://img.shields.io/badge/Windows-startup_toggle-blue">
  <img alt="Sensitive values redacted" src="https://img.shields.io/badge/logs-redacted-green">
</p>

- Windows 10/11 tray app with click, double-click, and right-click menu access.
- Dynamic tray icon generated from current usage and error state.
- Provider rows with usage percentages, reset countdowns, stale state, and auth hints.
- Manual refresh, Open Log, Open Config Folder, Start with Windows, and Exit actions.
- Background refresh loop with a default 60 second interval.
- Provider abstraction through a shared `UsageProvider` interface.
- Unit coverage for auth parsing, JWT handling, formatters, colors, redaction, normalization, and branding.

## Quick Start

```powershell
npm install
npm run build
npm run dev
```

`npm run dev` builds TypeScript and starts Electron with `--no-window --debug`.

## Authentication Setup

QuotaBar does not replace provider login flows. Sign in with the local CLI tools first, then start QuotaBar.

### Claude

```powershell
claude login
```

QuotaBar reads Claude Code OAuth credentials from:

```text
~/.claude/.credentials.json
```

For local testing, you can set an OAuth token directly:

```powershell
$env:QUOTABAR_CLAUDE_OAUTH_TOKEN = "..."
```

### Codex

```powershell
codex login
```

QuotaBar reads Codex CLI auth from:

```text
~/.codex/auth.json
```

If `CODEX_HOME` is set, QuotaBar reads `auth.json` from that directory instead.

### Gemini

QuotaBar currently reads local Gemini state only:

```text
~/.gemini/settings.json
~/.gemini/tmp/session-*.json
```

This is a local session summary, not remote Gemini quota usage.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build and start Electron in debug mode |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm test` | Run the Vitest test suite |
| `npm run package` | Build Windows installer and portable artifacts |

Packaging uses `electron-builder` and writes artifacts to `package-output/`.

## Local Files

QuotaBar writes runtime files under:

```text
%USERPROFILE%\.quotabar-win
```

| File | Purpose |
| --- | --- |
| `settings.json` | Poll interval and provider timeout settings |
| `quotabar.log` | Local app log with sensitive values redacted |
| `.installed` | First-run marker |

## Architecture

```text
src/
├─ main/       Electron lifecycle, tray menu, autostart, logging
├─ providers/  Claude, Codex, Gemini, provider registry
├─ auth/       Credential parsing, JWT helpers, token refresh
├─ usage/      Refresh loop, snapshot store, formatters
├─ icon/       Runtime tray icon rendering
├─ config/     Paths, settings, first-run prompt
└─ shared/     Redaction and shared error types
```

The runtime flow is deliberately simple:

1. Electron starts without opening a main window.
2. Settings load from `%USERPROFILE%\.quotabar-win`.
3. Providers fetch or summarize usage through `UsageProvider`.
4. `UsageStore` keeps the latest successful snapshots.
5. The tray icon and menu update after each refresh.

## Security Model

<p>
  <img alt="No broad scans" src="https://img.shields.io/badge/files-no_broad_scans-green">
  <img alt="Known auth paths only" src="https://img.shields.io/badge/auth-known_paths_only-green">
  <img alt="JWTs redacted" src="https://img.shields.io/badge/JWTs-redacted-green">
</p>

- Tokens, cookies, authorization headers, and JWTs are not printed in UI output.
- Logs pass through redaction helpers before sensitive values are written.
- Credentials are read only from known provider paths.
- QuotaBar does not scan the disk for auth files.
- Provider/Auth code keeps unofficial endpoints isolated and defensive.

## Status

This is an early Windows MVP. The core app is usable for local development, but the provider integrations depend on upstream CLI credential formats and private usage APIs.

## License

MIT
