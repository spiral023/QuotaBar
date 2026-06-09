import fs from "node:fs/promises";
import path from "node:path";

export interface BackfillManifest {
  version: 1;
  sources: Record<string, string>; // absoluter Pfad → "size:mtimeMs"
  lastRunAt: string;
}

const MANIFEST_FILE = "backfill-manifest.json";

export function emptyManifest(): BackfillManifest {
  return { version: 1, sources: {}, lastRunAt: new Date(0).toISOString() };
}

export async function loadManifest(logDir: string): Promise<BackfillManifest> {
  try {
    const raw = await fs.readFile(path.join(logDir, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<BackfillManifest>;
    if (parsed && parsed.version === 1 && parsed.sources && typeof parsed.sources === "object") {
      return { version: 1, sources: parsed.sources as Record<string, string>, lastRunAt: parsed.lastRunAt ?? new Date(0).toISOString() };
    }
  } catch {
    // missing or corrupt → empty
  }
  return emptyManifest();
}

export async function saveManifest(logDir: string, manifest: BackfillManifest): Promise<void> {
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path.join(logDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** "size:mtimeMs" for an existing file, or null if it cannot be stat'd. */
export async function fileSignature(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Partitions current source signatures into changed/new vs. unchanged. */
export function diffSources(
  previous: Record<string, string>,
  current: Record<string, string>,
): { changed: string[]; unchanged: string[] } {
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [file, sig] of Object.entries(current)) {
    if (previous[file] === sig) unchanged.push(file);
    else changed.push(file);
  }
  return { changed, unchanged };
}
