import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBackfillDayRecords } from "../src/reports/backfill-reader";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-bfr-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("readBackfillDayRecords", () => {
  it("gibt [] zurück wenn Verzeichnis nicht existiert", async () => {
    const result = await readBackfillDayRecords(path.join(tmpDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("gibt [] zurück wenn Verzeichnis leer ist", async () => {
    const result = await readBackfillDayRecords(tmpDir);
    expect(result).toEqual([]);
  });
});
