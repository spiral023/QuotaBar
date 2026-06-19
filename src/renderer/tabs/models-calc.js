// src/renderer/tabs/models-calc.js
// Pure Berechnungen für den Models-Tab. UMD: läuft im Renderer (QB.modelsCalc)
// und in vitest (module.exports). KEINE DOM- oder Chart.js-Abhängigkeiten.
(function (root, factory) {
  'use strict';
  // In Electron renderer, both `module` and `window` are defined (nodeIntegration).
  // Only use CommonJS when window is truly absent (pure Node.js / vitest).
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = factory();
  } else {
    root.QB = root.QB || {};
    root.QB.modelsCalc = factory();
  }
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

  function aggregateByModel(days) {
    const map = new Map();
    for (const d of days) {
      let m = map.get(d.model);
      if (!m) {
        m = {
          model: d.model, provider: d.provider,
          inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
          cacheReadTokens: 0, totalTokens: 0, costUSD: 0,
          firstUsed: d.date, lastUsed: d.date,
        };
        map.set(d.model, m);
      }
      m.inputTokens += d.inputTokens;
      m.outputTokens += d.outputTokens;
      m.cacheCreationTokens += d.cacheCreationTokens;
      m.cacheReadTokens += d.cacheReadTokens;
      m.totalTokens += d.totalTokens;
      m.costUSD += d.costUSD;
      if (d.date < m.firstUsed) m.firstUsed = d.date;
      if (d.date > m.lastUsed) m.lastUsed = d.date;
    }
    return Array.from(map.values());
  }

  // null bei costUSD 0 (Modell ohne Pricing) oder 0 Tokens.
  function effPerMTokOf(costUSD, totalTokens) {
    return costUSD > 0 && totalTokens > 0 ? (costUSD / totalTokens) * 1e6 : null;
  }

  function computeKpis(days, prevDays, benchmarks) {
    const agg = aggregateByModel(days);
    const prevAgg = aggregateByModel(prevDays);
    const totalCost = agg.reduce((s, m) => s + m.costUSD, 0);
    const totalTokens = agg.reduce((s, m) => s + m.totalTokens, 0);
    const prevCost = prevAgg.reduce((s, m) => s + m.costUSD, 0);
    const prevTokens = prevAgg.reduce((s, m) => s + m.totalTokens, 0);

    const byCost = agg.slice().sort((a, b) => b.costUSD - a.costUSD);
    const byOutput = agg.slice().sort((a, b) => b.outputTokens - a.outputTokens);

    const effPerMTok = effPerMTokOf(totalCost, totalTokens);
    const prevEff = effPerMTokOf(prevCost, prevTokens);

    let bestValue = null;
    for (const m of agg) {
      const score = benchmarks[m.model];
      const eff = effPerMTokOf(m.costUSD, m.totalTokens);
      if (typeof score !== 'number' || !eff) continue;
      const value = score / eff;
      if (!bestValue || value > bestValue.scorePerDollar) {
        bestValue = { model: m.model, provider: m.provider, scorePerDollar: value };
      }
    }

    return {
      activeModels: agg.length,
      activeModelsDelta: prevDays.length > 0 ? agg.length - prevAgg.length : null,
      topCost: byCost[0]
        ? { model: byCost[0].model, provider: byCost[0].provider, costUSD: byCost[0].costUSD,
            sharePct: totalCost > 0 ? (byCost[0].costUSD / totalCost) * 100 : 0 }
        : null,
      topOutput: byOutput[0]
        ? { model: byOutput[0].model, provider: byOutput[0].provider, outputTokens: byOutput[0].outputTokens }
        : null,
      effPerMTok,
      effPerMTokDeltaPct: effPerMTok != null && prevEff ? ((effPerMTok - prevEff) / prevEff) * 100 : null,
      bestValue,
      top3SharePct: totalCost > 0
        ? (byCost.slice(0, 3).reduce((s, m) => s + m.costUSD, 0) / totalCost) * 100
        : 0,
    };
  }

  function tableRows(days, benchmarks) {
    const agg = aggregateByModel(days);
    const totalCost = agg.reduce((s, m) => s + m.costUSD, 0);
    return agg.map((m) => {
      const eff = effPerMTokOf(m.costUSD, m.totalTokens);
      const score = typeof benchmarks[m.model] === 'number' ? benchmarks[m.model] : null;
      const cacheBase = m.inputTokens + m.cacheReadTokens;
      return {
        ...m,
        effPerMTok: eff,
        score,
        scorePerDollar: score != null && eff ? score / eff : null,
        sharePct: totalCost > 0 ? (m.costUSD / totalCost) * 100 : 0,
        cacheHitRate: cacheBase > 0 ? m.cacheReadTokens / cacheBase : null,
      };
    }).sort((a, b) => b.costUSD - a.costUSD);
  }

  // Bubble-Radius: 4–18px, skaliert mit Wurzel des Kostenanteils.
  function scatterPoints(rows) {
    const candidates = rows
      .filter((r) => r.score != null && r.effPerMTok != null)
      .map((r) => ({
        model: r.model, provider: r.provider,
        x: r.effPerMTok, y: r.score,
        r: 4 + Math.sqrt(Math.max(r.sharePct, 0)) * 1.4,
        sharePct: r.sharePct,
      }));
    const costs = candidates.map((p) => p.x);
    const scores = candidates.map((p) => p.y);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    return candidates.map((p) => {
      const cheapness = 1 - normalizeRange(p.x, minCost, maxCost);
      const intelligence = normalizeRange(p.y, minScore, maxScore);
      const value = (cheapness + intelligence) / 2;
      return { ...p, valueScore: value, valueColor: valueColor(value) };
    });
  }

  function scatterBubbleColors(points, colorForProvider) {
    return {
      backgroundColor: points.map((p) => colorForProvider(p.provider) + 'CC'),
      borderColor: points.map((p) => colorForProvider(p.provider)),
    };
  }

  function scatterAxisColorScale(points) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minCost = Math.min(...xs);
    const maxCost = Math.max(...xs);
    const minScore = Math.min(...ys);
    const maxScore = Math.max(...ys);
    return {
      costColor: (value) => axisValueColor(1 - normalizeRange(Number(value), minCost, maxCost)),
      scoreColor: (value) => axisValueColor(normalizeRange(Number(value), minScore, maxScore)),
    };
  }

  function normalizeRange(value, min, max) {
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return 0.5;
    if (max <= min) return 0.5;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  function valueColor(value) {
    const v = Math.max(0, Math.min(1, value));
    if (v <= 0) return '#ff4b5c';
    if (v >= 1) return '#52d017';
    if (Math.abs(v - 0.5) < 1e-9) return '#ff9f1a';
    if (v < 0.5) return mixHex('#ff4b5c', '#ff9f1a', v / 0.5);
    return mixHex('#ff9f1a', '#52d017', (v - 0.5) / 0.5);
  }

  function axisValueColor(value) {
    const v = Math.max(0, Math.min(1, value));
    if (v <= 0) return '#ff4b5c';
    if (v >= 1) return '#52d017';
    if (Math.abs(v - 0.5) < 1e-9) return '#ffd21a';
    if (v < 0.5) return mixHex('#ff4b5c', '#ffd21a', v / 0.5);
    return mixHex('#ffd21a', '#52d017', (v - 0.5) / 0.5);
  }

  function mixHex(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    const ch = (from, to) => Math.round(from + (to - from) * t).toString(16).padStart(2, '0');
    return '#' + ch(ca[0], cb[0]) + ch(ca[1], cb[1]) + ch(ca[2], cb[2]);
  }

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  // Pro Modell: Monate mit Deckkraft relativ zum stärksten Monat.
  function adoptionTimeline(days) {
    const byModel = new Map();
    for (const d of days) {
      const month = d.date.slice(0, 7);
      let m = byModel.get(d.model);
      if (!m) { m = { provider: d.provider, months: new Map() }; byModel.set(d.model, m); }
      m.months.set(month, (m.months.get(month) || 0) + d.outputTokens);
    }
    return Array.from(byModel.entries()).map(([model, m]) => {
      const max = Math.max(...m.months.values());
      const months = Array.from(m.months.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, v]) => ({ month, intensity: max > 0 ? v / max : 0 }));
      return { model, provider: m.provider, first: months[0].month, last: months[months.length - 1].month, months };
    }).sort((a, b) => a.first.localeCompare(b.first) || a.model.localeCompare(b.model));
  }

  function cacheEfficiency(days, pricing) {
    return aggregateByModel(days)
      .filter((m) => pricing[m.model] && (m.inputTokens + m.cacheReadTokens) > 0)
      .map((m) => {
        const rate = pricing[m.model];
        return {
          model: m.model, provider: m.provider,
          hitRate: m.cacheReadTokens / (m.inputTokens + m.cacheReadTokens),
          savedUSD: (m.cacheReadTokens / 1e6) * Math.max(rate.inputPerMTok - rate.cacheReadPerMTok, 0),
        };
      })
      .sort((a, b) => b.savedUSD - a.savedUSD);
  }

  // Claude-Anteil je Bucket für das 3px-Ribbon unter dem Hero-Chart.
  function providerRibbon(days, metric, granularity) {
    const bucketOf = granularity === 'weekly' ? (d) => isoWeek(d.date) : (d) => d.date;
    const map = new Map();
    for (const d of days) {
      const b = bucketOf(d);
      const v = metricOf(d, metric);
      let e = map.get(b);
      if (!e) { e = { claude: 0, total: 0 }; map.set(b, e); }
      if (d.provider === 'claude') e.claude += v;
      e.total += v;
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, e]) => ({ bucket, claudeShare: e.total > 0 ? e.claude / e.total : 0 }));
  }

  function tokenTypeBreakdown(days) {
    let input = 0, output = 0, cacheRead = 0, cacheCreation = 0;
    for (const d of days) {
      input         += d.inputTokens;
      output        += d.outputTokens;
      cacheRead     += d.cacheReadTokens;
      cacheCreation += d.cacheCreationTokens;
    }
    const total = input + output + cacheRead + cacheCreation;
    const pct = (v) => total > 0 ? (v / total) * 100 : 0;
    return {
      input, output, cacheRead, cacheCreation, total,
      inputPct: pct(input), outputPct: pct(output),
      cacheReadPct: pct(cacheRead), cacheCreationPct: pct(cacheCreation),
    };
  }

  return { isoAddDays, filterWindow, previousWindow, metricOf, isoWeek, buildStack, modelColorOrder, aggregateByModel, computeKpis, tableRows, scatterPoints, scatterBubbleColors, scatterAxisColorScale, adoptionTimeline, cacheEfficiency, providerRibbon, tokenTypeBreakdown };
});
