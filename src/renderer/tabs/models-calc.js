// src/renderer/tabs/models-calc.js
// Pure Berechnungen für den Models-Tab. UMD: läuft im Renderer (QB.modelsCalc)
// und in vitest (module.exports). KEINE DOM- oder Chart.js-Abhängigkeiten.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.QB = root.QB || {}; root.QB.modelsCalc = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isoAddDays(iso, delta) {
    const dt = new Date(iso + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  }

  function windowDays(win) { return win === '30d' ? 30 : 90; }

  // win: '30d' | '90d' | 'all'; today: 'YYYY-MM-DD'
  function filterWindow(days, win, today) {
    if (win === 'all') return days.slice();
    const start = isoAddDays(today, -(windowDays(win) - 1));
    return days.filter((d) => d.date >= start && d.date <= today);
  }

  // Gleich langes Fenster unmittelbar davor (Spec: „Vorperiode").
  function previousWindow(days, win, today) {
    if (win === 'all') return [];
    const n = windowDays(win);
    const start = isoAddDays(today, -(2 * n - 1));
    const end = isoAddDays(today, -n);
    return days.filter((d) => d.date >= start && d.date <= end);
  }

  function metricOf(d, metric) {
    switch (metric) {
      case 'input':         return d.inputTokens;
      case 'output':        return d.outputTokens;
      case 'cacheRead':     return d.cacheReadTokens;
      case 'cacheCreation': return d.cacheCreationTokens;
      case 'cost':          return d.costUSD;
      default:              return d.totalTokens;
    }
  }

  // Identische Semantik wie isoWeekBucket in src/reports/reportService.ts.
  function isoWeek(iso) {
    const date = new Date(iso + 'T00:00:00Z');
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    const weekStr = String(week).padStart(2, '0');
    return date.getUTCFullYear() + '-W' + weekStr;
  }

  /**
   * Stellt Tages- oder Wochendaten für Stacked Bar Charts zusammen.
   * → { buckets: string[], series: [{ model, provider, values: number[] }], othersGrouped: string[] }
   * series enthält absolute Werte; die 100%-Normalisierung passiert beim Chart-Aufbau.
   * othersThreshold: Anteil am Gesamtwert des Fensters, unter dem ein Modell in „Andere" fällt (z.B. 0.01).
   */
  function buildStack(days, metric, granularity, othersThreshold) {
    const bucketOf = granularity === 'weekly' ? (d) => isoWeek(d.date) : (d) => d.date;
    const buckets = Array.from(new Set(days.map(bucketOf))).sort();
    const idx = new Map(buckets.map((b, i) => [b, i]));

    const perModel = new Map(); // model → { provider, values[] , sum }
    let grandTotal = 0;
    for (const d of days) {
      const v = metricOf(d, metric);
      grandTotal += v;
      let entry = perModel.get(d.model);
      if (!entry) {
        entry = { provider: d.provider, values: new Array(buckets.length).fill(0), sum: 0 };
        perModel.set(d.model, entry);
      }
      entry.values[idx.get(bucketOf(d))] += v;
      entry.sum += v;
    }

    const series = [];
    const othersGrouped = [];
    let others = null;
    for (const [model, e] of perModel) {
      if (grandTotal > 0 && e.sum / grandTotal < othersThreshold) {
        othersGrouped.push(model);
        if (!others) others = { model: 'Andere', provider: 'other', values: new Array(buckets.length).fill(0) };
        for (let i = 0; i < e.values.length; i++) others.values[i] += e.values[i];
      } else {
        series.push({ model, provider: e.provider, values: e.values });
      }
    }
    series.sort((a, b) => a.model.localeCompare(b.model));
    if (others) series.push(others);
    othersGrouped.sort();
    return { buckets, series, othersGrouped };
  }

  // Reihenfolge des ERSTEN Auftretens über die GESAMTE Historie — Basis für
  // stabile Farbzuordnung über Fenster-/Metrikwechsel hinweg.
  function modelColorOrder(allDays) {
    const first = new Map();
    for (const d of allDays) {
      const cur = first.get(d.model);
      if (!cur || d.date < cur) first.set(d.model, d.date);
    }
    return Array.from(first.entries())
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
      .map(([model]) => model);
  }

  return { isoAddDays, filterWindow, previousWindow, metricOf, isoWeek, buildStack, modelColorOrder };
});
