"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const usageStore_1 = require("../src/usage/usageStore");
function snap(provider) {
    return {
        provider,
        status: "stale",
        windows: [{ name: "fiveHour", usedPercent: 12 }],
        updatedAt: "2026-05-26T10:00:00.000Z",
    };
}
(0, vitest_1.describe)("UsageStore", () => {
    (0, vitest_1.it)("can be initialized with cached snapshots", () => {
        const store = new usageStore_1.UsageStore([snap("codex"), snap("claude")]);
        (0, vitest_1.expect)(store.getAll().map((snapshot) => snapshot.provider)).toEqual(["claude", "codex"]);
        (0, vitest_1.expect)(store.get("claude")?.windows[0].usedPercent).toBe(12);
    });
});
