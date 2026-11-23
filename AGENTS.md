# AGENTS.md

## Projekt

Dieses Repository enthaelt eine Electron/TypeScript Windows-Tray-App fuer QuotaBar direkt im Repo-Root.

## Arbeitsregeln

- Arbeite im Repo-Root; `src/`, `tests/`, `assets/` und die Node/Electron-Konfiguration liegen direkt hier.
- Keine Tokens, Cookies, Authorization Header oder JWTs loggen oder in Ausgaben anzeigen.
- Auth-Dateien nur aus bekannten Standardpfaden lesen, keine breite Festplatten-Suche.
- Inoffizielle Provider-Endpunkte in Provider-/Auth-Modulen kapseln und defensiv behandeln.
- Vor Abschluss mindestens `npm test` und `npm run build` ausfuehren, wenn Code geaendert wurde.
- GUI-/Renderer-Änderungen live im echten Electron-Fenster verifizieren — Anleitung in [TESTING.md](TESTING.md).
- Performance-Arbeit in [PERFORMANCE.md](PERFORMANCE.md) festhalten: Messwerte, erledigte Optimierungen und offene Punkte — vor neuen Optimierungen dort nach bereits Gemessenem sehen.
- Build-Artefakte, `node_modules`, `dist`, `release` und `package-output` nicht committen.
- Deutsche Umlaute in Textdateien korrekt schreiben (`ä`, `ö`, `ü`, `Ä`, `Ö`, `Ü`, `ß`), nicht als `ae`, `oe`, `ue` usw.

## Sprache

Die gesamte App ist auf **Englisch**: UI-Labels, Tooltips, Fehlermeldungen, Benachrichtigungen, Kommentare im Code und öffentliche Dokumentation. Niemals UI-Strings oder Docs ins Deutsche übersetzen — ein "Übersetzungsfehler" bedeutet immer, dass ein deutsches Wort in englischen Text eingeschlichen ist, nicht umgekehrt.

## UI-Konventionen

### Tooltips
Tooltips laufen über das gemeinsame Portal-Modul `QB.portalTip` in [shared/tooltip.js](src/renderer/shared/tooltip.js). Es hängt ein einziges Element direkt an `<body>`, damit nichts durch `overflow: hidden` oder `z-index`-Stacking abgeschnitten wird. Keine eigenen Tooltip-Elemente mehr pro Tab bauen.

- Einfache Texte: Anker bekommt `data-tip="…"` (Text, kein HTML); Container einmal mit `QB.portalTip.bindDataTips(container, selector)` binden. Das ist idempotent, deckt Maus und Tastatur-Fokus ab und überlebt `innerHTML`-Neu-Renderings.
- Eigene Auslöser: `QB.portalTip.show(anchor, text)` / `QB.portalTip.hide()`; Zeilen-Layout mit `{ variant: 'rows', html }` (Beispiel: Token-Breakdown in [history.js](src/renderer/tabs/history.js)).
- Aussehen und Einblend-Animation (`opacity + scale + filter: blur`, 160 ms) stehen in `.qb-portal-tip` in [shell.css](src/renderer/styles/shell.css); Position zentriert oberhalb des Ankers, bei zu wenig Platz unterhalb, `transformOrigin` wechselt mit.

## Hinweise zur Preisdaten-Quelle

- Die LiteLLM-Preisdatei (`model_prices_and_context_window.json`) ist ca. **1,5 MB** groß und enthält hunderte Einträge. Nicht vollständig einlesen oder parsen, wenn nur einzelne Modelle gesucht werden – gezielt suchen oder die bereits implementierte `LiteLLMFetcher`-Klasse nutzen.
- Fallback-Preise sind in `src/pricing/litellm-fetcher.ts` unter `FALLBACK_PRICES` hinterlegt und werden verwendet, wenn das Netz nicht erreichbar ist oder ein Modell in LiteLLM fehlt.

## Dependency maintenance

Read [docs/dependency-maintenance.md](docs/dependency-maintenance.md) before dependency, CI or release changes. Keep npm as the authoritative package manager and verify the Windows installer before enabling an update merge.
