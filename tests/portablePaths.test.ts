import { describe, expect, it } from "vitest";
import {
  getPendingImportPath,
  getPortableEventsDir,
  getPortableMigrationPath,
  getPortableQuotaDir,
  getPortableUsageDir,
} from "../src/config/paths";

describe("portable statistics paths", () => {
  it("keeps portable store paths below the QuotaBar config directory", () => {
    const paths = [
      getPortableUsageDir(),
      getPortableEventsDir(),
      getPortableQuotaDir(),
      getPortableMigrationPath(),
      getPendingImportPath(),
    ];

    for (const portablePath of paths) {
      expect(portablePath).toContain(".quotabar-win");
    }
  });
});
