'use strict';

// Local calendar-day helpers shared by the range filters in History, Analytics
// and Models. Day keys are local dates on purpose: toISOString() uses UTC and
// would leave "today" out of every range between local midnight and the UTC
// offset.
(function () {
  window.QB = window.QB || {};

  // "All time" before the first usage day is known: 90 days including today,
  // the same inclusive counting as the 7d/30d presets.
  const ALL_FALLBACK_DAYS_BACK = 89;

  const pad = (n) => String(n).padStart(2, '0');

  function localDayKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Calendar arithmetic instead of `now - n * 864e5`, which drifts by an hour
  // across DST changes and can land on the wrong day near midnight.
  function localDayKeyDaysAgo(now, days) {
    return localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
  }

  function presetRange(preset, minDate, now) {
    const at = now instanceof Date ? now : new Date();
    const today = localDayKey(at);
    switch (preset) {
      case '7d':
        return { from: localDayKeyDaysAgo(at, 6), to: today };
      case '30d':
        return { from: localDayKeyDaysAgo(at, 29), to: today };
      case 'week': {
        const weekday = at.getDay();
        return { from: localDayKeyDaysAgo(at, weekday === 0 ? 6 : weekday - 1), to: today };
      }
      case 'month':
        return { from: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-01`, to: today };
      case 'year':
        return { from: `${at.getFullYear()}-01-01`, to: today };
      case 'all':
      default:
        return { from: minDate || localDayKeyDaysAgo(at, ALL_FALLBACK_DAYS_BACK), to: today };
    }
  }

  QB.localDayKey = localDayKey;
  QB.localDayKeyDaysAgo = localDayKeyDaysAgo;
  QB.presetRange = presetRange;
})();
