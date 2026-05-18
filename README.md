# CodexBar for Windows

Electron/TypeScript MVP einer Windows-System-Tray-App für lokale AI-Coding-Quota-Anzeige.

## Technische Analyse der Referenzen

### steipete/CodexBar

- Architektur: Swift/macOS-Menüleisten-App mit getrenntem Core (`Sources/CodexBarCore`) für Fetching/Parsing, App-Schicht (`Sources/CodexBar`) für `UsageStore`, Settings, Menü und Icon, plus CLI und Widgets.
- Provider-Modell: Provider-Descriptoren kapseln Auth-Quelle, Fetch-Strategie, Parser und Präsentation. Sources sind unter anderem OAuth, CLI, Browser-Cookies, API Keys und lokale Dateien.
- Auth-Quellen: Codex nutzt Codex-CLI/OAuth und optionale OpenAI-Web-Dashboard-Extras. Claude nutzt OAuth, Web/Cookies und CLI-PTY-Fallback. Gemini nutzt OAuth-backed CLI-Credentials.
- Refresh-Loop: Background refresh aktualisiert `UsageStore`; manuelles Refresh bleibt immer verfügbar; Fehler/Stale-Zustände dimmen die Anzeige.
- Tray/Icon/UI: macOS Status Item mit dynamischen Meters, Provider-Reihen, Reset-Countdowns, Settings und optionalen Extras.
- macOS-spezifisch: Keychain, Sparkle, WidgetKit, WebKit, menu bar APIs und macOS Permission-Prompts.

### Finesssee/Win-CodexBar

- Architektur: Windows-Port mit Tauri + React UI und Rust-Backend; Rust enthält Provider, Credential-Härtung, Tray-Rendering, CLI und Windows-Packaging.
- Provider-Modell: Rust `Provider` trait plus Fetch-Plan/Source-Modi. Codex/Claude/Gemini sind sauber isolierte Provider-Module.
- Auth-Quellen: Codex liest `~/.codex/auth.json` und ruft `https://chatgpt.com/backend-api/wham/usage` auf. Claude liest `~/.claude/.credentials.json` und ruft `https://api.anthropic.com/api/oauth/usage` auf. Gemini nutzt im Port eine API-Strategie; dieses MVP bleibt bewusst lokal.
- Refresh/UI: System-Tray, dynamische Usage-Meter, Provider Panel und Settings. Credential Stores werden unter Windows mit DPAPI gehärtet.
- Windows-spezifisch: Tauri/WebView2, Inno/portable Packaging, Windows Tray und Autostart.

## Architekturentscheidung

Dieses MVP übernimmt die Referenz-Ideen, aber nicht deren Code:

- Electron Main Process ohne Hauptfenster.
- Provider sind TypeScript-Module hinter einem einheitlichen `UsageProvider` Interface.
- Inoffizielle/fragile APIs bleiben in `src/providers/codex.ts`, `src/providers/claude.ts` und `src/auth/tokenRefresh.ts` gekapselt.
- Credentials werden nur aus bekannten Standardpfaden gelesen. Tokens werden nicht angezeigt und vor Logging redigiert.
- `UsageStore` hält letzte erfolgreiche Snapshots und markiert sie bei Folgefehlern als `stale`.
- Dynamisches PNG-Tray-Icon wird zur Laufzeit erzeugt.

## Risiken

- `chatgpt.com/backend-api/wham/usage`, `api.anthropic.com/api/oauth/usage` und Claude OAuth Refresh sind inoffiziell oder intern und können Format, Auth oder Statuscodes ändern.
- `~/.codex/auth.json` und `~/.claude/.credentials.json` sind CLI-Implementierungsdetails.
- Electron/electron-builder bringen transitive npm-Abhängigkeiten mit; `npm audit` sollte vor Releases gesondert bewertet werden.

## MVP-Scope

- Windows 10/11 Tray-App ohne Hauptfenster.
- Rechtsklick/Klick/Doppelklick öffnet Kontextmenü.
- Periodischer Refresh, manuelles Refresh, Start-with-Windows Toggle, Open Log, Open Config Folder, Exit.
- Codex Provider über Codex-CLI-OAuth-Datei.
- Claude Provider über Claude-Code-OAuth-Datei plus optionaler Token-Refresh und Env-Fallback.
- Gemini Provider nur lokal: Modellname und `session-*.json` Zählung.
- Unit Tests für JWT, Auth-Parser, Formatter, Farben, Redaction und Snapshot-Normalisierung.

## Dateibaum

```text
.
├─ package.json
├─ tsconfig.json
├─ electron-builder.yml
├─ README.md
├─ AGENTS.md
├─ src/
│  ├─ main/
│  │  ├─ main.ts
│  │  ├─ tray.ts
│  │  ├─ menu.ts
│  │  ├─ autostart.ts
│  │  ├─ updater.ts
│  │  └─ logging.ts
│  ├─ providers/
│  │  ├─ types.ts
│  │  ├─ codex.ts
│  │  ├─ claude.ts
│  │  ├─ gemini.ts
│  │  └─ providerRegistry.ts
│  ├─ auth/
│  │  ├─ codexAuth.ts
│  │  ├─ claudeAuth.ts
│  │  ├─ tokenRefresh.ts
│  │  └─ jwt.ts
│  ├─ usage/
│  │  ├─ usageStore.ts
│  │  ├─ refreshLoop.ts
│  │  └─ formatters.ts
│  ├─ icon/
│  │  ├─ renderTrayIcon.ts
│  │  └─ colors.ts
│  ├─ config/
│  │  ├─ paths.ts
│  │  ├─ settings.ts
│  │  └─ firstRun.ts
│  └─ shared/
│     ├─ redaction.ts
│     └─ errors.ts
├─ tests/
└─ assets/
   └─ icon.ico
```

## Installation

```powershell
npm install
npm run build
```

## Entwicklung

```powershell
npm run dev
npm test
```

`npm run dev` baut TypeScript und startet Electron mit `--no-window --debug`.

## Packaging

```powershell
npm run package
```

Packaging nutzt `electron-builder` und erzeugt Windows NSIS/portable Artefakte unter `package-output/`.

## Auth-Hinweise

- Codex: `codex login` ausführen. Das MVP liest `~/.codex/auth.json`.
- Claude: `claude login` ausführen. Das MVP liest `~/.claude/.credentials.json`; alternativ `CODEXBAR_CLAUDE_OAUTH_TOKEN` setzen.
- Gemini: Das MVP liest nur `~/.gemini/settings.json` und zählt lokale Sessions unter `~/.gemini/tmp/`.

## Sicherheit und Datenschutz

- Keine Passwörter werden gespeichert.
- Tokens, Cookies, Authorization Header und JWTs werden nicht im UI angezeigt und vor dem Logging redigiert.
- Logs liegen unter `%USERPROFILE%\.codexbar-win\codexbar.log`.
- Gelesen werden nur bekannte Provider-Standardpfade; es findet kein Festplatten-Scan statt.
- Claude/OpenAI interne oder inoffizielle APIs können sich ohne Vorankündigung ändern.
