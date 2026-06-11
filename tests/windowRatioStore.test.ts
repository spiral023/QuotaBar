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
});
