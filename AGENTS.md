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
- Build-Artefakte, `node_modules`, `dist`, `release` und `package-output` nicht committen.
- Deutsche Umlaute in Textdateien korrekt schreiben (`ä`, `ö`, `ü`, `Ä`, `Ö`, `Ü`, `ß`), nicht als `ae`, `oe`, `ue` usw.

## Sprache

Die gesamte App ist auf **Englisch**: UI-Labels, Tooltips, Fehlermeldungen, Benachrichtigungen, Kommentare im Code und öffentliche Dokumentation. Niemals UI-Strings oder Docs ins Deutsche übersetzen — ein "Übersetzungsfehler" bedeutet immer, dass ein deutsches Wort in englischen Text eingeschlichen ist, nicht umgekehrt.

## UI-Konventionen

### Tooltips
Neue Tooltips werden als **Portal-Elemente** direkt an `<body>` gehängt (nicht als Child des auslösenden Elements), damit sie nicht durch `overflow: hidden` oder `z-index`-Stacking abgeschnitten werden. Orientierung am bestehenden Token-Breakdown-Tooltip in [history.js](src/renderer/tabs/history.js):

- CSS-Klasse `.hr-kpi-tok-tip` in [index.html](src/renderer/index.html) als Vorlage für Aussehen und Einblend-Animation (`opacity + scale + filter: blur`, 160 ms)
- Tooltip-Element beim ersten Aufruf erzeugen (`document.createElement`, `document.body.appendChild`), ID vergeben, bei späteren Aufrufen per `getElementById` wiederverwenden
- Position über `getBoundingClientRect()` des Anker-Elements berechnen; zentriert oberhalb, bei zu wenig Platz unterhalb — mit `transformOrigin` entsprechend wechseln
- Einblenden durch `.classList.add('is-visible')`, Ausblenden durch `.classList.remove('is-visible')`

## Hinweise zur Preisdaten-Quelle

- Die LiteLLM-Preisdatei (`model_prices_and_context_window.json`) ist ca. **1,5 MB** groß und enthält hunderte Einträge. Nicht vollständig einlesen oder parsen, wenn nur einzelne Modelle gesucht werden – gezielt suchen oder die bereits implementierte `LiteLLMFetcher`-Klasse nutzen.
- Fallback-Preise sind in `src/pricing/litellm-fetcher.ts` unter `FALLBACK_PRICES` hinterlegt und werden verwendet, wenn das Netz nicht erreichbar ist oder ein Modell in LiteLLM fehlt.
