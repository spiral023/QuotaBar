import fs from "node:fs/promises";
import { writeAppDataFile } from "../portable/appDataLock";
import {
  emptyWindowHistoryFile,
  type WindowHistoryEntry,
  type WindowHistoryFile,
} from "./windowHistory";

export async function loadWindowHistoryFile(filePath: string): Promise<WindowHistoryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isWindowHistoryFile(parsed)) return emptyWindowHistoryFile();
    return parsed;
  } catch {
    return emptyWindowHistoryFile();
  }
}

export async function saveWindowHistoryFile(filePath: string, file: WindowHistoryFile): Promise<void> {
  await writeAppDataFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Vereint persistierte mit frisch aus den Logs berechneten Einträgen. Schlüssel
 * ist `provider|weekEnd`. Frisch berechnete Einträge gewinnen (genauere Daten,
 * solange die Logs reichen); ältere bleiben erhalten, auch wenn ihre Logs
 * inzwischen gelöscht wurden. Ergebnis ist nach weekEnd sortiert.
 */
export function mergeWindowHistory(
  stored: WindowHistoryEntry[],
  computed: WindowHistoryEntry[],
): WindowHistoryEntry[] {
  const byKey = new Map<string, WindowHistoryEntry>();
  // Tagesgenauer Schlüssel: absorbiert Sekunden-/Minuten-Jitter im resetsAt;
  // zwei echte 7d-Perioden enden nie am selben Tag.
  const keyOf = (e: WindowHistoryEntry): string => `${e.provider}|${e.weekEnd.slice(0, 10)}`;
  for (const e of stored) byKey.set(keyOf(e), e);
  for (const e of computed) byKey.set(keyOf(e), e); // frisch überschreibt
  return Array.from(byKey.values()).sort((a, b) => a.weekEnd.localeCompare(b.weekEnd));
}

export function isWindowHistoryFile(value: unknown): value is WindowHistoryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  // v1 enthielt durch instabiles Codex-resetsAt erzeugte Pseudo-Perioden →
  // bewusst verwerfen, damit der Store sauber aus den Logs neu aufgebaut wird.
  if (r.version !== 2) return false;
  if (!Array.isArray(r.entries)) return false;
  return r.entries.every(isEntry);
}

function isEntry(value: unknown): value is WindowHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.provider === "string"
    && typeof e.weekStart === "string"
    && typeof e.weekEnd === "string"
    && typeof e.usedWindows === "number"
    && (e.maxWindows === null || typeof e.maxWindows === "number")
    && typeof e.bonus === "boolean";
}
