# AGENTS.md

## Projekt

Dieses Repository enthaelt eine Electron/TypeScript Windows-Tray-App fuer QuotaBar direkt im Repo-Root.

## Arbeitsregeln

- Arbeite im Repo-Root; `src/`, `tests/`, `assets/` und die Node/Electron-Konfiguration liegen direkt hier.
- Keine Tokens, Cookies, Authorization Header oder JWTs loggen oder in Ausgaben anzeigen.
- Auth-Dateien nur aus bekannten Standardpfaden lesen, keine breite Festplatten-Suche.
- Inoffizielle Provider-Endpunkte in Provider-/Auth-Modulen kapseln und defensiv behandeln.
- Vor Abschluss mindestens `npm test` und `npm run build` ausfuehren, wenn Code geaendert wurde.
- Build-Artefakte, `node_modules`, `dist`, `release` und `package-output` nicht committen.
- Deutsche Umlaute in Textdateien korrekt schreiben (`ä`, `ö`, `ü`, `Ä`, `Ö`, `Ü`, `ß`), nicht als `ae`, `oe`, `ue` usw.

## Hinweise zur Preisdaten-Quelle

- Die LiteLLM-Preisdatei (`model_prices_and_context_window.json`) ist ca. **1,5 MB** groß und enthält hunderte Einträge. Nicht vollständig einlesen oder parsen, wenn nur einzelne Modelle gesucht werden – gezielt suchen oder die bereits implementierte `LiteLLMFetcher`-Klasse nutzen.
- Fallback-Preise sind in `src/pricing/litellm-fetcher.ts` unter `FALLBACK_PRICES` hinterlegt und werden verwendet, wenn das Netz nicht erreichbar ist oder ein Modell in LiteLLM fehlt.
