import fs from "node:fs/promises";
import path from "node:path";
import { emptyBonusStateFile, type BonusStateFile } from "./bonusReset";

export async function loadBonusStateFile(filePath: string): Promise<BonusStateFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isBonusStateFile(parsed)) return emptyBonusStateFile();
    return parsed;
  } catch {
    return emptyBonusStateFile();
  }
}

export async function saveBonusStateFile(filePath: string, file: BonusStateFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function isBonusStateFile(value: unknown): value is BonusStateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.version !== 1) return false;
  if (!r.providers || typeof r.providers !== "object" || Array.isArray(r.providers)) return false;
  return Object.values(r.providers as Record<string, unknown>).every((v) => {
    if (!v || typeof v !== "object") return false;
    const s = v as Record<string, unknown>;
    const isNullOrNumber = (x: unknown): boolean => x === null || typeof x === "number";
    const isNullOrString = (x: unknown): boolean => x === null || typeof x === "string";
    return isNullOrNumber(s.lastWeeklyPct)
      && isNullOrString(s.lastWeeklyResetsAt)
      && isNullOrString(s.bonusForResetsAt);
  });
}
