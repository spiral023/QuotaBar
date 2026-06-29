# Abo-Plan-Timeline mit Währungsumrechnung — Design

**Datum:** 2026-06-13
**Status:** Genehmigt (Brainstorming abgeschlossen)

## Ziel

QuotaBar soll zeitlich begrenzte Abo-Plan-Perioden pro Anbieter (Claude/Codex) konfigurierbar machen — inklusive paralleler Accounts (Overlap), frei benennbarer Pläne, Kosten in € oder $ mit Umrechnung anhand des **tagesaktuellen** Wechselkurses (historisch aus dem Internet), und Sichtbarmachung von Plan-Wechseln in den Analytics- und History-Graphen.

Hintergrund: Das bisherige Modell kennt nur **einen** fixen Monatsbetrag pro Anbieter (`settings.subscriptionCosts.{claude,codex}`), verwendet als `betrag × Tage/30`. Das kann weder Tarifwechsel über die Zeit noch zwei parallele Accounts noch Fremdwährung abbilden, und der ROI rechnet dadurch mit einem statischen, oft veralteten Wert.

## Kernentscheidungen (aus dem Brainstorming)

| Frage | Entscheidung |
|---|---|
| €→USD-Umrechnung | **Täglich variabel** — pro Tag der Kurs dieses Tages; historische Tages-Kurs-Reihe, lokal gecacht |
| Overlap zweier Pläne | **Summe** der Tageskosten beider aktiven Pläne; gemeinsamer ROI |
| Perioden-Modell | **Start + optionales Ende**, Overlaps & Lücken erlaubt |
| Basiswährung | **USD** bleibt Vergleichs-/Anzeigebasis (API-Kosten sind USD); €-Originalbetrag wird im Editor zusätzlich gezeigt |
| UI-Ort | **Eigener Tab „Abos"** |
| Chart-Darstellung | **Vertikale Linie + Label** am Wechsel |
| Architektur | **Backend ist Single Source of Truth** (Ansatz A) |
| Initial-Plan | **Kein stillschweigender Default** — Einrichtungs-Hinweis, wenn kein Plan hinterlegt |
| Preisänderung / neue Stufen | Durch Perioden-Modell + Freitext-Name + freien Betrag abgedeckt; Komfort-Shortcut „Preis/Stufe ändern ab …" |

## Abschnitt 1 — Datenmodell

In `src/config/settings.ts`:

```ts
type Currency = "USD" | "EUR";

interface PlanPeriod {
  id: string;            // stabile ID (Bearbeiten/Löschen)
  provider: "claude" | "codex";
  name: string;          // frei, z. B. "Claude Pro", "Max 20×", "Team"
  amount: number;        // Monatsbetrag in `currency`, ≥ 0
  currency: Currency;    // "EUR" | "USD"
  startsAt: string;      // ISO-Datum+Uhrzeit
  endsAt: string | null; // ISO-Datum+Uhrzeit, null = läuft weiter
}
```

- `Settings.plans: PlanPeriod[]` **ersetzt** `subscriptionCosts`.
- **Tageskostenanteil** eines Plans = `amount/30` (gleiche Konvention wie der bestehende Live-Faktor → konsistent).
- **Grenztag-Proration:** An einem Tag, an dem ein Plan startet/endet, zählt er anteilig nach dem aktiven Bruchteil dieses Tages (nutzt die Uhrzeit). Volle Tage = Faktor 1.
- **Overlap:** mehrere an einem Tag aktive Pläne werden summiert.
- **Lücke** (kein aktiver Plan an einem Tag): Abo-Baseline = 0 → ROI dort „n/a".

## Abschnitt 2 — Wechselkurse (FX)

Neues Modul `src/pricing/fx-fetcher.ts` (analog zu `LiteLLMFetcher`).

- **Quelle:** Frankfurter API (`api.frankfurter.dev`) — EZB-Referenzkurse, kostenlos, kein API-Key, historische Tageskurse seit 1999. Paar `EUR→USD`, Zeitreihe für ganze Bereiche in einem Request (`/v1/{start}..{end}?base=EUR&symbols=USD`).
- **Cache:** `~/.quotabar-win/cache/fx-rates.json`, Form `{ "EURUSD": { "YYYY-MM-DD": number, … } }`.
- **Backfill:** beim ersten Bedarf einmalig vom frühesten Plan-Start bis heute als Zeitreihe; danach inkrementell nur fehlende Tage.
- **EZB-Lücken** (Wochenende/Feiertage): letzter vorheriger Handelstag wird vorgetragen (forward-fill).
- **Offline / Fehler:** bei `pricingOfflineMode` oder fehlgeschlagenem Abruf → letzter bekannter Cache-Kurs (forward/backward-fill); wenn gar keiner existiert, fester Fallback (`EURUSD ≈ 1.08`) mit „geschätzt"-Kennzeichnung in der UI.
- **USD-Pläne** brauchen nie FX (Faktor 1).

Schnittstelle (vereinfacht):

```ts
interface FxLookup { rate(pair: "EURUSD", day: string): { value: number; estimated: boolean }; }
class FxFetcher {
  ensureRange(minDay: string, maxDay: string): Promise<void>; // Backfill + Cache
  lookup(): FxLookup;                                          // synchroner Zugriff nach ensureRange
}
```

## Abschnitt 3 — Kosten-Engine & Integration

Neues Modul `src/pricing/plan-cost.ts`:

```ts
// Summe der Tages-Abokosten (USD) aller an `day` aktiven Pläne des Anbieters,
// €-Beträge via Tageskurs umgerechnet, Grenztag-Proration angewandt. 0 bei Lücke.
function dailySubCostUSD(
  plans: PlanPeriod[],
  provider: "claude" | "codex",
  day: string,            // YYYY-MM-DD (lokaler Kalendertag)
  fx: FxLookup,
): number;

// Effektive Abokosten (USD) über einen Tagesbereich = Σ dailySubCostUSD.
function periodSubCostUSD(plans, provider, sinceDay, untilDay, fx): number;

// Wechselpunkte (Plan-Start/-Ende) im Bereich, für Chart-Marker.
function planChangePoints(plans, provider, sinceDay, untilDay): Array<{
  day: string; provider: string; label: string; // z. B. "Pro → Max", "+ 2. Account", "Pro endet"
}>;
```

Eingebunden an genau **zwei** Stellen (eine Wahrheit):

1. **Live-Faktor** `src/pricing/subscription-factor.ts`: `periodSubCost = periodSubCostUSD(...)` über die Fenstertage statt `amount × Tage/30`. `CostFactorResult.subscriptionCostUSD` = effektive Summe. Bei „kein Plan im Fenster" → `factor = null`, Label „Kein Abo hinterlegt".
2. **Analytics-Worker** `src/main/analyticsWorker.ts`: `dailyBuckets[]` bekommt je Tag `claudeSubUSD`/`codexSubUSD`; Gesamt-`roiFactor` wie bisher, aber mit zeitvariablem Nenner.

## Abschnitt 4 — IPC & Datenfluss

- **Neue IPC-Kanäle:**
  - `plans:get` → `PlanPeriod[]`
  - `plans:save` → speichert die Liste (validiert/normalisiert), invalidiert Analytics-/Live-Caches (bestehender `clearAnalyticsCaches`).
  - `fx:status` → Info für „geschätzt"-Kennzeichnung (z. B. letzter erfolgreicher Abruf, Offline-Flag).
- **`analytics:get`-Antwort:**
  - `dailyBuckets[]` zusätzlich `claudeSubUSD`/`codexSubUSD` (für kumulativen ROI mit echtem zeitvariablem Nenner statt heute `subscriptionCostUSD/30`).
  - `planChanges: PlanChangePoint[]` — Wechselpunkte im Zeitraum (Anbieter, Tag, Label).
- **`reports:get` (History)-Antwort:** analog `planChanges` im Zeitraum, damit der Balkenchart dieselben Marker zeigt.
- Plan-Speichern invalidiert die Caches; FX-Backfill läuft im Worker/Main beim Neuberechnen.

## Abschnitt 5 — Frontend („Abos"-Tab + Chart-Marker)

Neuer Tab „Abos" (Button in der Tab-Leiste, `#view-plans`, neuer Renderer `src/renderer/tabs/plans.js`). Umsetzung mit `/frontend-design` und `/make-interfaces-feel-better`.

- **Pro Anbieter eine Karte** (Claude / Codex) mit Perioden-Timeline: je Eintrag Name, Zeitraum, Betrag in Originalwährung + „(≈ $X)" USD-Äquivalent, „aktiv"-Badge.
- **Leerzustand:** „Noch kein Abo für {Anbieter} hinterlegt" + auffälliger Button „Abo hinzufügen". Auch der ROI-Bereich in Analytics zeigt dezent einen „Abo einrichten"-Hinweis (Link zum Abos-Tab).
- **Hinzufügen/Bearbeiten-Formular:** Name (Schnellvorschläge Pro/Max/Team, frei überschreibbar), Betrag, Währungsumschalter €/$, Start (Datum+Uhrzeit), Ende (optional, „läuft weiter"), Live-Vorschau „≈ $X (Kurs vom …)".
- **„Preis/Stufe ändern ab …"** auf einer aktiven Periode: beendet sie automatisch zum Zeitpunkt und legt Folgeperiode an.
- **Löschen** mit Bestätigung.
- **Polish** (make-interfaces-feel-better): tabular-nums für Beträge, dezentes „aktiv"-Band, weiche Add/Edit-Übergänge, optische Ausrichtung.
- **Chart-Marker:** kleines eingebettetes Chart.js-Plugin (keine neue Abhängigkeit) zeichnet vertikale Linien + Label an den Wechselpunkten — im Analytics-Linienchart und im History-Balkenchart. Wechseldatum → nächster Bucket-Index auf der Kategorie-X-Achse.
- **ROI-bei-kein-Plan:** ROI-Umschalter zeigt „n/a"/leere Linie + Hinweis-Chip; Kosten-Ansicht funktioniert weiter.

## Abschnitt 6 — Migration, Edge Cases, Tests

- **Migration:** `normalizeSettings` ergänzt `plans: []`, falls fehlend; toleriert alte Settings-Dateien. Alle Verbraucher von `settings.subscriptionCosts` werden auf das Plan-Modell umgestellt: `subscription-factor.ts`, `analyticsWorker.ts`, `detailsWindow.ts`, Settings-Formular in `index.html`. Die alten €-Felder im Settings-Tab entfallen (wandern in den Abos-Tab). Legacy-`subscriptionCosts` wird **nur** als unverbindlicher Formular-Vorschlag gelesen, **nie** automatisch zu Plänen gemacht.
- **Edge Cases:** kein Plan → ROI/Faktor „n/a"; Overlap → Summe; Lücke → 0; Grenztag → Proration; FX offline → letzter Cache-Kurs bzw. Fallback + „geschätzt".
- **Validierung:** Betrag ≥ 0; Start < Ende (falls Ende gesetzt); Name nicht leer.
- **Tests (vitest, bestehende Muster):**
  - `plan-cost.ts`: Einzelplan, Overlap-Summe, Lücke=0, Grenztag-Proration, €→USD via FX, USD-Durchgriff, `planChangePoints`.
  - `fx-fetcher.ts`: Cache-Treffer, forward-fill über EZB-Lücken, Offline-Fallback, Backfill-Range.
  - Settings-Migration: keine Pläne erfunden; `plans: []` ergänzt.
  - `periodSubCostUSD` über Fenster mit Wechsel/Overlap.

## Nicht im Umfang (YAGNI)

- Globaler „alles in €"-Anzeigemodus (API-Kosten blieben USD).
- Jährliche Abrechnungszyklen (nur monatlich; Tagesanteil `/30`).
- Andere Währungen als € und $.
- Automatische Tarif-Erkennung aus den Provider-Daten (`planType` ist opak; bleibt unangetastet).
