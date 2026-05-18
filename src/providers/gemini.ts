import fs from "node:fs/promises";
import path from "node:path";
import { getGeminiSettingsPath, getGeminiTmpDir } from "../config/paths";
import { UsageProvider, UsageSnapshot } from "./types";

export class GeminiProvider implements UsageProvider {
  id = "gemini";
  displayName = "Gemini";

  async isAvailable(): Promise<boolean> {
    try {
      await fs.access(getGeminiSettingsPath());
      return true;
    } catch {
      return false;
    }
  }

  async getAuthHint(): Promise<string | null> {
    return (await this.isAvailable()) ? null : "Gemini: local settings not found";
  }

  async fetchUsage(): Promise<UsageSnapshot> {
    const model = await readGeminiModel();
    const sessions = await countGeminiSessions();
    return {
      provider: "gemini",
      status: "ok",
      model,
      windows: [{
        name: "session",
        label: `${sessions} sessions${model ? ` (${model})` : ""}`
      }],
      updatedAt: new Date().toISOString()
    };
  }
}

async function readGeminiModel(): Promise<string | undefined> {
  try {
    const json = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8")) as { model?: { name?: unknown } };
    return typeof json.model?.name === "string" ? json.model.name : undefined;
  } catch {
    return undefined;
  }
}

async function countGeminiSessions(): Promise<number> {
  try {
    const entries = await fs.readdir(getGeminiTmpDir());
    return entries.filter((entry) => /^session-.*\.json$/i.test(path.basename(entry))).length;
  } catch {
    return 0;
  }
}
