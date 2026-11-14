import { contextBridge, ipcRenderer } from "electron";
import { invokeChannels, sendChannels, eventChannels, validIpcArguments } from "../shared/ipcContract";

function assertAllowed(channels: readonly string[], channel: string, args?: unknown[]): void {
  if (!channels.includes(channel) || (args && !validIpcArguments(channel, args))) throw new Error("IPC request rejected");
}

contextBridge.exposeInMainWorld("__QB_IPC_BRIDGE__", {
  invoke: (channel: string, ...args: unknown[]) => {
    assertAllowed(invokeChannels, channel, args);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, fn: (payload: unknown) => void) => {
    assertAllowed(eventChannels, channel);
    if (typeof fn !== "function") throw new Error("IPC listener rejected");
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  send: (channel: string, ...args: unknown[]) => {
    assertAllowed(sendChannels, channel, args);
    ipcRenderer.send(channel, ...args);
  },
});
