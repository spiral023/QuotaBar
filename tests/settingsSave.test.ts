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
        update: async (change) => {
          stored = normalizeSettings(change(stored));
          return stored;
        },
      },
    );

    expect(result.providerOrder).toEqual(["codex", "claude"]);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith(result, ["providerOrder"]);
  });

  it("does not report a save when the update is rejected", async () => {
    const onSaved = vi.fn();

    await expect(mergeAndSaveSettings({ pinned: true }, onSaved, {
      update: async () => { throw new Error("Settings file is corrupt"); },
    })).rejects.toThrow("Settings file is corrupt");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
