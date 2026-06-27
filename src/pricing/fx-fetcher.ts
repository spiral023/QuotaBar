import fs from "node:fs/promises";
import path from "node:path";
import { getFxCachePath } from "../config/paths";
import { httpFetch } from "../main/httpClient";
import { log } from "../main/logging";
import { recordDataSourceStatus } from "../main/dataSourceStatus";

export type FxPair = "EURUSD";
export interface FxRate { value: number; estimated: boolean; }
export interface FxLookup { rate(pair: FxPair, day: string): FxRate; }

export const FALLBACK_EURUSD = 1.08;

// Reiner Lookup aus einer Tages-Map. Fehlende Tage: letzter vorheriger Kurs
// (estimated=true). Ganz leer: Fallback (estimated=true).
export function makeFxLookup(map: Record<string, number>, anyEstimated: boolean): FxLookup {
  const days = Object.keys(map).sort();
  return {
    rate(_pair, day) {
      const exact = map[day];
      if (exact !== undefined) return { value: exact, estimated: anyEstimated };
      let prev: string | undefined;
      for (const d of days) { if (d <= day) prev = d; else break; }
      if (prev !== undefined) return { value: map[prev], estimated: true };
      if (days.length > 0) return { value: map[days[0]], estimated: true };
      return { value: FALLBACK_EURUSD, estimated: true };
    },
  };
}

interface FxCache { EURUSD: Record<string, number>; }

export class FxFetcher {
  private cache: FxCache | null = null;
  private anyEstimated = false;

  constructor(
    private readonly offlineMode = false,
    private readonly cachePath: string = getFxCachePath(),
  ) {}

  // Stellt sicher, dass alle Handelstage in [minDay, maxDay] geladen/gecacht sind.
  async ensureRange(minDay: string, maxDay: string): Promise<void> {
    await this.load();
    const have = this.cache!.EURUSD;
    const latestDay = (): string | undefined => {
      const keys = Object.keys(have).sort();
      return keys.length > 0 ? keys[keys.length - 1] : undefined;
    };
    const detail = (): string => { const d = latestDay(); return d ? `latest rate ${d}` : "no cached rates"; };

    if (this.offlineMode) {
      this.anyEstimated = true;
      recordDataSourceStatus("fx", { ok: true, source: "offline", at: new Date().toISOString(), detail: detail() });
      return;
    }
    const needFetch = this.missingBusinessDay(have, minDay, maxDay);
    if (!needFetch) {
      recordDataSourceStatus("fx", { ok: true, source: "live", at: new Date().toISOString(), detail: detail() });
      return;
    }
    try {
      const url = `https://api.frankfurter.dev/v1/${minDay}..${maxDay}?base=EUR&symbols=USD`;
      const res = await httpFetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rates?: Record<string, { USD?: number }> };
      for (const [day, obj] of Object.entries(json.rates ?? {})) {
        if (typeof obj?.USD === "number") have[day] = obj.USD;
      }
      await this.save();
      if (recordDataSourceStatus("fx", { ok: true, source: "live", at: new Date().toISOString(), detail: detail() })) {
        log.info(`FX rates loaded (${detail()})`);
      }
    } catch (err) {
      this.anyEstimated = true; // Abruf fehlgeschlagen → vorhandene/Fallback-Kurse
      const msg = err instanceof Error ? err.message : String(err);
      if (recordDataSourceStatus("fx", { ok: false, source: "fallback", at: new Date().toISOString(), detail: detail(), error: msg })) {
        log.warn(`FX rates fetch failed, using cached/fallback (${detail()}): ${msg}`);
      }
    }
  }

  lookup(): FxLookup {
    return makeFxLookup(this.cache?.EURUSD ?? {}, this.anyEstimated || this.offlineMode);
  }

  exportRange(_pair: FxPair, minDay: string, maxDay: string): Record<string, number> {
    const src = this.cache?.EURUSD ?? {};
    const out: Record<string, number> = {};
    for (const [d, v] of Object.entries(src)) if (d >= minDay && d <= maxDay) out[d] = v;
    return out;
  }

  get estimated(): boolean { return this.anyEstimated || this.offlineMode; }

  private missingBusinessDay(have: Record<string, number>, minDay: string, maxDay: string): boolean {
    for (let d = new Date(`${minDay}T00:00:00Z`); d <= new Date(`${maxDay}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const key = d.toISOString().slice(0, 10);
      if (have[key] === undefined) return true;
    }
    return false;
  }

  private async load(): Promise<void> {
    if (this.cache) return;
    try {
      this.cache = JSON.parse(await fs.readFile(this.cachePath, "utf8")) as FxCache;
      if (!this.cache.EURUSD) this.cache.EURUSD = {};
    } catch {
      this.cache = { EURUSD: {} };
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(this.cache), "utf8");
  }
}

// Geteilte Instanz: ein FX-Owner für Main + Pricing-Engine.
export const sharedFxFetcher = new FxFetcher();
