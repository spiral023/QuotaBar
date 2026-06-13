import { describe, it, expect } from "vitest";
import { normalizeSettings, defaultSettings, type Settings } from "../src/config/settings";

describe("settings plans migration", () => {
  it("ergänzt plans: [] wenn nicht vorhanden", () => {
    const raw = { ...defaultSettings } as Partial<Settings>;
    delete (raw as Record<string, unknown>).plans;
    const s = normalizeSettings(raw as Settings);
    expect(Array.isArray(s.plans)).toBe(true);
    expect(s.plans).toHaveLength(0);
  });

  it("erfindet KEINE Pläne aus Legacy-subscriptionCosts", () => {
    const raw = { ...defaultSettings, subscriptionCosts: { claude: 100, codex: 20 } } as unknown as Settings;
    delete (raw as Record<string, unknown>).plans;
    const s = normalizeSettings(raw);
    expect(s.plans).toHaveLength(0);
  });

  it("normalisiert valide Pläne und verwirft kaputte Einträge", () => {
    const raw = { ...defaultSettings, plans: [
      { id: "a", provider: "claude", name: "Pro", amount: 20, currency: "USD", startsAt: "2026-01-01T00:00:00.000Z", endsAt: null },
      { id: "b", provider: "x", name: "", amount: -5, currency: "GBP", startsAt: "nope", endsAt: null },
    ] } as unknown as Settings;
    const s = normalizeSettings(raw);
    expect(s.plans).toHaveLength(1);
    expect(s.plans[0].id).toBe("a");
  });
});
