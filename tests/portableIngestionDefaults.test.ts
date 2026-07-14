import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  usageDir: "",
}));

vi.mock("../src/config/paths", () => ({
  getPortableUsageDir: () => mocks.usageDir,
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
import { PortableUsageStore } from "../src/portable/usageStore";

describe("portable ingestion production defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClaudeDirs.mockReturnValue([mocks.claudeDir]);
    mocks.getCodexDirs.mockReturnValue([mocks.codexDir]);
    mocks.listClaude.mockResolvedValue([{ file: mocks.claudeFile, baseDir: mocks.claudeDir }]);
    mocks.listCodex.mockResolvedValue([{ file: mocks.codexFile, baseDir: mocks.codexDir }]);
    mocks.readClaude.mockResolvedValue([]);
    mocks.readCodex.mockResolvedValue([]);
    mocks.usageDir = path.resolve("unused-usage");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses only canonical known directories when refs and overrides are absent", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-default-ingestion-"));
    const statePath = path.join(rootDir, "ingest-state.json");
    const store = {
      getIngestStatePath: () => statePath,
      recoverPending: vi.fn(async () => undefined),
      reconcileWithIngestState: vi.fn(async () => ({ inserted: 0, updated: 0, existing: 0 })),
    };
    try {
      await ingestPortableUsage({
        store,
        statePath,
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

  it("reuses the default store instance for the same canonical usage root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "quotabar-default-store-reuse-"));
    mocks.usageDir = rootDir;
    const recoveredBy: PortableUsageStore[] = [];
    vi.spyOn(PortableUsageStore.prototype, "recoverPending").mockImplementation(async function recoverPending() {
      recoveredBy.push(this);
    });
    try {
      await ingestPortableUsage({ claudeRefs: [], codexRefs: [] });
      await ingestPortableUsage({ claudeRefs: [], codexRefs: [] });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }

    expect(recoveredBy).toHaveLength(2);
    expect(new Set(recoveredBy).size).toBe(1);
  });
});
