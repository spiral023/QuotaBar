'use strict';

// Shared range filter bar for History, Analytics and Models: period preset,
// local from/to dates, optional reload, resolution and provider segments.
// Each tab still owns its state and its second-row extras; this module only
// renders the common markup (identical classes, so CSS is unchanged) and binds
// the period controls. Requires shared/dates.js (QB.presetRange).
(function () {
  window.QB = window.QB || {};

  const PRESETS = [
    { id: '7d',    label: 'Last 7 days' },
    { id: '30d',   label: 'Last 30 days' },
    { id: 'week',  label: 'This week' },
    { id: 'month', label: 'This month' },
    { id: 'year',  label: 'This year' },
    { id: 'all',   label: 'All time' },
  ];

  const RESOLUTIONS = [
    { id: 'hourly',  label: 'Hr',  title: 'Hourly' },
    { id: 'daily',   label: 'Day', title: 'Daily' },
    { id: 'weekly',  label: 'Wk',  title: 'Weekly' },
    { id: 'monthly', label: 'Mo',  title: 'Monthly' },
  ];

  const CHEVRON = `<svg class="hr-select-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none"
               stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1.5 3 4 5.5 6.5 3"/>
          </svg>`;

  const RELOAD_ICON = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none"
               stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1.5 7a5.5 5.5 0 0 1 9.9-3.3"/>
            <path d="M12.5 7a5.5 5.5 0 0 1-9.9 3.3"/>
            <path d="M11 2.2 13 4l-2 1.8"/>
            <path d="M3 11.8 1 10l2-1.8"/>
          </svg>`;

  const attr = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  /**
   * First control row: preset select, from/to dates and an optional reload
   * button. Element ids are `${prefix}-preset`, `${prefix}-from`,
   * `${prefix}-to` and `${prefix}-load-btn`. `preset` null selects "Custom range".
   */
  function periodRowHtml({ prefix, preset, from, to, reload = false }) {
    const options = PRESETS.map((p) =>
      `<option value="${p.id}"${preset === p.id ? ' selected' : ''}>${p.label}</option>`).join('');
    return `
      <div class="hr-ctrl-row1">
        <div class="hr-select-wrap">
          <select class="hr-preset-select" id="${prefix}-preset" aria-label="Period" title="Select period">
            <option value="custom" hidden${preset ? '' : ' selected'}>Custom range</option>
            ${options}
          </select>
          ${CHEVRON}
        </div>
        <div class="hr-date-pair">
          <input class="hr-date-input" type="date" id="${prefix}-from" value="${attr(from)}" aria-label="From" title="Start date">
          <span class="hr-date-sep" aria-hidden="true">–</span>
          <input class="hr-date-input" type="date" id="${prefix}-to" value="${attr(to)}" aria-label="To" title="End date">
        </div>${reload ? `
        <button class="hr-reload" id="${prefix}-load-btn" title="Reload" aria-label="Reload">
          ${RELOAD_ICON}
        </button>` : ''}
      </div>`;
  }

  /** Resolution segment (`data-agg`); `extraClass` adds tab-specific styling. */
  function resolutionSegHtml({ id, active, extraClass = '' }) {
    const buttons = RESOLUTIONS.map((r) =>
      `<button class="hr-seg-btn${active === r.id ? ' active' : ''}" data-agg="${r.id}" title="${r.title}">${r.label}</button>`).join('');
    return `<div class="hr-seg${extraClass ? ` ${extraClass}` : ''}" id="${id}" role="group" aria-label="Resolution">${buttons}</div>`;
  }

  /** Provider segment (`data-prov`: all, claude, codex). */
  function providerSegHtml({ id, active }) {
    const btn = (prov, cls, label) =>
      `<button class="hr-seg-btn${cls}${active === prov ? ' active' : ''}" data-prov="${prov}">${label}</button>`;
    return `<div class="hr-seg" id="${id}" role="group" aria-label="Provider">`
      + btn('all', '', 'All')
      + btn('claude', ' hr-seg-claude', '<span class="hr-seg-dot"></span>Claude')
      + btn('codex', ' hr-seg-codex', '<span class="hr-seg-dot"></span>Codex')
      + '</div>';
  }

  /**
   * Binds the period row rendered by periodRowHtml. A preset choice fills both
   * dates; editing a date switches to "Custom range". `onChange` receives
   * `{ preset, from, to }` (preset null for a custom range).
   */
  function bindPeriod({ prefix, minDate, onChange }) {
    const select = document.getElementById(`${prefix}-preset`);
    const fromEl = () => document.getElementById(`${prefix}-from`);
    const toEl = () => document.getElementById(`${prefix}-to`);
    select?.addEventListener('change', () => {
      if (select.value === 'custom') return;
      const preset = select.value;
      const { from, to } = QB.presetRange(preset, minDate ? minDate() : null);
      const f = fromEl();
      const t = toEl();
      if (f) f.value = from;
      if (t) t.value = to;
      onChange({ preset, from, to });
    });
    [`${prefix}-from`, `${prefix}-to`].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => {
        if (select) select.value = 'custom';
        onChange({ preset: null, from: fromEl()?.value ?? '', to: toEl()?.value ?? '' });
      });
    });
  }

  QB.filterBar = { PRESETS, periodRowHtml, resolutionSegHtml, providerSegHtml, bindPeriod };
})();
