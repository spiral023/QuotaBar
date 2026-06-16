import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadBonusStateFile, saveBonusStateFile } from "../src/usage/bonusStateStore";
import { BONUS_STATE_VERSION } from "../src/usage/bonusReset";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-bonus-"));
  file = path.join(dir, "bonus-state.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadBonusStateFile", () => {
  it("liefert leeren State, wenn die Datei fehlt", async () => {
    const loaded = await loadBonusStateFile(file);
    expect(loaded).toEqual({ version: BONUS_STATE_VERSION, providers: {} });
  });

  it("migriert v1 → v2 und verwirft den (spike-anfälligen) Bonus-Marker", async () => {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      providers: {
        "claude:default_raven": {
          lastWeeklyPct: 18,
          lastWeeklyResetsAt: "2026-06-23T10:59:59.572228+00:00",
          bonusForResetsAt: "2026-06-23T11:00:00.026952+00:00",
        },
      },
    }));
    const loaded = await loadBonusStateFile(file);
    expect(loaded.version).toBe(BONUS_STATE_VERSION);
    const p = loaded.providers["claude:default_raven"];
    expect(p.bonusForResetsAt).toBeNull(); // Fehl-Marker entfernt
    expect(p.lastWeeklyPct).toBe(18);      // übriger State bleibt
    expect(p.lastFivePct).toBeNull();      // neues Feld initialisiert
  });

  it("behält Bonus-Marker einer bereits migrierten v2-Datei", async () => {
    const v2: any = {
      version: 2,
      providers: {
        "claude:max": {
          lastWeeklyPct: 1,
          lastWeeklyResetsAt: "2026-06-23T11:00:00Z",
          lastFivePct: 12,
          bonusForResetsAt: "2026-06-23T11:00:00Z",
        },
      },
    };
    await fs.writeFile(file, JSON.stringify(v2));
    const loaded = await loadBonusStateFile(file);
    expect(loaded.providers["claude:max"].bonusForResetsAt).toBe("2026-06-23T11:00:00Z");
    expect(loaded.providers["claude:max"].lastFivePct).toBe(12);
  });

  it("liefert leeren State bei unbekannter Version", async () => {
    await fs.writeFile(file, JSON.stringify({ version: 99, providers: {} }));
    expect(await loadBonusStateFile(file)).toEqual({ version: BONUS_STATE_VERSION, providers: {} });
  });

  it("round-trip: gespeicherter State wird unverändert geladen", async () => {
    const state = {
      version: BONUS_STATE_VERSION as typeof BONUS_STATE_VERSION,
      providers: {
        "codex:team": { lastWeeklyPct: 93, lastWeeklyResetsAt: "2026-06-18T01:34:24.000Z", lastFivePct: 1, bonusForResetsAt: null },
      },
    };
    await saveBonusStateFile(file, state);
    expect(await loadBonusStateFile(file)).toEqual(state);
  });
});
