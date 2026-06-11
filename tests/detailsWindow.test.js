"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
// Mock Electron — DetailsWindowController calls ipcMain.on and may use other
// Electron APIs at import/construction time. Provide just enough surface to
// allow construction without a running Electron runtime.
vitest_1.vi.mock("electron", () => {
    const ipcMain = {
        on: vitest_1.vi.fn(),
        handle: vitest_1.vi.fn(),
    };
    return {
        ipcMain,
        BrowserWindow: class {
        },
        screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
        Tray: class {
        },
        clipboard: { writeText: vitest_1.vi.fn() },
    };
});
const debugRecorder_1 = require("../src/main/debugRecorder");
const detailsWindow_1 = require("../src/main/detailsWindow");
let tmpDir;
(0, vitest_1.beforeEach)(async () => {
    tmpDir = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "qb-dw-"));
});
(0, vitest_1.afterEach)(async () => {
    await promises_1.default.rm(tmpDir, { recursive: true, force: true });
});
(0, vitest_1.describe)("DetailsWindowController dashboard.refreshRequested", () => {
    (0, vitest_1.it)("emits dashboard.refreshRequested before invoking the callback", async () => {
        const recorder = new debugRecorder_1.DebugRecorder({ enabled: true, logDir: tmpDir });
        const controller = new detailsWindow_1.DetailsWindowController(() => null, recorder);
        const callback = vitest_1.vi.fn();
        controller
            .handleDashboardRefresh(callback);
        await recorder.flush();
        (0, vitest_1.expect)(callback).toHaveBeenCalledOnce();
        const files = await promises_1.default.readdir(tmpDir);
        const content = await promises_1.default.readFile(node_path_1.default.join(tmpDir, files[0]), "utf8");
        const events = content.trim().split("\n").map((l) => JSON.parse(l));
        (0, vitest_1.expect)(events.some((e) => e.kind === "dashboard.refreshRequested")).toBe(true);
    });
});
