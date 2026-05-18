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
