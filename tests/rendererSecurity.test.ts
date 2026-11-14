import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { validIpcArguments } from "../src/shared/ipcContract";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn(), warn: vi.fn() }));
vi.mock("../src/main/logging", () => ({ log: { warn: mocks.warn } }));
vi.mock("electron", () => ({ ipcMain: mocks }));
import { hardenRendererWindow, rendererIpc } from "../src/main/rendererSecurity";

function windowFixture(role: "dashboard" | "onboarding" = "dashboard") {
  const url = pathToFileURL(path.resolve(`src/renderer/${role === "dashboard" ? "index" : "onboarding"}.html`)).href;
  const frame = { parent: null, url };
  const contents = { mainFrame: frame, getURL: () => url, setWindowOpenHandler: vi.fn(), on: vi.fn() };
  const window = { webContents: contents } as unknown as BrowserWindow;
  hardenRendererWindow(window, path.resolve(`src/renderer/${role === "dashboard" ? "index" : "onboarding"}.html`), role);
  return { contents, frame, event: { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent };
}

beforeEach(() => vi.clearAllMocks());

describe("privileged renderer IPC", () => {
  it("accepts only the registered main frame and rejects foreign windows, URLs and roles", () => {
    const trusted = windowFixture();
    const listener = vi.fn(() => "ok");
    rendererIpc.handle("settings:get", listener);
    const handler = mocks.handle.mock.calls[0][1];
    expect(handler(trusted.event)).toBe("ok");
    expect(() => handler({})).toThrow("IPC request rejected");
    expect(() => handler(windowFixture("onboarding").event)).toThrow("IPC request rejected");
    expect(() => handler({ ...trusted.event, senderFrame: { ...trusted.frame } })).toThrow("IPC request rejected");
    trusted.frame.url = "https://example.com";
    expect(() => handler(trusted.event)).toThrow("IPC request rejected");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects malformed arguments before running a handler", () => {
    const { event } = windowFixture();
    const listener = vi.fn();
    rendererIpc.handle("settings:save", listener);
    const handler = mocks.handle.mock.calls[0][1];
    expect(() => handler(event, null)).toThrow("IPC request rejected");
    expect(() => handler(event, { nested: { value: "x".repeat(4097) } })).toThrow("IPC request rejected");
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores untrusted fire-and-forget messages and rejects unknown channels", () => {
    const listener = vi.fn();
    rendererIpc.on("quota:refresh", listener);
    mocks.on.mock.calls[0][1]({});
    expect(listener).not.toHaveBeenCalled();
    expect(() => rendererIpc.handle("arbitrary:channel", listener)).toThrow("Unknown IPC handler");
  });

  it("contains asynchronous send failures without exposing diagnostics", async () => {
    const { event } = windowFixture();
    rendererIpc.on("quota:refresh", async () => { throw new Error("private diagnostic"); });
    mocks.on.mock.calls[0][1](event);
    await Promise.resolve();
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("Renderer IPC action failed");
  });

  it("denies new windows, navigation and webviews", () => {
    const { contents } = windowFixture();
    expect(contents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
    for (const [, listener] of contents.on.mock.calls) {
      const preventDefault = vi.fn();
      listener({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });
});

describe("IPC payload validation", () => {
  it.each(["2026-02-30", "2026-99-99", "bad", 7])("rejects invalid dates: %s", since => {
    expect(validIpcArguments("analytics:get", [{ since }])).toBe(false);
  });
  it("rejects extra arguments, unsupported zones, invalid cleanup groups and prototype keys", () => {
    expect(validIpcArguments("settings:get", [1])).toBe(false);
    expect(validIpcArguments("analytics:get", [{ timeZone: "bad/zone" }])).toBe(false);
    expect(validIpcArguments("system:delete-app-data", [["everything"]])).toBe(false);
    expect(validIpcArguments("settings:save", [JSON.parse('{"__proto__":{}}')])).toBe(false);
    expect(validIpcArguments("analytics:get", [{ since: "2026-11-14", timeZone: "Europe/Vienna" }])).toBe(true);
  });
});
