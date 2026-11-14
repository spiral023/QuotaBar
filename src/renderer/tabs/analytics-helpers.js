/* global QB */
'use strict';

(function () {
  const ACTIVITY_HEAT_LOW = [38, 66, 79];

  const ACTIVITY_HEAT_HIGH = [125, 220, 196];

  const KPI_TOOLTIPS = {
    'Active days': 'Number of days in the selected period with recorded activity, shown against all days in the period.',
    'Cache hit': 'Share of reusable prompt input served from cache. In All mode this is weighted by provider input volume.',
    'Avg session': 'Average tracked session length for the selected provider filter.',
    'Sessions': 'Total number of tracked sessions in the selected period.',
    'Ses/day': 'Average sessions per active day, excluding days without activity.',
    'Total hours': 'Total tracked active session time in the selected period.',
    'API cost': 'Estimated API-equivalent usage cost for the selected provider filter and period.',
    'ROI': 'API-equivalent factor: estimated API cost divided by subscription cost for the selected provider filter.',
    'Tokens': 'Input plus output tokens for the selected provider filter, excluding cache-read tokens.',
    '$/1k output': 'API cost divided by output tokens, normalized to 1,000 output tokens.',
    '$/hr (API)': 'Estimated API-equivalent cost divided by tracked active hours.',
    '$/hr (sub)': 'Subscription cost allocated across tracked active hours.',
    '$/session': 'Estimated API-equivalent cost divided by tracked sessions.',
    'Out tok/hr': 'Output tokens generated per tracked active hour.',
    'Tok/session': 'Input plus output tokens divided by tracked sessions.',
  };

  function _statTooltip(label) {
    return KPI_TOOLTIPS[label] || '';
  }

  function _activityHeatColor(t, boost = 0) {
    const v = Math.max(0, Math.min(1, t || 0));
    const r = Math.round(ACTIVITY_HEAT_LOW[0] + (ACTIVITY_HEAT_HIGH[0] - ACTIVITY_HEAT_LOW[0]) * v);
    const g = Math.round(ACTIVITY_HEAT_LOW[1] + (ACTIVITY_HEAT_HIGH[1] - ACTIVITY_HEAT_LOW[1]) * v);
    const b = Math.round(ACTIVITY_HEAT_LOW[2] + (ACTIVITY_HEAT_HIGH[2] - ACTIVITY_HEAT_LOW[2]) * v);
    const a = Math.min(1, 0.42 + 0.58 * v + boost);
    return `rgba(${r},${g},${b},${a})`;
  }

  function _cumulativeRoiSeries(buckets, costKey, subKey) {
    let cumCost = 0, cumSub = 0;
    return buckets.map(b => {
      cumCost += b[costKey] ?? 0;
      cumSub += b[subKey] ?? 0;
      return cumSub > 0 ? cumCost / cumSub : null;
    });
  }

  function _isoWeekStart(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (day - 1));
    return d.toISOString().slice(0, 10);
  }

  function _isoWeekNum(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
  }

  function _aggregateBuckets(daily, agg) {
    if (agg === 'daily') {
      return daily.map(b => ({
        date: b.date, days: 1,
        claudeUSD: b.claudeUSD || 0, codexUSD: b.codexUSD || 0,
        claudeSubUSD: b.claudeSubUSD || 0, codexSubUSD: b.codexSubUSD || 0,
      }));
    }
    const keyOf = agg === 'weekly'
      ? (b) => _isoWeekStart(b.date)
      : (b) => b.date.slice(0, 7) + '-01';
    const map = new Map();
    for (const b of daily) {
      const key = keyOf(b);
      let e = map.get(key);
      if (!e) { e = { date: key, days: 0, claudeUSD: 0, codexUSD: 0, claudeSubUSD: 0, codexSubUSD: 0 }; map.set(key, e); }
      e.claudeUSD += b.claudeUSD || 0;
      e.codexUSD += b.codexUSD || 0;
      e.claudeSubUSD += b.claudeSubUSD || 0;
      e.codexSubUSD += b.codexSubUSD || 0;
      e.days += 1;
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  function _bucketLabel(dateStr, agg) {
    if (agg === 'hourly') return dateStr.slice(11, 16); // "HH:00"
    const d = new Date(dateStr + 'T00:00:00Z');
    if (agg === 'monthly') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    if (agg === 'weekly') return 'W' + _isoWeekNum(dateStr);
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  }

  function _visibleLineDatasets(provider, datasets) {
    if (provider === 'claude') return datasets.filter(d => d.label === 'Claude');
    if (provider === 'codex') return datasets.filter(d => d.label === 'Codex');
    return datasets;
  }

  function _weekdayLabel(d) {
    const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return labels[d.day] ?? d.label;
  }

  QB.analyticsHelpers = { _statTooltip, _activityHeatColor, _cumulativeRoiSeries, _isoWeekStart, _isoWeekNum, _aggregateBuckets, _bucketLabel, _visibleLineDatasets, _weekdayLabel };
})();
