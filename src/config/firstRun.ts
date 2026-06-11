import fs from "node:fs/promises";
import { ensureConfigDir } from "../main/logging";
import { getInstalledMarkerPath } from "./paths";

/** True, solange der Installations-Marker noch nicht geschrieben wurde. */
export async function isFirstRun(): Promise<boolean> {
  try {
    await fs.access(getInstalledMarkerPath());
    return false;
  } catch {
    return true;
  }
}

export async function markFirstRunComplete(): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(getInstalledMarkerPath(), new Date().toISOString(), "utf8");
}
