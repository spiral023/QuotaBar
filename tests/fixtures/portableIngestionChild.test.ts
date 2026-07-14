import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeUsageEntriesFromFilesStrict, type SourceFileRef } from "../../src/pricing/jsonl-reader";
import { ingestPortableUsage } from "../../src/portable/ingestion";
import { PortableUsageStore } from "../../src/portable/usageStore";

const rootDir = process.env.QUOTABAR_INGEST_CHILD_ROOT;
const source = process.env.QUOTABAR_INGEST_CHILD_SOURCE;
const baseDir = process.env.QUOTABAR_INGEST_CHILD_BASE;
const childId = process.env.QUOTABAR_INGEST_CHILD_ID;

describe.runIf(Boolean(rootDir && source && baseDir && childId))("portable ingestion child fixture", () => {
  it("ingests after the parent barrier", async () => {
    const root = rootDir as string;
    const ref: SourceFileRef = { file: source as string, baseDir: baseDir as string };
    await writeFile(path.join(root, `ingest-ready-${childId}`), "ready", "utf8");
    const startAt = await waitForStart(path.join(root, "ingest-go"));
    while (Date.now() < startAt) await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await ingestPortableUsage({
      store: new PortableUsageStore(root),
      statePath: path.join(root, "ingest-state.json"),
      claudeRefs: [ref],
      codexRefs: [],
      readClaude: async (refs) => {
        await appendFile(path.join(root, "provider-read.log"), `${childId}\n`, "utf8");
        return readClaudeUsageEntriesFromFilesStrict(refs);
      },
    });
    expect(result.errors).toEqual([]);
  });
});

async function waitForStart(filePath: string): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(filePath, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for ingestion parent barrier");
}
