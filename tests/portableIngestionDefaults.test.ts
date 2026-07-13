import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claudeDir: "C:\\quotabar-known-claude-projects",
  codexDir: "C:\\quotabar-known-codex-sessions",
  claudeFile: "C:\\quotabar-known-claude-projects\\a.jsonl",
  codexFile: "C:\\quotabar-known-codex-sessions\\b.jsonl",
  getClaudeDirs: vi.fn(),
  getCodexDirs: vi.fn(),
  listClaude: vi.fn(),
  listCodex: vi.fn(),
  readClaude: vi.fn(),
  readCodex: vi.fn(),
}));

vi.mock("../src/config/paths", () => ({
  getPortableIngestStatePath: () => path.resolve("unused-ingest-state.json"),
  getPortableUsageDir: () => path.resolve("unused-usage"),
  getClaudeProjectsDirs: mocks.getClaudeDirs,
  getCodexSessionsDirs: mocks.getCodexDirs,
}));

vi.mock("../src/pricing/jsonl-reader", () => ({
  listClaudeSourceFilesStrict: mocks.listClaude,
  readClaudeUsageEntriesFromFilesStrict: mocks.readClaude,
}));

vi.mock("../src/pricing/codex-log-reader", () => ({
  listCodexSourceFilesStrict: mocks.listCodex,
  readCodexTokensFromFilesStrict: mocks.readCodex,
}));

import { ingestPortableUsage } from "../src/portable/ingestion";

describe("portable ingestion production defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClaudeDirs.mockReturnValue([mocks.claudeDir]);
    mocks.getCodexDirs.mockReturnValue([mocks.codexDir]);
    mocks.listClaude.mockResolvedValue([{ file: mocks.claudeFile, baseDir: mocks.claudeDir }]);
    mocks.listCodex.mockResolvedValue([{ file: mocks.codexFile, baseDir: mocks.codexDir }]);
    mocks.readClaude.mockResolvedValue([]);
    mocks.readCodex.mockResolvedValue([]);
  });

  it("uses only canonical known directories when refs and overrides are absent", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-default-ingestion-"));
    const store = {
      reconcileWithIngestState: vi.fn(async () => ({ inserted: 0, updated: 0, existing: 0 })),
    };
    try {
      await ingestPortableUsage({
        store,
        statePath: path.join(rootDir, "ingest-state.json"),
        statSource: async () => ({ isFile: true, size: "1", mtimeNs: "2", ctimeNs: "3" }),
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }

    expect(mocks.getClaudeDirs).toHaveBeenCalledOnce();
    expect(mocks.getCodexDirs).toHaveBeenCalledOnce();
    expect(mocks.listClaude).toHaveBeenCalledWith(mocks.claudeDir);
    expect(mocks.listCodex).toHaveBeenCalledWith(mocks.codexDir);
  });
});
