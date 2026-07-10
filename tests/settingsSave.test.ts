import { describe, expect, it, vi } from "vitest";
import { defaultSettings, normalizeSettings, type Settings } from "../src/config/settings";
import { mergeAndSaveSettings } from "../src/main/settingsSave";

describe("mergeAndSaveSettings", () => {
  it("returns normalized settings and reports changed keys after persistence", async () => {
    let stored: Settings = { ...defaultSettings };
    const onSaved = vi.fn();

    const result = await mergeAndSaveSettings(
      { providerOrder: ["codex", "invalid", "codex"] },
      onSaved,
      {
        load: async () => stored,
        save: async (settings) => { stored = normalizeSettings(settings); },
      },
    );

    expect(result.providerOrder).toEqual(["codex", "claude"]);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith(result, ["providerOrder"]);
  });
});
