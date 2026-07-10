import { loadSettings, saveSettings, type Settings } from "../config/settings";

export interface SettingsPersistence {
  load(): Promise<Settings>;
  save(settings: Settings): Promise<void>;
}

const defaultPersistence: SettingsPersistence = {
  load: loadSettings,
  save: saveSettings,
};

export async function mergeAndSaveSettings(
  partial: Record<string, unknown>,
  onSaved?: (settings: Settings, changedKeys: string[]) => void,
  persistence: SettingsPersistence = defaultPersistence,
): Promise<Settings> {
  const current = await persistence.load();
  await persistence.save({ ...current, ...partial } as Settings);
  const saved = await persistence.load();
  onSaved?.(saved, Object.keys(partial));
  return saved;
}
