# QuotaBar Performance-Tracking

Langfristiges Register für Performance-Analysen, Messwerte und offene Optimierungen.

Erstanalyse: 2026-09-05
Letzte Aktualisierung: 2026-09-05

## Warum diese Datei

QuotaBars Kosten skalieren mit der **Anzahl der Events**, nicht mit der Anzahl der
Tage. Bei 1–4 Mrd. Token pro Monat wächst der Store schnell, und Operationen, die
die gesamte Historie anfassen, werden zum Dauerproblem. Diese Datei hält fest, was
gemessen wurde, was daraus folgte und was noch offen ist — damit spätere Arbeit
nicht bei null anfängt.

## Referenz-Datenbestand

Alle Messwerte beziehen sich auf diesen Stand (Entwicklungsmaschine, NVMe-SSD):

| Größe | Wert |
| --- | --- |
| Usage-Events | 184.389 in 12 Monatspartitionen |
| Store-Größe (`~/.quotabar-win/usage/events`) | 125 MB |
| Größte Monatspartition | 41 MB (2026-07) |
| `ingest-state.json` | 14,1 MB, 3.119 Quellen, 172.883 `eventIds` |
| Quota-Snapshots | 36 MB, 43.883 Zeilen |
| Debug-Logs | 86 MB |
| Claude-Quelldateien | 1.870 Dateien, 871 MB |
| Ingest-Zyklen (10 aktive Tage) | 22.028, davon 4.233 mit Schreibvorgang |

## Messmethodik

Reproduzierbar ohne Electron, direkt gegen den echten Store:

```js
// Laufzeit einer Analytics-Abfrage
const { runAnalyticsTask } = require('./dist/main/analyticsWorker.js');
await runAnalyticsTask({ task: 'get', periodStartMs, windowDays, since, until,
  settings: { plans: [], pricingOfflineMode: true, minModelTokenSharePct: 0 },
  cacheHitRate: { claude: 0, codex: 0 }, nowMs, periodEndMs, timeZone });
```

```js
// Schreib-/Leselast: der Store nimmt sein Dateisystem im Konstruktor
const store = new PortableUsageStore(root, { ...nodeFs, writeFile: zaehlend });
```

**Wichtig:** Jede Messung in einem *frischen Prozess* durchführen. Mehrere Läufe
im selben Prozess verfälschen durch JIT-Warmup und gefüllte Caches — ein früher
Vergleich zeigte dadurch fälschlich "keine Verbesserung", wo isoliert −32 % lagen.

**Ergebnisgleichheit** wird über stabile Hashes des Ergebnisobjekts geprüft
(`generatedAt` maskiert). Referenzwerte vom 2026-09-05, vor allen Änderungen:

| Abfrage | Hash |
| --- | --- |
| `analytics:get` 30 d | `b832d7ce711755de…` |
| `analytics:get` 365 d | `b3704332f4503f72…` |
| `reports:get` all-time | `f8ea48607314d6a4…` |
| Store-Revision | `2a796cf21f0ab1f9…` |

Diese Hashes müssen nach Optimierungen **unverändert** bleiben.

## Erledigt

### Runde 1 — Rechenlast (2026-09-05)

| Operation | vorher | nachher | Maßnahme |
| --- | --- | --- | --- |
| `getRevision()` warm | 1.250 ms | **9 ms** | Memo über Partitions-Identitäten |
| `portableDataIsReady()` | 2.200 ms | **11 ms** | geteilte Store-Instanz statt neuer pro Aufruf |
| `reports:get` all-time | 3.644 ms | **1.099 ms** | geteilter Store + `dateParts`-Cache |
| `analytics:get` 365 d | 7.147 ms | **5.401 ms** | `dateParts`-Cache |
| `analytics:get` 30 d | 750 ms | **604 ms** | dito |
| `models:get` | 2.124 ms | 1.026 ms | geteilter Store |
| Quell-Listing im Leerlauf | 4×/min (1,6 s) | **1×/min** | `fs.watch` mit Polling-Fallback |

Details:

- **Revisions-Memo** ([usageStore.ts](src/portable/usageStore.ts)) — `storeRevision()`
  serialisierte und hashte bei jedem Aufruf alle Events (~125 MB String). Jetzt
  entscheidet ein Fingerprint aus Partitions-Identitäten; der Digest bleibt
  bit-identisch, daher bleiben persistierte Revisionen in `migration-state.json`
  gültig.
- **`portableDataIsReady()`** erzeugte per Default-Parameter bei *jedem* IPC-Aufruf
  eine neue `PortableUsageStore`-Instanz — also immer ohne Partition-Cache. Ein
  gemeinsames Store-Singleton pro Root (`getSharedUsageStore`) behebt das.
- **Gezielter Cache-Clear** — bei Fremdänderung wird nicht mehr der gesamte
  Partition-Cache verworfen, sondern nur die Monate, deren Signatur sich in
  `store-metadata.json` geändert hat.
- **`dateParts`** ([reportService.ts](src/reports/reportService.ts)) —
  `Intl.formatToParts` lief mehrfach pro Event. Jetzt wird der UTC-Offset pro
  Stunde gecacht.
- **Differenzierte Cache-Invalidierung** — ein Poll-Tick verwarf alle
  Analytics-Caches, obwohl er nur Quota-Prozente bringt. Jetzt fallen nur
  snapshot-abhängige Caches; die Cache-Hit-Rate steckt im Cache-Key statt in der
  Invalidierung.

### Runde 2 — Schreiblast (2026-09-05)

| Kennzahl | vorher | nachher |
| --- | --- | --- |
| Schreiben pro Ingest-Zyklus | 28,7 MB | **14,1 MB** |
| davon Partition | 14,96 MB | **0,4 KB** |
| Lesen pro Ingest-Zyklus | 28,8 MB | **14,1 MB** |
| Hochrechnung pro aktivem Tag | ~12,2 GB | **~6,0 GB** |

- **Partition-Append** — ein neues Event schrieb den kompletten Monat neu. Jetzt
  werden bei reinen Einfügungen nur die neuen Zeilen angehängt. Sicher, weil die
  Dateireihenfolge irrelevant ist (Leser sortieren, der Revisions-Digest wird aus
  der sortierten Menge gebildet). Vorbedingung: Die Datei ist exakt so groß, wie
  dieser Store sie zuletzt geschrieben hat — sonst Vollschreiben, was einen durch
  Absturz abgeschnittenen Append zugleich repariert.
- **Doppelte Verifikation entfernt** — `rollForward()` las und hashte jede Datei
  zweimal (einmal die Staging-Datei, danach nochmals das Ziel nach dem Rename).
  Die Integritätsprüfung vor dem Rename bleibt unangetastet.

## Feldbefunde aus v2.1.0

Nach dem Rollout auf der Entwicklungsmaschine (184k Events) aufgetreten.

### Livelock beim Start (behoben in 2.1.1)

`createPortableIngestionRunner.waitForGeneration()` wartete über die drain-Promise auf
*alle* angeforderten Durchläufe statt auf den eigenen. Sobald ein Ingest-Zyklus länger
dauert als das 15-s-Intervall, werden neue Generationen schneller angefordert, als sie
fertig werden — die Promise löst nie auf. Damit blieb `await lifecycle.start()` in
`main.ts` hängen und alles danach wurde nie erreicht, insbesondere `tray.rebuildMenu()`
und `refreshLoop.start()`. Symptom: Die App lädt, aber der Refresh-Balken hängt und es
kommen keine Quota-Daten mehr.

Der Bug war latent vorhanden und schlug zu, als die Zykluszeit über das Intervall stieg.
Nachweis in den Logs: `refresh.start` und `snapshot` fehlen nach dem Start vollständig.

### Watcher auf WSL-Pfaden wirkungslos

`fs.watch(..., { recursive: true })` scheitert auf UNC-Pfaden mit `EISDIR` (beobachtet für
ein Codex-Home unter `\\wsl.localhost\...`). Der Fallback greift korrekt — es wird wie
bisher bei jedem Tick gescannt — aber bei Setups mit WSL-Codex-Home entfällt die
Listing-Ersparnis vollständig. Ein Teil-Watch nur für die lokalen Roots bringt nichts,
weil der Scan ohnehin alle Roots listet.

### Ingest-Hotspot: Type-Guard validierte Event-IDs millionenfach (behoben in 2.1.2)

Ein CPU-Profil des Ingest-Laufs zeigte **37,5 % der Zeit in `RegExp: ^[a-f0-9]{64}$`** —
der Event-ID-Prüfung in `isEventIds()`. Ursache: `isCurrentIngestSourceState()` validiert
jede eventId einer Quelle neu, und der Guard wird in Schleifen über *alle* bekannten
Quellen aufgerufen (`findPreviousSource`, `removeLegacySource`, die Owner-Sammlung). Bei
3.389 Quellen mit zusammen 188.069 IDs ergibt das hunderte Millionen Regex-Tests.

Fix: Validierte Records werden pro Objekt in einem `WeakSet` gemerkt. Sicher, weil
Source-Records immer als Ganzes ersetzt und nie in place mutiert werden.

Wirkung auf einen kompletten Ingest-Lauf (3.389 Quellen, 122 geändert):

| | vorher | nachher |
| --- | --- | --- |
| Gesamt | 17.723 ms | **10.346 ms** (−42 %) |
| davon nicht in Listing/Lesen/Reconcile | 12.516 ms | 5.095 ms |

Danach ist kein dominanter Posten mehr übrig: Datei-Stats ~8 %, JSONL-Parsen ~5 %,
Store-Operationen (`readValidEvents`, `compareCanonicalEvents`, `monthKey`) ~13 %.

**Lehre:** Die ursprüngliche Vermutung war die verschachtelte Kollisionsschleife in
`ingestion.ts` (122 × 3.289 Owner). Nachgemessen kostet die nur 449 ms — ein invertierter
Index würde daraus 55 ms machen, also 0,4 s statt der vermuteten Sekunden. Ohne Profil
wäre hier viel Aufwand am eigentlichen Problem vorbeigegangen.

### Ingest-Zyklus länger als sein Intervall

Gemessen auf derselben Maschine am selben Tag, Mediane in ms:

| Stage | v2.0.0 | v2.1.0 |
| --- | --- | --- |
| ingestion | 15.629 | 16.756 |
| legacy_reconciliation | 3.129 | 3.141 |
| migration_completion | 1.283 | 1.304 |
| consumer_prewarm | 2.441 | **1.557** |

Ein voller Zyklus dauert ~22 s bei 15 s Intervall, die App rechnet also praktisch
ununterbrochen und blockiert dabei den Main-Thread. Runde 1 und 2 haben die
Dashboard-Pfade optimiert (`consumer_prewarm` −36 %), den Ingest-Stage aber nicht
angefasst — der ist jetzt der dominante Posten. Siehe offene Punkte 1, 3 und 7.

## Offen

Priorisiert nach Nutzen/Aufwand. Zahlen aus den Messungen oben.

### 1. `ingest-state.json` aufteilen — hoch

14,1 MB pro Zyklus, jetzt der **gesamte verbleibende Schreib-Overhead**. 85 % der
Datei sind `eventIds` von 3.119 Quellen, von denen sich pro Zyklus ein bis zwei
ändern. Median-Größe einer einzelnen Quelle: 1,5 KB.

Nur geänderte Quellen zu schreiben würde 14,1 MB → ~1,5 KB bedeuten (−99,99 %).
Erfordert einen Formatwechsel (Sidecar oder Chunks) mit Kompatibilitätspfad.
Kompaktes JSON allein bringt nur 12 % und lohnt den Eingriff nicht.

### 2. Tages-Rollups persistieren — hoch, größerer Umbau

Der Architektur-Fix: `rollups/<YYYY-MM>.jsonl` je Tag × Provider × Modell mit
Tokens und Kosten. Analytics, History und Models lesen dann ~300 Zeilen statt
184.389 Events; nur der laufende Tag wird neu berechnet. Damit skaliert die App
mit *Tagen* statt mit *Events* — die Voraussetzung dafür, dass sie langfristig
schnell bleibt. Adressiert zugleich `models:get` (1,0 s) und `windowHistory`
(0,85 s), die weiterhin die volle Historie lesen.

### 3. Legacy-Reconciliation prüfen — mittel

Kostet 2,8–3,4 s pro Ingest-Zyklus und liest dabei 86 MB Debug-Logs. Zu klären:
Wie viel davon ist nach abgeschlossener Migration noch nötig, und lässt sich der
Pfad an Änderungen der Debug-Logs koppeln, statt ihn bei jedem Zyklus zu fahren.

### 4. Ein Analytics-Durchlauf statt mehrerer — mittel

`analytics:get` läuft rund 15 volle Durchgänge über alle Events (zwei Reports,
dazu `sessionStats`, `hourHeatmap`, `weekdayDistribution` je dreifach für
claude/codex/all). Die Provider-Aufteilung ließe sich in einem Durchgang
erledigen. Größter verbleibender Posten in den 5,4 s der 365-Tage-Abfrage.

### 5. Retention für Quota-Snapshots und Debug-Logs — niedrig

36 MB bzw. 86 MB, wachsen unbegrenzt, obwohl nur Aggregate genutzt werden. Es ist
Append-Last, nicht Rewrite-Last — für die SSD irrelevant, aber es verlangsamt
`windowHistory` (parst 36 MB für 22 Ergebniszeilen, ohne Cache).

### 6. Speicherverbrauch — beobachten

RSS ~650 MB nach einem vollen Read; Main-Prozess und Analytics-Worker halten je
einen eigenen Partition-Cache. Bisher kein Problem, sollte aber mit dem Store
mitwachsend im Auge behalten werden. Erledigt sich weitgehend mit Punkt 2.

### 7. Ingest-Intervall an die Zykluszeit koppeln — hoch

Das Intervall steht fest auf 15 s, ein Zyklus dauert aber ~22 s. Dadurch steht immer ein
Folgelauf an und der Main-Thread kommt nie zur Ruhe. Ein Mindestabstand, der sich an der
letzten Zykluszeit orientiert, würde das entkoppeln — und hätte den Livelock oben gar
nicht erst auslösen können.

## SSD-Verschleiß

Nach den Messungen **unkritisch**, entgegen der ursprünglichen Sorge:

- ~6,0 GB pro aktivem Tag (nach Runde 2), bei 200 aktiven Tagen ~1,2 TB/Jahr
- Typisches TBW-Budget einer 1-TB-TLC-SSD: 600 TBW → rechnerisch mehrere
  Jahrhunderte

Die Schreiblast war nie ein Haltbarkeitsproblem, sondern ein Effizienzproblem:
29 MB für ein einziges neues Event. Sie wächst mit der Historie, weshalb Punkt 1
und 2 trotzdem lohnen.

## Erkenntnisse und Fallstricke

- **Datei-Identitäten sind nicht kollisionsfrei.** Ein Test mit 400 schnellen
  Schreibvorgängen gleicher Größe ergab **8,8 % Kollisionen** bei
  `size:mtimeNs:ctimeNs`; die beobachtete mtime-Auflösung lag bei ~0,4 ms. Caches
  dürfen sich deshalb nicht allein auf Identitäten verlassen — die Invalidierung
  gehört an die Stelle, an der alle Schreibpfade zusammenlaufen (`rollForward`).
- **Verzeichnis-mtime taugt nicht zur Änderungserkennung.** Änderungen an Dateien
  in Unterordnern ändern die mtime des Root-Verzeichnisses nicht (getestet auf
  NTFS). Nur `fs.watch(recursive)` funktioniert — mit Fallback, da UNC-/WSL-Pfade
  scheitern können.
- **Performance-Tests müssen mutationsgeprüft sein.** Zwei Testsuiten blieben hier
  grün, obwohl die optimierte Logik deaktiviert war: beim `dateParts`-Test, weil
  kein realer Zeitzonenfall den Fallback auslöst; beim Append-Test, weil ein
  Rewrite chronologisch sortierter Events zufällig dasselbe Dateiergebnis liefert.
  Vor dem Vertrauen auf einen solchen Test: Optimierung deaktivieren und prüfen,
  ob er rot wird.
- **Der DST-Fallback in `dateParts` ist bewusst ungetestet.** Ein Durchlauf über
  alle IANA-Zonen für 2024–2027 fand keine Umstellung, bei der eine UTC-Stunde mit
  Offsetwechsel den lokalen *Tag* verschiebt. Der Code bleibt als Absicherung gegen
  künftige tzdata-Änderungen und pre-1900-LMT-Offsets, ist im Quelltext aber als
  nicht testabgedeckt markiert.
