# Wie QuotaBar Tokens und Kosten berechnet

QuotaBar liest lokale JSONL-Dateien, die Claude Code und Codex CLI auf dem Rechner hinterlassen, und berechnet daraus Token-Summen, API-Kosten und den Abo-Faktor. Dieser Text beschreibt den vollständigen Rechenweg.

---

## Datenquellen

| Provider | Dateipfad | Format |
|---|---|---|
| Claude | `~/.claude/projects/**/*.jsonl` | Eine JSON-Zeile pro Assistent-Nachricht |
| Codex | `~/.codex/sessions/**/*.jsonl` | Eine JSON-Zeile pro Token-Count-Event |

Die Dateien werden bei jedem Poll-Zyklus frisch eingelesen. Es gibt keinen lokalen Cache zwischen Refreshes.

---

## Claude: Token-Zählung

### Welche Zeilen werden ausgewertet?

Jede Zeile im Claude-JSONL hat ein `type`-Feld. Ausgewertet werden nur Zeilen mit `type: "assistant"`, die ein `message.usage`-Objekt enthalten:

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

### Deduplizierung

Claude Code schreibt bei Streaming-Antworten mehrere Snapshots derselben Nachricht in die JSONL-Datei (mit zunehmenden Token-Zählern). QuotaBar dedupliziert auf `message.id`: Die erste Zeile mit einer bestimmten ID wird gezählt, alle weiteren werden übersprungen.

**Folge:** QuotaBar zählt jede API-Anfrage genau einmal. Tools wie ccusage, die nicht deduplizieren, können höhere Output-Token-Zahlen ausweisen (typisch ~10 % mehr).

### Token-Felder

| UI-Feld | JSONL-Feld | Bedeutung |
|---|---|---|
| INPUT | `input_tokens` | Frische, nicht gecachte Prompt-Tokens |
| OUTPUT | `output_tokens` | Generierte Antwort-Tokens |
| CACHE + | `cache_creation_input_tokens` | Tokens, die neu in den Cache geschrieben wurden |
| CACHE ▷ | `cache_read_input_tokens` | Tokens, die aus dem Cache gelesen wurden (günstiger) |
| TOTAL | Summe aller vier Felder | Alle verarbeiteten Tokens |

```
TOTAL = INPUT + OUTPUT + CACHE+ + CACHE▷
```

### Zeitfenster-Filter

Bevor Token-Daten aufsummiert werden, filtert QuotaBar nach dem konfigurierten Kostenfenster (siehe [Kostenfenster](#kostenfenster)). Einträge mit `timestamp < billingStart` werden ignoriert.

---

## Claude: Kostenberechnung

Kosten werden in zwei Schritten berechnet:

**Schritt 1 – Einträge mit `costUSD`-Feld:**
Neuere Claude-Code-Versionen schreiben einen `costUSD`-Wert direkt in jede JSONL-Zeile. Diese Werte werden direkt summiert.

**Schritt 2 – Einträge ohne `costUSD`:**
Für ältere Einträge ohne `costUSD` holt QuotaBar die Modellpreise von der [LiteLLM-Preistabelle](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json) (oder aus dem lokalen Cache bei Offline-Modus) und rechnet:

```
Kosten = INPUT × input_cost_per_token
       + OUTPUT × output_cost_per_token
       + CACHE+ × cache_creation_input_token_cost
       + CACHE▷ × cache_read_input_token_cost
```

Beide Teilsummen werden addiert.

---

## Codex: Token-Zählung

### Dateiformat

Codex CLI schreibt zwei relevante Zeilentypen:

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

### Kumulierte vs. Delta-Zählung

Codex schreibt entweder kumulative Gesamtzahlen (`total_token_usage`) oder Zahlen für den letzten Turn (`last_token_usage`). QuotaBar verarbeitet beide:

- **`last_token_usage` vorhanden:** Wert direkt als Delta übernehmen.
- **Nur `total_token_usage` vorhanden:** Delta = Aktuell − Vorherige Summe (Differenzbildung über den Session-Verlauf).

### Token-Felder

| UI-Feld | Bedeutung |
|---|---|
| INPUT | `input_tokens` — **alle** Prompt-Tokens inkl. Cache-Anteil |
| CACHE ▷ | `cached_input_tokens` — der gecachte Anteil von INPUT (Teilmenge, nicht additiv) |
| OUTPUT | `output_tokens` |
| TOTAL | `total_tokens` aus dem JSONL (= INPUT + OUTPUT + Reasoning) |

> **Wichtig:** Bei Codex ist `cached_input_tokens` eine **Teilmenge** von `input_tokens` — beide zusammen addieren würde Cache-Tokens doppelt zählen. QuotaBar zeigt `CACHE ▷` zur Information an, rechnet es aber nicht nochmals zum Total.
>
> ```
> TOTAL = INPUT + OUTPUT + reasoning_output_tokens
>       ≠ INPUT + CACHE▷ + OUTPUT   (das wäre doppelt gezählt)
> ```

### Modell-Erkennung

Das aktuelle Modell wird aus dem letzten `turn_context`-Eintrag vor dem Token-Event gelesen. Fehlt er, wird `gpt-5` als Fallback gesetzt (`isFallback: true`).

### Keine Deduplizierung nötig

Codex schreibt keine doppelten Events. Jeder Token-Count-Event entspricht einem echten API-Turn.

---

## Codex: Kostenberechnung

```
Kosten = (INPUT − CACHE▷) × input_cost_per_token
       + CACHE▷ × cache_read_input_token_cost
       + OUTPUT × output_cost_per_token
```

Der ungecachte Anteil (`INPUT − CACHE▷`) wird zum vollen Input-Preis berechnet, der gecachte Anteil (`CACHE▷`) zum günstigeren Cache-Read-Preis.

**Speed Tier:** Liest QuotaBar aus `~/.codex/config` den Eintrag `service_tier = priority` (oder `fast`), werden alle Kosten mit dem Faktor aus der LiteLLM-Tabelle multipliziert (typisch 2×).

**Modell-Aliase:** Interne Codex-Modellnamen werden vor der Preisabfrage gemappt:

| JSONL-Name | Preisabfrage-Name |
|---|---|
| `gpt-5-codex` | `gpt-5` |
| `gpt-5.3-codex` | `gpt-5.2-codex` |

---

## Kostenfenster

QuotaBar filtert Token-Daten auf einen konfigurierbaren Zeitraum. Die Einstellung `costWindow` in den App-Settings steuert den Startpunkt:

| Modus | Startpunkt |
|---|---|
| `billing` | Nativer Abrechnungszeitraum des Providers (Standard) |
| `30d` | Jetzt − 30 Tage |
| `7d` | Jetzt − 7 Tage |

### Billing-Modus: Claude

QuotaBar sucht im aktuellen Snapshot nach einem `credits`-Window mit `resetsAt`. Das ist der nächste Abrechnungsstichtag; als Startpunkt wird dieser direkt verwendet (die Credits-Period beginnt am Reset-Datum).

Fehlt das `credits`-Window, fällt QuotaBar auf den ersten UTC-Tag des laufenden Kalendermonats zurück.

### Billing-Modus: Codex

Codex hat ein wöchentliches Quota-Window. QuotaBar liest `weekly.resetsAt` aus dem Snapshot und berechnet:

```
billingStart = weekly.resetsAt − 7 Tage
```

Das ergibt den Beginn der laufenden Woche.

---

## Abo-Faktor

Der Abo-Faktor (`N× sub`) zeigt, wie viel die tatsächliche API-Nutzung im Verhältnis zum monatlichen Abo-Preis gekostet hätte:

```
factor = apiCostUSD / subscriptionCostUSD
```

Standardwerte (konfigurierbar in den App-Settings):

| Provider | Standard |
|---|---|
| Claude | $20 / Monat |
| Codex | $20 / Monat |

**Beispiel:** `$275.71 · 30d (13.79× sub)` bedeutet: Die API-Nutzung der letzten 30 Tage hätte $275.71 gekostet — das entspricht dem 13.79-fachen des $20-Abos.

---

## Debug-Log und Backfill

QuotaBar schreibt optional strukturierte Logs nach `~/.quotabar-win/debug/`:

| Datei | Inhalt |
|---|---|
| `YYYY-MM-DD.jsonl` | Live-Events: App-Start, Refresh-Zyklen, Snapshots |
| `YYYY-MM-DD.backfill.jsonl` | Historische Token-Events aus den JSONL-Dateien |

Der Backfill wird beim App-Start einmalig ausgeführt und überspringt Tage, für die die Datei bereits existiert. Über das Tray-Menü ("Regenerate Debug Backfill") kann er erzwungen neu gestartet werden.

> **Hinweis zu Backfill-Kosten:** Die Claude- und Codex-JSONL-Dateien enthalten für Subscription-Accounts keine Kostenfelder. Die `totalCostUSD`-Felder in den Backfill-Dateien sind daher immer `0`.

---

## Unterschiede zu ccusage

| Aspekt | QuotaBar | ccusage |
|---|---|---|
| Claude Deduplizierung | Ja, auf `message.id` | Nein (zählt alle Streaming-Snapshots) |
| Claude Output-Tokens | Tendenziell ~10 % niedriger | Höher durch fehlende Dedup |
| Codex Token-Zählung | Übereinstimmend (< 1 % Abweichung) | Übereinstimmend |
| Gemini / OpenCode | Nicht unterstützt | Unterstützt |
| Kosten-Anzeige | API-Kosten + Abo-Faktor | API-Kosten in USD |
| Zeitfenster | billing / 30d / 7d wählbar | Fest nach Kalendermonat/-woche |

---

## Dateipfade (Windows)

| Zweck | Pfad |
|---|---|
| Claude JSONL | `%APPDATA%\Claude\projects\**\*.jsonl` |
| Codex JSONL | `%USERPROFILE%\.codex\sessions\**\*.jsonl` |
| Codex Config | `%USERPROFILE%\.codex\config` |
| QuotaBar Settings | `%APPDATA%\quotabar-win\settings.json` |
| QuotaBar Log | `%APPDATA%\quotabar-win\quotabar.log` |
| Debug-Log | `%APPDATA%\quotabar-win\debug\` |
