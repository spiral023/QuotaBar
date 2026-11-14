/** Channels are shared by the bundled preload and the privileged receiver. */
export const invokeChannels = [
  "settings:get", "settings:save", "settings:test-proxy", "app:meta",
  "reports:get", "reports:get-batch", "analytics:summary", "analytics:get",
  "plans:get", "plans:save", "fx:status", "dataSources:get", "models:get",
  "windowBudget:get", "windowHistory:get", "system:get",
  "system:export-portable-data", "system:import-portable-data",
  "system:confirm-portable-import-restart", "system:codex-homes:suggest",
  "system:claude-roots:suggest", "shell:open-url", "system:open-path",
  "system:delete-app-data", "window:set-view", "notification:history",
  "notification:test", "notification:settings:save", "update:get-state",
  "update:check", "update:quit-and-install", "onboarding:agents",
] as const;
export const sendChannels = [
  "quota:ready", "quota:refresh", "quota:recompute-cost", "window:close",
  "window:toggle-pin", "onboarding:complete",
] as const;
export const eventChannels = ["quota:update", "quota:ready-ack", "window:pin-state", "ui:show-tab", "update:state"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === undefined || value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4096;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => boundedJson(item, depth + 1));
  return record(value) && Object.keys(value).length <= 100
    && Object.entries(value).every(([key, item]) => !["__proto__", "constructor", "prototype"].includes(key) && boundedJson(item, depth + 1));
}

const objectChannels = new Set([
  "settings:save", "settings:test-proxy", "notification:settings:save",
  "reports:get", "reports:get-batch", "analytics:get", "analytics:summary", "onboarding:complete",
]);
const optionalObjectChannels = new Set(["analytics:get", "analytics:summary"]);

/** Reject malformed or oversized input before any filesystem/network side effects. */
export function validIpcArguments(channel: string, args: unknown[]): boolean {
  if (args.length > 1) return false;
  if (objectChannels.has(channel)) {
    if (args.length === 0 || args[0] === undefined) return optionalObjectChannels.has(channel);
    if (!record(args[0]) || !boundedJson(args[0])) return false;
    if (channel === "onboarding:complete") return Object.keys(args[0]).every(key => key === "autostart") && typeof args[0].autostart === "boolean";
    if (channel === "analytics:summary") return args[0].costWindow === undefined || ["7d", "30d", "all"].includes(String(args[0].costWindow));
    if (channel === "analytics:get" || channel.startsWith("reports:")) {
      for (const key of ["since", "until"]) {
        const value = args[0][key];
        if (value !== undefined && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) return false;
      }
      for (const key of ["timezone", "timeZone"]) {
        const zone = args[0][key];
        if (zone !== undefined) {
          if (typeof zone !== "string") return false;
          try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { return false; }
        }
      }
    }
    return true;
  }
  if (channel === "plans:save") return Array.isArray(args[0]) && boundedJson(args[0]);
  if (channel === "system:delete-app-data") return Array.isArray(args[0]) && args[0].length <= 4 && args[0].every(group => ["cache", "logs", "state", "debug"].includes(group));
  if (channel === "window:set-view") return args[0] === "dashboard" || args[0] === "compact";
  if (channel === "shell:open-url" || channel === "system:open-path") return typeof args[0] === "string" && args[0].length > 0 && args[0].length <= 4096;
  return args.length === 0;
}
