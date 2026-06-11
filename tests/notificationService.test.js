"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const notifications_1 = require("../src/main/notifications");
function event(provider, title) {
    return {
        ruleId: "highUsage",
        provider,
        windowName: "fiveHour",
        severity: "warning",
        title,
        body: "Das Kontingent hat 80 % überschritten.",
        firedAt: "2026-06-04T12:00:00.000Z",
        reason: "test",
    };
}
(0, vitest_1.describe)("buildNotificationOptions", () => {
    (0, vitest_1.it)("uses the provider-specific event title and Codex logo", () => {
        const options = (0, notifications_1.buildNotificationOptions)(event("codex", "Codex 5h: 82 % verbraucht"));
        (0, vitest_1.expect)(options.title).toBe("Codex 5h: 82 % verbraucht");
        (0, vitest_1.expect)(options.body).toBe("Das Kontingent hat 80 % überschritten.");
        (0, vitest_1.expect)(String(options.icon)).toBe(node_path_1.default.resolve("logos", "codex.png"));
    });
    (0, vitest_1.it)("uses the Claude logo for Claude events", () => {
        const options = (0, notifications_1.buildNotificationOptions)(event("claude", "Claude Woche: 97 % verbraucht"));
        (0, vitest_1.expect)(options.title).toBe("Claude Woche: 97 % verbraucht");
        (0, vitest_1.expect)(String(options.icon)).toBe(node_path_1.default.resolve("logos", "claude.png"));
    });
});
