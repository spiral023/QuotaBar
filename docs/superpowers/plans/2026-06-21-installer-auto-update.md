# Installer mit Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QuotaBar als signierfreien NSIS-Installer bauen, der sich über GitHub Releases vollautomatisch im Hintergrund aktualisiert; Releases werden per Git-Tag durch GitHub Actions gebaut und veröffentlicht.

**Architecture:** `electron-updater` läuft im Main-Prozess (nur in gepackten Builds), prüft beim Start und periodisch auf Updates, lädt still herunter und installiert beim Beenden. Eine GitHub Action baut bei Tags `v*` den Installer und published `latest.yml` + Setup-Exe. Reine Logik (Tag/Version-Abgleich, Update-State-Reducer) wird als testbare Pure Functions ausgelagert.

**Tech Stack:** Electron 42, electron-builder 26 (NSIS), electron-updater 6.x, TypeScript, Vitest, GitHub Actions.

## Global Constraints

- **Repo:** `spiral023/QuotaBar` (öffentlich); Updater nutzt das von Actions bereitgestellte `GITHUB_TOKEN` als `GH_TOKEN` — kein Personal Access Token.
- **Kein Code-Signing**, keine Notarisierung, keine macOS-/Linux-Builds.
- **Erstinstallation:** NSIS-Assistent (`oneClick: false`) bleibt; Updates installieren still.
- **`package.json` `version` ist die einzige Versions-Wahrheit**; Git-Tag `vX.Y.Z` muss exakt passen.
- **Updater darf nie crashen:** alle Fehler werden geloggt und geschluckt (Muster wie der bestehende File-`log`).
- **Logger:** Die App nutzt den eigenen File-Logger aus [logging.ts](src/main/logging.ts) (`log.debug/info/warn/error`, je ein `string`-Argument) — **nicht** electron-log. `autoUpdater.logger` bekommt einen Adapter auf dieses `log`.
- **Renderer-Tab-Skripte teilen globalen Scope:** neuer Code in `src/renderer/tabs/system.js` bleibt in der bestehenden IIFE gekapselt.
- Code-Referenzen für Konsumenten: `app.getVersion()` liefert die aktuelle Version; Tray-Menü wird über `TrayController.rebuildMenu()` neu gebaut.

---

### Task 1: electron-updater installieren & electron-builder.yml umstellen

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `electron-builder.yml:3` (publish) und `electron-builder.yml:17-20` (win.target)

**Interfaces:**
- Consumes: nichts.
- Produces: Dependency `electron-updater`; Release-Konfiguration mit GitHub-Provider und NSIS-only-Target, auf die Task 3 und Task 6 sich stützen.

- [ ] **Step 1: electron-updater als Laufzeit-Dependency installieren**

```bash
npm install electron-updater@^6.3.9
```

- [ ] **Step 2: publish-Provider in electron-builder.yml setzen**

Ersetze in [electron-builder.yml](electron-builder.yml) die Zeile `publish: null` durch:

```yaml
publish:
  provider: github
  owner: spiral023
  repo: QuotaBar
```

- [ ] **Step 3: win.target auf NSIS-only reduzieren**

Ersetze in [electron-builder.yml](electron-builder.yml) den `win.target`-Block:

```yaml
win:
  target:
    - nsis
  icon: assets/icon.ico
```

(Der `portable`-Eintrag entfällt — Portable kann nicht auto-updaten.)

- [ ] **Step 4: Build verifizieren (tsc kompiliert weiterhin)**

Run: `npm run build`
Expected: Kein Fehler; `dist/main/main.js` existiert.

- [ ] **Step 5: electron-builder-Konfiguration validieren (kein Upload)**

Run: `npx electron-builder --win --publish never`
Expected: Build läuft durch, `package-output/` enthält genau eine `*Setup*.exe` und `latest.yml`, **kein** `*portable*.exe`. (Dauert einige Minuten; bei reiner Plan-Validierung optional.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json electron-builder.yml
git commit -m "build: electron-updater + GitHub-Publish, NSIS-only target"
```

---

### Task 2: Version/Tag-Abgleich als testbare Funktion

**Files:**
- Create: `src/build/versionTag.ts`
- Test: `tests/versionTag.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - `parseTagVersion(tag: string): string` — entfernt führendes `v`, gibt die nackte Version zurück; wirft `Error` bei ungültigem SemVer-Format (`X.Y.Z`, optional Pre-Release-Suffix).
  - `assertTagMatches(tag: string, version: string): void` — wirft `Error` mit aussagekräftiger Meldung, wenn `parseTagVersion(tag) !== version`. Wird in Task 6 (CI) via `node -e` aufgerufen.

- [ ] **Step 1: Failing Test schreiben**

Create `tests/versionTag.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseTagVersion, assertTagMatches } from "../src/build/versionTag";

describe("parseTagVersion", () => {
  it("strips a leading v", () => {
    expect(parseTagVersion("v1.2.3")).toBe("1.2.3");
  });
  it("accepts a bare version without v", () => {
    expect(parseTagVersion("1.2.3")).toBe("1.2.3");
  });
  it("accepts a prerelease suffix", () => {
    expect(parseTagVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });
  it("throws on a non-semver tag", () => {
    expect(() => parseTagVersion("v1.2")).toThrow();
    expect(() => parseTagVersion("release-1")).toThrow();
  });
});

describe("assertTagMatches", () => {
  it("passes when tag matches package version", () => {
    expect(() => assertTagMatches("v0.2.0", "0.2.0")).not.toThrow();
  });
  it("throws when tag and version differ", () => {
    expect(() => assertTagMatches("v0.2.0", "0.1.0")).toThrow(/0\.2\.0.*0\.1\.0/);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `npx vitest run tests/versionTag.test.ts`
Expected: FAIL — `Cannot find module '../src/build/versionTag'`.

- [ ] **Step 3: Implementierung schreiben**

Create `src/build/versionTag.ts`:

```ts
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Entfernt ein optionales führendes "v" und prüft das SemVer-Format. */
export function parseTagVersion(tag: string): string {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!SEMVER.test(version)) {
    throw new Error(`Tag "${tag}" ist keine gültige SemVer-Version (erwartet vX.Y.Z)`);
  }
  return version;
}

/** Wirft, wenn der Git-Tag nicht exakt der package.json-Version entspricht. */
export function assertTagMatches(tag: string, version: string): void {
  const tagVersion = parseTagVersion(tag);
  if (tagVersion !== version) {
    throw new Error(
      `Versions-Mismatch: Git-Tag ergibt ${tagVersion}, package.json hat ${version}. ` +
        `Tag und package.json-Version müssen übereinstimmen.`,
    );
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg bestätigen**

Run: `npx vitest run tests/versionTag.test.ts`
Expected: PASS (6 Tests grün).

- [ ] **Step 5: Commit**

```bash
git add src/build/versionTag.ts tests/versionTag.test.ts
git commit -m "feat(build): testbarer Tag/Version-Abgleich für Release-CI"
```

---

### Task 3: Update-State-Reducer (Pure Function, TDD)

**Files:**
- Create: `src/main/updateState.ts`
- Test: `tests/updateState.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - Typ `UpdateUiState = { status: "disabled" | "idle" | "checking" | "available" | "downloading" | "ready" | "error"; currentVersion: string; newVersion: string | null; downloadPercent: number; error: string | null }`.
  - Typ `UpdateEvent` (discriminated union): `{ type: "checking" } | { type: "available"; version: string } | { type: "not-available" } | { type: "progress"; percent: number } | { type: "downloaded"; version: string } | { type: "error"; message: string }`.
  - `initialUpdateState(currentVersion: string, enabled: boolean): UpdateUiState`.
  - `reduceUpdateState(state: UpdateUiState, event: UpdateEvent): UpdateUiState` — reiner Reducer.
  - Task 4 (updater.ts) hält eine `UpdateUiState`-Instanz und mutiert sie ausschließlich über `reduceUpdateState`.

- [ ] **Step 1: Failing Test schreiben**

Create `tests/updateState.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { initialUpdateState, reduceUpdateState } from "../src/main/updateState";

describe("initialUpdateState", () => {
  it("is disabled when updater is not enabled (dev)", () => {
    const s = initialUpdateState("0.1.0", false);
    expect(s.status).toBe("disabled");
    expect(s.currentVersion).toBe("0.1.0");
  });
  it("is idle when enabled", () => {
    expect(initialUpdateState("0.1.0", true).status).toBe("idle");
  });
});

describe("reduceUpdateState", () => {
  const base = initialUpdateState("0.1.0", true);

  it("moves to checking", () => {
    expect(reduceUpdateState(base, { type: "checking" }).status).toBe("checking");
  });
  it("records an available version", () => {
    const s = reduceUpdateState(base, { type: "available", version: "0.2.0" });
    expect(s.status).toBe("available");
    expect(s.newVersion).toBe("0.2.0");
  });
  it("tracks download progress", () => {
    const s = reduceUpdateState(base, { type: "progress", percent: 42 });
    expect(s.status).toBe("downloading");
    expect(s.downloadPercent).toBe(42);
  });
  it("marks ready after download", () => {
    const s = reduceUpdateState(base, { type: "downloaded", version: "0.2.0" });
    expect(s.status).toBe("ready");
    expect(s.newVersion).toBe("0.2.0");
  });
  it("returns to idle when nothing is available", () => {
    const checking = reduceUpdateState(base, { type: "checking" });
    expect(reduceUpdateState(checking, { type: "not-available" }).status).toBe("idle");
  });
  it("captures errors without losing the current version", () => {
    const s = reduceUpdateState(base, { type: "error", message: "boom" });
    expect(s.status).toBe("error");
    expect(s.error).toBe("boom");
    expect(s.currentVersion).toBe("0.1.0");
  });
  it("never leaves the disabled state", () => {
    const disabled = initialUpdateState("0.1.0", false);
    expect(reduceUpdateState(disabled, { type: "checking" }).status).toBe("disabled");
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag bestätigen**

Run: `npx vitest run tests/updateState.test.ts`
Expected: FAIL — Modul nicht gefunden.

- [ ] **Step 3: Implementierung schreiben**

Create `src/main/updateState.ts`:

```ts
export interface UpdateUiState {
  status: "disabled" | "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  currentVersion: string;
  newVersion: string | null;
  downloadPercent: number;
  error: string | null;
}

export type UpdateEvent =
  | { type: "checking" }
  | { type: "available"; version: string }
  | { type: "not-available" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

export function initialUpdateState(currentVersion: string, enabled: boolean): UpdateUiState {
  return {
    status: enabled ? "idle" : "disabled",
    currentVersion,
    newVersion: null,
    downloadPercent: 0,
    error: null,
  };
}

export function reduceUpdateState(state: UpdateUiState, event: UpdateEvent): UpdateUiState {
  // Im Dev-Build (disabled) ignorieren wir alle Events.
  if (state.status === "disabled") return state;

  switch (event.type) {
    case "checking":
      return { ...state, status: "checking", error: null };
    case "available":
      return { ...state, status: "available", newVersion: event.version, error: null };
    case "not-available":
      return { ...state, status: "idle", newVersion: null };
    case "progress":
      return { ...state, status: "downloading", downloadPercent: Math.round(event.percent) };
    case "downloaded":
      return { ...state, status: "ready", newVersion: event.version, downloadPercent: 100 };
    case "error":
      return { ...state, status: "error", error: event.message };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg bestätigen**

Run: `npx vitest run tests/updateState.test.ts`
Expected: PASS (alle Tests grün).

- [ ] **Step 5: Commit**

```bash
git add src/main/updateState.ts tests/updateState.test.ts
git commit -m "feat(updater): reiner Update-State-Reducer mit Tests"
```

---

### Task 4: updater.ts implementieren (electron-updater verdrahten)

**Files:**
- Modify: `src/main/updater.ts` (ersetzt den No-Op-Stub vollständig)
- Test: manuell (Electron-Integration, nicht unit-testbar)

**Interfaces:**
- Consumes: `initialUpdateState`, `reduceUpdateState`, `UpdateUiState`, `UpdateEvent` aus `./updateState`; `log` aus `./logging`.
- Produces (Modul-API, von Task 5 und main.ts/tray.ts konsumiert):
  - `initializeUpdater(opts?: { onStateChange?: (state: UpdateUiState) => void }): Promise<void>` — Signatur-kompatibel zum bestehenden Aufruf in [main.ts:235](src/main/main.ts#L235) (Parameter ist optional).
  - `checkForUpdatesNow(): void`
  - `quitAndInstall(): void`
  - `getUpdateState(): UpdateUiState`

- [ ] **Step 1: updater.ts neu schreiben**

Ersetze den gesamten Inhalt von [updater.ts](src/main/updater.ts):

```ts
import { app, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { log } from "./logging";
import { initialUpdateState, reduceUpdateState, UpdateUiState } from "./updateState";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const START_DELAY_MS = 20_000; // App-Init nicht blockieren

let state: UpdateUiState = initialUpdateState("0.0.0", false);
let notifyStateChange: ((state: UpdateUiState) => void) | null = null;

function apply(event: Parameters<typeof reduceUpdateState>[1]): void {
  state = reduceUpdateState(state, event);
  notifyStateChange?.(state);
}

// Adapter: electron-updater erwartet einen Logger mit (msg, ...args) – auf den
// vorhandenen String-File-Logger abbilden, niemals werfen.
function toMessage(args: unknown[]): string {
  return args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
}
const updaterLogger = {
  info: (...a: unknown[]) => log.info(`[updater] ${toMessage(a)}`),
  warn: (...a: unknown[]) => log.warn(`[updater] ${toMessage(a)}`),
  error: (...a: unknown[]) => log.error(`[updater] ${toMessage(a)}`),
  debug: (...a: unknown[]) => log.debug(`[updater] ${toMessage(a)}`),
};

export function getUpdateState(): UpdateUiState {
  return state;
}

export function checkForUpdatesNow(): void {
  if (state.status === "disabled") return;
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    apply({ type: "error", message: err instanceof Error ? err.message : String(err) });
  });
}

export function quitAndInstall(): void {
  if (state.status !== "ready") return;
  // isSilent=true, isForceRunAfter=true → still installieren, danach App starten.
  autoUpdater.quitAndInstall(true, true);
}

export async function initializeUpdater(
  opts: { onStateChange?: (state: UpdateUiState) => void } = {},
): Promise<void> {
  notifyStateChange = opts.onStateChange ?? null;

  // IPC-Handler IMMER registrieren, damit der System-Tab auch im Dev funktioniert.
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => {
    checkForUpdatesNow();
    return state;
  });
  ipcMain.handle("update:quit-and-install", () => {
    quitAndInstall();
    return state;
  });

  if (!app.isPackaged) {
    state = initialUpdateState(app.getVersion(), false);
    log.debug("Updater disabled: app is not packaged (dev build)");
    return;
  }

  state = initialUpdateState(app.getVersion(), true);
  autoUpdater.logger = updaterLogger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => apply({ type: "checking" }));
  autoUpdater.on("update-available", (info) => apply({ type: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => apply({ type: "not-available" }));
  autoUpdater.on("download-progress", (p) => apply({ type: "progress", percent: p.percent }));
  autoUpdater.on("update-downloaded", (info) => {
    log.info(`Update ${info.version} heruntergeladen; installiert beim Beenden`);
    apply({ type: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    apply({ type: "error", message: err instanceof Error ? err.message : String(err) });
  });

  // Erster Check verzögert, dann periodisch (Tray-App läuft tagelang).
  const startTimer = setTimeout(() => checkForUpdatesNow(), START_DELAY_MS);
  startTimer.unref();
  const intervalTimer = setInterval(() => checkForUpdatesNow(), SIX_HOURS_MS);
  intervalTimer.unref();

  log.info(`Updater initialisiert (Version ${app.getVersion()})`);
}
```

- [ ] **Step 2: Typecheck/Build**

Run: `npm run build`
Expected: Kein TypeScript-Fehler.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: Keine neuen Fehler in `src/main/updater.ts`.

- [ ] **Step 4: Dev-Smoke-Test (Updater bleibt deaktiviert)**

Run: `npm run dev`
Expected: App startet, im Log erscheint `Updater disabled: app is not packaged (dev build)`, kein Crash. App wieder beenden.

- [ ] **Step 5: Commit**

```bash
git add src/main/updater.ts
git commit -m "feat(updater): electron-updater verdrahten (silent, periodisch, IPC)"
```

---

### Task 5: Tray-Eintrag „Update bereit"

**Files:**
- Modify: `src/main/menu.ts:9-14` (MenuActions) und `src/main/menu.ts:43-58` (Menü-Items)
- Modify: `src/main/tray.ts` (Update-State halten, an Menü reichen)
- Modify: `src/main/main.ts:235` (onStateChange-Callback an `initializeUpdater`)

**Interfaces:**
- Consumes: `quitAndInstall`, `UpdateUiState` aus `./updater` bzw. `./updateState`; `TrayController.setUpdateState`.
- Produces: `TrayController.setUpdateState(state: UpdateUiState): void` — speichert den State und ruft `rebuildMenu()`.

- [ ] **Step 1: MenuActions um Update-Infos erweitern**

In [menu.ts](src/main/menu.ts) das Interface `MenuActions` ergänzen:

```ts
export interface MenuActions {
  refreshNow(): Promise<void>;
  rebuildMenu(): void;
  openDashboard(): void;
  regenerateBackfill(): Promise<void>;
  updateReady: boolean;
  updateVersion: string | null;
  installUpdate(): void;
}
```

- [ ] **Step 2: Menü-Item bedingt einfügen**

In [menu.ts](src/main/menu.ts) direkt **vor** dem `{ type: "separator" }`/`Exit`-Block (aktuell Zeile 56-57) einfügen:

```ts
  if (actions.updateReady) {
    items.push(
      { type: "separator" },
      {
        label: actions.updateVersion
          ? `Update ${actions.updateVersion} bereit – jetzt neu starten`
          : "Update bereit – jetzt neu starten",
        click: () => actions.installUpdate(),
      },
    );
  }
```

- [ ] **Step 3: TrayController um Update-State erweitern**

In [tray.ts](src/main/tray.ts):

Import ergänzen (oben):

```ts
import { quitAndInstall } from "./updater";
import type { UpdateUiState } from "./updateState";
```

Feld in der Klasse ergänzen (neben `isStaleAfterResume`):

```ts
  private updateState: UpdateUiState | null = null;
```

Methode ergänzen (z. B. nach `setDetailsWindow`):

```ts
  setUpdateState(state: UpdateUiState): void {
    this.updateState = state;
    void this.rebuildMenu();
  }
```

In `rebuildMenu()` die Actions um die drei neuen Felder ergänzen:

```ts
      regenerateBackfill: this.onRegenerateBackfill,
      updateReady: this.updateState?.status === "ready",
      updateVersion: this.updateState?.newVersion ?? null,
      installUpdate: () => quitAndInstall(),
```

- [ ] **Step 4: Updater-Callback in main.ts verdrahten**

In [main.ts](src/main/main.ts) den Aufruf an Zeile 235 ersetzen:

```ts
      await initializeUpdater({
        onStateChange: (updateState) => tray.setUpdateState(updateState),
      });
```

- [ ] **Step 5: Build + Lint**

Run: `npm run build && npm run lint`
Expected: Kein Fehler.

- [ ] **Step 6: Dev-Smoke-Test (Menü unverändert ohne Update)**

Run: `npm run dev`
Expected: Tray-Menü öffnet normal; **kein** „Update bereit"-Eintrag (Dev = disabled). Beenden.

- [ ] **Step 7: Commit**

```bash
git add src/main/menu.ts src/main/tray.ts src/main/main.ts
git commit -m "feat(updater): Tray-Eintrag 'Update bereit – jetzt neu starten'"
```

---

### Task 6: System-Tab — Version & Update-Status

**Files:**
- Modify: `src/renderer/tabs/system.js` (innerhalb der bestehenden IIFE)

**Interfaces:**
- Consumes: IPC-Kanäle `update:get-state`, `update:check`, `update:quit-and-install` (aus Task 4); `QB.ipc.invoke`.
- Produces: ein Update-Panel oben im System-Tab plus Event-Bindings.

- [ ] **Step 1: Update-State laden und Panel rendern**

In [system.js](src/renderer/tabs/system.js) innerhalb der IIFE eine Hilfsfunktion und das Laden ergänzen. Füge nach den `let _data … _animated` Variablen hinzu:

```js
  let _update = null;

  async function loadUpdateState(force) {
    try {
      _update = await QB.ipc.invoke(force ? 'update:check' : 'update:get-state');
    } catch (e) {
      console.error('update:get-state failed', e);
      _update = null;
    }
    return _update;
  }

  function updatePanelHtml(u) {
    if (!u) return '';
    const map = {
      disabled: ['Entwicklungs-Build', 'Auto-Updates sind nur im installierten Build aktiv.'],
      idle: ['Aktuell', 'Du verwendest die neueste Version.'],
      checking: ['Suche nach Updates…', ''],
      available: [`Update ${u.newVersion || ''} gefunden`, 'Wird im Hintergrund geladen…'],
      downloading: [`Lädt ${u.newVersion || ''}…`, `${u.downloadPercent}%`],
      ready: [`Update ${u.newVersion || ''} bereit`, 'Wird beim Beenden installiert.'],
      error: ['Update-Fehler', u.error || ''],
    };
    const [title, sub] = map[u.status] || ['—', ''];
    const canCheck = u.status !== 'disabled' && u.status !== 'checking' && u.status !== 'downloading';
    const canInstall = u.status === 'ready';
    return `
      <div class="sys-panel">
        <div class="sys-section-head">
          <span class="sys-section-title">Version & Updates</span>
          <span class="sys-section-count">v${u.currentVersion}</span>
        </div>
        <div class="sys-update-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0">
          <div>
            <div class="sys-update-title" style="font-weight:600">${title}</div>
            <div class="sys-update-sub" style="opacity:.7;font-size:11px">${sub}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="sys-action secondary" id="sys-update-check" ${canCheck ? '' : 'disabled'}
              style="min-height:28px;padding:0 10px;font-size:9.5px">Auf Updates prüfen</button>
            ${canInstall ? `<button class="sys-action" id="sys-update-install"
              style="min-height:28px;padding:0 10px;font-size:9.5px">Jetzt neu starten</button>` : ''}
          </div>
        </div>
      </div>`;
  }
```

- [ ] **Step 2: Update-State beim Tab-Render mitladen und Panel einsetzen**

In `QB.renderSystem` den Ladevorgang ergänzen, sodass `_update` vor `renderUI` verfügbar ist. Ersetze den `try`-Block in `renderSystem`:

```js
    try {
      const [report] = await Promise.all([loadData(), loadUpdateState(false)]);
      _data = report;
      renderUI(wrap, _data);
    } catch (e) {
      console.error('system:get failed', e);
      wrap.innerHTML = '<div class="empty"><span>Systemdaten nicht verfügbar.</span></div>';
    }
```

In `renderUI` das Panel als erstes Element im äußeren Container einfügen — direkt nach `` wrap.innerHTML = ` `` und der öffnenden `<div class="${_animated ? '' : 'sys-stagger'}">` Zeile, also vor `<div class="sys-toolbar">`:

```js
        ${updatePanelHtml(_update)}
```

- [ ] **Step 3: Buttons binden**

Am Ende von `bindEvents(wrap)` ergänzen:

```js
    wrap.querySelector('#sys-update-check')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      await loadUpdateState(true);
      renderUI(wrap, _data);
    });

    wrap.querySelector('#sys-update-install')?.addEventListener('click', () => {
      void QB.ipc.invoke('update:quit-and-install');
    });
```

- [ ] **Step 4: Build + Dev-Smoke-Test**

Run: `npm run build && npm run dev`
Expected: System-Tab zeigt oben „Version & Updates" mit `v0.1.0` und Status „Entwicklungs-Build" (Dev = disabled); Button „Auf Updates prüfen" ist deaktiviert. Keine Konsolenfehler im DevTools. Beenden.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tabs/system.js
git commit -m "feat(system): Version & Update-Status im System-Tab"
```

---

### Task 7: GitHub Actions Release-Workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `README.md` (Release-Anleitung + SmartScreen-Hinweis)

**Interfaces:**
- Consumes: `dist/build/versionTag.js` (kompiliert aus Task 2) für den Tag-Check; `npm run build`, `electron-builder`.
- Produces: ein veröffentlichtes GitHub Release mit `*Setup*.exe`, `latest.yml`, `.blockmap` bei jedem `v*`-Tag.

- [ ] **Step 1: Workflow anlegen**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  release:
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Verify tag matches package.json version
        shell: bash
        env:
          GIT_TAG: ${{ github.ref_name }}
        run: |
          node -e "require('./dist/build/versionTag').assertTagMatches(process.env.GIT_TAG, require('./package.json').version)"

      - name: Build & publish installer
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx electron-builder --win --publish always
```

- [ ] **Step 2: README um Release-Prozess ergänzen**

Hänge in [README.md](README.md) einen Abschnitt an:

```markdown
## Release & Auto-Update

QuotaBar aktualisiert sich im installierten Build automatisch über GitHub Releases.

**Neuen Release veröffentlichen:**

```bash
npm version patch        # bumpt package.json + erstellt Tag vX.Y.Z
git push --follow-tags   # löst den Release-Workflow aus
```

Die GitHub Action baut den NSIS-Installer und veröffentlicht ihn samt
`latest.yml`. Installierte Clients prüfen beim Start und alle 6 Stunden, laden
ein Update still herunter und installieren es beim nächsten Beenden (oder sofort
über den Tray-Eintrag „Update bereit – jetzt neu starten").

**SmartScreen:** Die Builds sind nicht signiert. Beim ersten Start zeigt Windows
ggf. „Der Computer wurde durch Windows geschützt" → „Weitere Informationen" →
„Trotzdem ausführen".
```

- [ ] **Step 3: YAML-Syntax lokal prüfen**

Run: `node -e "require('js-yaml')" 2>/dev/null && echo has-yaml || echo "skip: js-yaml nicht vorhanden"`
Falls vorhanden: `npx --yes js-yaml .github/workflows/release.yml >/dev/null && echo "YAML ok"`
Expected: `YAML ok` oder übersprungen (GitHub validiert beim Push ebenfalls).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "ci: Release-Workflow für getaggte Builds + README"
```

- [ ] **Step 5: End-to-End-Release verifizieren (manuell)**

```bash
npm version patch
git push --follow-tags
```

Expected:
- GitHub Action „Release" läuft grün durch (Tag-Check besteht).
- Unter *Releases* erscheint ein neuer Eintrag mit `QuotaBar-Setup-<version>.exe`, `latest.yml`, `.blockmap`.
- Installer ausführen, App startet. Nach einem weiteren Release-Bump (höhere Version) erkennt die laufende Instanz das Update (Log: `Update <version> heruntergeladen`) und der Tray-Eintrag „Update bereit" erscheint.

---

## Self-Review

**Spec coverage:**
- A. Versions-Quelle & Tag-Auslöser → Task 2 (Abgleich), Task 7 (`npm version` + Workflow-Trigger). ✓
- B. electron-builder.yml (github publish, nsis-only) → Task 1. ✓
- C. updater.ts (isPackaged-Guard, autoDownload, autoInstallOnAppQuit, Start- + 6h-Check, Events, Logging, API) → Task 3 (State), Task 4 (Wiring). ✓
- D. Tray-Eintrag + System-Tab (Version, Status, „prüfen") → Task 5 (Tray), Task 6 (System-Tab). ✓
- E. GitHub Actions Workflow (windows-latest, npm ci/build/publish, GITHUB_TOKEN, non-draft) → Task 7. ✓
- Logger-Adapter auf bestehenden File-`log` statt electron-log → Task 4 Global Constraint umgesetzt. ✓
- Renderer-IIFE-Kapselung → Task 6 hält sich an die bestehende IIFE. ✓

**Placeholder scan:** Keine TODO/TBD; alle Code-Schritte mit vollständigem Code. ✓

**Type consistency:** `UpdateUiState`/`UpdateEvent` in Task 3 definiert, in Task 4/5 identisch verwendet; `initializeUpdater(opts?)` Signatur in Task 4 produziert, in Task 5 (main.ts) konsumiert; `setUpdateState` in Task 5 definiert und im selben Task verdrahtet; IPC-Kanäle (`update:get-state/check/quit-and-install`) in Task 4 registriert und in Task 6 konsumiert. ✓
