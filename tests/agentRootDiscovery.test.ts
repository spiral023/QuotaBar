import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/config/settings";
import {
  agentRootsFromWslDiscovery,
  mergeSettingsWithAgentRoots,
} from "../src/main/agentRootDiscovery";

describe("agent root discovery runtime settings", () => {
  it("extracts runtime roots from WSL discovery suggestions", () => {
    const roots = agentRootsFromWslDiscovery({
      platform: "win32",
      available: true,
      hosts: ["\\\\wsl.localhost", "\\\\wsl$"],
      durationMs: 5,
      distros: ["Ubuntu"],
      claudeRoots: [{
        path: "\\\\wsl.localhost\\Ubuntu\\home\\asi\\.claude",
        label: "Ubuntu / asi / .claude",
        source: "wsl",
        hasCredentials: true,
        hasProjects: false,
      }],
      codexHomes: [{
        path: "\\\\wsl.localhost\\Ubuntu\\home\\asi\\.codex",
        label: "Ubuntu / asi",
        source: "wsl",
        hasAuth: true,
        hasSessions: true,
      }],
    });

    expect(roots).toEqual({
      claudeRoots: ["\\\\wsl.localhost\\Ubuntu\\home\\asi\\.claude"],
      codexHomes: ["\\\\wsl.localhost\\Ubuntu\\home\\asi\\.codex"],
    });
  });

  it("merges runtime roots after saved roots without duplicates or mutation", () => {
    const settings = {
      ...defaultSettings,
      claudeRoots: ["C:\\Users\\dev\\.claude"],
      codexHomes: ["C:\\Users\\dev\\.codex"],
    };
    const merged = mergeSettingsWithAgentRoots(settings, {
      claudeRoots: ["C:\\Users\\dev\\.claude", "\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude"],
      codexHomes: ["\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex", "C:\\Users\\dev\\.codex"],
    });

    expect(merged.claudeRoots).toEqual([
      "C:\\Users\\dev\\.claude",
      "\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude",
    ]);
    expect(merged.codexHomes).toEqual([
      "C:\\Users\\dev\\.codex",
      "\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex",
    ]);
    expect(settings.claudeRoots).toEqual(["C:\\Users\\dev\\.claude"]);
    expect(settings.codexHomes).toEqual(["C:\\Users\\dev\\.codex"]);
  });
});
