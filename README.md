# QuotaBar for Windows

<p>
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue">
  <img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-0078D4">
  <img alt="Runtime: Electron" src="https://img.shields.io/badge/runtime-Electron_30-47848F">
  <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="Tests: Vitest" src="https://img.shields.io/badge/tests-Vitest-6E9F18">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green">
</p>

**A small Windows tray app for tracking AI coding quota usage and real API costs across Claude, Codex, and local Gemini state.**

QuotaBar runs quietly in the system tray, reads credentials from known local CLI locations, and keeps your current AI coding usage one click away. It is intentionally narrow: no main window, no broad disk scans, and no account dashboard.

---

## Contents

- [At a Glance](#at-a-glance)
- [Provider Support](#provider-support)
- [Cost Tracking](#cost-tracking)
- [Features](#features)
- [Quick Start](#quick-start)
- [Authentication Setup](#authentication-setup)
- [Commands](#commands)
- [Local Files](#local-files)
- [Architecture](#architecture)
- [Security Model](#security-model)
- [Status](#status)
- [License](#license)

---

## At a Glance

| Area | What QuotaBar does |
| --- | --- |
| **Tray-first UI** | Stacked per-provider progress bars in the Windows system tray |
| **Multi-provider** | Supports Claude, Codex, and local Gemini session state |
| **Real cost tracking** | Reads JSONL logs to calculate actual API costs vs. subscription |
| **Reset notifications** | Windows toast when a provider's usage limit resets back to 0% |
| **Background refresh** | Updates usage periodically, with manual refresh in the tray menu |
| **Defensive fetches** | Keeps the last successful snapshot when a provider endpoint fails |
| **Rate limit handling** | Per-provider backoff on HTTP 429; respects `Retry-After` header |
| **Privacy-aware** | Reads only known paths and redacts sensitive values before logging |

## Provider Support

| Provider | Support level | Source | Cost tracking |
| --- | --- | --- | --- |
| <img alt="Claude" src="https://img.shields.io/badge/Claude-usage_windows-8A5CF6"> | Usage windows | `~/.claude/.credentials.json` | Real — JSONL token logs |
| <img alt="Codex" src="https://img.shields.io/badge/Codex-usage_windows-111827"> | Usage windows | `~/.codex/auth.json` | Real — JSONL session logs |
| <img alt="Gemini" src="https://img.shields.io/badge/Gemini-local_sessions-4285F4"> | Local summary | `~/.gemini/settings.json`, `~/.gemini/tmp/` | Estimated — session count |

> [!IMPORTANT]
> Claude and Codex quota data currently depends on unofficial or internal provider endpoints. These endpoints can change without notice. QuotaBar handles failures defensively, but provider behavior may break until the integration is updated.

## Cost Tracking

QuotaBar's pricing engine calculates how much of your subscription you're actually consuming in API-equivalent terms.

### How it works

For each provider, QuotaBar reads local JSONL logs to aggregate real token usage, fetches current model pricing from [LiteLLM](https://github.com/BerriAI/litellm), and computes:

```
subscription factor = API cost (USD) / subscription cost (USD)
```

A factor of `1.4×` means your usage would cost 1.4× your subscription if billed at API rates.

### Data sources

| Provider | Token source | Method |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl` | Real — aggregates input, output, cache tokens per billing period |
| Codex | `~/.codex/sessions/**/*.jsonl` | Real — aggregates per-session token events |
| Gemini | Session count from `~/.gemini/tmp/` | Estimated — cost modeled from session count |

### Configuration

Subscription costs are set in `settings.json` under `subscriptionCosts`:

```jsonc
{
  "subscriptionCosts": {
    "claude": 20,   // USD/month
    "codex": 10,    // USD/month
    "gemini": 20    // USD/month
  },
  "pricingOfflineMode": false
}
```

Set `pricingOfflineMode: true` to skip LiteLLM price fetches and use built-in fallback prices.

## Features

<p>
  <img alt="No main window" src="https://img.shields.io/badge/UI-tray_only-blue">
  <img alt="Progress bars" src="https://img.shields.io/badge/icon-progress_bars-blue">
  <img alt="Reset notifications" src="https://img.shields.io/badge/notifications-reset_alerts-blue">
  <img alt="Startup toggle" src="https://img.shields.io/badge/Windows-startup_toggle-blue">
  <img alt="Subscription factor" src="https://img.shields.io/badge/cost-subscription_factor-orange">
  <img alt="Sensitive values redacted" src="https://img.shields.io/badge/logs-redacted-green">
</p>

- Windows 10/11 tray app with click, double-click, and right-click menu access.
- **Tray icon shows stacked horizontal progress bars** — one bar per active provider (Codex top, Claude middle, Gemini bottom). Only authenticated providers appear. Bar color reflects usage level; stale data is dimmed. Disconnected state shows a single gray track.
- **Windows toast notification** when a provider's usage window resets to 0% so you know immediately when you can work again.
- Provider rows with usage percentages, reset countdowns, and stale-data indicators.
- **Weekly usage pace tracking** — shows whether you're on track, ahead, or behind relative to a linear weekly burn rate, with ETA until the quota runs out.
- Subscription factor label in tray menu (e.g. `1.4× Abo`, `~0.3× Abo` for estimates).
- **Per-provider rate limit backoff** — on HTTP 429, QuotaBar backs off that provider (respecting the `Retry-After` header; default 5 minutes) without pausing other providers or the global refresh tick.
- Manual refresh, Open Log, Open Config Folder, Start with Windows, and Exit actions.
- Background refresh loop with a default 60 second interval.
- Provider abstraction through a shared `UsageProvider` interface.
- Unit coverage for auth parsing, JWT handling, formatters, colors, redaction, normalization, branding, icon state, reset detection, and refresh loop backoff.

<!-- Add screenshot: tray-menu.png -->

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
| `npm run package` | Build Windows installer and portable artifacts into `package-output/` |

## Local Files

QuotaBar writes runtime files under:

```text
%USERPROFILE%\.quotabar-win
```

| File | Purpose |
| --- | --- |
| `settings.json` | Poll interval, provider timeout, and subscription cost settings |
| `quotabar.log` | Local app log with sensitive values redacted |
| `.installed` | First-run marker |

## Architecture

```text
src/
├─ main/       Electron lifecycle, tray menu, notifications, autostart, logging
├─ providers/  Claude, Codex, Gemini, provider registry
├─ auth/       Credential parsing, JWT helpers, token refresh
├─ usage/      Refresh loop (with rate-limit backoff), snapshot store, reset detection, formatters, usage pace
├─ pricing/    PricingEngine, JSONL readers, cost calculators, LiteLLM fetcher
├─ icon/       Tray icon: stacked progress bars rendered per active provider
├─ config/     Paths, settings, first-run prompt
└─ shared/     Redaction and shared error types
```

The runtime flow:

1. Electron starts without opening a main window.
2. Settings load from `%USERPROFILE%\.quotabar-win`.
3. Providers fetch or summarize usage through `UsageProvider`.
4. `UsageStore` keeps the latest successful snapshots; marks them stale on error.
5. `PricingEngine` reads JSONL logs and calculates the subscription factor for each provider.
6. The tray icon (progress bars) and menu update after each refresh cycle.
7. `NotificationService` fires a Windows toast whenever a usage window resets from ≥ 99.5% back to ≤ 1%.

### Pricing module

| File | Responsibility |
| --- | --- |
| `subscription-factor.ts` | `PricingEngine` — orchestrates factor calculation per provider |
| `jsonl-reader.ts` | Aggregates Claude token usage from `~/.claude/projects/` JSONL files |
| `codex-log-reader.ts` | Aggregates Codex token events from session JSONL files |
| `codex-cost-calculator.ts` | Computes USD cost from Codex token events + speed tier |
| `cost-calculator.ts` | Generic token → USD calculator using LiteLLM pricing |
| `gemini-estimator.ts` | Estimates Gemini cost from session count |
| `litellm-fetcher.ts` | Fetches model pricing from LiteLLM; falls back to offline mode |

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

Early Windows MVP. The core app is usable for local development.

**Known limitations:**

- Claude and Codex quota data depends on unofficial provider endpoints that can change without notice.
- Cost tracking requires local JSONL logs. If no logs exist for a billing period, the cost factor is not displayed.
- Gemini cost is an estimate based on session count, not real token data.
- LiteLLM price fetches require network access. Set `pricingOfflineMode: true` in `settings.json` to use built-in fallback prices instead.
- Reset notifications fire only for windows that drop from ≥ 99.5% to ≤ 1% with status `ok`; they require QuotaBar to be running at the time of the reset.

## License

MIT
