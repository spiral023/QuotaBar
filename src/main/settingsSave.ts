import { updateSettings, type Settings } from "../config/settings";

export interface SettingsPersistence {
  /** Atomic read-modify-write; aborts instead of overwriting an unreadable file. */
  update(change: (current: Settings) => Settings): Promise<Settings>;
}

const defaultPersistence: SettingsPersistence = {
  update: (change) => updateSettings(change),
};

export async function mergeAndSaveSettings(
  partial: Record<string, unknown>,
  onSaved?: (settings: Settings, changedKeys: string[]) => void,
  persistence: SettingsPersistence = defaultPersistence,
): Promise<Settings> {
  const saved = await persistence.update((current) => ({ ...current, ...partial } as Settings));
  onSaved?.(saved, Object.keys(partial));
  return saved;
}
