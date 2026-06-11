import fs from "node:fs/promises";
import path from "node:path";
import { emptyRatioFile, type ProviderRatioState, type WindowRatioFile } from "./windowRatio";

export async function loadWindowRatioFile(filePath: string): Promise<WindowRatioFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isWindowRatioFile(parsed)) return emptyRatioFile();
    return parsed;
  } catch {
    return emptyRatioFile();
  }
}

export async function saveWindowRatioFile(filePath: string, file: WindowRatioFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function isWindowRatioFile(value: unknown): value is WindowRatioFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  // v1-Dateien nutzten Provider-only-Keys; bewusst verwerfen (→ leerer State,
  // seededThrough null), damit der Seeder den Tier-keyed State neu aufbaut.
  if (r.version !== 2) return false;
  if (r.seededThrough !== null && typeof r.seededThrough !== "string") return false;
  if (!r.providers || typeof r.providers !== "object" || Array.isArray(r.providers)) return false;
  return Object.values(r.providers as Record<string, unknown>).every(isProviderState);
}

function isProviderState(value: unknown): value is ProviderRatioState {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const isNullOrNumber = (v: unknown): boolean => v === null || typeof v === "number";
  const isNullOrString = (v: unknown): boolean => v === null || typeof v === "string";
  return typeof r.sumFivePct === "number"
    && typeof r.sumWeeklyPct === "number"
    && typeof r.pairCount === "number"
    && isNullOrNumber(r.lastFive)
    && isNullOrNumber(r.lastWeekly)
    && isNullOrString(r.lastFiveResetsAt)
    && isNullOrString(r.lastPlanType)
    && isNullOrString(r.lastTs);
}
