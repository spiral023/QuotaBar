import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyProviderState, emptyRatioFile } from "../src/usage/windowRatio";
import { loadWindowRatioFile, saveWindowRatioFile } from "../src/usage/windowRatioStore";

describe("windowRatioStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "qb-ratio-"));
    file = path.join(dir, "sub", "window-ratio.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("Roundtrip: save → load liefert identische Daten", async () => {
    const data = emptyRatioFile();
    data.seededThrough = "2026-06-10";
    data.providers.claude = { ...emptyProviderState(), sumFivePct: 900, sumWeeklyPct: 300, pairCount: 42 };
    await saveWindowRatioFile(file, data);
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(data);
  });

  it("liefert leeren State bei fehlender Datei", async () => {
    const loaded = await loadWindowRatioFile(path.join(dir, "missing.json"));
    expect(loaded).toEqual(emptyRatioFile());
  });

  it("liefert leeren State bei defekter Datei", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ kaputt", "utf8");
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(emptyRatioFile());
  });

  it("liefert leeren State bei falscher Struktur", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 99, foo: true }), "utf8");
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(emptyRatioFile());
  });

  it("liefert leeren State bei v1-Datei (erzwingt Re-Seed bei Bestandsnutzern)", async () => {
    // A v1 file must be rejected so existing users are automatically re-seeded
    // with the new tier-keyed state on the next app start.
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, seededThrough: "2026-06-10", providers: {} }),
      "utf8",
    );
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(emptyRatioFile());
  });

  it("liefert leeren State bei v2-Datei (mit fehlerhaftem Rollover-Filter trainiert)", async () => {
    // v2 state was trained with a faulty rollover filter (microsecond jitter counted as
    // window change) and must be rejected so the seeder rebuilds a correct state.
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ version: 2, seededThrough: "2026-06-10", providers: {} }),
      "utf8",
    );
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(emptyRatioFile());
  });

  it("liefert leeren State bei ungültigem Provider-Eintrag (lastTs ist Zahl)", async () => {
    // Ensures the lastTs field in ProviderRatioState is validated as null|string.
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 3,
        seededThrough: null,
        providers: {
          claude: {
            sumFivePct: 100,
            sumWeeklyPct: 10,
            pairCount: 5,
            lastFive: null,
            lastWeekly: null,
            lastFiveResetsAt: null,
            lastPlanType: null,
            lastTs: 42,
          },
        },
      }),
      "utf8",
    );
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(emptyRatioFile());
  });

  it("liefert leeren State bei ungültigem Provider-Eintrag", async () => {
    // Tests the provider-field guard (sumFivePct type), not the version guard.
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 3,
        seededThrough: null,
        providers: { claude: { sumFivePct: "bad", sumWeeklyPct: 0, pairCount: 0 } },
      }),
      "utf8",
    );
    const loaded = await loadWindowRatioFile(file);
    expect(loaded).toEqual(emptyRatioFile());
  });
});
