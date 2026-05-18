# Design: API-Kosten-Faktor-Berechnung

**Datum:** 2026-05-18  
**Status:** Genehmigt  
**Ziel:** Im Tray-Menü anzeigen, um welchen Faktor die API-Nutzung teurer wäre als das monatliche Abo.

---

## Überblick

QuotaBar zeigt derzeit Nutzungs-Prozentsätze pro Provider. Diese Funktion ergänzt pro Provider eine Zeile wie:

```
Claude: 45% (resets in 3h 12m)
API-Äq: $47.32 (~2.4× Abo)
```

Der Faktor = `apiCostUSD / subscriptionCostUSD`. Ein Wert > 1 bedeutet: Die API-Nutzung wäre teurer als das Abo.

---

## Gewählter Ansatz

**Ansatz A: Vollständige Pipeline mit Fallback-Schätzungen**

- Claude: Exakt via JSONL-Logs + LiteLLM-Preise
- Codex: Geschätzt via Nutzungs-% + GPT-4o-Referenzpreise (mit `~`-Präfix)
- Gemini: Geschätzt via Session-Anzahl + Gemini-Preise (mit `~`-Präfix)

---

## Neue Module: `src/pricing/`

### `litellm-fetcher.ts`

Lädt Preisdaten von:
```
https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
```

- Cached im Speicher (`Map<string, ModelPricing>`)
- Modell-Lookup in dieser Reihenfolge:
  1. Direkter Match
  2. Mit Präfixen: `anthropic/`, `claude-3-5-`, `claude-3-`, `claude-`
  3. Case-insensitive Teilstring-Match
  4. `null` wenn nicht gefunden
- Fallback-Preise (hartcodiert) für: `claude-opus-4`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `gpt-4o`, `gemini-2.0-flash`
- `pricingOfflineMode: true` in Settings → Fetch überspringen, nur Fallbacks

```typescript
interface ModelPricing {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  provider_specific_entry?: { fast?: number };
}
```

---

### `cost-calculator.ts`

Berechnet Kosten aus Token-Zählungen mit gestaffelter Logik.

**Tiered-Schwellenwert:** 200.000 Tokens (nur Claude/Anthropic-Modelle).

```typescript
function calculateTieredCost(totalTokens, basePrice, tieredPrice): number
function calculateCostFromTokens(tokens, pricing): number
```

`tokens` enthält: `input_tokens`, `output_tokens`, `cache_creation_input_tokens?`, `cache_read_input_tokens?`, `speed?: 'standard' | 'fast'`

Fast-Modus-Multiplikator: `pricing.provider_specific_entry?.fast ?? 1`

---

### `jsonl-reader.ts`

Liest Claude JSONL-Logs für die aktuelle Billing-Periode.

**Pfad:** `~/.claude/projects/**/*.jsonl`

**Billing-Periode:**
- Primär: `resetsAt` des `credits`-Fensters aus dem Claude-Snapshot
- Fallback: Erster Tag des laufenden Monats

**Pro Zeile gelesen:**
```json
{
  "message": {
    "model": "claude-opus-4-5",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 890
    }
  },
  "timestamp": "2026-05-10T14:23:00Z"
}
```

- Ungültige/kaputte Zeilen werden übersprungen
- Ergebnis: Aggregierte Token-Counts pro Modell + Liste verwendeter Modelle

---

### `codex-estimator.ts`

Schätzt Codex-API-Kosten ohne lokale Logs.

**Methode:**
- Referenz-Budget: 2.000.000 Input-Tokens + 500.000 Output-Tokens = "100% Nutzung"
- `usedPercent` aus Snapshot × Referenz-Budget × GPT-4o-Preise aus LiteLLM
- Ergebnis immer mit `isEstimate: true` markiert

---

### `gemini-estimator.ts`

Schätzt Gemini-Kosten aus Session-Anzahl.

**Methode:**
- Session-Anzahl aus `~/.gemini/tmp/*.json` (bereits im bestehenden Gemini-Provider)
- Durchschnittliche Tokens pro Session: 5.000 Input + 1.000 Output (Schätzwert)
- × Gemini Flash/Pro-Preise aus LiteLLM
- Ergebnis immer mit `isEstimate: true` markiert

---

### `subscription-factor.ts`

Koordiniert alle Berechnungen, gibt `CostFactorResult` zurück.

```typescript
interface CostFactorResult {
  apiCostUSD: number;
  subscriptionCostUSD: number;
  factor: number;
  isEstimate: boolean;        // true bei Codex/Gemini
  label: string;              // z.B. "~2.4× Abo" oder "$0.00 (keine Daten)"
}
```

Aufruf: einmal pro Provider nach jedem Refresh-Zyklus.

---

## Integration in bestehenden Code

### `src/providers/types.ts`
`UsageSnapshot` erhält optionales Feld:
```typescript
costFactor?: CostFactorResult;
```

### `src/usage/refreshLoop.ts`
Nach `provider.fetchUsage()` → `calculateSubscriptionFactor(snapshot)` aufrufen → Ergebnis in Snapshot schreiben.

### `src/main/menu.ts`
Pro Provider-Block: wenn `snapshot.costFactor` vorhanden → zusätzliche disabled Menüzeile einfügen:
```
API-Äq: $47.32 (~2.4× Abo)       // exakt
API-Äq: ~$8.10 (~0.8× Abo)       // Schätzung (~ vorne)
$0.00 (keine Daten)               // wenn JSONL-Verzeichnis fehlt
```

### `src/config/settings.ts`
Neue Felder mit Defaults:
```typescript
subscriptionCosts: { claude: 20, codex: 10, gemini: 19 }
pricingOfflineMode: false
```

---

## Fehlerbehandlung

| Fehlerszenario | Verhalten |
|---|---|
| LiteLLM-Fetch schlägt fehl | Hartcodierte Fallback-Preise verwenden |
| JSONL-Verzeichnis nicht vorhanden | `apiCostUSD: 0`, Label: `$0.00 (keine Daten)` |
| Einzelne JSONL-Zeile ungültig | Zeile überspringen, Rest verarbeiten |
| Provider-Snapshot im Error-Status | `costFactor` bleibt `undefined`, keine Zeile im Menü |
| `subscriptionCosts`-Felder fehlen in Settings | Defaults greifen: claude=20, codex=10, gemini=19 |

---

## Konfiguration (`~/.quotabar-win/settings.json`)

```json
{
  "pollIntervalSeconds": 60,
  "providerTimeoutMs": 10000,
  "subscriptionCosts": {
    "claude": 20,
    "codex": 10,
    "gemini": 19
  },
  "pricingOfflineMode": false
}
```

---

## Nicht im Scope

- Historische Kosten-Trends oder Graphen
- Export/CSV der Kostendaten
- Benachrichtigungen bei Kostenschwellen
- Codex/Gemini mit exakten Token-Logs (kein lokales Log-Format vorhanden)
- Gemini 128k-Tiered-Pricing (flache Rate für v1)
