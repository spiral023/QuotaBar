import { describe, it, expect } from "vitest";
import { makeFxLookup, FALLBACK_EURUSD } from "../src/pricing/fx-fetcher";

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
