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

Wichtig: `input_tokens` in Claude-JSONL enthält **nur** den frischen, ungecachten Anteil. Cache-Reads kommen ausschließlich in `cache_read_input_tokens`.

### Zeitfenster-Filter

Bevor Token-Daten aufsummiert werden, filtert QuotaBar nach dem konfigurierten Kostenfenster (siehe [Kostenfenster](#kostenfenster)). Einträge mit `timestamp < billingStart` werden ignoriert.

---

## Claude: Kostenberechnung

Kosten werden in zwei Schritten berechnet:

**Schritt 1 – Einträge mit `costUSD`-Feld:**
Neuere Claude-Code-Versionen schreiben einen `costUSD`-Wert direkt in jede JSONL-Zeile. Diese Werte werden direkt summiert.

**Schritt 2 – Einträge ohne `costUSD`:**
Für ältere Einträge ohne `costUSD` holt QuotaBar die Modellpreise von der [LiteLLM-Preistabelle](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json) (oder aus dem lokalen Cache bei Offline-Modus) und rechnet pro Modell:

```
Kosten = INPUT  × input_cost_per_token
       + OUTPUT × output_cost_per_token
       + CACHE+ × cache_creation_input_token_cost
       + CACHE▷ × cache_read_input_token_cost
```

Da `input_tokens` in Claude-JSONL bereits nur den ungecachten Anteil enthält, wird kein weiterer Abzug vorgenommen. CACHE+ und CACHE▷ werden mit ihren eigenen (günstigeren) Preisen multipliziert — beide tragen zur Gesamtsumme bei.

Beide Teilsummen (Schritt 1 + Schritt 2) werden addiert. Gibt es für einen Eintrag ohne `costUSD` kein Modell-Feld, wird das erste bekannte Modell oder `claude-sonnet-4-5` als Fallback verwendet.

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

Im Codex-JSONL enthält `input_tokens` die **Gesamtsumme** aller Prompt-Tokens — also inklusive des gecachten Anteils. QuotaBar rechnet das intern um:

| UI-Feld | Berechnung | Bedeutung |
|---|---|---|
| INPUT | `input_tokens − cached_input_tokens` | Frischer, ungecachter Prompt-Anteil |
| CACHE ▷ | `cached_input_tokens` | Gecachter Prompt-Anteil |
| OUTPUT | `output_tokens` | Generierte Antwort-Tokens |
| TOTAL | `total_tokens` aus dem JSONL | Alle Tokens (Prompt inkl. Cache + Output + Reasoning) |

```
Angezeigtes INPUT = input_tokens − cached_input_tokens   (ungecacht)
CACHE ▷           = cached_input_tokens                  (gecacht)
TOTAL             = input_tokens + output_tokens + reasoning  (aus JSONL)
```

Damit bedeutet das Feld INPUT bei beiden Providern dasselbe: *frische, ungecachte Tokens*.

### Modell-Erkennung

Das aktuelle Modell wird aus dem letzten `turn_context`-Eintrag vor dem Token-Event gelesen. Fehlt er, wird `gpt-5` als Fallback gesetzt (`isFallback: true`).

### Keine Deduplizierung nötig

Codex schreibt keine doppelten Events. Jeder Token-Count-Event entspricht einem echten API-Turn.

---

## Codex: Kostenberechnung

```
Kosten = INPUT  × input_cost_per_token
       + CACHE▷ × cache_read_input_token_cost  (Fallback: input_cost_per_token)
       + OUTPUT × output_cost_per_token
```

Wobei INPUT und CACHE▷ die oben berechneten UI-Werte sind:

- **INPUT** = `input_tokens − cached_input_tokens` (ungecachter Anteil zum vollen Preis)
- **CACHE▷** = `cached_input_tokens` (gecachter Anteil zum günstigeren Cache-Read-Preis, falls das Modell einen solchen ausweist — sonst zum normalen Input-Preis)

**Speed Tier:** Liest QuotaBar aus `~/.codex/config` den Eintrag `service_tier = priority` (oder `fast`), wird das Ergebnis mit dem Fast-Faktor aus der LiteLLM-Tabelle multipliziert (typisch 2×, modellabhängig).

**Modell-Aliase:** Interne Codex-Modellnamen werden vor der Preisabfrage gemappt:

| JSONL-Name | Preisabfrage-Name |
|---|---|
| `gpt-5-codex` | `gpt-5` |
| `gpt-5.3-codex` | `gpt-5.2-codex` |

---

## Kostenfenster

QuotaBar filtert Token-Daten auf einen konfigurierbaren Zeitraum. Die Einstellung `costWindow` in den App-Settings steuert den Startpunkt:

| Modus | Startpunkt | `windowDays` |
|---|---|---|
| `7d` | Jetzt − 7 Tage | 7 (fest) |
| `30d` | Jetzt − 30 Tage | 30 (fest) |
| `all` | Epoch (1970-01-01) | Tatsächliche Spanne aus den Daten |

Im Modus `all` wird `windowDays` nicht vorab gesetzt, sondern nach dem Einlesen der Daten berechnet: Differenz zwischen jüngstem Eintrag und heute in Tagen (mindestens 1). Dieser Modus heißt intern `calculationMode: "actual-span"`, die festen Modi heißen `"fixed"`.

Das Fenster wird in der UI als Badge angezeigt (z. B. `30d` oder `14d (all)`). Tooltips erklären den Modus (`festes Fenster` vs. `tatsächlicher Zeitraum`).

---

## Token-Details in der Live-Ansicht

Die aufklappbare Sektion **Token Details** unterhalb jeder Provider-Karte zeigt die akkumulierten Tokens und API-Kosten für das aktuell konfigurierte Kostenfenster — **nicht** all-time.

Der Zeitraum ist im Toggle-Label sichtbar, z. B. `Token Details · 30d`.

| Feld | Inhalt |
|---|---|
| Input | INPUT-Tokens des Fensters |
| Output | OUTPUT-Tokens des Fensters |
| Cache + | CACHE+-Tokens (nur Claude) |
| Cache ▷ | CACHE▷-Tokens des Fensters |
| Total | Summe aller vier Felder |
| Cost | Berechnete API-Kosten in USD für dieses Fenster |

---

## History-Tab: Kosten- und Token-Diagramm

Der History-Tab zeigt ein gestapeltes Balkendiagramm (Claude + Codex) pro Periode. Über den Toggle **Kosten / Tokens** wird zwischen zwei Ansichten gewechselt:

- **Kosten:** API-Kosten in USD pro Periode
- **Tokens:** Token-Menge pro Periode — wählbar zwischen Gesamt, Input, Output, Cache (= CACHE+ + CACHE▷)

Die Y-Achse und Tooltips passen sich automatisch an (USD vs. Token-Einheiten).

---

## Abo-Faktor

Der Abo-Faktor (`N× sub`) zeigt, wie viel die tatsächliche API-Nutzung im Verhältnis zum monatlichen Abo-Preis gekostet hätte:

```
factor = apiCostUSD / (subscriptionCostUSD × windowDays / 30)
```

Die Normalisierung auf `windowDays / 30` macht Fenster unterschiedlicher Länge vergleichbar.

Standardwerte (konfigurierbar in den App-Settings):

| Provider | Standard |
|---|---|
| Claude | $20 / Monat |
| Codex | $20 / Monat |

**Beispiel:** `$275.71 · 30d (13.79× sub)` bedeutet: Die API-Nutzung der letzten 30 Tage hätte $275.71 gekostet — das entspricht dem 13.79-fachen des $20-Abos.

---

## Fenster-Budget (5h ↔ Weekly)

QuotaBar lernt aus der eigenen Nutzung, wie viele volle 5h-Fenster in ein Weekly-Fenster passen. Bei jedem Poll-Zyklus werden die Prozent-Zuwächse beider Fenster verglichen:

```
r = Σ ΔWeekly% / Σ Δ5h%        Fenster pro Woche = 1 / r
```

Verworfen werden Paare mit 5h-Reset (Δ5h ≤ 0 oder `resetsAt`-Wechsel), Weekly-Reset (ΔWeekly < 0), gesättigtem Weekly (≥ 99,5 %), Paare mit mehr als 10 Minuten Abstand (Konto-Wechsel, App-Pausen, Log-Lücken) und Paare mit ΔWeekly > Δ5h (physikalisch unmöglich — transiente API-Ausreißer); ein `resetsAt`-Wechsel zählt erst oberhalb von 60 s Differenz als echter Rollover (Mikrosekunden-Jitter der Claude-API). Das Verhältnis gilt erst ab 200 % beobachteter 5h-Nutzung als belastbar — vorher zeigt die Karte „lernt noch…".

**Mehrere Konten:** Gelernt wird pro Plan-Tier (`planType`), denn das Fenster-Verhältnis ist eine Eigenschaft des Abos, nicht des Kontos. Wer mehrere Claude-Konten nutzt (Wechsel via `claude /login`), behält für jedes Tier den gelernten Stand; Kennzahlen und Verlaufsgraph zeigen immer das gerade aktive Konto. Die Claude-Karte zeigt dessen E-Mail-Adresse an (Quelle: OAuth-Profil-Endpoint, in Debug-Logs redigiert).

Der State liegt in `%USERPROFILE%\.quotabar-win\window-ratio.json` (Format-Version 4; ältere Dateien werden verworfen und automatisch neu aus den Logs geseedet) und wird beim ersten Start einmalig aus den vorhandenen Live-Debug-Logs aufgebaut. Oberhalb von 3000 % Summe werden beide Summen halbiert (exponentielles Vergessen), damit sich Limit-Änderungen der Anbieter durchsetzen.

**Prognose:** Der Termin „Limit erreicht ~…" basiert primär auf dem Wochenprofil (durchschnittliche Token pro Wochentag der letzten 4 Wochen, ab 2 Wochen Historie), sonst auf der linearen Wochen-Durchschnittsrate. Zusätzlich wird die aktuelle Burn-Rate als „Bei aktuellem Tempo: …" angezeigt.

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
| Zeitfenster | 7d / 30d / all wählbar | Fest nach Kalendermonat/-woche |

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
