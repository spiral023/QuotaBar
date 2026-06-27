import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeFxLookup, FALLBACK_EURUSD, FxFetcher } from "../src/pricing/fx-fetcher";

describe("makeFxLookup", () => {
  it("liefert exakten Tageskurs", () => {
    const fx = makeFxLookup({ "2026-03-10": 1.09, "2026-03-11": 1.10 }, false);
    expect(fx.rate("EURUSD", "2026-03-11")).toEqual({ value: 1.10, estimated: false });
  });

  it("forward-fill über EZB-Lücken (Wochenende)", () => {
    const fx = makeFxLookup({ "2026-03-13": 1.08 }, false); // Fr
    expect(fx.rate("EURUSD", "2026-03-14")).toEqual({ value: 1.08, estimated: true });
  });

  it("Fallback wenn Map leer", () => {
    const fx = makeFxLookup({}, true);
    expect(fx.rate("EURUSD", "2026-03-14")).toEqual({ value: FALLBACK_EURUSD, estimated: true });
  });
});

describe("FxFetcher", () => {
  it("checks business days by local day keys, not UTC rollover boundaries", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "qb-fx-"));
    const cachePath = path.join(tmp, "fx.json");
    try {
      await fs.writeFile(cachePath, JSON.stringify({ EURUSD: { "2026-03-06": 1.08 } }), "utf8");
      const fetcher = new FxFetcher(false, cachePath);

      await fetcher.ensureRange("2026-03-07", "2026-03-08");

      expect(fetcher.exportRange("EURUSD", "2026-03-06", "2026-03-08")).toEqual({ "2026-03-06": 1.08 });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
