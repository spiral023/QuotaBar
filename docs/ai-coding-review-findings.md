# Code-Review `tools/ai-coding.ps1` — offene Funde

Gründliche Voll-Review vom **2026-07-22**. Gesamturteil: **solide** — keine kritischen/hohen Probleme, keine ConstrainedLanguage-Verstöße, keine EAP/stderr-Bugs, keine PS7-only-Syntax.

Kontext-Constraints (bei jeder Umsetzung beachten):
- Läuft auf Ziel-PCs in **ConstrainedLanguage-Mode** (keine statischen .NET-Methodenaufrufe wie `[Convert]::...`, kein `New-Object` mit beliebigen Typen).
- **Windows PowerShell 5.1**, nicht PS7.
- `$ErrorActionPreference = "Stop"` global → native `& exe … 2>&1` mit stderr wirft Exception; EAP für solche Aufrufe lokal auf `Continue`.

## Bereits umgesetzt (2026-07-22)
- **#4** `Test-Port` beachtet jetzt die Adresse (Listener auf `$a`, `0.0.0.0` oder `::`).
- **#8** `Get-CaVarDivergence` nutzt `Sort-Object -Unique` (case-insensitiver Pfadvergleich).
- **#9** Menü „Beide installieren" bricht nach Claude-Fehler ab (`if ($Script:FailedCount -eq 0)`), konsistent zur CLI-Action `InstallBoth`.

---

## Offen — später prüfen

### #1 (Mittel) — `NODE_USE_ENV_PROXY` nur im Codex-Pfad gesetzt
- **Stellen:** gesetzt in `Install-CodexCli` (Session Z. ~654, persistent Z. ~670); **nicht** in `Install-ClaudeCode` / `Set-SessionProxyEnv` (Z. ~311) / `Set-ProxyEnvPersistent` (Z. ~441). Healthcheck warnt aber generell danach (Z. ~937).
- **Folge:** Auf einem **Claude-only-PC** wird die Variable nie gesetzt → Healthcheck meldet einen scheinbaren Fehler. Konfiguration wird installationsreihenfolge-abhängig.
- **Vorschlag:** `NODE_USE_ENV_PROXY=1` in `Set-SessionProxyEnv` **und** `Set-ProxyEnvPersistent` aufnehmen (dann in beiden Pfaden gesetzt) und die redundanten Einzelzeilen in `Install-CodexCli` entfernen.
- **Zu verifizieren:** Braucht Claude Code das Flag tatsächlich, oder routet es `HTTPS_PROXY` mit eigener Logik? (`NODE_USE_ENV_PROXY` ist ein neueres Node-Flag für fetch/undici.) Hinweis: `NODE_USE_SYSTEM_CA` (CA-Trust) und `NODE_USE_ENV_PROXY` (Proxy-Routing) sind **zwei verschiedene** legitime Flags — nicht verwechseln.

### #2 (Mittel) — `allow-scripts` ist kein npm-Config-Key
- **Stelle:** `Set-NpmConfigValue "allow-scripts" $claudePkg` (Z. ~363 in `Set-NpmConfig`).
- **Folge:** npm kennt den Key nicht (nativer Key ist `ignore-scripts`; `allow-scripts` gehört zu `@lavamoat/allow-scripts`). Wirkungslos + npm schreibt „Unknown user config" und **warnt bei jedem npm-Aufruf** auf stderr.
- **Vorschlag:** Zeile entfernen (Absicht unklar/vermutlich Missverständnis). Falls Install-Scripts bewusst gesteuert werden sollen: über `ignore-scripts` (bool) lösen.

### #3 (Niedrig) — Menüstart kann auf `npm view` hängen
- **Stellen:** `Initialize-AgentVersionCache` (Z. ~972–978) beim Menüstart ruft `npm view <pkg> version` (Netzwerk).
- **Folge:** Läuft px noch nicht / ist der Corporate-Proxy erreichbar aber träge, blockiert der Menüaufbau am npm-Timeout.
- **Vorschlag:** Timeout/`--fetch-timeout` setzen, oder Versionsprüfung lazy/asynchron bzw. nur auf Anforderung.

### #5 (Niedrig) — Codex-Install erneuert vorhandenes CA-Bundle nicht
- **Stelle:** `Install-CodexCli` (Z. ~642–648) exportiert nur bei **fehlendem** Bundle; ein veraltetes/unvollständiges Bundle wird kommentarlos wiederverwendet.
- **Folge:** Ein Bundle aus der Zeit vor dem Intermediate-Fix bliebe unvollständig. Abhilfe existiert separat über `UpdateCaBundle`.
- **Vorschlag:** Optional Bundle-Alter/-Vollständigkeit prüfen oder bei Install immer neu bauen.

### #6 (Niedrig, kosmetisch) — `[Console]::OutputEncoding` unter CLM
- **Stelle:** Z. ~34 (in `try/catch`). Im CLM-Modus wirft die Zuweisung (gefangen) → Konsole bleibt auf OEM-Codepage → ä/ö/ü ggf. falsch dargestellt.
- **Vorschlag:** CLM-tauglichen Weg prüfen (z. B. `chcp 65001` via cmd) oder als bekannt akzeptieren.

### #7 (Niedrig, kosmetisch) — `FailedCount` wird mehrfach gezählt
- **Stelle:** z. B. npm-Fehler in `Install-*` erhöht `FailedCount` dreifach (`Invoke-ExternalCommand` + `Write-Change "Failed"` + `Write-Err`).
- **Folge:** Nur die Summary-Zahl ist zu hoch; Schwellen (`-gt 0` / `-eq 0`) bleiben korrekt.
- **Vorschlag:** Zählung an einer Stelle bündeln.

### #10 (Niedrig) — `Initialize-Logging` legt Logdatei auch im DryRun an
- **Stelle:** Z. ~84, unbedingt vor jeder Action (auch DryRun/Healthcheck).
- **Folge:** „Dry Run" erzeugt real `C:\Entwicklung\ai-coding` samt Logdatei — geringfügige Verletzung der „keine Änderungen"-Zusage.
- **Vorschlag:** Logging im DryRun in-memory halten oder unterdrücken (Meta/Logging ist aber vertretbar).
