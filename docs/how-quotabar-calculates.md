# How QuotaBar calculates tokens and costs

QuotaBar reads local JSONL files written by Claude Code and Codex CLI and derives token totals, API costs, and the subscription factor from them. This document describes the full calculation pipeline.

---

## Data sources

| Provider | File path | Format |
|---|---|---|
| Claude | `~/.claude/projects/**/*.jsonl` | One JSON line per assistant message |
| Codex | `~/.codex/sessions/**/*.jsonl` | One JSON line per token-count event |

Files are read fresh on every poll cycle. There is no in-memory cache between refreshes.

---

## Claude: token counting

### Which lines are counted?

Each line in the Claude JSONL has a `type` field. Only lines with `type: "assistant"` that contain a `message.usage` object are counted:

```json
{
  "type": "assistant",
  "timestamp": "2026-05-26T08:00:00Z",
  "message": {
    "id": "msg_abc123",
    "model": "claude-sonnet-4-6",
    "usage": {
      "input_tokens": 1200,
      "output_tokens": 450,
      "cache_creation_input_tokens": 800,
      "cache_read_input_tokens": 42000
    }
  }
}
```

### Deduplication

Claude Code writes multiple snapshots of the same message during streaming (with incrementing token counts). QuotaBar deduplicates on `message.id`: the first line with a given ID is counted; all subsequent ones are skipped.

**Effect:** QuotaBar counts each API request exactly once. Tools such as ccusage that do not deduplicate may report higher output-token numbers (typically ~10 % more).

### Token fields

| UI field | JSONL field | Meaning |
|---|---|---|
| INPUT | `input_tokens` | Fresh, uncached prompt tokens |
| OUTPUT | `output_tokens` | Generated response tokens |
| CACHE + | `cache_creation_input_tokens` | Tokens newly written to the cache |
| CACHE ▷ | `cache_read_input_tokens` | Tokens read from the cache (cheaper) |
| TOTAL | Sum of all four | All processed tokens |

```
TOTAL = INPUT + OUTPUT + CACHE+ + CACHE▷
```

Important: `input_tokens` in Claude JSONL contains **only** the fresh, uncached portion. Cache reads are reported exclusively in `cache_read_input_tokens`.

### Time-window filter

Before tokens are summed, QuotaBar filters on the configured cost window (see [Cost window](#cost-window)). Entries with `timestamp < windowStart` are ignored.

---

## Claude: cost calculation

Costs are calculated in two steps:

**Step 1 — entries with a `costUSD` field:**  
Newer Claude Code versions write a `costUSD` value directly into each JSONL line. These values are summed directly.

**Step 2 — entries without `costUSD`:**  
For older entries without `costUSD`, QuotaBar fetches model prices from the [LiteLLM pricing table](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json) (or from a local cache in offline mode) and calculates per model:

```
cost = INPUT  × input_cost_per_token
     + OUTPUT × output_cost_per_token
     + CACHE+ × cache_creation_input_token_cost
     + CACHE▷ × cache_read_input_token_cost
```

Because `input_tokens` already contains only the uncached portion, no further subtraction is needed. CACHE+ and CACHE▷ are multiplied by their own (lower) rates — both contribute to the total.

Both subtotals (step 1 + step 2) are added. If an entry without `costUSD` has no model field, the first known model or `claude-sonnet-4-5` is used as a fallback.

---

## Codex: token counting

### File format

Codex CLI writes two relevant line types:

```json
{ "type": "turn_context", "payload": { "model": "gpt-5.5" } }

{ "type": "event_msg", "timestamp": "2026-05-26T08:00:00Z",
  "payload": { "type": "token_count", "info": {
    "last_token_usage": {
      "input_tokens": 45000,
      "cached_input_tokens": 42000,
      "output_tokens": 380,
      "reasoning_output_tokens": 0,
      "total_tokens": 45380
    }
  }}}
```

### Cumulative vs. delta counting

Codex writes either cumulative session totals (`total_token_usage`) or per-turn counts (`last_token_usage`). QuotaBar handles both:

- **`last_token_usage` present:** Value used directly as a delta.
- **Only `total_token_usage` present:** Delta = current − previous sum (difference across the session).

### Token fields

In Codex JSONL, `input_tokens` contains the **total** of all prompt tokens — including the cached portion. QuotaBar converts internally:

| UI field | Calculation | Meaning |
|---|---|---|
| INPUT | `input_tokens − cached_input_tokens` | Fresh, uncached prompt portion |
| CACHE ▷ | `cached_input_tokens` | Cached prompt portion |
| OUTPUT | `output_tokens` | Generated response tokens |
| TOTAL | `total_tokens` from JSONL | All tokens (prompt incl. cache + output + reasoning) |

```
Displayed INPUT = input_tokens − cached_input_tokens   (uncached)
CACHE ▷         = cached_input_tokens                  (cached)
TOTAL           = input_tokens + output_tokens + reasoning  (from JSONL)
```

Both providers therefore mean the same thing by INPUT: *fresh, uncached tokens*.

### Model detection

The active model is read from the most recent `turn_context` entry before the token event. If none is found, `gpt-5` is used as a fallback (`isFallback: true`).

### No deduplication needed

Codex does not write duplicate events. Each token-count event corresponds to one real API turn.

---

## Codex: cost calculation

```
cost = INPUT  × input_cost_per_token
     + CACHE▷ × cache_read_input_token_cost  (fallback: input_cost_per_token)
     + OUTPUT × output_cost_per_token
```

Where INPUT and CACHE▷ are the UI values calculated above:

- **INPUT** = `input_tokens − cached_input_tokens` (uncached portion at full price)
- **CACHE▷** = `cached_input_tokens` (cached portion at cache-read price if the model provides one — otherwise at the normal input price)

**Speed tier:** If QuotaBar reads `service_tier = priority` (or `fast`) from `~/.codex/config`, the result is multiplied by the fast-tier factor from the LiteLLM table (typically 2×, model-dependent).

**Model aliases:** Internal Codex model names are mapped before the pricing lookup:

| JSONL name | Pricing lookup name |
|---|---|
| `gpt-5-codex` | `gpt-5` |
| `gpt-5.3-codex` | `gpt-5.2-codex` |

---

## Cost window

QuotaBar filters token data to a configurable time range. The `costWindow` setting controls the start point:

| Mode | Start point | `windowDays` |
|---|---|---|
| `7d` | Now − 7 days | 7 (fixed) |
| `30d` | Now − 30 days | 30 (fixed) |
| `all` | Epoch (1970-01-01) | Actual span from the data |

In `all` mode, `windowDays` is not fixed upfront but calculated after reading the data: the difference between the most recent entry and today in days (minimum 1). This mode is called `calculationMode: "actual-span"` internally; the fixed modes are `"fixed"`.

The window is shown as a badge in the UI (e.g. `30d` or `14d (all)`). Tooltips explain the mode (*fixed window* vs. *actual span*).

---

## Token details in the live view

The expandable **Token Details** section below each provider card shows accumulated tokens and API costs for the currently configured cost window — **not** all-time.

The time range is visible directly in the toggle label, e.g. `Token Details · 30d`.

| Field | Content |
|---|---|
| Input | INPUT tokens for the window |
| Output | OUTPUT tokens for the window |
| Cache + | CACHE+ tokens (Claude only) |
| Cache ▷ | CACHE▷ tokens for the window |
| Total | Sum of all four |
| Cost | Calculated API cost in USD for this window |

---

## History tab: cost and token chart

The History tab shows a stacked bar chart (Claude + Codex) per period. The **Cost / Tokens** toggle switches between two views:

- **Cost:** API cost in USD per period
- **Tokens:** Token volume per period — selectable between total, input, output, and cache (= CACHE+ + CACHE▷)

The Y-axis and tooltips adjust automatically (USD vs. token units). Available resolutions: hourly, daily, weekly, monthly.

---

## Analytics tab: ROI and trends

### Cost trend chart

The cost trend line chart aggregates API cost per bucket and shows separate series for Claude and Codex. Available resolutions:

| Resolution | Y-axis value |
|---|---|
| Hourly | Raw cost per hour |
| Daily | Cost per day |
| Weekly | Average cost per day within the week |
| Monthly | Average cost per day within the month |

### ROI factor

The ROI (subscription factor) is:

```
ROI = apiCostUSD / (subscriptionCostUSD × windowDays / 30)
```

Normalising by `windowDays / 30` makes any window length directly comparable to a monthly subscription price. `1×` means API-equivalent cost equals the subscription cost; `13×` means it is thirteen times the subscription cost.

The running ROI chart shows the cumulative factor growing over time: at each date, all API cost accumulated so far is divided by all subscription cost accumulated so far.

### Other analytics sections

| Section | What it shows |
|---|---|
| Usage breakdown | Donut chart with per-provider cost share; centre shows the combined ROI factor for the selected window |
| Activity stats | Session count, active days, average cost per day, and similar aggregate KPIs |
| Hour heatmap | 24-hour grid showing average cost per hour of the day |
| Weekday pattern | Per-weekday bar chart and the top-5 most expensive individual days |
| 5h window peak | Highest single 5-hour window within the selected range |
| Cost efficiency | Per-model cache-hit rates and estimated USD saved through cache reads |
| ROI by tier | Subscription factor broken out by plan tier |
| 5h window history | Rolling utilisation chart over time (requires debug logging enabled) |

---

## 5h window budget

QuotaBar learns from its own usage data how many full 5-hour windows fit into a weekly window. On every poll cycle it compares the percentage increments of both windows:

```
r = Σ ΔWeekly% / Σ Δ5h%        windows per week = 1 / r
```

Pairs are discarded when:
- 5h reset occurred (Δ5h ≤ 0 or `resetsAt` change)
- Weekly reset occurred (ΔWeekly < 0)
- Weekly is saturated (≥ 99.5 %)
- More than 10 minutes between samples (account switch, app pause, log gap)
- ΔWeekly > Δ5h (physically impossible — transient API outliers)

A `resetsAt` change only counts as a real rollover when the difference exceeds 60 seconds (eliminates microsecond API jitter). The ratio is considered reliable after 200 % of accumulated 5h usage — until then the card shows "still learning…".

**Multiple accounts:** The ratio is learned per plan tier (`planType`) because the window ratio is a property of the subscription, not the account. Users who switch between multiple Claude accounts (via `claude /login`) retain the learned ratio per tier; all metrics and the history chart always reflect the currently active account. The Claude card displays that account's email address (sourced from the OAuth profile endpoint; redacted in debug logs).

The state is stored in `%USERPROFILE%\.quotabar-win\window-ratio.json` (format version 4; older files are discarded and automatically re-seeded from existing debug logs). On first start the file is built once from available live debug logs. Once the accumulated total exceeds 3000 %, both sums are halved (exponential forgetting) so provider limit changes propagate over time.

**Forecast:** The "limit reached ~…" estimate is based primarily on the weekly usage profile (average tokens per weekday for the last 4 weeks, available after 2 weeks of history), otherwise on the linear weekly average rate. The current burn rate is also shown as "At current pace: …".

---

## Bonus reset detection

QuotaBar detects **unscheduled ("bonus") resets** of the weekly quota window. A bonus reset is when:
- Weekly usage drops by ≥ 10 percentage points **and** falls below 5 %
- But the `resetsAt` timestamp does **not** advance by ~7 days (i.e. it is not a scheduled weekly reset)

This pattern indicates an out-of-cycle reset (e.g. a courtesy reset from Anthropic or incident recovery). The bonus badge on the Live tab shows the estimated extra 5-hour windows available during the bonus period.

Transient API artifacts (e.g. brief utilisation spikes) are filtered by cross-checking against 5-hour window movements. Bonus state persists across app restarts.

---

## Portable usage store and debug logs

QuotaBar optionally writes structured logs to `%USERPROFILE%\.quotabar-win\debug\`:

| File | Content |
|---|---|
| `YYYY-MM-DD.jsonl` | Live events: app start, refresh cycles, snapshots |
| `YYYY-MM-DD.backfill.jsonl` | Legacy daily aggregates retained as a migration input during the compatibility release |

Provider JSONL files and legacy backfill records are ingestion-only inputs. QuotaBar sanitizes and stores usage events under `%USERPROFILE%\.quotabar-win\usage\events\`, stores quota observations under `%USERPROFILE%\.quotabar-win\quota\`, and serves calculation views from those portable stores. The migration state is exposed to the System tab only as `pending`, `running`, `complete`, or `failed`; its file contents are never included in System data.

Portable exports include the sanitized usage store, quota snapshots, machine-independent settings, notification state, and a checksum manifest. The privacy boundary explicitly excludes raw provider logs, `auth.json`, `.credentials.json`, machine-specific ingestion state, application logs, caches, and backups.

System Import accepts only portable ZIPs created by **Export data**. An import replaces the portable statistics and settings covered by that archive; it does not merge them with the target account's data. QuotaBar first writes a verified timestamped full backup to `%USERPROFILE%\QuotaBar Backups\`. Importing a portable export between different Windows usernames clears saved provider roots from the source and lets the target discover its own known paths, so a source path such as `C:\Users\Alice` does not remain active for Bob.

The automatic backup is private, full, and intended for same-machine recovery. It has no portable manifest, can contain logs, caches, and target-local paths, and cannot be selected in System Import. Do not share it or use it for a cross-user import. To restore it, fully quit QuotaBar, preserve the current `%USERPROFILE%\.quotabar-win\` separately, extract the trusted backup into a temporary directory, replace the contents of `%USERPROFILE%\.quotabar-win\` while QuotaBar is stopped, and then restart QuotaBar.

---

## Comparison with ccusage

| Aspect | QuotaBar | ccusage |
|---|---|---|
| Claude deduplication | Yes, on `message.id` | No (counts all streaming snapshots) |
| Claude output tokens | Typically ~10 % lower | Higher due to missing dedup |
| Codex token counting | Aligned (< 1 % difference) | Aligned |
| Gemini / OpenCode | Not supported | Supported |
| Cost display | API cost + subscription factor | API cost in USD |
| Time window | 7 d / 30 d / all selectable | Fixed to calendar month / week |

---

## File paths (Windows)

| Purpose | Path |
|---|---|
| Claude JSONL | `%APPDATA%\Claude\projects\**\*.jsonl` |
| Codex JSONL | `%USERPROFILE%\.codex\sessions\**\*.jsonl` |
| Codex config | `%USERPROFILE%\.codex\config` |
| QuotaBar settings | `%USERPROFILE%\.quotabar-win\settings.json` |
| QuotaBar log | `%USERPROFILE%\.quotabar-win\quotabar.log` |
| Debug log | `%USERPROFILE%\.quotabar-win\debug\` |
| Portable usage store | `%USERPROFILE%\.quotabar-win\usage\` |
| Portable quota snapshots | `%USERPROFILE%\.quotabar-win\quota\` |
| Automatic import backups | `%USERPROFILE%\QuotaBar Backups\` |
| Window-ratio state | `%USERPROFILE%\.quotabar-win\window-ratio.json` |
