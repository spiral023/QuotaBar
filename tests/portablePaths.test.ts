import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAppConfigDir,
  getImportStagingDir,
  getPendingImportPath,
  getPortableEventsDir,
  getPortableIngestStatePath,
  getPortableMetadataPath,
  getPortableMigrationPath,
  getPortableQuotaDir,
  getPortableUsageDir,
} from "../src/config/paths";

describe("portable statistics paths", () => {
  const appConfigDir = getAppConfigDir();
  const portablePaths = [
    [getPortableUsageDir(), path.join(appConfigDir, "usage")],
    [getPortableEventsDir(), path.join(appConfigDir, "usage", "events")],
    [getPortableQuotaDir(), path.join(appConfigDir, "quota")],
    [getPortableMetadataPath(), path.join(appConfigDir, "usage", "store-metadata.json")],
    [getPortableIngestStatePath(), path.join(appConfigDir, "usage", "ingest-state.json")],
    [getPortableMigrationPath(), path.join(appConfigDir, "usage", "migration-state.json")],
    [getImportStagingDir(), path.join(appConfigDir, "import-staging")],
    [getPendingImportPath(), path.join(appConfigDir, "pending-import.json")],
  ] as const;

  it("returns every canonical portable path", () => {
    for (const [actual, expected] of portablePaths) {
      expect(actual).toBe(expected);
    }
  });

  it("keeps every canonical portable path below the QuotaBar config directory", () => {
    for (const [portablePath] of portablePaths) {
      const relativePath = path.relative(appConfigDir, portablePath);

      expect(path.isAbsolute(relativePath)).toBe(false);
      expect(relativePath).not.toBe("..");
      expect(relativePath.startsWith(`..${path.sep}`)).toBe(false);
    }
  });
});
