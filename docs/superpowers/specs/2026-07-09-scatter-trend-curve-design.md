# Design: Preis/Leistungs-Trendkurve im Cost-vs-Intelligence-Scatter

**Datum:** 2026-07-09
**Tab:** Models → Cost-vs-Intelligence-Scatter (`src/renderer/tabs/models.js`, `models-calc.js`)

## Ziel

Eine weiße Referenzkurve in den Scatter legen, die den typischen Zusammenhang
zwischen effektivem Preis (`$/MTok`, x) und Benchmark-Intelligenz (`score`, y)
ausdrückt. Sie beantwortet: „Wie viel Intelligenz bekommt man für diesen Preis
üblicherweise?" Der vertikale Abstand eines Modells zur Kurve (Residuum) zeigt, ob
es besser oder schlechter als für seinen Preis erwartbar abschneidet.

Die Kurve zielt auf **`score` und `$/MTok`**, nicht auf den Kostenanteil
(`sharePct` / % of cost). Der Kostenanteil bleibt ausschließlich die Blasengröße.

## Semantik

Trend / Erwartungswert (Regression durch **alle** sichtbaren Punkte), nicht
Effizienz-Frontier und nicht Iso-Value-Linie. Die Kurve ist die Mitte der
Punktwolke; Punkte darüber = besseres Preis/Leistung als erwartet, darunter =
schlechter.

## Mathematik (`models-calc.js`)

Neue reine Funktion `scatterTrendCurve(points, sampleCount = 48)`:

- **Fit-Modell:** `y = a + b·ln(x)` (logarithmisch → diminishing returns).
- **Verfahren:** OLS auf den transformierten Punkten `(u = ln x, y)`:
  - `ū = mean(u)`, `ȳ = mean(y)`
  - `Suu = Σ(u−ū)²`, `Suy = Σ(u−ū)(y−ȳ)`
  - `b = Suy / Suu`, `a = ȳ − b·ū`
- **Ungewichtet:** jedes Modell zählt gleich; `sharePct` geht nicht ein.
- **Guards → `return null`** (Kurve wird nicht gezeichnet):
  - weniger als **4** Punkte,
  - irgendein `x <= 0` (ln undefiniert; in der Praxis ist `effPerMTok > 0`),
  - `Suu === 0` (alle x identisch → keine Steigung schätzbar),
  - `a`/`b` nicht finite.
- **Rückgabe:** `{ a, b, samples: [{x, y}, …] }`
  - `samples`: `sampleCount` Punkte gleichmäßig über den **beobachteten** Bereich
    `[minX, maxX]` (keine Extrapolation über die Datenpunkte hinaus).

Ergänzung in `scatterPoints`: kein struktureller Eingriff nötig — das Residuum
wird im Renderer aus `{a, b}` berechnet: `residual = p.y − (a + b·Math.log(p.x))`.
Alternativ als kleine Helferin `trendResidual(point, fit)` in `models-calc.js`,
damit sie testbar ist.

## Rendering (`models.js`, `renderScatter`)

- Zweites Dataset im bestehenden `type: 'bubble'`-Chart:
  ```js
  {
    type: 'line',
    data: fit.samples,          // [{x, y}]
    parsing: false,             // {x,y} direkt
    pointRadius: 0,
    fill: false,
    borderColor: 'rgba(255,255,255,0.7)',
    borderWidth: 2,
    tension: 0,
    order: 10,                  // hoher order → unter den Blasen gezeichnet
  }
  ```
  Das Blasen-Dataset bekommt `order: 0`, damit Punkte über der Linie liegen.
- **Tooltip:** Der bestehende `label`-Callback greift auf `dataset.pointsMeta` zu —
  das Line-Dataset hat keine `pointsMeta`. Deshalb `tooltip.filter` ergänzen, das
  nur Items mit `pointsMeta` durchlässt (Line-Dataset ist nicht hoverbar).
- **Residuum im Bubble-Tooltip:** Wenn ein Fit existiert, Zeile anhängen (Englisch):
  - `+4.2 above trend ▲` bzw. `−3.1 below trend ▼` (eine Nachkommastelle,
    Unicode-Minus/Pfeile wie im restlichen Tab).
- **Update-Pfad:** Beide Update-Zweige (`initial` vs. `_scatterChart.update()`)
  müssen das Line-Dataset neu setzen bzw. bei `null`-Fit entfernen.
- **Refit-on-Filter:** `renderScatter` baut `pts` aus den sichtbaren Zeilen; die
  Kurve refittet automatisch beim Provider-/Fenster-Filter. Die 4-Punkte-Schwelle
  blendet sie aus, wenn der Filter zu wenig übrig lässt.

## Koexistenz mit OPTIMUM-Rechteck

Beide bleiben: OPTIMUM-Box (absolut: günstige Hälfte × starke Hälfte) und
Trendkurve (relativ: Preis/Leistungs-Erwartung) ergänzen sich. Keine Änderung am
`SCATTER_OPTIMUM_PLUGIN`.

## Caption

Bestehende `mod-scatter-note` erweitern (App-Sprache **Englisch**):

> `x = $/MTok effective (incl. cache) · green = better, red = worse · white line = expected score for price · <benchmarksAsOf>`

## Edge Cases

- < 4 sichtbare Punkte, entartete x-Werte oder leeres Fenster → kein Line-Dataset,
  Rest unverändert (bestehende Empty-Note greift bei 0 Punkten).
- Dark-Theme-only (wie die gesamte App) — die weiße Linie passt ohne Theme-Token.

## Tests (`tests/modelsCalc.test.ts`)

- Fit reproduziert bekannte log-Beziehung: Punkte exakt auf `y = 2 + 5·ln(x)` →
  `a ≈ 2`, `b ≈ 5`, `samples` liegen auf der Kurve.
- `< 4` Punkte → `null`.
- alle x identisch → `null` (Suu = 0).
- `samples` decken `[minX, maxX]` ab, aufsteigend, `sampleCount` Länge.
- `trendResidual`: Punkt über/unter Kurve → korrektes Vorzeichen.

## Nicht im Scope (YAGNI)

- Keine Blasen-Umfärbung nach Residuum (Provider-Farbe bleibt Identitätskanal).
- Kein R²/Konfidenzband, keine robuste/gewichtete Regression.
- Keine Sättigungs- oder LOESS-Variante.
