import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__QB_IPC_BRIDGE__", {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, fn: (payload: unknown) => void) => {
    ipcRenderer.on(channel, (_event, payload: unknown) => fn(payload));
  },
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
});
