# Design: Echte Codex-Kostenberechnung via JSONL-Logs

**Datum:** 2026-05-18  
**Status:** Genehmigt  
**Ziel:** Codex-Kosten aus echten Session-JSONL-Logs berechnen statt aus fiktivem Token-Budget-Schätzwert.

---

## Problem

`codex-estimator.ts` schätzt Kosten via `usedPercent × 2M Input / 500K Output Tokens` gegen `gpt-4o`-Preise. Das ist ungenau und trägt immer `isEstimate: true`. Der OpenAI Codex CLI schreibt vollständige Token-Zählungen in JSONL-Session-Logs — diese sollen stattdessen verwendet werden.

---

## Gewählter Ansatz

Alle neuen Dateien in `src/pricing/` (konsistent mit `jsonl-reader.ts` für Claude). Zwei neue Module:

1. **`codex-log-reader.ts`** — liest JSONL, produziert `CodexTokenEvent[]`
2. **`codex-cost-calculator.ts`** — berechnet Kosten pro Event, liest Speed-Tier aus `config.toml`

---

## Neue Dateien

### `src/pricing/codex-log-reader.ts`

**JSONL-Pfad:**
```
CODEX_HOME ?? ~/.codex/sessions/**/*.jsonl
```
Wird als `getCodexSessionsDir()` in `src/config/paths.ts` ergänzt (analog zu `getCodexAuthPath()`).

**Interface:**
```typescript
interface CodexTokenEvent {
  timestamp: string;
  model: string;
  isFallback: boolean;
  inputTokens: number;
  cachedInputTokens: number;      // Math.min(raw.cached, raw.input) — Bug-Schutz
  outputTokens: number;           // reasoning bereits enthalten — NICHT separat addieren
  reasoningOutputTokens: number;  // nur zur Anzeige
  totalTokens: number;
}
```

**Parsing pro Datei:**
- Zeilenweise; fehlerhafte JSON-Zeilen überspringen
- `turn_context` → `currentModel = payload.model` merken
- `event_msg` mit `payload.type === "token_count"` und `payload.info !== null`:
  - Modell: `info.model` → `info.metadata?.model` → `currentModel` → `"gpt-5"` (`isFallback=true`)
  - `last_token_usage` vorhanden → direkt als Delta verwenden
  - Sonst: Delta = `total_token_usage - previousTotals`; `previousTotals` danach aktualisieren
  - `cachedInputTokens = Math.min(raw.cached_input_tokens ?? 0, raw.input_tokens ?? 0)`
  - Event mit Timestamp + Modell speichern

**Zeitraum-Filter:**
```
billingStart = weekly.resetsAt - 7 Tage
```
Wird als Parameter übergeben. `event.timestamp >= billingStart.toISOString()`.

**Fallback:** Wenn Verzeichnis nicht existiert oder keine Dateien → leeres Array `[]`.

---

### `src/pricing/codex-cost-calculator.ts`

**Funktion:**
```typescript
async function calculateCodexApiCost(
  events: CodexTokenEvent[],
  fetcher: LiteLLMFetcher,
  speedTier: "standard" | "fast",
): Promise<number>
```

**Modell-Aliases** (vor LiteLLM-Lookup):
```
"gpt-5-codex"   → "gpt-5"
"gpt-5.3-codex" → "gpt-5.2-codex"
```

**LiteLLM-Lookup** — neue Prefixes in `litellm-fetcher.ts`:
```
"openai/", "azure/", "openrouter/openai/"
```
(Werden dem bestehenden `lookup()`-Array hinzugefügt, nach bestehendem Direktmatch geprüft.)

**Kostenformel** (kein Tiered Pricing für OpenAI-Modelle):
```
nonCachedInput = max(inputTokens - cachedInputTokens, 0)
cost = (nonCachedInput / 1_000_000) * inputCostPerMToken
     + (cachedInputTokens / 1_000_000) * cachedInputCostPerMToken
     + (outputTokens / 1_000_000) * outputCostPerMToken
```
Wobei: `inputCostPerMToken = pricing.input_cost_per_token * 1_000_000` usw.

**Speed-Tier-Multiplikator:**
```
speedTier === "fast" → cost *= pricing.provider_specific_entry?.fast ?? 2
speedTier === "standard" → keine Multiplikation
```

**Speed-Tier lesen** (eigene Funktion in der Datei):
```typescript
async function readCodexSpeedTier(configPath: string): Promise<"standard" | "fast">
```
Liest `~/.codex/config.toml` via `fs.readFile`. Regex:
```
/^service_tier\s*=\s*["']?([\w-]+)["']?/m
```
Match = `"priority"` oder `"fast"` → `"fast"`. Fehler / kein Match → `"standard"`.

---

## Geänderte Dateien

### `src/config/paths.ts`

Neue Exportfunktionen:
```typescript
export function getCodexSessionsDir(): string {
  return path.join(
    process.env.CODEX_HOME?.trim() || path.join(getHomeDir(), ".codex"),
    "sessions"
  );
}

export function getCodexConfigPath(): string {
  return path.join(
    process.env.CODEX_HOME?.trim() || path.join(getHomeDir(), ".codex"),
    "config.toml"
  );
}
```

### `src/pricing/litellm-fetcher.ts`

`lookup()` — OpenAI-Prefixes ergänzen:
```typescript
for (const prefix of ["openai/", "azure/", "openrouter/openai/", "anthropic/", ...]) {
```

### `src/pricing/subscription-factor.ts`

`calculateCodexFactor` ersetzt durch echte Log-Berechnung:
```typescript
private async calculateCodexFactor(snapshot: UsageSnapshot): Promise<CostFactorResult | undefined> {
  const billingStart = getCodexBillingStart(snapshot);
  const sessions = getCodexSessionsDir();
  const events = await readCodexTokensForPeriod(sessions, billingStart);
  if (events.length === 0) {
    return {
      apiCostUSD: 0,
      subscriptionCostUSD: this.settings.subscriptionCosts.codex,
      factor: null,
      isEstimate: true,
      label: "Keine Logs verfügbar",
    };
  }
  const speedTier = await readCodexSpeedTier(getCodexConfigPath());
  const apiCostUSD = await calculateCodexApiCost(events, this.fetcher, speedTier);
  const subscriptionCostUSD = this.settings.subscriptionCosts.codex;
  const factor = subscriptionCostUSD > 0 ? apiCostUSD / subscriptionCostUSD : 0;
  return {
    apiCostUSD,
    subscriptionCostUSD,
    factor,
    isEstimate: false,
    label: formatLabel(apiCostUSD, factor, false),
  };
}
```

**Hilfsfunktion:**
```typescript
function getCodexBillingStart(snapshot: UsageSnapshot): Date {
  const weekly = snapshot.windows.find(w => w.name === "weekly" && w.resetsAt);
  if (weekly?.resetsAt) {
    const resetsAt = new Date(weekly.resetsAt);
    if (!isNaN(resetsAt.getTime())) {
      return new Date(resetsAt.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
  }
  // Fallback: Monatsanfang
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
```

### `src/providers/types.ts`

`CostFactorResult.factor` wird `number | null`:
```typescript
export interface CostFactorResult {
  apiCostUSD: number;
  subscriptionCostUSD: number;
  factor: number | null;   // null = keine Logs verfügbar
  isEstimate: boolean;
  label: string;
}
```

### `src/main/menu.ts`

`formatCostFactorLine` für `factor: null`:
```typescript
function formatCostFactorLine(cost: CostFactorResult): string {
  if (cost.factor === null) return `  API-Äq: ${cost.label}`;
  if (cost.apiCostUSD === 0 && !cost.isEstimate) return "  API-Äq: $0.00 (keine Daten)";
  const prefix = cost.isEstimate ? "~" : "";
  return `  API-Äq: ${prefix}$${cost.apiCostUSD.toFixed(2)} (${cost.label})`;
}
```

## Gelöschte Dateien

- `src/pricing/codex-estimator.ts` — vollständig ersetzt

---

## Fehlerbehandlung

| Szenario | Verhalten |
|----------|-----------|
| `sessions/` nicht vorhanden | Leeres Array → "Keine Logs verfügbar" |
| JSONL-Zeile ungültig | Überspringen, weiter |
| `info: null` in token_count | Überspringen (kein Token-Event) |
| LiteLLM-Lookup schlägt fehl | Kosten = 0 für dieses Event |
| `config.toml` nicht lesbar | `speedTier = "standard"` |

---

## Wichtige Invarianten

- Reasoning-Tokens sind in `output_tokens` enthalten → **nicht** separat addieren
- `cachedInputTokens = Math.min(cached, input)` → immer, da Codex-Bug möglich
- Kein Tiered Pricing für OpenAI (kein 200k-Schwellenwert)
- Keine Token-Werte oder Pfade mit sensiblen Inhalten loggen
