# QuotaBar Performance-Tracking

Langfristiges Register für Performance-Analysen, Messwerte und offene Optimierungen.

Erstanalyse: 2026-09-05
Last updated: 2026-11-15

## Current status — 2026-11-15

Implemented: append ingestion journal, per-root watcher fallback, bounded main
and renderer analytics caches, worker request limits, persisted daily metrics,
per-partition daily rebuilds, shared timezone conversion, shared activity
aggregation and bounded asynchronous application logging.

The older rounds and open-item descriptions below are historical evidence.
In particular, daily rollups are implemented, and unchanged legacy
reconciliation uses the revision memo. See the latest measurements at the end.
Remaining work includes measuring partition cloning and long-running memory
retention; canonical event reads remain necessary for session/project details.

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

**Ergebnisgleichheit** wird über Hashes des Ergebnisobjekts geprüft (`generatedAt`
maskiert). Wichtig: Gegen **feste** Referenz-Hashes zu prüfen funktioniert nicht — der
Store wächst im Betrieb weiter, und schon eine laufende App macht jeden gestern notierten
Hash wertlos. Das hat hier einmal einen Fehlalarm ausgelöst.

Richtig ist ein A/B-Vergleich auf eingefrorenem Datenstand:

```bash
cp -r ~/.quotabar-win/usage/events  <fixture>/     # Datenstand einfrieren
cp ~/.quotabar-win/usage/store-metadata.json <fixture>/
node equiv.js <fixture>            # mit der Änderung
git stash && npm run build
node equiv.js <fixture>            # ohne die Änderung
git stash pop && npm run build
```

Verglichen werden Store-Revision, ein Hash über alle `(id, occurredAt)` in Lesereihenfolge
und ein Report-Hash. Alle drei müssen zwischen den beiden Läufen übereinstimmen.

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

### Runde 3 — Ingest-Kadenz und heiße Schleifen (2026-09-06)

Alle vier Änderungen sind ergebnisneutral; nachgewiesen per A/B-Vergleich auf
eingefrorenem Datenstand (200.872 Events), Revision und Report-Hash identisch.

| Operation | vorher | nachher |
| --- | --- | --- |
| `store.read()` (volle Historie) | 950 ms | **519 ms** (−45 %) |
| `reconcile` innerhalb des Ingests | 1.063 ms | **581 ms** (−45 %) |
| `reports:get` all-time | 1.725 ms | 1.480 ms (−14 %) |
| `getRevision()` kalt | 2.754 ms | 2.477 ms (−10 %) |

- **Ruhephase nach jedem Ingest-Durchlauf** (offener Punkt 7). Jeder geplante Durchlauf
  wird von einer Pause gefolgt, die so lang ist wie der Durchlauf selbst, gedeckelt auf
  60 s. Damit rechnet der Hintergrund nur noch etwa die Hälfte der Zeit statt
  durchgehend. Startup- und manuelle Trigger umgehen die Pause. Kosten: Neue Nutzung
  erscheint im ungünstigsten Fall einen Zyklus später.
- **Zeitstempel-Vergleich ohne `Date.parse`.** `compareCanonicalEvents` parste bei *jedem*
  Vergleich beide Zeitstempel — beim Sortieren der ganzen Historie sind das Millionen
  Aufrufe. Da `sanitizePortableEvent` kanonisches UTC erzwingt (`occurredAt !==
  new Date(occurredAt).toISOString()` wird abgelehnt, verifiziert an 200.872 Events),
  sind die Strings gleich lang und lexikografische Ordnung ist chronologische Ordnung.
  Ungleiche Längen fallen auf `Date.parse` zurück.
- **Monatsschlüssel ohne `Date`.** `monthKey(new Date(e.occurredAt))` baute ein
  Date-Objekt und formatierte einen vollen ISO-String, um sieben Zeichen abzuschneiden —
  einmal pro Event in mehreren Schleifen. Aus demselben Grund wie oben ist der Monat
  einfach das Präfix.
- **`canonicalPath` memoisiert.** `path.resolve` lief mehrfach pro bekannter Quelle, also
  tausendfach pro Durchlauf über dieselben Pfade.

### Runde 4 — Ingest-State-Journal (2026-10-17)

Gemessen auf eingefrorenem Datenstand (`ingest-state.json` inzwischen 19,5 MB), gleiche
Kopie für beide Versionen, je ein frischer Prozess. Ein „geänderter Lauf" simuliert genau
eine geänderte Quelle (die jüngste Session-Datei), wie im aktiven Betrieb üblich.

| Kennzahl | vorher | nachher |
| --- | --- | --- |
| Schreiben pro Lauf mit 1 geänderter Quelle | 20.074 KB | **5 KB** |
| Laufzeit mit 1 geänderter Quelle | ~2.220 ms | **~1.750 ms** |
| Laufzeit ohne Änderung | ~1.780 ms | **~1.430 ms** |

- **Append-Journal** ([ingestState.ts](src/portable/ingestState.ts)) — Ein Lauf hängt nur
  die geänderten Quell-Records als eine Zeile an `ingest-state.journal.jsonl` an, statt den
  kompletten Snapshot neu zu schreiben. Kompaktiert wird, sobald das Journal ein Viertel des
  Snapshots erreicht; unter 256 KB Snapshot wird wie bisher immer voll geschrieben.
- **Sicherheitsargument:** Die Journal-Zeile wird *nach* Events und Metadaten geschrieben.
  Fehlt sie oder ein beliebiges Ende des Journals, gelten nur weniger Quellen als verarbeitet;
  der nächste Lauf liest sie erneut und landet bei „existing" — derselbe Pfad wie ein
  Absturz vor dem State-Schreiben. Ein abgerissenes Zeilenende wird übersprungen und erzwingt
  die Kompaktierung.
- **Bindung an den Snapshot:** Der Journal-Header trägt Größe, `mtimeNs` und SHA-256 des
  Snapshots. Ersetzt jemand anderes den Snapshot (Import, ältere App-Version), passt der
  Header nicht mehr und das Journal wird ignoriert — auch bei byte-identischem Inhalt.
  Ältere App-Versionen ignorieren das Journal ohnehin und lesen dann etwas mehr neu ein.
- **State-Cache** ([ingestion.ts](src/portable/ingestion.ts)) — Der geparste State bleibt
  im Prozess, abgesichert über Größe/mtime/ctime von Snapshot und Journal. Vorher wurde er
  bei *jedem* Lauf gelesen, voll validiert und zum Kanonik-Vergleich neu serialisiert, auch
  ohne jede Änderung; dazu ein zweites Komplett-Parsen in der Cost-Enrichment-Vorprüfung.
- **Kein Tiefenklon mehr** — `cloneSources` kopierte alle `eventIds` jeder Quelle pro Lauf.
  Records werden nur ersetzt, nie mutiert; eine flache Kopie reicht, und geänderte Records
  sind damit über die Objektidentität als Delta erkennbar.

### Runde 5 — Watcher pro Root statt alles-oder-nichts (2026-10-17)

Live gemessen in der Dev-Build mit echtem Datenbestand und WSL-Codex-Home (7 Dateien),
App im Leerlauf, `quotabar.log` → `stage=ingestion`:

| | vorher | nachher |
| --- | --- | --- |
| Ingest-Läufe im Leerlauf | alle ~15 s | **alle ~60 s** |
| Main-Thread-Anteil für Ingest im Leerlauf | ~37 % (5,5 s / 15 s) | **~11 %** (6,5 s / 60 s) |

- **[sourceChangeWatcher.ts](src/main/sourceChangeWatcher.ts)** — Ein nicht beobachtbarer
  Root deaktiviert den Watcher nicht mehr für alle. Er wird über den ohnehin vorhandenen
  Zwangsscan abgedeckt (höchstens alle 60 s). Nur wenn *kein* Root beobachtet werden kann,
  wird weiter bei jedem Tick gescannt. Ein Watcher, der zur Laufzeit ausfällt, löst einmal
  einen Scan aus, weil vor dem Fehler Events verloren gegangen sein können.
- **Bewusster Kompromiss:** Änderungen unter einem nicht beobachtbaren Root (WSL) erscheinen
  nach höchstens ~60 s statt ~15 s. Sobald ein lokaler Root eine Änderung meldet, wird ohnehin
  alles gescannt, auch WSL.
- **Testfalle:** Die laufende Claude-Code-Sitzung schreibt selbst in `~/.claude/projects`.
  Wer den Leerlauf misst, darf in der Zeit nicht mit Claude Code arbeiten, sonst ist jeder
  Tick zu Recht „geändert“.

### Runde 6 — Endlos-Retry unbepreister Events (2026-10-17)

Gefunden per CPU-Profil des laufenden Main-Prozesses (`electron --inspect`, CDP-Profiler)
und Abgleich Platte ↔ State: **133 von 2.367 Quellen** galten in jedem Lauf als geändert,
wurden komplett gelesen und nie in den State übernommen. Dazu las jeder Lauf den gesamten
Store (264k Events, 1,9 s), um ihn neu zu bepreisen.

Ursache: Eine Quelle mit auch nur einem unbepreisten Event bleibt bewusst aus dem State, und
`costEnrichmentVersion` bleibt leer, damit später ein Preis nachgetragen werden kann. Der
Nachtrag wurde aber **bei jedem Tick** versucht. Auslöser waren fast nur `<synthetic>`-Einträge
von Claude Code (API-Fehler wie „session limit“, „No response requested.“) mit 0 Tokens, für
die es nie einen Preis gibt; 132 Session-Dateien enthielten mindestens einen davon.

| Leerlauf-Lauf ohne Änderung (live) | vorher | nachher |
| --- | --- | --- |
| `stage=ingestion` | 5,5–8,5 s | **1,5–2,4 s** |
| Quellen, die jeder Lauf neu liest | 133 | **3** (aktive Session + 2 mit echt unbepreisten Modellen) |
| Store-Vollread zur Kostenreparatur | jeder Lauf | **≤ 1×/h** und beim Start |

- **0 Tokens → 0 $** ([costEnrichment.ts](src/portable/costEnrichment.ts)) — Events ohne
  Tokens gelten ohne Preis-Lookup als vollständig bepreist (`pricingVersion: "zero-tokens"`).
  Ohne Versionserhöhung: Wo die Reparatur noch aussteht, holt der nächste Lauf das nach.
- **Retries gedrosselt** ([ingestion.ts](src/portable/ingestion.ts)) — Eine Quelle, die nur
  am fehlenden Preis hängt, wird bei unverändertem Fingerprint höchstens stündlich neu gelesen,
  die Store-Reparatur ebenso. Gilt nur, solange die State-Dateien so sind, wie dieser Prozess
  sie hinterlassen hat; Fremdschreiben (Import, anderer Prozess) setzt die Drossel zurück.
  Rein im Speicher, kein Formatwechsel.
- **Datenprüfung** gegen ein Backup vor dem Lauf: Events, Tokens und Kosten bis 10:00 und
  11:00 UTC identisch; einzige Änderung sind 150 `<synthetic>`-Events mit jetzt 0 $.
- **Danach noch unbepreist** (684 Events): `gpt-5-codex-mini` (675), `codex-auto-review` (6)
  und eine Antigravity-Proxy-Route mit `ag-`-Präfix (3). Erledigt im Folge-Commit: Alias
  `gpt-5-codex-mini` → `gpt-5.1-codex-mini`, die beiden anderen bewusst mit 0 $
  (`pricingVersion: "unpriced-model"`), sofern der Lookup keinen Preis findet.
- **Profil-Fallstrick:** In async-Code zeigt die inklusive Zeit eines Aufrufers nur den
  synchronen Teil bis zum ersten `await`. `readSource` erschien mit 0,3 s, obwohl die
  JSONL-Reads darunter Sekunden kosteten. Lese-Hotspots über die Self-Time der Blätter
  (`processJsonlFile`, Readline, `string_decoder`) zuordnen, nicht über Aufrufer.

### Runde 7 — Startpfad und Revisions-Hashes (2026-10-17)

Live gemessen in der Dev-Build mit echtem Datenbestand, je zwei Starts hintereinander (der erste
füllt das Legacy-Quota-Manifest und schließt die Kostenreparatur ab, der zweite ist der
Normalfall).

| Start | vorher | nachher (2. Start) |
| --- | --- | --- |
| Session-Start → erste Live-Quota-Abfrage | ~22 s | **~1,6 s** |
| `quota_migration` | 2,9–5,4 s (63k Snapshots) | **0,5 s** (146 Snapshots, nur heutiges Log) |
| `migration_completion` | ~1,0 s | **0,03–0,09 s** |
| erster Ingest-Lauf | 8,4 s | **3,4 s** (keine Kostenreparatur mehr) |
| `legacy_reconciliation` | 4,1–5,0 s | 5,3–6,0 s (kalter Cache, jetzt parallel zu Polling/UI) |

| Refresh-Lauf mit neuen Events | vorher | nachher |
| --- | --- | --- |
| `legacy_reconciliation` | 2,6–3,5 s | **2,3 s** |
| `migration_completion` | 0,85–1,3 s | **0,03 s** |
| `consumer_prewarm` | 1,3–1,8 s | 0,7 s |
| Folge-Stages gesamt | ~5–6 s | **~3,1 s** |

`legacy_reconciliation` beim Start bleibt offen: Dort muss die Revision einmal kalt berechnet
werden, und Polling/UI laufen jetzt parallel. Der nächste Hebel ist Option 2 aus Punkt 3
(überspringen, wenn kein Legacy-Tag betroffen ist).

- **Live-Pfad entkoppelt** ([main.ts](src/main/main.ts)) — `startPortableData()` startet erst
  nach `refreshLoop.start()` und läuft im Hintergrund. Der Shutdown setzt ein Stop-Flag und wartet
  auf die laufende Vorbereitung, damit kein Commit abgeschnitten wird und danach kein
  Ingest-Lifecycle mehr anläuft. Das Detailfenster überbrückt den Zwischenzustand mit
  `portableDataPreparing` und Retry.
- **Verworfener Hash gestrichen** ([usageStore.ts](src/portable/usageStore.ts)) — Der
  Builder-Parameter `revision` von `reconcileLegacyDerived` entfällt; ohne Writes und in
  `commitIfRevision` dient die memoisierte, byte-identische `currentRevision()`. Ein Test prüft
  die Gleichheit mit einer frischen Vollberechnung.
- **Legacy-Quota-Import inkrementell** ([debugBackfill.ts](src/main/debugBackfill.ts)) —
  Manifest `cache/legacy-quota-import.json` (Größe + mtime je Debug-Log, maschinenlokal, bewusst
  nicht im archivierten `quota/`). Ignoriert, wenn keine Quota-Partitionen existieren; erst nach
  erfolgreichem Append geschrieben; nach angewendetem Archiv-Import gelöscht.
- **Preise:** `gpt-5-codex-mini` per Alias auf `gpt-5.1-codex-mini` (+3,23 $ Codex-Kosten),
  `codex-auto-review` und `ag-`-Proxy-Routen bewusst 0 $, sofern kein Preis gefunden wird.
- **Datenprüfung** gegen Backup: Events und Tokens identisch, Quota-Snapshots bis 11:45 UTC
  identisch (63.296), 0 unbepreiste Events.

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

### Watcher auf WSL-Pfaden wirkungslos (behoben in Runde 5)

`fs.watch(..., { recursive: true })` scheitert auf UNC-Pfaden mit `EISDIR` (beobachtet für
ein Codex-Home unter `\\wsl.localhost\...`). Damals schaltete schon *ein* solcher Root den
ganzen Watcher ab, und es wurde bei jedem Tick gescannt. Die ursprüngliche Einschätzung,
ein Teil-Watch bringe nichts, weil der Scan ohnehin alle Roots listet, übersah den
eigentlichen Gewinn: Gespart wird nicht im Scan, sondern durch ausfallende Ticks. Siehe
Runde 5.

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

### 1. ~~`ingest-state.json` aufteilen~~ — erledigt in Runde 4

Gelöst über ein Append-Journal statt Sidecars/Chunks, siehe Runde 4.

### 10. ~~Ingest live ~4 s langsamer als isoliert~~ — Hauptursache behoben in Runde 6

Ursache war der Endlos-Retry unbepreister Events. Live jetzt 1,5–2,4 s gegenüber ~1,4 s
isoliert; der Rest ist im erwartbaren Rahmen für einen Prozess mit paralleler Last.
Ursprünglicher Befund:

Isoliert (frischer Prozess, ruhige Datenkopie) dauert ein Lauf ohne Änderung ~1,4 s; Listing
und `stat` aller 2.367 Quellen machen davon ~1,4 s aus (Claude 2.182 Dateien: ~0,7 s Listing,
~0,35 s stat; WSL: ~50 ms). In der laufenden App meldet `stage=ingestion` bei `count=0`
aber 5,5–8,5 s, unverändert seit mindestens 07.10. WSL und das Lock-Polling (25 ms) sind
ausgeschlossen. Vermutung: Konkurrenz auf dem Main-Thread bzw. im libuv-Threadpool mit
Quota-Polling, Analytics-Worker-Kommunikation und Fenster. Nächster Schritt: CPU-Profil des
Main-Prozesses (`--inspect`) während eines Leerlauf-Ticks.

### 9. Partition-Vollschreiben beim ersten Lauf nach Prozessstart — mittel

Neu gefunden bei der Messung zu Runde 4: Der erste Ingest-Lauf eines Prozesses schrieb
129–149 MB, obwohl nur 8–10 Events neu waren. Ursache: `appendableFiles` ist beim Start
leer, also darf der Store an keine Partition anhängen und schreibt jeden betroffenen Monat
komplett neu. Passiert bei jedem App-Start. Möglicher Ansatz: die Append-Vorbedingung beim
ersten Lesen einer Partition aus deren tatsächlicher Größe ableiten, sofern die Datei
vollständig und mit Zeilenende gelesen wurde.

Geprüft 2026-10-17: Der Ansatz ist sicher (Größenprüfung und Append liegen im selben Root-Lock),
aber nur mit strengerer Vorbedingung. Zeilenende allein reicht nicht: Jede nicht-leere Zeile
muss gültig sein, im richtigen Monat liegen und eine eindeutige ID haben, sonst verewigt ein
Append Defekte, die ein Rewrite repariert hätte (`archiveContentValidator` lehnt sie ab; Test
`portableUsageStoreAppend.test.ts:117` deckt genau das ab). Zweite Einschränkung: Ein einziges
Update irgendwo setzt `mutatedStored` global und erzwingt Rewrites **aller** betroffenen Monate
([usageStore.ts:454](src/portable/usageStore.ts#L454)). Ob der Start-Lauf überwiegend durch
Updates oder durch Inserts umschreibt, ist noch nicht gemessen — vor der Umsetzung klären,
sonst greift der Fix nicht.

### 11. ~~Live-Polling startet erst nach ~22 s Startarbeit~~ — erledigt in Runde 7

Ursprünglicher Befund: `refreshLoop.start()`, `NotificationService` und Updater liefen erst nach
`await preparePortableData` und `await portableIngestionLifecycle.start()`
([main.ts:196, 260, 333](src/main/main.ts#L333)). Tray und Klick-Menü sind sofort da, zeigen
aber bis zu ~22 s gecachte Quota-Werte. Start-Stages live: ingestion 8,4 s,
legacy_reconciliation 5,0 s, quota_migration 2,9–5,4 s, migration_completion 1,0 s,
consumer_prewarm 1,8 s, danach sofort ein zweiter Refresh-Pass (~1,5 s). Jeder Start fährt
bewusst alle Stages (Test `portableStartup.test.ts:156`), es gibt keinen Skip-Marker.
Entkoppeln ist der größte spürbare Hebel; Risiko mittel wegen der Livelock-Historie (siehe
Feldbefunde).

### 12. ~~quota_migration liest bei jedem Start 73 MB Debug-Logs~~ — erledigt in Runde 7

Ursprünglicher Befund: `readLegacyQuotaSnapshots` parst alle 106 `debug/YYYY-MM-DD.jsonl` (~63k Snapshots),
`appendQuotaSnapshots` liest zum Deduplizieren alle betroffenen Quota-Partitionen (~52 MB) und
schreibt im Normalfall nichts. Nicht einfach abschaltbar: Er heilt fehlgeschlagene
Live-Appends (20× `Portable quota snapshot save failed` im Log, zuletzt 17.10.). Ansatz: ein
Manifest mit Größe/mtime je Debug-Datei, nur geänderte Dateien lesen (normal heute/gestern).

### 13. ~~Kostenreparatur-Drossel greift beim Start nie~~ — erledigt in Runde 7

Mit Preisen für alle Modelle ist die Reparatur abgeschlossen (`costEnrichmentVersion: 1`), der
erste Lauf liest den Store nicht mehr. Kommt ein neues unbepreistes Modell hinzu, greift
wieder die stündliche Drossel; beim Start läuft dann einmal ein voller Versuch.

### 2. Persisted daily rollups — implemented; incremental partitions added 2026-11-15

Der Architektur-Fix: `rollups/<YYYY-MM>.jsonl` je Tag × Provider × Modell mit
Tokens und Kosten. Analytics, History und Models lesen dann ~300 Zeilen statt
184.389 Events; nur der laufende Tag wird neu berechnet. Damit skaliert die App
mit *Tagen* statt mit *Events* — die Voraussetzung dafür, dass sie langfristig
schnell bleibt. Adressiert zugleich `models:get` (1,0 s) und `windowHistory`
(0,85 s), die weiterhin die volle Historie lesen.

### 3. Historical reconciliation profile — unchanged runs now use the revision memo

Die Debug-Logs sind **nicht** der Kostenpunkt. Gelesen werden nur die 201 `*.backfill.jsonl`
(36 MB, 320 ms, und im Refresh-Pfad sogar außerhalb des Stage-Timers); sie sind seit
14.07.2026 eingefroren, `runBackfill` hat keinen Aufrufer mehr.

Die ~2,9 s von `legacy_reconciliation` (count=0) und ~1 s von `migration_completion` sind fast
nur `storeRevision`: JSON-Serialisierung aller 264k Events plus SHA-256, ~1,2 s pro Aufruf
(read-only nachgemessen). `reconcileLegacyDerived` rechnet ihn zweimal
([usageStore.ts:300](src/portable/usageStore.ts#L300) und `:377`), den ersten verwirft der
einzige Aufrufer ungenutzt (`void revision`, [migration.ts:224](src/portable/migration.ts#L224));
`commitIfRevision` rechnet ihn ein drittes Mal. Dazu zwei volle Klone und mehrere Sorts.

Optionen nach Nutzen/Risiko:
1. Den verworfenen Hash streichen und `revisionMemo` nach eigenen Writes setzen, damit
   `commitIfRevision` die memoisierte Revision nutzt. Spart ~2 s pro Lauf, ändert keine Daten.
2. Reconciliation überspringen, wenn kein geänderter Event-Tag ein Legacy-Tag ist
   (2025-09-24 bis 2026-07-14) und die Backfill-Dateien unverändert sind. Die Tag-Erkennung
   muss eine Obermenge sein (inkl. `activityChanged`/Kosten-Reparatur), sonst driften die
   synthetischen Rest-Events.
3. `consumer_prewarm` (~1,5–1,7 s) nicht abwarten: Er läuft im Worker, verlängert aber Zyklus
   und Cooldown.

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

### 7. Datei-Stats im Ingest — mittel

Nach Runde 3 der größte verbliebene Einzelposten im Profil: `internalModuleStat` mit ~8 %,
also 3.389 `lstat`-Aufrufe pro Durchlauf für die Änderungserkennung. Die sind grundsätzlich
nötig — offen ist, ob sich die Menge eingrenzen lässt, etwa indem Quellen mit weit
zurückliegendem `processedAt` seltener geprüft werden. Vorsicht: Das ist genau der
Mechanismus, der Änderungen erkennt; eine falsche Eingrenzung verliert Nutzungsdaten.

### 8. Klonen bei jedem Store-Read — mittel

`readValidEvents` gibt `cached.events.map(clonePortableEvent)` zurück, kopiert also bei
jedem Lesevorgang die gesamte Historie. Das treibt die GC-Last (~4,6 % im Profil).
`Object.freeze` statt Klonen wäre schneller, verlagert aber eine bisher stille Annahme
(„Aufrufer mutieren nicht") in eine harte Zusage — im strict mode würde eine Mutation
werfen. Erst prüfen, ob wirklich kein Aufrufer mutiert.

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

## Audit measurements — 2026-11-14

This audit did not change application code or implement an optimization. The
existing measurements above remain historical observations, not measurements
of the current release. In particular, the ingestion journal, watcher fallback,
unpriced-event retry throttle and startup decoupling are already implemented.

### Synthetic analytics baseline

Measured the current compiled `runAnalyticsTask({ task: "get", ... })` with a
365-day range, `Europe/Vienna`, no subscription plans, offline pricing, and an
empty injected quota-snapshot reader. Each dataset ran once in a fresh Node
process. All events were synthetic, split equally between Claude and Codex,
with stored token costs; no provider credentials or production store were read.

| Synthetic events | Analytics task duration | Process RSS after task |
| --- | --- | --- |
| 10,000 | 195 ms | 121 MiB |
| 100,000 | 1,477 ms | 308 MiB |

Environment: Windows, Node v26.13.1, installed TypeScript 5.9.3, QuotaBar 2.3.1
source. The repository declares Node 22.23.4; these numbers are therefore a
development-host baseline, not a validated Node 22 or Electron benchmark. Timing
excludes module loading, event generation, disk reads and renderer painting.
RSS includes the synthetic input array and module state. A single sample does
not establish a latency distribution or isolate a bottleneck.

### Follow-up priorities

- Add a repeatable synthetic benchmark with multiple fresh-process samples,
  fixed input, result-equivalence checks and stage timings before optimizing.
- Consolidate repeated event filtering, adaptation and provider aggregation in
  `analyticsWorker.ts`; then evaluate persisted daily rollups for additive
  metrics. Session duration, overlapping active time and timezone boundaries
  need richer intermediate data or an event-based fallback.
- Re-measure first-ingest partition rewrites and legacy reconciliation before
  applying the still-open changes described above.
- Measure cache retention and main-thread stalls. Partition reads still clone
  events, analytics result caches have no size limit, and application logging
  performs synchronous filesystem operations.

### Implemented maintenance and validated baseline — 2026-11-14

- Analytics result caches now retain at most 32 entries, evicting the least
  recently used key. A rejected request from an older cache generation cannot
  remove its replacement. Regression tests cover both behaviors.
- Model pricing groups events by normalized model once instead of filtering the
  entire history for every model. Existing stored-cost and missing-component
  tests verify the resulting pricing behavior.
- Worker requests have a 60-second deadline and a limit of 16 outstanding
  requests. A timed-out worker is terminated and can be recreated on demand.
- Daily rollups were implemented in the follow-up below. Consolidation of full
  activity/session analytics, partition cloning and asynchronous logging remain
  follow-up work.

Run `npm run build` followed by `node tools/benchmark-analytics.cjs` using the
Node version in `.nvmrc`. The benchmark injects synthetic input and an empty
quota reader, uses three fresh processes for each size, checks identical result
hashes within each size, and cleans its disposable home. No production store or
provider credentials are used.

| Events | Three task samples | Median | Process RSS range |
| --- | --- | --- | --- |
| 10,000 | 336 / 344 / 335 ms | 336 ms | 95 MiB |
| 100,000 | 2,280 / 2,375 / 2,269 ms | 2,280 ms | 238–242 MiB |

Environment: Windows, Node 22.23.4, TypeScript 5.9.3, updated dependencies and
the maintenance source. No other QuotaBar test/build ran concurrently with this
recorded benchmark. These results are not directly comparable with the earlier
Node 26 single samples. Timing still excludes input construction, filesystem
reads and renderer painting; RSS includes input and module state.


### Persisted daily rollups — 2026-11-14

Daily/weekly/monthly portable reports and Models now consume persisted additive
provider/model/day rows. The snapshot is scoped by timezone and format version,
checksummed, atomically replaced and guarded by the existing portable root lock.
Source identities include size, nanosecond timestamps, device and inode. A durable
write generation invalidates all timezone snapshots before append, replacement,
removal and transaction recovery, covering same-stat writes. Metadata-only
checkpoints preserve it. Corruption or unavailable cache storage falls back to
canonical events. Portable exports exclude the derived files.

Cost reconciliation runs per source event before summing; Models keeps the raw
component totals and separate missing-pricing evidence. Exact instant ranges
fall back to canonical reads for partially included boundary groups. Activity,
hourly, project and session analytics continue to use events because their
non-additive semantics require them.

The append invalidation test freezes every partition stat and asserts that the
actual append path ran. A mutation check disabling append invalidation produced
the expected stale one-event total instead of two and failed that test. Restoring
the invalidation passes. Additional regressions cover transaction recovery,
replacement/removal, external import, DST/month boundaries, corrupt files,
pricing completeness and archive exclusion.

The first read after any source mutation still rebuilds a full daily snapshot.
Incremental per-partition rollups, full activity/session aggregation, source
cloning and asynchronous logging remain separate measured follow-ups.


#### Measured daily report comparison

`node tools/benchmark-rollups.cjs`, Windows, Node 22.23.4, native TypeScript
7.0.2 build, Europe/Vienna, 100,000 synthetic events across 12 partitions.
Each sample ran in a fresh process. No QuotaBar build, test or Sandbox VM ran
concurrently. Input generation/module loading and renderer painting are excluded;
timed work includes the portable lock, source/cache reads and report generation.
Filesystem pages may already be cached by Windows; "cold" means no daily snapshot,
not a cold physical disk. RSS is measured after the task.

| Path | Samples | Median | JSONL reads per sample | RSS |
| --- | --- | --- | --- | --- |
| Canonical events | 1,015 / 1,063 / 1,032 ms | 1,032 ms | 12 | 188–206 MiB |
| First snapshot build | 1,489 ms | one sample | 12 | 170 MiB |
| Persisted snapshot, fresh process | 72 / 74 / 74 ms | 74 ms | 0 | 58 MiB |

The cached daily report was about 14 times faster in this fixture. The first
snapshot build was slower than a raw report and still scales with full history.
All seven reports had identical row/total hashes after rounding numerical values
to six decimal places. The warm-path assertion also requires zero JSONL reads.
These measurements describe additive daily reports, not the full activity/session
Analytics screen or end-to-end UI latency.


## Renderer and performance maintenance — 2026-11-15

Implemented latest-request rendering and invalidation-safe prefetch, a 32-entry
renderer LRU, strictly checked IPC/data-loading helpers, literal update text,
adaptive cost ticks, shared timezone conversion/activity aggregation and bounded
asynchronous application logging. The five source files previously over 1,000
lines were split by responsibility; all first-party runtime source files now
remain below 1,000 lines. Report IPC registration is separate from window code.

Daily snapshot format 2 stores per-UTC-month contributions plus durable partition
generations. Appends, replacements, removals and transaction recovery update the
affected generations before source writes. A tracked mutation rebuilds only
changed partitions, then merges local-day/provider/model contributions. Unknown
external changes trigger a full canonical read with global ID deduplication.
Checksums, exact-range fallbacks, offset timestamp handling and archive exclusion
remain covered by regressions. Metadata-only checkpoints preserve the cache.

### Matched A/B analytics and incremental reads

Windows, Node 22.23.4, native TypeScript 7.0.2 on both sides. The baseline source
was extracted from HEAD into an ignored isolated directory and compiled with the
same compiler/dependencies. Each sample uses a fresh process and synthetic data;
no test, package build or Sandbox ran concurrently. Analytics freezes its clock
to the fixture end date because sparklines otherwise change across midnight.
All before/after hashes match (daily numeric values rounded to six decimals).

| Workload | Baseline samples (ms) | Updated samples (ms) | Median before → after |
| --- | --- | --- | --- |
| Full Analytics, 10,000 events | 360 / 370 / 373 | 292 / 288 / 287 | 370 → 288 ms |
| Full Analytics, 100,000 events | 2,390 / 2,367 / 2,359 | 1,791 / 1,778 / 1,799 | 2,367 → 1,791 ms |
| Daily read after one changed month, 100,000 events | 1,475 / 1,525 / 1,487 | 109 / 104 / 105 | 1,487 → 105 ms |

Full Analytics improved by about 24% in the larger fixture. Its RSS was
241–245 MiB before and 247–249 MiB after; this change does not reduce full-task
memory. Incremental reads dropped from 12 JSONL reads to one and about 14 times
less latency; RSS in that fixture was 253–256 MiB before and 206–208 MiB after.

Analytics timing excludes input generation, module loading, disk reads and
renderer painting. The incremental benchmark warms the initial snapshot and
performs the source mutation outside the timed section, then times a new store
instance reading the updated daily data. It includes locks, cache/source reads
and aggregation. It does not measure ingestion/write latency or cold physical
storage. Synthetic timing is evidence for these paths, not a UI latency promise.

The existing daily-report benchmark also passed unchanged canonical-result and
zero-JSONL-read warm assertions. Observed initial snapshot creation was 1,805 ms
before and 1,067 ms after (single samples); warm report medians were 103 ms and
76 ms. These single cold samples do not establish a latency distribution.

Reproduce after building:

```powershell
node tools/benchmark-analytics.cjs
node tools/benchmark-rollups.cjs
node tools/benchmark-incremental-rollups.cjs
```

`QB_BENCHMARK_DIST` optionally selects an isolated compiled baseline for the
analytics/incremental tools. Both versions must use the same runtime and compiler.
Remaining work: measure canonical partition cloning, long-running cache memory
and logging event-loop latency. Full ingestion/reconciliation still scans canonical
history in several paths; incremental daily reads do not remove that write cost.


Final correctness validation passed 1,545 tests, strict typechecking, lint, build,
coverage, isolated Electron rendering and real installed update acceptance in
Windows Sandbox. The last UI follow-up reloads an active invalidated view and
renders prefetched replacement data on tab reentry; it does not alter the worker
or rollup workloads measured above.


## Final review corrections — 2026-11-15

Snapshot format 3 records whether each full snapshot was independent of global
ID deduplication. An ambiguous snapshot can reuse unchanged rows, but a mutation
requires a full canonical rebuild. Managed writers also invalidate the global
epoch when raw partitions contain duplicate IDs, covering external edits masked
by a subsequent managed write. Once duplicates are resolved, independent monthly
rebuilds resume. No canonical usage format changed.

Partial instant-range fallback now retains only the original aggregate group,
preventing separately stored offset events from being counted twice. Application
log stat/rotation/append operations now share the archive application lock.

Fresh-process benchmark verification after these correctness fixes preserved
all result hashes: full Analytics medians were 285 ms (10,000 events) and
1,776 ms (100,000 events); the updated daily read after one changed month had
105 / 108 / 108 ms samples (108 ms median) and exactly one JSONL read per sample.
The warm daily-report assertion still requires zero JSONL reads. The documented
benchmark timing boundaries and synthetic-data limitations above still apply.

Final review verification passed 1,556 tests, strict typechecks, lint, build,
coverage, isolated real Electron rendering and the installed Windows Sandbox
update test. The duplicate and offset regressions use canonical-event aggregates
as the reference; the logger test holds the archive lock until queued logging
has demonstrably waited. Details are in `docs/reviews/2026-11-15-maintenance-final-review.md`.
