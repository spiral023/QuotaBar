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

  return { isoAddDays, filterWindow, previousWindow, metricOf, isoWeek };
});
