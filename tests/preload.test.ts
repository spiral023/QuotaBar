import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: mocks, ipcRenderer: mocks }));
import "../src/main/preload";

const bridge = mocks.exposeInMainWorld.mock.calls[0][1] as {
  invoke(channel: string, ...args: unknown[]): unknown;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, fn: (payload: unknown) => void): () => void;
};

describe("preload allowlist", () => {
  it("blocks arbitrary channels and invalid payloads before reaching Electron", () => {
    expect(() => bridge.invoke("arbitrary:channel")).toThrow("IPC request rejected");
    expect(() => bridge.send("settings:save", {})).toThrow("IPC request rejected");
    expect(() => bridge.invoke("settings:save", null)).toThrow("IPC request rejected");
    expect(mocks.invoke).not.toHaveBeenCalled();
    bridge.invoke("settings:get");
    expect(mocks.invoke).toHaveBeenCalledWith("settings:get");
  });
  it("strips the Electron event and returns an unsubscribe function", () => {
    const callback = vi.fn();
    const unsubscribe = bridge.on("quota:update", callback);
    const listener = mocks.on.mock.calls[0][1];
    listener({ sender: "must not escape" }, { value: 1 });
    expect(callback).toHaveBeenCalledExactlyOnceWith({ value: 1 });
    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith("quota:update", listener);
    expect(() => bridge.on("arbitrary:event", callback)).toThrow("IPC request rejected");
  });
});
