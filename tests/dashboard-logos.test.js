"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const vitest_1 = require("vitest");
const repoRoot = node_path_1.default.resolve(__dirname, "..");
function cssRule(content, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = content.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
    return match?.[1] ?? "";
}
(0, vitest_1.describe)("dashboard provider logos", () => {
    (0, vitest_1.it)("references the transparent provider logo assets", () => {
        const liveJs = node_fs_1.default.readFileSync(node_path_1.default.join(repoRoot, "src", "renderer", "tabs", "live.js"), "utf8");
        (0, vitest_1.expect)(liveJs).toContain("../../logos/claude.png");
        (0, vitest_1.expect)(liveJs).toContain("../../logos/codex.png");
    });
    (0, vitest_1.it)("includes the logo folder in packaged builds", () => {
        const builderConfig = node_fs_1.default.readFileSync(node_path_1.default.join(repoRoot, "electron-builder.yml"), "utf8");
        (0, vitest_1.expect)(builderConfig).toContain("logos/**");
    });
    (0, vitest_1.it)("keeps the Claude logo on a neutral background for contrast", () => {
        const html = node_fs_1.default.readFileSync(node_path_1.default.join(repoRoot, "src", "renderer", "index.html"), "utf8");
        const claudeRule = cssRule(html, ".prov-icon.icon-claude");
        (0, vitest_1.expect)(claudeRule).toContain("rgba(255,255,255");
        (0, vitest_1.expect)(claudeRule).not.toContain("#e07818");
        (0, vitest_1.expect)(claudeRule).not.toContain("#b85a10");
    });
});
