# Design: Installer mit Auto-Update, Silent-Install & Versionierung

**Datum:** 2026-06-21
**Status:** Freigegeben

## Ziel

QuotaBar als signierfreien Windows-Installer (NSIS) verteilen, der sich über
GitHub Releases vollautomatisch im Hintergrund aktualisiert. Releases werden per
Git-Tag über GitHub Actions gebaut und veröffentlicht. Kein Code-Signing.

## Entscheidungen (vom Nutzer bestätigt)

- **Release-Weg:** GitHub Actions, ausgelöst durch Git-Tag `v*`.
- **Update-UX:** Vollautomatisch still — im Hintergrund laden, beim nächsten
  Beenden/Neustart installieren.
- **Erstinstallation:** Assistent (`oneClick: false`) bleibt.
- **Portable-Target:** entfernt (kann nicht auto-updaten).
- **Release-Sichtbarkeit:** direkt veröffentlicht (kein Draft).
- **Code-Signing:** keines (SmartScreen-Warnung beim ersten Start akzeptiert).

## Repo

- GitHub: `spiral023/QuotaBar` (öffentlich)
- Updater nutzt das automatische `GITHUB_TOKEN` der Action — kein PAT nötig.

## Bausteine

### A. Versions-Quelle & Release-Auslöser

`package.json` `version` ist die einzige Wahrheit. Veröffentlichen:

```
npm version patch       # bumpt package.json + erstellt git-Tag v0.1.1
git push --follow-tags  # löst GitHub Action aus
```

Die GitHub Action validiert, dass der Tag (`v0.1.1` → `0.1.1`) exakt der
`package.json`-Version entspricht. Bei Abweichung bricht der Build mit Fehler ab,
damit Tag und ausgelieferte Version nie auseinanderlaufen.

### B. electron-builder.yml

- `publish:` von `null` → GitHub-Provider:
  ```yaml
  publish:
    provider: github
    owner: spiral023
    repo: QuotaBar
  ```
- `win.target`: nur noch `nsis` (Eintrag `portable` entfernt).
- `nsis`: `oneClick: false`, `perMachine: false`,
  `allowToChangeInstallationDirectory: true` bleiben unverändert.
- electron-builder erzeugt beim Release automatisch `latest.yml` plus `.blockmap`
  (für differenzielle Downloads), die `electron-updater` ausliest.

### C. updater.ts (ersetzt den Stub)

Aktuell ein No-Op-Stub. Neue Implementierung:

- `electron-updater` (`autoUpdater`) einbinden.
- `autoUpdater.logger = electron-log` (bereits als Dependency vorhanden).
- **Guard:** Updater-Logik nur ausführen wenn `app.isPackaged === true`
  (im Dev-Modus passiert nichts, kein Fehler).
- `autoUpdater.autoDownload = true`.
- `autoUpdater.autoInstallOnAppQuit = true`.
- Prüfen auf Updates:
  - einmal beim Start mit kurzer Verzögerung (App-Init nicht blockieren),
  - danach periodisch alle ~6 Stunden (`setInterval`), da die Tray-App tagelang
    läuft und selten beendet wird.
- Event-Handling, jeweils mit Logging:
  - `checking-for-update`, `update-available`, `update-not-available`
  - `download-progress` (nur Log)
  - `update-downloaded` → Flag „Update bereit" setzen, Tray-Menü aktualisieren,
    System-Tab-Status aktualisieren
  - `error` → Fehler werden geloggt und geschluckt, niemals als Crash/Dialog
- Öffentliche API des Moduls:
  - `initializeUpdater()` — wird in `main.ts` aufgerufen (Signatur bleibt).
  - `checkForUpdatesNow()` — manueller Trigger (für System-Tab-Button).
  - `quitAndInstall()` — sofort neu starten & installieren (für Tray-Eintrag).
  - `getUpdateState()` — aktueller Status für die UI
    (`current`/`available`/`downloading`/`ready`/`error` + Versionen).

### D. Tray- & UI-Feedback (minimal)

- **Tray-Menü:** Wenn ein Update heruntergeladen und bereit ist, erscheint der
  zusätzliche Eintrag **„Update bereit – jetzt neu starten"**, der
  `quitAndInstall()` aufruft. Ohne Klick installiert sich das Update still beim
  nächsten regulären Beenden.
- **System-Tab:** zeigt
  - aktuelle App-Version (`app.getVersion()`),
  - Update-Status (z. B. „aktuell" / „Update v0.2.0 wird beim Beenden
    installiert"),
  - Button **„Auf Updates prüfen"** (→ `checkForUpdatesNow()`).
- Kommunikation Renderer ↔ Main über bestehende IPC/preload-Muster.

### E. GitHub Actions Workflow (`.github/workflows/release.yml`)

- **Trigger:** Push von Tags, die auf `v*` matchen.
- **Runner:** `windows-latest`.
- **Schritte:**
  1. Checkout
  2. Node einrichten (Version passend zu lokaler Entwicklung)
  3. `npm ci`
  4. Tag-vs-`package.json`-Version-Check (Abbruch bei Mismatch)
  5. `npm run build`
  6. `npx electron-builder --win --publish always`
- **Token:** das von Actions automatisch bereitgestellte `GITHUB_TOKEN` (als
  `GH_TOKEN`-Env für electron-builder) — kein Personal Access Token.
- **Ergebnis:** ein normales (nicht-Draft, nicht-Prerelease) GitHub Release mit
  `QuotaBar-Setup-x.y.z.exe`, `latest.yml` und `.blockmap`.

## Abgrenzung / Nicht-Ziele

- Kein Code-Signing, keine Notarisierung.
- Keine Portable-Variante mehr.
- Keine macOS-/Linux-Builds.
- Kein Rollback-/Kanal-Mechanismus (kein beta/stable-Split) im MVP.

## Risiken & Hinweise

- **SmartScreen:** Ohne Signatur warnt Windows beim ersten Start
  („Unbekannter Herausgeber"). Akzeptiert; mit zunehmender Verbreitung legt sich
  die Warnung. Im README erwähnen.
- **Lang laufende Tray-App:** Updates installieren erst beim Beenden. Der
  Tray-Eintrag „jetzt neu starten" ist der schnelle Weg; periodische Prüfung
  hält den Download aktuell.
- **Erst-Update braucht ein veröffentlichtes Release:** Der Updater funktioniert
  erst, sobald mindestens ein Release mit `latest.yml` existiert.
