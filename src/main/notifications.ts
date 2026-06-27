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
  /** Open or focus the dashboard on the Notifications tab. */
  openDashboard: () => void;
  /** Persist rules[ruleId].enabled = false and return the updated settings. */
  muteRule: (ruleId: string) => Promise<NotificationSettings>;
  /** Trigger an immediate app restart to apply a downloaded update. */
  installUpdate: () => void;
  /** Suppress the update-ready notification for a specific version. */
  dismissUpdate: (version: string) => void;
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

  sendUpdateReady(version: string): void {
    if (this.state.getDismissedUpdateVersion() === version) return;
    const withActions = this.actionHandlers != null;
    const notification = new Notification(
      process.platform === "win32"
        ? { toastXml: buildUpdateToastXml(version, withActions) }
        : {
            title: `QuotaBar ${version} ready to install`,
            body: "Restart now to apply the update.",
            ...(withActions
              ? { actions: [
                  { type: "button" as const, text: "Restart Now" },
                  { type: "button" as const, text: "Later" },
                ] }
              : {}),
          },
    );
    notification.on("click", () => this.actionHandlers?.installUpdate());
    notification.on("action", (details, legacyIndex) => {
      const fromDetails = (details as { actionIndex?: number } | undefined)?.actionIndex;
      const index = typeof fromDetails === "number" ? fromDetails : legacyIndex;
      if (index === 0) this.actionHandlers?.installUpdate();
      else if (index === 1) this.actionHandlers?.dismissUpdate(version);
    });
    notification.show();
  }

  dismissUpdateVersion(version: string): void {
    this.state.setDismissedUpdateVersion(version);
    this.savePersistedState();
  }

  sendTest(): void {
    const withActions = this.actionHandlers != null;
    const notification = new Notification(
      // On Windows, toast activation must use the quotabar:// protocol because
      // Windows starts a new process on click instead of invoking the running
      // instance's on('click')/on('action') handlers.
      process.platform === "win32"
        ? { toastXml: buildTestToastXml(withActions) }
        : {
            title: "QuotaBar",
            body: "Test notification - notifications are working.",
            ...(withActions ? { actions: [{ type: "button" as const, text: "Open" }] } : {}),
          },
    );
    // Fallback for macOS and cases where events still fire.
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
      // Newer Electron versions provide details.actionIndex; older versions pass
      // the index as the second argument.
      const fromDetails = (details as { actionIndex?: number } | undefined)?.actionIndex;
      const index = typeof fromDetails === "number" ? fromDetails : legacyIndex;
      if (index === 0) this.actionHandlers?.openDashboard();
      else if (index === 1) void this.muteRuleFromNotification(event.ruleId);
    });
    notification.show();
  }

  /**
   * Handles a quotabar:// activation from a Windows toast.
   * Called from the second-instance handler when the app is already running, or
   * from cold start with the protocol URL in process.argv.
   *   quotabar://open            -> open the dashboard
   *   quotabar://mute?rule=<id>  -> mute the rule without opening the dashboard
   */
  handleProtocolUrl(rawUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== "quotabar:") return;
    // For quotabar://open, "open" lands in hostname; defensively check pathname too.
    const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, "")).toLowerCase();
    if (action === "mute") {
      const ruleId = parsed.searchParams.get("rule");
      if (ruleId) void this.muteRuleFromNotification(ruleId);
      return;
    }
    if (action === "update-install") {
      this.actionHandlers?.installUpdate();
      return;
    }
    if (action === "update-dismiss") {
      const version = parsed.searchParams.get("v");
      if (version) this.actionHandlers?.dismissUpdate(version);
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
    // Make the action visible in history: rule ID only, no sensitive contents.
    const entry: NotificationEvent = {
      ruleId,
      provider: "",
      severity: "info",
      title: "Rule disabled",
      body: `Notification type "${ruleId}" was disabled from a notification.`,
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
        { type: "button" as const, text: "Open" },
        { type: "button" as const, text: "Mute" },
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
      `<action content="Open" activationType="protocol" arguments="quotabar://open"/>` +
      `<action content="Mute" activationType="protocol" arguments="${escapeXml(muteArg)}"/>` +
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
    ? `<actions><action content="Open" activationType="protocol" arguments="quotabar://open"/></actions>`
    : "";
  return (
    `<toast activationType="protocol" launch="quotabar://open">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>QuotaBar</text>` +
    `<text>Test notification - notifications are working.</text>` +
    `</binding></visual>` +
    actionsXml +
    `</toast>`
  );
}

export function buildUpdateToastXml(version: string, withActions = false): string {
  const versionXml = escapeXml(version);
  // Double-layer encoding: encodeURIComponent makes the version URL-safe (query value),
  // then escapeXml makes the whole URL safe as an XML attribute value.
  const dismissArg = escapeXml(`quotabar://update-dismiss?v=${encodeURIComponent(version)}`);
  const actionsXml = withActions
    ? `<actions>` +
      `<action content="Restart Now" activationType="protocol" arguments="quotabar://update-install"/>` +
      `<action content="Later" activationType="protocol" arguments="${dismissArg}"/>` +
      `</actions>`
    : "";
  return (
    `<toast activationType="protocol" launch="quotabar://open">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>QuotaBar ${versionXml} ready to install</text>` +
    `<text>Restart now to apply the update.</text>` +
    `</binding></visual>` +
    actionsXml +
    `</toast>`
  );
}

function getProviderLogoPath(provider: string): string | undefined {
  const logoFile = PROVIDER_LOGO_FILES[provider.toLowerCase()];
  if (!logoFile) return undefined;

  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, "logos", logoFile)] : []),
    path.resolve(__dirname, "..", "..", "logos", logoFile),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}
