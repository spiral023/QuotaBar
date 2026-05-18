# QuotaBar for Windows

QuotaBar is a lightweight Windows tray app for keeping an eye on AI coding usage across local developer tools.

It runs in the background, reads credentials and local state from known CLI locations, and shows current quota status for supported providers from the system tray. The project is intentionally small: no main window, no account dashboard, no broad disk scans.

## Supported Providers

| Provider | Status | Data source |
| --- | --- | --- |
| Claude | Usage windows | Claude Code OAuth credentials from `~/.claude/.credentials.json` |
| Codex | Usage windows | Codex CLI OAuth credentials from `~/.codex/auth.json` |
| Gemini | Local session summary | Gemini settings and local `session-*.json` files |

Claude and Codex usage currently depends on unofficial or internal provider endpoints. Those APIs can change without notice, so QuotaBar treats provider failures defensively and keeps the last successful snapshot as stale instead of crashing the tray app.

## Features

- Windows 10/11 system tray app with no main window.
- Dynamic tray icon generated at runtime from current usage state.
- Tray menu with provider status, reset countdowns, manual refresh, logs, config folder, startup toggle, and exit.
- Periodic background refresh, defaulting to every 60 seconds.
- Provider isolation through a shared `UsageProvider` interface.
- Token redaction before logging.
- Credential reads limited to known provider paths.
- Unit tests for auth parsing, JWT handling, formatting, colors, redaction, normalization, and branding.

## Installation

```powershell
npm install
npm run build
```

## Development

Start the tray app in development mode:

```powershell
npm run dev
```

Run tests:

```powershell
npm test
```

`npm run dev` builds TypeScript first, then starts Electron with `--no-window --debug`.

## Packaging

Build Windows installer and portable artifacts:

```powershell
npm run package
```

Packaging uses `electron-builder` and writes output to `package-output/`.

## Authentication

QuotaBar does not implement its own login flow for every provider. It uses credentials already created by the official local CLI tools where available.

### Claude

Run:

```powershell
claude login
```

QuotaBar reads:

```text
~/.claude/.credentials.json
```

For local testing, you can also set:

```powershell
$env:QUOTABAR_CLAUDE_OAUTH_TOKEN = "..."
```

### Codex

Run:

```powershell
codex login
```

QuotaBar reads:

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

This is used for a local session summary, not remote quota usage.

## Local Data

QuotaBar writes its own runtime files under:

```text
%USERPROFILE%\.quotabar-win
```

Common files:

| File | Purpose |
| --- | --- |
| `settings.json` | Poll interval and provider timeout settings |
| `quotabar.log` | Local app log with sensitive values redacted |
| `.installed` | First-run marker |

## Architecture

```text
src/
├─ main/       Electron app lifecycle, tray menu, autostart, logging
├─ providers/  Claude, Codex, Gemini, and provider registry
├─ auth/       Credential parsing, JWT helpers, token refresh
├─ usage/      Refresh loop, snapshot store, formatters
├─ icon/       Runtime tray icon rendering
├─ config/     Paths, settings, first-run prompt
└─ shared/     Redaction and shared error types
```

The core flow is:

1. Electron starts without opening a main window.
2. Settings are loaded from `%USERPROFILE%\.quotabar-win`.
3. Providers fetch or summarize usage through the shared provider interface.
4. `UsageStore` keeps the latest successful snapshots.
5. The tray icon and menu update after each refresh.

## Security Notes

- Tokens, cookies, authorization headers, and JWTs are not printed in UI output.
- Logs pass through redaction helpers before sensitive values are written.
- Credentials are read only from known provider paths.
- QuotaBar does not scan the disk for auth files.
- Provider APIs used for Claude and Codex quota data are unofficial or internal and may change.

## Project Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Build and start Electron in debug mode |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm test` | Run the Vitest test suite |
| `npm run package` | Build Windows release artifacts |

## License

MIT
