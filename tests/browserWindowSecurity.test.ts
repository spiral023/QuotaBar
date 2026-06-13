import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type BrowserWindowOptions = {
  webPreferences?: {
    nodeIntegration?: boolean;
    contextIsolation?: boolean;
    preload?: string;
  };
};

describe("BrowserWindow renderer security", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("electron");
    vi.doUnmock("../src/config/settings");
    vi.doUnmock("../src/config/firstRun");
    vi.doUnmock("../src/main/onboarding");
  });

  it("hardens the details window renderer and loads the compiled preload", async () => {
    const windows: BrowserWindowOptions[] = [];

    vi.doMock("electron", () => ({
      BrowserWindow: class {
        public webContents = { send: vi.fn() };
        constructor(options: BrowserWindowOptions) {
          windows.push(options);
        }
        loadFile = vi.fn().mockResolvedValue(undefined);
        once = vi.fn();
        on = vi.fn();
        isDestroyed = vi.fn(() => false);
        isVisible = vi.fn(() => true);
        show = vi.fn();
        focus = vi.fn();
        getSize = vi.fn(() => [900, 660]);
        setPosition = vi.fn();
      },
      ipcMain: { on: vi.fn(), handle: vi.fn() },
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      Tray: class {},
      clipboard: { writeText: vi.fn() },
      shell: { openPath: vi.fn() },
    }));
    vi.doMock("../src/config/settings", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/config/settings")>();
      return {
        ...actual,
        loadSettings: vi.fn().mockResolvedValue({ ...actual.DEFAULT_SETTINGS, viewMode: "dashboard", pinned: false }),
      };
    });

    const { DetailsWindowController } = await import("../src/main/detailsWindow");
    new DetailsWindowController(() => null).open(vi.fn());
    await vi.waitFor(() => expect(windows).toHaveLength(1));

    const prefs = windows[0].webPreferences;
    expect(prefs?.nodeIntegration).toBe(false);
    expect(prefs?.contextIsolation).toBe(true);
    expect(prefs?.preload).toBe(path.join(process.cwd(), "src", "main", "preload.js"));
  });

  it("hardens the onboarding window renderer and loads the compiled preload", async () => {
    const windows: BrowserWindowOptions[] = [];

    vi.doMock("electron", () => ({
      app: { setLoginItemSettings: vi.fn() },
      BrowserWindow: class {
        constructor(options: BrowserWindowOptions) {
          windows.push(options);
        }
        static fromWebContents = vi.fn();
        loadFile = vi.fn().mockResolvedValue(undefined);
        once = vi.fn();
        on = vi.fn();
        isDestroyed = vi.fn(() => false);
        show = vi.fn();
      },
      ipcMain: { on: vi.fn(), handle: vi.fn() },
    }));
    vi.doMock("../src/config/firstRun", () => ({ markFirstRunComplete: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock("../src/main/onboarding", () => ({
      defaultAgentProbes: vi.fn(() => []),
      detectAgents: vi.fn(),
    }));

    const { openOnboardingWindow } = await import("../src/main/onboardingWindow");
    openOnboardingWindow([]);

    const prefs = windows[0].webPreferences;
    expect(prefs?.nodeIntegration).toBe(false);
    expect(prefs?.contextIsolation).toBe(true);
    expect(prefs?.preload).toBe(path.join(process.cwd(), "src", "main", "preload.js"));
  });
});
