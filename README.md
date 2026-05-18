# QuotaBar for Windows

**A small Windows tray app for tracking AI coding quota usage and local API-equivalent costs for Claude and Codex.**

QuotaBar runs quietly in the system tray, reads credentials and usage logs from known local CLI locations, and keeps current quota windows plus historical usage reports one click away. It does not scan the disk for credentials.

## At a Glance

| Area | What QuotaBar does |
| --- | --- |
| Tray-first UI | Stacked per-provider progress bars in the Windows system tray |
| Providers | Claude and Codex |
| Live quota | Shows 5-hour and weekly usage windows where provider data is available |
| Reports | Daily, weekly, monthly, and session reports in the dashboard |
| Cost tracking | Calculates API-equivalent USD costs and subscription factor |
| Privacy | Reads known local paths only and redacts sensitive values before logging |

## Provider Support

| Provider | Usage source | Cost source |
| --- | --- | --- |
| Claude | `~/.claude/.credentials.json` plus OAuth usage endpoint | `~/.config/claude/projects/**/*.jsonl`, `~/.claude/projects/**/*.jsonl` |
| Codex | `${CODEX_HOME:-~/.codex}/auth.json` plus usage endpoint | `${CODEX_HOME:-~/.codex}/sessions/**/*.jsonl` |

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` may contain comma-separated roots. QuotaBar deduplicates existing roots and combines usage data from them.

> Claude and Codex quota windows depend on unofficial provider endpoints. QuotaBar handles failures defensively and keeps stale data visible, but these endpoints may change.

## Reports

The dashboard includes Live and Reports tabs. Reports support:

- Provider filter: all, Claude, or Codex.
- Report types: daily, weekly, monthly, and session.
- Since/until date filters, timezone, project/instance filter, sort order, and instance grouping.
- Claude cost modes: `auto`, `calculate`, and `display`.
- Codex speed: `auto`, `standard`, and `fast`.
- Copy JSON for programmatic analysis.

Weekly reports use Monday as the week start. JSON field names are stable English names.

## Cost Tracking

QuotaBar reads local JSONL logs, fetches current model pricing from LiteLLM when online, and computes:

```text
subscription factor = API cost (USD) / subscription cost (USD)
```

Claude cost mode behavior:

- `auto`: use `costUSD` from logs when present, calculate missing entries from tokens.
- `calculate`: calculate all entries from tokens and current pricing.
- `display`: show only `costUSD` from logs.

Codex cached input uses cache-read pricing when available and falls back to input pricing when a model lacks a cache-read price.

Settings are stored in `%USERPROFILE%\.quotabar-win\settings.json`:

```jsonc
{
  "subscriptionCosts": {
    "claude": 20,
    "codex": 10
  },
  "pricingOfflineMode": false,
  "costWindow": "billing"
}
```

Older settings files may still contain extra provider keys. QuotaBar ignores them and writes only supported providers on save.

## Quick Start

```powershell
npm install
npm run build
npm run dev
```

## Authentication Setup

Sign in with the local CLI tools first:

```powershell
claude login
codex login
```

QuotaBar reads Claude credentials from `~/.claude/.credentials.json`. It reads Codex credentials from `${CODEX_HOME:-~/.codex}/auth.json`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build and start Electron in debug mode |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm test` | Run the Vitest test suite |
| `npm run package` | Build Windows installer and portable artifacts |

## Architecture

```text
src/
├─ main/       Electron lifecycle, tray menu, dashboard, notifications, autostart
├─ providers/  Claude and Codex live usage providers
├─ auth/       Credential parsing, JWT helpers, token refresh
├─ usage/      Refresh loop, snapshot store, reset detection, formatters, pace
├─ pricing/    JSONL readers, cost calculators, LiteLLM fetcher, subscription factor
├─ reports/    Daily, weekly, monthly, and session report aggregation
├─ icon/       Tray icon progress bars
├─ config/     Paths, settings, first-run prompt
└─ shared/     Redaction and shared error types
```

## Security Model

- Tokens, cookies, authorization headers, and JWTs are not printed in UI output.
- Logs pass through redaction helpers before sensitive values are written.
- Credentials are read only from known provider paths.
- QuotaBar does not scan the disk for auth files.
- Provider/Auth code keeps unofficial endpoints isolated and defensive.

## Status

Early Windows MVP. Cost tracking requires local JSONL logs. LiteLLM price fetches require network access unless `pricingOfflineMode` is enabled.

## License

MIT
