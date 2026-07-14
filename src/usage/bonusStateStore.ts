import fs from "node:fs/promises";
import { writeAppDataFile } from "../portable/appDataLock";
import {
  BONUS_STATE_VERSION,
  emptyBonusStateFile,
  type BonusProviderState,
  type BonusStateFile,
} from "./bonusReset";

export async function loadBonusStateFile(filePath: string): Promise<BonusStateFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return migrateBonusStateFile(parsed) ?? emptyBonusStateFile();
  } catch {
    return emptyBonusStateFile();
  }
}

export async function saveBonusStateFile(filePath: string, file: BonusStateFile): Promise<void> {
  await writeAppDataFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Validiert die Struktur und hebt Altversionen auf {@link BONUS_STATE_VERSION}.
 * v1 → v2: Bonus-Marker werden verworfen — sie wurden noch mit der
 * spike-anfälligen Erkennung gesetzt (vor dem utilization-Skalen-Fix) und sind
 * nicht mehr vertrauenswürdig. null = Datei unbrauchbar (→ leerer State).
 */
export function migrateBonusStateFile(value: unknown): BonusStateFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.version !== 1 && r.version !== 2) return null;
  if (!r.providers || typeof r.providers !== "object" || Array.isArray(r.providers)) return null;
  const entries = Object.entries(r.providers as Record<string, unknown>);
  if (!entries.every(([, v]) => isProviderState(v))) return null;

  const dropMarkers = r.version === 1;
  const providers: Record<string, BonusProviderState> = {};
  for (const [key, v] of entries) {
    const s = v as Record<string, unknown>;
    providers[key] = {
      lastWeeklyPct: typeof s.lastWeeklyPct === "number" ? s.lastWeeklyPct : null,
      lastWeeklyResetsAt: typeof s.lastWeeklyResetsAt === "string" ? s.lastWeeklyResetsAt : null,
      lastFivePct: typeof s.lastFivePct === "number" ? s.lastFivePct : null,
      bonusForResetsAt: dropMarkers || typeof s.bonusForResetsAt !== "string" ? null : s.bonusForResetsAt,
    };
  }
  return { version: BONUS_STATE_VERSION, providers };
}

function isProviderState(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  const isNullOrNumber = (x: unknown): boolean => x === null || typeof x === "number";
  const isNullOrString = (x: unknown): boolean => x === null || typeof x === "string";
  // lastFivePct kam erst mit v2 dazu; in v1-Dateien fehlt es (undefined zulässig).
  const isAbsentNullOrNumber = (x: unknown): boolean => x === undefined || isNullOrNumber(x);
  return isNullOrNumber(s.lastWeeklyPct)
    && isNullOrString(s.lastWeeklyResetsAt)
    && isAbsentNullOrNumber(s.lastFivePct)
    && isNullOrString(s.bonusForResetsAt);
}
