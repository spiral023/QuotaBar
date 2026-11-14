import path from "node:path";
import { pathToFileURL } from "node:url";
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { invokeChannels, sendChannels, validIpcArguments } from "../shared/ipcContract";
import { log } from "./logging";

type Role = "dashboard" | "onboarding";
const trusted = new WeakMap<WebContents, { role: Role; url: string }>();

export function hardenRendererWindow(window: BrowserWindow, filePath: string, role: Role): void {
  const contents = window.webContents;
  trusted.set(contents, { role, url: pathToFileURL(path.resolve(filePath)).href });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", event => event.preventDefault());
  contents.on("will-attach-webview", event => event.preventDefault());
}

export function isTrustedRenderer(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
  const owner = trusted.get(event.sender);
  const frame = event.senderFrame;
  return Boolean(owner && frame && frame === event.sender.mainFrame && frame.parent === null
    && frame.url === owner.url && event.sender.getURL() === owner.url
    && owner.role === (channel.startsWith("onboarding:") ? "onboarding" : "dashboard"));
}

/** Every privileged channel checks both the registered window and its main frame. */
export const rendererIpc = {
  handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
    if (!(invokeChannels as readonly string[]).includes(channel)) throw new Error("Unknown IPC handler");
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedRenderer(event, channel) || !validIpcArguments(channel, args)) throw new Error("IPC request rejected");
      return listener(event, ...args);
    });
  },
  on(channel: string, listener: Parameters<typeof ipcMain.on>[1]): void {
    if (!(sendChannels as readonly string[]).includes(channel)) throw new Error("Unknown IPC listener");
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (!isTrustedRenderer(event, channel) || !validIpcArguments(channel, args)) return;
      try {
        void Promise.resolve(listener(event, ...args)).catch(() => log.warn("Renderer IPC action failed"));
      } catch {
        log.warn("Renderer IPC action failed");
      }
    });
  },
};
