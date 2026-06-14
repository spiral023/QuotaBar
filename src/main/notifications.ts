import { existsSync } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Notification } from "electron";
import type { NotificationConstructorOptions } from "electron";
import type { UsageSnapshot } from "../providers/types";
import type { NotificationSettings } from "../config/settings";
import { NotificationEngine, NotificationStateStore } from "./notificationEngine";
import type { NotificationEvent, PersistedNotificationState } from "./notificationEngine";
import { NotificationHistory } from "./notificationHistory";
import { NotificationLog } from "./notificationLog";
import { getNotificationStatePath } from "../config/paths";
import { localISOString, log } from "./logging";

export { NotificationEvent };

export interface NotificationActionHandlers {
  /** Dashboard-Fenster öffnen/fokussieren (Notifications-Tab). */
  openDashboard: () => void;
  /** Persistiert rules[ruleId].enabled = false und liefert die neuen Settings. */
  muteRule: (ruleId: string) => Promise<NotificationSettings>;
}

const PROVIDER_LOGO_FILES: Record<string, string> = {
  claude: "claude.png",
  codex: "codex.png",
};

export class NotificationService {
  private readonly engine  = new NotificationEngine();
  private readonly state   = new NotificationStateStore();
  readonly history         = new NotificationHistory();
  private readonly notifLog = new NotificationLog();

  private previous: UsageSnapshot[] = [];
  private settings: NotificationSettings;
  private actionHandlers: NotificationActionHandlers | null = null;

  constructor(settings: NotificationSettings) {
    this.settings = settings;
    this.loadPersistedState();
  }

  private loadPersistedState(): void {
    try {
      const raw = fsSync.readFileSync(getNotificationStatePath(), "utf8");
      const parsed = JSON.parse(raw) as PersistedNotificationState;
      this.state.loadPersisted(parsed);
    } catch {
      // File doesn't exist yet or corrupt — start fresh
    }
  }

  private savePersistedState(): void {
    try {
      fsSync.writeFileSync(getNotificationStatePath(), JSON.stringify(this.state.serialize()), "utf8");
    } catch {
      // Best-effort — never crash the app
    }
  }

  updateSettings(settings: NotificationSettings): void {
    this.settings = settings;
  }

  setActionHandlers(handlers: NotificationActionHandlers): void {
    this.actionHandlers = handlers;
  }

  onRefresh(snapshots: UsageSnapshot[]): void {
    const events = this.engine.evaluate({
      current: snapshots,
      previous: this.previous,
      settings: this.settings,
    }, this.state);

    this.previous = snapshots;

    for (const event of events) {
      this.notifLog.write(event);
      this.show(event);
    }

    if (events.length > 0) {
      this.history.add(events);
      this.savePersistedState();
    }
  }

  sendTest(): void {
    const withActions = this.actionHandlers != null;
    const notification = new Notification(
      // Auf Windows muss die Toast-Aktivierung über das quotabar://-Protokoll
      // laufen, weil Windows beim Klick einen neuen Prozess startet statt die
      // on('click')/on('action')-Handler der laufenden Instanz auszulösen.
      process.platform === "win32"
        ? { toastXml: buildTestToastXml(withActions) }
        : {
            title: "QuotaBar",
            body: "Testbenachrichtigung – Benachrichtigungen funktionieren.",
            ...(withActions ? { actions: [{ type: "button" as const, text: "Öffnen" }] } : {}),
          },
    );
    // Fallback für macOS bzw. Fälle, in denen die Events doch feuern.
    notification.on("click", () => this.actionHandlers?.openDashboard());
    notification.on("action", () => this.actionHandlers?.openDashboard());
    notification.show();
  }

  private show(event: NotificationEvent): void {
    const withActions = this.actionHandlers != null;
    const notification = new Notification(
      process.platform === "win32"
        ? { toastXml: buildToastXml(event, withActions) }
        : buildNotificationOptions(event, withActions),
    );
    notification.on("click", () => this.actionHandlers?.openDashboard());
    notification.on("action", (details, legacyIndex) => {
      // Neuere Electron-Versionen liefern details.actionIndex, ältere den Index als 2. Argument
      const fromDetails = (details as { actionIndex?: number } | undefined)?.actionIndex;
      const index = typeof fromDetails === "number" ? fromDetails : legacyIndex;
      if (index === 0) this.actionHandlers?.openDashboard();
      else if (index === 1) void this.muteRuleFromNotification(event.ruleId);
    });
    notification.show();
  }

  /**
   * Verarbeitet eine quotabar://-Aktivierung aus einer Windows-Toast.
   * Aufgerufen aus dem second-instance-Handler (App lief bereits) bzw. beim
   * Kaltstart mit der Protokoll-URL in process.argv.
   *   quotabar://open            → Dashboard öffnen
   *   quotabar://mute?rule=<id>  → Regel stummschalten (ohne Dashboard zu öffnen)
   */
  handleProtocolUrl(rawUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== "quotabar:") return;
    // Bei quotabar://open landet "open" im hostname; defensiv auch pathname prüfen.
    const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, "")).toLowerCase();
    if (action === "mute") {
      const ruleId = parsed.searchParams.get("rule");
      if (ruleId) void this.muteRuleFromNotification(ruleId);
      return;
    }
    this.actionHandlers?.openDashboard();
  }

  private async muteRuleFromNotification(ruleId: string): Promise<void> {
    if (!this.actionHandlers) return;
    try {
      this.settings = await this.actionHandlers.muteRule(ruleId);
    } catch (error) {
      log.warn(`Mute via notification failed for rule ${ruleId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // Aktion im Verlauf sichtbar machen — nur die Rule-ID, keine sensiblen Inhalte
    const entry: NotificationEvent = {
      ruleId,
      provider: "",
      severity: "info",
      title: "Regel deaktiviert",
      body: `Benachrichtigungstyp "${ruleId}" wurde über eine Benachrichtigung deaktiviert.`,
      firedAt: localISOString(new Date()),
      reason: "rule-muted",
    };
    this.notifLog.write(entry);
    this.history.add([entry]);
    log.info(`Notification rule ${ruleId} muted via toast action`);
  }
}

export function buildNotificationOptions(event: NotificationEvent, withActions = false): NotificationConstructorOptions {
  const icon = getProviderLogoPath(event.provider);
  return {
    title: event.title,
    body: event.body,
    ...(icon ? { icon } : {}),
    ...(withActions ? {
      actions: [
        { type: "button" as const, text: "Öffnen" },
        { type: "button" as const, text: "Stumm" },
      ],
    } : {}),
  };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );
}

/**
 * Baut das Windows-ToastGeneric-XML mit Protokoll-Aktivierung. Der Body-Klick
 * (launch) und beide Buttons aktivieren quotabar://-URLs, die Windows an die
 * (laufende) App weiterreicht – siehe NotificationService.handleProtocolUrl.
 */
export function buildToastXml(event: NotificationEvent, withActions = false): string {
  const icon = getProviderLogoPath(event.provider);
  const imageXml = icon
    ? `<image placement="appLogoOverride" src="${escapeXml(pathToFileURL(icon).href)}"/>`
    : "";
  const muteArg = `quotabar://mute?rule=${encodeURIComponent(event.ruleId)}`;
  const actionsXml = withActions
    ? `<actions>` +
      `<action content="Öffnen" activationType="protocol" arguments="quotabar://open"/>` +
      `<action content="Stumm" activationType="protocol" arguments="${escapeXml(muteArg)}"/>` +
      `</actions>`
    : "";
  return (
    `<toast activationType="protocol" launch="quotabar://open">` +
    `<visual><binding template="ToastGeneric">` +
    imageXml +
    `<text>${escapeXml(event.title)}</text>` +
    `<text>${escapeXml(event.body)}</text>` +
    `</binding></visual>` +
    actionsXml +
    `</toast>`
  );
}

export function buildTestToastXml(withActions = false): string {
  const actionsXml = withActions
    ? `<actions><action content="Öffnen" activationType="protocol" arguments="quotabar://open"/></actions>`
    : "";
  return (
    `<toast activationType="protocol" launch="quotabar://open">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>QuotaBar</text>` +
    `<text>Testbenachrichtigung – Benachrichtigungen funktionieren.</text>` +
    `</binding></visual>` +
    actionsXml +
    `</toast>`
  );
}

function getProviderLogoPath(provider: string): string | undefined {
  const logoFile = PROVIDER_LOGO_FILES[provider.toLowerCase()];
  if (!logoFile) return undefined;

  const logoPath = path.resolve(__dirname, "..", "..", "logos", logoFile);
  return existsSync(logoPath) ? logoPath : undefined;
}
