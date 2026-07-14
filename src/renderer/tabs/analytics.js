/* global QB, Chart */
'use strict';

window.QB = window.QB || {};

// IIFE-gekapselt, damit top-level let/const/function (z. B. _initialized,
// _minDate, PRESETS) nicht mit gleichnamigen Symbolen anderer Tab-Skripte im
// gemeinsamen globalen Scope kollidieren (sonst SyntaxError beim Laden des
// nachfolgenden history.js → QB.renderHistory bliebe undefiniert).
(function () {

let _lineChart    = null;
let _donutChart   = null;
let _sessionTimeChart = null;
let _initialized  = false;
let _minDate      = null;
let _activePreset = null;
let _from         = null;
let _to           = null;
let _lastData     = null;     // aktuell gerendertes AnalyticsData (für Chart-Toggles)
let _chartMode    = 'cost';   // 'cost' | 'roi'
let _provider     = 'all';    // globaler Provider-Toggle: 'all' | 'claude' | 'codex' — steuert ALLE provider-abhängigen Sektionen
let _agg          = 'daily';  // 'daily' | 'weekly' | 'monthly' | 'hourly'
let _hourlyBuckets = null;    // gecachte Stunden-Daten für den Linien-Chart
const _cache      = new Map(); // `${from}:${to}` → AnalyticsData
let _whChart      = null;      // Chart-Instanz der 5h-Fenster-Historie
let _whData       = null;      // { entries, planChanges } (zeitraum-unabhängig gecacht)
let _whMode       = 'util';    // 'util' | 'used' | 'max'
let _whGen        = 0;         // Race-Schutz für den asynchron geladenen Verlauf
let _hourClockResizeObserver = null;

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

// Wählt aus einem ProviderTriple ({claude, codex, all}) die Sicht des aktuellen
// globalen Toggles; fällt auf die "all"-Sicht bzw. den Fallback zurück.
function _pick(triple, fallback) {
  if (!triple) return fallback;
  const v = triple[_provider];
  return v !== undefined && v !== null ? v : (triple.all ?? fallback);
}

// Re-rendert alle provider-abhängigen Sektionen mit den zuletzt geladenen Daten.
function _applyProvider() {
  if (!_lastData) return;
  _buildLineChart(_lastData);
  _buildSessionTimeChart(_lastData);
  _buildStats(_lastData);
  _buildHourHeatmap(_lastData);
  _buildWeekdayBars(_lastData);
  _buildTopDays(_lastData);
  _buildFiveHourPressure(_lastData);
  _buildCostEfficiency(_lastData);
}

function _activityHeatColor(t, boost = 0) {
  const v = Math.max(0, Math.min(1, t || 0));
  const r = Math.round(ACTIVITY_HEAT_LOW[0] + (ACTIVITY_HEAT_HIGH[0] - ACTIVITY_HEAT_LOW[0]) * v);
  const g = Math.round(ACTIVITY_HEAT_LOW[1] + (ACTIVITY_HEAT_HIGH[1] - ACTIVITY_HEAT_LOW[1]) * v);
  const b = Math.round(ACTIVITY_HEAT_LOW[2] + (ACTIVITY_HEAT_HIGH[2] - ACTIVITY_HEAT_LOW[2]) * v);
  const a = Math.min(1, 0.42 + 0.58 * v + boost);
  return `rgba(${r},${g},${b},${a})`;
}

const PRESETS = [
  { id: '7d',    label: 'Last 7 days' },
  { id: '30d',   label: 'Last 30 days' },
  { id: 'week',  label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'year',  label: 'This year' },
  { id: 'all',   label: 'All time' },
];

const PRESET_LABELS = {
  '7d': '7 days', '30d': '30 days', week: 'this week',
  month: 'this month', year: 'this year', all: 'all time',
};

QB.renderAnalytics = async function renderAnalytics() {
  const container = document.getElementById('analytics-content');
  if (!container) return;

  if (!_initialized) {
    _initialized = true;
    _minDate = await _fetchMinDate();
    _buildControls(container);
    await _loadAndRender();
  } else if (!_cache.has(_rangeKey())) {
    // Cache wurde z. B. nach Settings-Save invalidiert → aktuellen Bereich neu laden.
    await _loadAndRender();
  }
};

QB.prefetchAnalytics = function prefetchAnalytics() {
  const { from, to } = _presetDates('30d');
  const key = `${from}:${to}`;
  if (_cache.has(key)) return;
  QB.ipc.invoke('analytics:get', { since: from, until: to, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    .then(data => { if (!QB.isPortableDataPreparing(data)) _cache.set(key, data); })
    .catch(e => console.error('analytics prefetch failed', e));
};

QB.clearAnalyticsCache = function clearAnalyticsCache() {
  QB.clearPortableDataRetry('analytics');
  QB.clearPortableDataRetry('window-history');
  _cache.clear();
  _hourlyBuckets = null;
  _whData = null; // Plan-/Settings-Änderung → Fenster-Historie neu laden
};

async function _fetchMinDate() {
  try {
    const report = await QB.ipc.invoke('reports:get', {
      type:      'daily',
      order:     'asc',
      timezone:  Intl.DateTimeFormat().resolvedOptions().timeZone,
      breakdown: false,
    });
    return report.rows?.[0]?.bucket ?? null;
  } catch {
    return null;
  }
}

function _presetDates(preset) {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const pad   = n => String(n).padStart(2, '0');

  switch (preset) {
    case '7d':
      return { from: new Date(now - 6  * 864e5).toISOString().slice(0, 10), to: today };
    case '30d':
      return { from: new Date(now - 29 * 864e5).toISOString().slice(0, 10), to: today };
    case 'week': {
      const d   = new Date(now);
      const day = d.getDay();
      d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
      return { from: d.toISOString().slice(0, 10), to: today };
    }
    case 'month':
      return { from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, to: today };
    case 'year':
      return { from: `${now.getFullYear()}-01-01`, to: today };
    case 'all':
    default: {
      const fallback = new Date(now - 90 * 864e5).toISOString().slice(0, 10);
      return { from: _minDate ?? fallback, to: today };
    }
  }
}

function _rangeKey() {
  return `${_from}:${_to}`;
}

function _winLabel() {
  if (_activePreset && PRESET_LABELS[_activePreset]) return PRESET_LABELS[_activePreset];
  if (_from && _to) {
    const days = Math.round((new Date(_to) - new Date(_from)) / 864e5) + 1;
    return `${days} days`;
  }
  return '';
}

function _buildControls(container) {
  const today     = new Date().toISOString().slice(0, 10);
  const ninetyAgo = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

  // Default-Zeitraum: letzte 30 Tage (wie bisher).
  if (_activePreset === null && _from === null) {
    _activePreset = '30d';
    const d = _presetDates('30d');
    _from = d.from;
    _to   = d.to;
  }

  const presetOptions = PRESETS.map(p =>
    `<option value="${p.id}"${_activePreset === p.id ? ' selected' : ''}>${p.label}</option>`
  ).join('');

  container.innerHTML = `
    <div class="hr-controls">
      <div class="hr-ctrl-row1">
        <div class="hr-select-wrap">
          <select class="hr-preset-select" id="an-preset" aria-label="Period" title="Select period">
            <option value="custom" hidden${_activePreset ? '' : ' selected'}>Custom range</option>
            ${presetOptions}
          </select>
          <svg class="hr-select-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none"
               stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1.5 3 4 5.5 6.5 3"/>
          </svg>
        </div>
        <div class="hr-date-pair">
          <input class="hr-date-input" type="date" id="an-from" value="${_from ?? ninetyAgo}" aria-label="From" title="Start date">
          <span class="hr-date-sep" aria-hidden="true">–</span>
          <input class="hr-date-input" type="date" id="an-to" value="${_to ?? today}" aria-label="To" title="End date">
        </div>
      </div>
      <div class="hr-ctrl-row2">
        <div class="hr-seg an-agg-seg" id="an-agg-pills" role="group" aria-label="Resolution">
          <button class="hr-seg-btn${_agg === 'hourly'  ? ' active' : ''}" data-agg="hourly"  title="Hourly">Hr</button>
          <button class="hr-seg-btn${_agg === 'daily'   ? ' active' : ''}" data-agg="daily"   title="Daily">Day</button>
          <button class="hr-seg-btn${_agg === 'weekly'  ? ' active' : ''}" data-agg="weekly"  title="Weekly">Wk</button>
          <button class="hr-seg-btn${_agg === 'monthly' ? ' active' : ''}" data-agg="monthly" title="Monthly">Mo</button>
        </div>
        <div class="hr-seg" id="an-provider-pills" role="group" aria-label="Provider">
          <button class="hr-seg-btn${_provider === 'all' ? ' active' : ''}" data-prov="all">All</button>
          <button class="hr-seg-btn hr-seg-claude${_provider === 'claude' ? ' active' : ''}" data-prov="claude"><span class="hr-seg-dot"></span>Claude</button>
          <button class="hr-seg-btn hr-seg-codex${_provider === 'codex' ? ' active' : ''}" data-prov="codex"><span class="hr-seg-dot"></span>Codex</button>
        </div>
      </div>
    </div>
    <div id="an-results"></div>
  `;

  const presetSelect = document.getElementById('an-preset');
  presetSelect?.addEventListener('change', () => {
    if (presetSelect.value === 'custom') return;
    _activePreset = presetSelect.value;
    const { from, to } = _presetDates(_activePreset);
    _from = from;
    _to   = to;
    document.getElementById('an-from').value = from;
    document.getElementById('an-to').value   = to;
    _loadAndRender();
  });

  ['an-from', 'an-to'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      _activePreset = null;
      if (presetSelect) presetSelect.value = 'custom';
      _from = document.getElementById('an-from').value;
      _to   = document.getElementById('an-to').value;
      _loadAndRender();
    });
  });

  // Auflösungs-Umschaltung: betrifft nur den Linien-Chart.
  container.querySelectorAll('#an-agg-pills .hr-seg-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('active')) return;
      container.querySelectorAll('#an-agg-pills .hr-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _agg = btn.dataset.agg;
      _updateLineTitle();
      if (_agg === 'hourly') await _ensureHourlyBuckets();
      if (_lastData) _buildLineChart(_lastData);
      if (_lastData) _buildSessionTimeChart(_lastData);
      // Auch die 5h-Fenster-Historie folgt der Auflösung (Woche ↔ Monat).
      _updateWhTitle();
      _buildWindowHistoryChart();
    });
  });

  // Globaler Provider-Toggle: steuert alle provider-abhängigen Sektionen.
  // Lebt in der persistenten Controls-Leiste (nicht im neu gerenderten Ergebnis),
  // daher Active-State manuell pflegen statt neu zu rendern.
  container.querySelectorAll('#an-provider-pills .hr-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      container.querySelectorAll('#an-provider-pills .hr-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _provider = btn.dataset.prov;
      _applyProvider();
    });
  });
}

async function _loadAndRender() {
  const results = document.getElementById('an-results');
  if (!results) return;

  results.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';

  try {
    const key = _rangeKey();
    let data = _cache.get(key);
    if (!data) {
      data = await QB.ipc.invoke('analytics:get', { since: _from, until: _to, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (QB.isPortableDataPreparing(data)) {
        _cache.delete(key);
        results.innerHTML = '<div class="empty"><span>Preparing data…</span></div>';
        QB.schedulePortableDataRetry('analytics', () => _loadAndRender());
        return;
      }
      QB.clearPortableDataRetry('analytics');
      _cache.set(key, data);
    }
    _hourlyBuckets = null; // Datumsbereich geändert → Stunden-Cache invalidieren
    if (_agg === 'hourly') await _ensureHourlyBuckets();
    _renderResults(data);
  } catch (e) {
    console.error('analytics:get failed', e);
    results.innerHTML = '<div class="empty"><span>Failed to load</span></div>';
  }
}

function _renderResults(data) {
  const results = document.getElementById('an-results');
  if (!results) return;

  const winLabel = _winLabel();

  results.innerHTML = `
    <div class="an-section">
      <div class="an-section-head">
        <span class="an-section-title" id="an-line-title">${_lineTitle()}</span>
        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
          <div class="mod-seg" id="an-ctype-pills">
            <button class="${_chartMode === 'cost' ? 'active' : ''}" data-ctype="cost">$</button>
            <button class="${_chartMode === 'roi'  ? 'active' : ''}" data-ctype="roi">ROI</button>
          </div>
          <div class="hr-chart-legend" id="an-line-legend">
            <span class="hr-legend-dot" style="background:var(--claude-col)"></span>
            <span class="hr-legend-dot" style="background:var(--codex-col)"></span>
          </div>
        </div>
      </div>
      <div class="an-chart-wrap"><canvas id="an-line-canvas"></canvas></div>
    </div>

    <div class="an-row2">
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">USAGE BREAKDOWN (${winLabel})</span></div>
        <div class="an-donut-wrap">
          <canvas id="an-donut-canvas"></canvas>
          <div class="an-donut-center" id="an-donut-center"></div>
        </div>
        <div class="an-legend" id="an-legend"></div>
      </div>
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">TOP MODELS BY COST (${winLabel})</span></div>
        <table class="top-models-table">
          <thead><tr><th>Model</th><th>Cost</th><th>%</th></tr></thead>
          <tbody id="an-top-models-body"></tbody>
        </table>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">ACTIVITY STATS (${winLabel})</span></div>
      <div class="an-stats-grid" id="an-stats-grid"></div>
    </div>

    <div class="an-section">
      <div class="an-section-head">
        <span class="an-section-title" id="an-session-time-title">${_sessionTimeTitle()}</span>
        <div class="hr-chart-legend" id="an-session-time-legend">
          <span class="hr-legend-dot" style="background:var(--claude-col)"></span>
          <span class="hr-legend-dot" style="background:var(--codex-col)"></span>
        </div>
      </div>
      <div class="an-wh-sub">Average session time is the average duration of measurable sessions in each bucket. A session duration is last recorded activity minus first recorded activity; sessions with only one activity entry are excluded because their length cannot be measured.</div>
      <div class="an-chart-wrap"><canvas id="an-session-time-canvas"></canvas></div>
    </div>

    <div class="an-row2">
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">HOUR HEATMAP (${winLabel})</span></div>
        <div id="an-hour-heatmap"></div>
      </div>
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">WEEKDAY (${winLabel})</span></div>
        <div id="an-weekday-bars"></div>
        <div class="an-section-head" style="margin-top:8px"><span class="an-section-title">TOP 5 DAYS</span></div>
        <div id="an-top-days"></div>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">5H WINDOW PRESSURE (${winLabel})</span></div>
      <div id="an-peak"></div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">COST EFFICIENCY</span></div>
      <div id="an-cost-eff"></div>
    </div>

    <div class="an-section">
      <div class="an-section-head">
        <span class="an-section-title" id="an-wh-title">${_whTitle()}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <div class="mod-seg" id="an-wh-pills">
            <button class="${_whMode === 'util' ? 'active' : ''}" data-whmode="util">%</button>
            <button class="${_whMode === 'used' ? 'active' : ''}" data-whmode="used">Cnt</button>
            <button class="${_whMode === 'max'  ? 'active' : ''}" data-whmode="max">Max</button>
          </div>
          <div class="hr-chart-legend">
            <span class="hr-legend-dot" style="background:var(--claude-col)"></span>
            <span class="hr-legend-dot" style="background:var(--codex-col)"></span>
          </div>
        </div>
      </div>
      <div class="an-wh-sub">5h windows used (≥5%) vs. possible windows per 7d window based on usage — shows whether the plan is being maxed out.</div>
      <div class="an-chart-wrap"><canvas id="an-wh-canvas"></canvas></div>
      <div id="an-wh-note" class="an-wh-empty" hidden></div>
    </div>
  `;

  _lastData = data;
  _buildLineChart(data);
  _bindLineToggles();
  _buildDonut(data);
  _buildTopModels(data);
  _buildStats(data);
  _buildSessionTimeChart(data);
  _buildHourHeatmap(data);
  _buildWeekdayBars(data);
  _buildTopDays(data);
  _buildFiveHourPressure(data);
  _buildCostEfficiency(data);
  void _renderWindowHistory();
}

function _lineTitle() {
  const winLabel = _winLabel();
  if (_chartMode === 'roi') {
    return `API EQUIVALENT FACTOR · RUNNING (${winLabel})`;
  }
  const per = _agg === 'monthly' ? 'AVG API COST/DAY · MONTH'
            : _agg === 'weekly'  ? 'AVG API COST/DAY · WEEK'
            : _agg === 'hourly'  ? 'API COST PER HOUR'
            : 'API COST PER DAY';
  return `${per} (${winLabel})`;
}

function _sessionTimeAgg() {
  return _agg === 'hourly' ? 'daily' : _agg;
}

function _sessionTimeTitle() {
  const unit = _sessionTimeAgg() === 'monthly' ? 'MONTH'
             : _sessionTimeAgg() === 'weekly' ? 'WEEK'
             : 'DAY';
  return `AVG SESSION TIME · ${unit} (${_winLabel()})`;
}

function _updateSessionTimeTitle() {
  const el = document.getElementById('an-session-time-title');
  if (el) el.textContent = _sessionTimeTitle();
}

// Laufender ("kumulativer") ROI je Anbieter: an jedem Tag das Verhältnis der bis
// dahin aufgelaufenen API-Kosten zu den bis dahin aufgelaufenen Abokosten (USD).
// Liefert null, solange keine Abo-Baseline existiert (kein Plan ⇒ Lücke).
function _cumulativeRoiSeries(buckets, costKey, subKey) {
  let cumCost = 0, cumSub = 0;
  return buckets.map(b => {
    cumCost += b[costKey] ?? 0;
    cumSub  += b[subKey]  ?? 0;
    return cumSub > 0 ? cumCost / cumSub : null;
  });
}

// ISO-Wochenanfang (Montag) als YYYY-MM-DD.
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

// Aggregiert Tages-Buckets zu Tag/Woche/Monat. Jeder Bucket trägt die
// aufsummierten USD-Werte sowie die Anzahl enthaltener Tage (days) – so lässt
// sich daraus sowohl der Tagesdurchschnitt (Kosten) als auch der laufende ROI
// (über die Summen) bilden.
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
    e.claudeUSD    += b.claudeUSD    || 0;
    e.codexUSD     += b.codexUSD     || 0;
    e.claudeSubUSD += b.claudeSubUSD || 0;
    e.codexSubUSD  += b.codexSubUSD  || 0;
    e.days += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function _bucketLabel(dateStr, agg) {
  if (agg === 'hourly') return dateStr.slice(11, 16); // "HH:00"
  const d = new Date(dateStr + 'T00:00:00Z');
  if (agg === 'monthly') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  if (agg === 'weekly')  return 'W' + _isoWeekNum(dateStr);
  return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

async function _ensureHourlyBuckets() {
  if (_hourlyBuckets !== null) return;
  try {
    const base = {
      type: 'hourly', limit: 168,
      since: _from || undefined, until: _to || undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      order: 'asc', breakdown: false,
    };
    const [cr, xr] = await Promise.all([
      QB.ipc.invoke('reports:get', { ...base, provider: 'claude' }),
      QB.ipc.invoke('reports:get', { ...base, provider: 'codex' }),
    ]);
    const cm = new Map((cr.rows || []).map(r => [r.bucket, r.costUSD || 0]));
    const xm = new Map((xr.rows || []).map(r => [r.bucket, r.costUSD || 0]));
    const all = new Set([...cm.keys(), ...xm.keys()]);
    _hourlyBuckets = Array.from(all).sort().map(b => ({
      date: b, days: 1, claudeUSD: cm.get(b) || 0, codexUSD: xm.get(b) || 0,
    }));
  } catch { _hourlyBuckets = []; }
}

function _buildLineChart(data) {
  if (_lineChart) { _lineChart.destroy(); _lineChart = null; }
  const ctx = document.getElementById('an-line-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const buckets = _agg === 'hourly'
    ? (_hourlyBuckets || [])
    : _aggregateBuckets(data.dailyBuckets || [], _agg);
  const labels  = buckets.map(b => _bucketLabel(b.date, _agg));

  const isRoi = _chartMode === 'roi';
  // Kosten: Ø $/Tag je Bucket (bei 'daily' == Tageswert). ROI: laufender
  // kumulativer Faktor über die aufsummierten Bucket-Werte.
  const claudeData = isRoi
    ? _cumulativeRoiSeries(buckets, 'claudeUSD', 'claudeSubUSD')
    : buckets.map(b => b.days > 0 ? b.claudeUSD / b.days : 0);
  const codexData = isRoi
    ? _cumulativeRoiSeries(buckets, 'codexUSD', 'codexSubUSD')
    : buckets.map(b => b.days > 0 ? b.codexUSD / b.days : 0);

  // Plan-Wechsel-Marker (nur Tages/Wochen/Monats-Modus).
  const dayKeys = buckets.map(b => b.date);
  const changes = _agg === 'hourly'
    ? []
    : QB.charts.mapChangesToIndex(data.planChanges || [], dayKeys);

  // "Kein Abo"-Hinweis (nur ROI): keine Abo-Baseline im sichtbaren Bereich.
  const totalSub = buckets.reduce((s, b) => s + (b.claudeSubUSD || 0) + (b.codexSubUSD || 0), 0);
  _renderNoPlanChip(isRoi && totalSub === 0);

  const datasets = [
    {
      label: 'Claude',
      data: claudeData,
      borderColor: '#DA785B',
      backgroundColor: 'rgba(218,120,91,0.08)',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
    {
      label: 'Codex',
      data: codexData,
      borderColor: '#4B55C8',
      backgroundColor: 'rgba(75,85,200,0.07)',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
  ];

  const visibleDatasets = _visibleLineDatasets(_provider, datasets);
  _renderLineLegend(visibleDatasets);

  _lineChart = QB.charts.createLine(ctx, labels, visibleDatasets, { yFormat: isRoi ? 'roi' : 'cost', planChanges: changes });
}

function _sessionDurationBucketsFor(data) {
  const buckets = data.sessionDurationBuckets || {};
  return buckets[_sessionTimeAgg()] || [];
}

function _buildSessionTimeChart(data) {
  if (_sessionTimeChart) { _sessionTimeChart.destroy(); _sessionTimeChart = null; }
  const ctx = document.getElementById('an-session-time-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const agg = _sessionTimeAgg();
  const buckets = _sessionDurationBucketsFor(data);
  const labels = buckets.map(b => _bucketLabel(b.date, agg));
  const datasets = [
    {
      label: 'Claude',
      data: buckets.map(b => b.claudeMinutes || 0),
      borderColor: '#DA785B',
      backgroundColor: 'rgba(218,120,91,0.08)',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
    {
      label: 'Codex',
      data: buckets.map(b => b.codexMinutes || 0),
      borderColor: '#4B55C8',
      backgroundColor: 'rgba(75,85,200,0.07)',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
  ];

  const visibleDatasets = _visibleLineDatasets(_provider, datasets);
  _renderSessionTimeLegend(visibleDatasets);
  _updateSessionTimeTitle();
  _sessionTimeChart = QB.charts.createLine(ctx, labels, visibleDatasets, { yFormat: 'minutes' });
}

function _visibleLineDatasets(provider, datasets) {
  if (provider === 'claude') return datasets.filter(d => d.label === 'Claude');
  if (provider === 'codex') return datasets.filter(d => d.label === 'Codex');
  return datasets;
}

function _renderLineLegend(datasets) {
  const legend = document.getElementById('an-line-legend');
  if (!legend) return;
  legend.innerHTML = datasets.map(d => (
    `<span class="hr-legend-dot" style="background:${QB.esc(d.borderColor)}"></span>`
  )).join('');
}

function _renderSessionTimeLegend(datasets) {
  const legend = document.getElementById('an-session-time-legend');
  if (!legend) return;
  legend.innerHTML = datasets.map(d => (
    `<span class="hr-legend-dot" style="background:${QB.esc(d.borderColor)}"></span>`
  )).join('');
}

// Zeigt/entfernt einen kleinen Hinweis-Chip über dem Linien-Chart, wenn im
// ROI-Modus keine Abo-Baseline hinterlegt ist. Klick navigiert zum Abos-Tab.
function _renderNoPlanChip(show) {
  const existing = document.getElementById('an-noplan-chip');
  if (!show) { existing?.remove(); return; }
  if (existing) return;

  const wrap = document.querySelector('.an-chart-wrap');
  if (!wrap) return;

  const chip = document.createElement('div');
  chip.id = 'an-noplan-chip';
  chip.className = 'an-noplan-chip';
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.textContent = "No subscription set up — configure in the Subscriptions tab";
  const go = () => document.getElementById('tab-plans')?.click();
  chip.addEventListener('click', go);
  chip.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  wrap.parentNode.insertBefore(chip, wrap);
}

function _bindLineToggles() {
  document.querySelectorAll('#an-ctype-pills button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('#an-ctype-pills button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _chartMode = btn.dataset.ctype;
      _updateLineTitle();
      if (_lastData) _buildLineChart(_lastData);
    });
  });
}

function _updateLineTitle() {
  const el = document.getElementById('an-line-title');
  if (el) el.textContent = _lineTitle();
}

function _buildDonut(data) {
  if (_donutChart) { _donutChart.destroy(); _donutChart = null; }
  const ctx = document.getElementById('an-donut-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const claudeCost = data.apiCostUSD?.claude ?? 0;
  const codexCost  = data.apiCostUSD?.codex  ?? 0;
  const total      = claudeCost + codexCost;

  const chartData   = total > 0 ? [claudeCost, codexCost] : [1, 1];
  const chartColors = ['#DA785B', '#4B55C8'];
  const labels      = ['Claude', 'Codex'];

  _donutChart = QB.charts.createDoughnut(ctx, labels, chartData, chartColors, { empty: total <= 0 });

  const roi    = data.roiFactor?.combined ?? 0;
  const center = document.getElementById('an-donut-center');
  if (center) {
    center.innerHTML = `
      <div class="an-donut-center-val" style="color:${QB.roiColor(roi)}">${roi.toFixed(1)}×</div>
      <div class="an-donut-center-lbl">ROI</div>
    `;
  }

  const legend = document.getElementById('an-legend');
  if (legend && total > 0) {
    legend.innerHTML = [
      { label: 'Claude', cost: claudeCost, color: '#DA785B' },
      { label: 'Codex',  cost: codexCost,  color: '#4B55C8' },
    ].map(p => `
      <div class="an-legend-row">
        <span class="an-legend-dot" style="background:${p.color}"></span>
        <span>${QB.esc(p.label)}</span>
        <span class="an-legend-pct">$${p.cost.toFixed(2)} · ${total > 0 ? ((p.cost/total)*100).toFixed(0) : 0}%</span>
      </div>
    `).join('');
  }
}

function _buildTopModels(data) {
  const tbody = document.getElementById('an-top-models-body');
  if (!tbody) return;
  if (!data.topModels?.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--t400);text-align:center;padding:8px">No data</td></tr>';
    return;
  }
  tbody.innerHTML = data.topModels.map(m => `
    <tr>
      <td class="model-name" title="${QB.esc(m.model)}">${QB.esc(QB.shortModelName(m.model))}</td>
      <td>$${(m.costUSD).toFixed(2)}</td>
      <td>${(m.pctOfTotal * 100).toFixed(0)}%</td>
    </tr>
  `).join('');
}

function _buildStats(data) {
  const grid = document.getElementById('an-stats-grid');
  if (!grid) return;

  const claudeTok = data.totalTokens?.claude ?? {};
  const codexTok  = data.totalTokens?.codex  ?? {};
  const claudeCacheDen = (claudeTok.input ?? 0) + (claudeTok.cacheRead ?? 0);
  const codexCacheDen  = (codexTok.input ?? 0) + (codexTok.cached ?? 0);

  // Cache-Hit folgt dem Provider-Toggle: einzeln pro Anbieter, bei "all"
  // volumengewichteter Mittelwert (wie bisher).
  let cacheRate;
  if (_provider === 'claude')      cacheRate = data.cacheHitRate?.claude ?? 0;
  else if (_provider === 'codex')  cacheRate = data.cacheHitRate?.codex ?? 0;
  else {
    const den = claudeCacheDen + codexCacheDen;
    cacheRate = den > 0
      ? (((data.cacheHitRate?.claude ?? 0) * claudeCacheDen) + ((data.cacheHitRate?.codex ?? 0) * codexCacheDen)) / den
      : 0;
  }

  // API-Kosten, ROI und Token folgen ebenfalls dem Toggle.
  const apiCost = _provider === 'all'
    ? (data.apiCostUSD?.total ?? 0)
    : (data.apiCostUSD?.[_provider] ?? 0);
  const roi = _provider === 'all'
    ? (data.roiFactor?.combined ?? 0)
    : (data.roiFactor?.[_provider] ?? 0);
  const tokensFor = (t) => (t?.input ?? 0) + (t?.output ?? 0);
  const tokens = _provider === 'claude' ? tokensFor(claudeTok)
               : _provider === 'codex'  ? tokensFor(codexTok)
               : tokensFor(claudeTok) + tokensFor(codexTok);

  const sessions = _pick(data.sessionStats, {});

  const tiles = [
    { lbl: 'Active days',      val: `${data.activeDays ?? 0}/${data.windowDays ?? 30}` },
    { lbl: 'Cache hit',        val: `${(cacheRate * 100).toFixed(1)}%` },
    { lbl: 'Avg session',      val: `${sessions.avgMinutes ?? 0} min` },
    { lbl: 'Sessions',         val: `${sessions.count ?? 0}` },
    { lbl: 'Ses/day',          val: `${sessions.sessionsPerActiveDay ?? 0}` },
    { lbl: 'Total hours',      val: `${sessions.totalHours ?? 0} h` },
    { lbl: 'API cost',         val: `$${apiCost.toFixed(0)}`,   color: 'var(--t100)' },
    { lbl: 'ROI',              val: `${roi.toFixed(1)}×`,       color: QB.roiColor(roi) },
    { lbl: 'Tokens',           val: QB.fmtTokens(tokens) },
  ];

  grid.innerHTML = tiles.map(_statTileHtml).join('');
  _bindAnalyticsStatTooltips(grid);
}

function _statTileHtml(t) {
  const tip = _statTooltip(t.lbl);
  const tipAttrs = tip
    ? ` tabindex="0" aria-label="${QB.esc(`${t.lbl}: ${tip}`)}" data-an-tip="${QB.esc(tip)}"`
    : '';
  return `
    <div class="an-stat-tile${tip ? ' an-stat-tip' : ''}"${tipAttrs}>
      <div class="an-stat-lbl">${QB.esc(t.lbl)}</div>
      <div class="an-stat-val" style="${t.color ? `color:${t.color}` : ''}">${QB.esc(String(t.val))}</div>
    </div>
  `;
}

function _ensureAnalyticsTooltipEl() {
  let tip = document.getElementById('an-kpi-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'an-kpi-tooltip';
    tip.className = 'hr-kpi-tok-tip an-kpi-tooltip';
    document.body.appendChild(tip);
  }
  return tip;
}

function _showAnalyticsTooltip(tip, anchor) {
  tip.textContent = anchor.dataset.anTip || '';
  const r = anchor.getBoundingClientRect();
  tip.style.visibility = 'hidden';
  tip.style.opacity = '0';
  tip.classList.add('is-visible');
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  tip.classList.remove('is-visible');
  tip.style.visibility = '';
  tip.style.opacity = '';

  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
  let top = r.top - th - 9;
  tip.style.transformOrigin = 'bottom center';
  if (top < 6) { top = r.bottom + 9; tip.style.transformOrigin = 'top center'; }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.classList.add('is-visible');
}

function _hideAnalyticsTooltip(tip) {
  tip.classList.remove('is-visible');
}

function _bindAnalyticsStatTooltips(root) {
  const anchors = root.querySelectorAll('[data-an-tip]');
  if (!anchors.length) return;
  const tip = _ensureAnalyticsTooltipEl();
  anchors.forEach(anchor => {
    anchor.addEventListener('mouseenter', () => _showAnalyticsTooltip(tip, anchor));
    anchor.addEventListener('mouseleave', () => _hideAnalyticsTooltip(tip));
    anchor.addEventListener('focusin', () => _showAnalyticsTooltip(tip, anchor));
    anchor.addEventListener('focusout', () => _hideAnalyticsTooltip(tip));
  });
}

function _buildHourHeatmap(data) {
  const el = document.getElementById('an-hour-heatmap');
  if (!el) return;
  const buckets = _pick(data.hourHeatmap, []);
  if (!buckets.length || buckets.every(b => b.count === 0)) {
    el.innerHTML = '<div style="color:var(--t400);font-size:10px;padding:4px 0">No data</div>';
    return;
  }

  // Auf volle 0..23-Skala normalisieren (fehlende Stunden ⇒ 0).
  const byHour = Array.from({ length: 24 }, (_, h) => {
    const b = buckets.find(x => x.hour === h);
    return { hour: h, count: b ? b.count : 0, pct: b ? b.pct : 0 };
  });
  const peak = byHour.reduce((m, b) => (b.count > m.count ? b : m), byHour[0]);
  const totalCount = byHour.reduce((s, b) => s + b.count, 0);

  el.innerHTML = `
    <div class="an-clock">
      <canvas class="an-clock-canvas"></canvas>
      <div class="an-clock-tip"></div>
      <div class="an-clock-cap">Peak hour <b>${String(peak.hour).padStart(2, '0')}:00</b> · Σ ${totalCount} activities</div>
    </div>`;

  _initHourClock(
    el.querySelector('.an-clock'),
    el.querySelector('.an-clock-canvas'),
    el.querySelector('.an-clock-tip'),
    byHour,
    totalCount,
  );
}

// Zeichnet die 24h-Aktivitätsuhr auf Canvas: 00 oben, 06 rechts, 12 unten,
// 18 links (im Uhrzeigersinn). Jede Stunde ist ein Speichen-Segment; ein
// dezenter Track in voller Länge, darüber ein Wert-Balken (Glut→Flamme nach
// Auslastung). Einblend-Animation, Hover-Highlight + Tooltip, ResizeObserver.
function _initHourClock(wrap, canvas, tip, byHour, totalCount) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const seg = (Math.PI * 2) / 24;
  const gap = seg * 0.16;
  let size = 0, cx = 0, cy = 0, innerR = 0, outerR = 0;
  let progress = 0;
  let hoverHour = -1;

  function layout() {
    const w = wrap.clientWidth || canvas.clientWidth || 240;
    size = Math.max(180, Math.min(280, Math.floor(w)));
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    cx = cy = size / 2;
    outerR = size / 2 - 4;
    innerR = outerR * 0.34;
  }

  function wedge(r0, r1, a0, a1) {
    ctx.beginPath();
    ctx.arc(cx, cy, r1, a0, a1);
    ctx.arc(cx, cy, r0, a1, a0, true);
    ctx.closePath();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Feiner Innenring um die Stundenlabels.
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 3, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.lineJoin = 'round';
    for (let h = 0; h < 24; h++) {
      const b = byHour[h];
      const center = -Math.PI / 2 + h * seg;   // 0 = oben, im Uhrzeigersinn
      const a0 = center - seg / 2 + gap / 2;
      const a1 = center + seg / 2 - gap / 2;
      const hovered = h === hoverHour;

      // Track (volle Länge, dezent).
      wedge(innerR, outerR, a0, a1);
      ctx.fillStyle = hovered ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.045)';
      ctx.fill();

      // Wert-Balken.
      const r1 = innerR + b.pct * progress * (outerR - innerR);
      if (r1 > innerR + 0.5) {
        wedge(innerR, r1, a0, a1);
        ctx.fillStyle = _activityHeatColor(b.pct, hovered ? 0.18 : 0);
        ctx.fill();
        if (hovered) {
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    // Stundenlabels an den Kardinalpunkten.
    ctx.fillStyle = '#7e92a4';
    ctx.font = '600 9px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rl = innerR * 0.6;
    [[0, 0, -1], [6, 1, 0], [12, 0, 1], [18, -1, 0]].forEach(([hr, dx, dy]) => {
      ctx.fillText(String(hr).padStart(2, '0'), cx + dx * rl, cy + dy * rl);
    });
  }

  function animate() {
    const step = () => {
      progress += (1 - progress) * 0.16;          // ease-out
      if (progress > 0.995) progress = 1;
      draw();
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  canvas.addEventListener('mousemove', (e) => {
    const cRect = canvas.getBoundingClientRect();
    const x = e.clientX - cRect.left - cx;
    const y = e.clientY - cRect.top - cy;
    const dist = Math.hypot(x, y);
    if (dist < innerR - 2 || dist > outerR + 4) {
      if (hoverHour !== -1) { hoverHour = -1; draw(); }
      tip.classList.remove('show');
      return;
    }
    let ang = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2); // 0 = oben
    const h = Math.floor(ang / seg + 0.5) % 24;
    if (h !== hoverHour) { hoverHour = h; draw(); }

    const b = byHour[h];
    const share = totalCount > 0 ? (b.count / totalCount) * 100 : 0;
    tip.innerHTML = `<b>${String(h).padStart(2, '0')}:00</b> · ${b.count} act.`
      + `<br><span class="an-clock-tip-sub">${share.toFixed(0)}% of activity</span>`;
    tip.classList.add('show');

    // Tooltip relativ zum .an-clock-Wrap positionieren.
    const wRect = wrap.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let px = e.clientX - wRect.left + 12;
    let py = e.clientY - wRect.top - th - 8;
    if (px + tw > wrap.clientWidth) px = e.clientX - wRect.left - tw - 12;
    if (py < 0) py = e.clientY - wRect.top + 14;
    tip.style.left = px + 'px';
    tip.style.top = py + 'px';
  });

  canvas.addEventListener('mouseleave', () => {
    hoverHour = -1; draw();
    tip.classList.remove('show');
  });

  layout();
  draw();
  animate();

  if (typeof ResizeObserver !== 'undefined') {
    if (_hourClockResizeObserver) _hourClockResizeObserver.disconnect();
    const ro = new ResizeObserver(() => { layout(); draw(); });
    ro.observe(wrap);
    _hourClockResizeObserver = ro;
  }
}

function _buildWeekdayBars(data) {
  const el = document.getElementById('an-weekday-bars');
  if (!el) return;
  const dist = _pick(data.weekdayDistribution, []);
  el.innerHTML = dist.map(d => `
    <div class="an-wkday-row" style="--wk-pct:${(d.pct * 100).toFixed(1)}%">
      <span class="an-wkday-lbl">${QB.esc(_weekdayLabel(d))}</span>
      <div class="an-wkday-track">
        <div class="an-wkday-fill"></div>
      </div>
      <span class="an-wkday-pct">${(d.pct * 100).toFixed(0)}%</span>
    </div>
  `).join('');
}

function _weekdayLabel(d) {
  const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return labels[d.day] ?? d.label;
}

function _buildTopDays(data) {
  const el = document.getElementById('an-top-days');
  if (!el) return;
  const days = _pick(data.topActiveDays, []);
  if (!days.length) {
    el.innerHTML = '<div style="color:var(--t400);font-size:10px">No data</div>';
    return;
  }
  const maxCalls = Math.max(...days.map(d => d.count), 1);
  el.innerHTML = '<div class="an-top-days">' + days.map((d, index) => `
    <div class="an-top-day-row">
      <span class="an-top-day-rank">${index + 1}</span>
      <span class="an-top-day-date">${QB.esc(d.date)}</span>
      <span class="an-top-day-count">${d.count}<small>Calls</small></span>
      <span class="an-top-day-spark" style="--day-pct:${((d.count / maxCalls) * 100).toFixed(1)}%"></span>
      <span class="an-top-day-tokens">${QB.fmtTokens(d.outputTokens)} out</span>
    </div>
  `).join('') + '</div>';
}

const _PRESSURE_BUCKETS = [
  { key: 'crit', lbl: '>=90%', color: '#e55' },
  { key: 'high', lbl: '75-90', color: '#f59830' },
  { key: 'mid',  lbl: '50-75', color: '#b9d617' },
  { key: 'low',  lbl: '25-50', color: '#52d017' },
  { key: 'min',  lbl: '5-25',  color: '#3a8a2a' },
];

function _pressureColumn(title, dist) {
  if (!dist || dist.total === 0) {
    return `
      <div class="an-pcol">
        <div class="an-pcol-head">${QB.esc(title)}</div>
        <div class="an-pcol-empty">Not enough window data yet</div>
      </div>`;
  }
  const maxCount = Math.max(..._PRESSURE_BUCKETS.map(b => dist.buckets[b.key]), 1);
  const rows = _PRESSURE_BUCKETS.map(b => {
    const c = dist.buckets[b.key];
    const w = Math.round((c / maxCount) * 100);
    return `
      <div class="an-threshold-row">
        <div class="an-threshold-lbl">${b.lbl}</div>
        <div class="an-threshold-track"><div class="an-threshold-fill" style="width:${w}%;background:${b.color}"></div></div>
        <div class="an-threshold-pct">${c}</div>
      </div>`;
  }).join('');
  const worst = dist.worst
    ? `${Math.round(dist.worst.pct)}% · ${new Date(dist.worst.windowStart).toLocaleString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : '—';
  return `
    <div class="an-pcol">
      <div class="an-pcol-head">${QB.esc(title)} · <b>${dist.hotCount}/${dist.total}</b> hot (&gt;=90%)</div>
      <div class="an-threshold">${rows}</div>
      <div class="an-pcol-worst">Worst ${QB.esc(worst)}</div>
    </div>`;
}

function _buildFiveHourPressure(data) {
  const el = document.getElementById('an-peak');
  if (!el) return;
  const dist  = _pick(data.fiveHourPressure, null);
  const title = _provider === 'claude' ? 'CLAUDE' : _provider === 'codex' ? 'CODEX' : 'ALL PROVIDERS';
  el.innerHTML = `
    <div class="an-pressure">
      ${_pressureColumn(title, dist)}
    </div>`;
}


function _buildCostEfficiency(data) {
  const elTiles = document.getElementById('an-cost-eff');
  if (!elTiles) return;
  const eff = _pick(data.costEfficiency, {
    costPer1kOutputTokens: 0, costPerActiveHour: 0, subCostPerActiveHour: 0,
    costPerSession: 0, outputTokensPerActiveHour: 0, tokensPerSession: 0,
  });

  const tiles = [
    { lbl: '$/1k output',  val: `$${(eff.costPer1kOutputTokens ?? 0).toFixed(3)}` },
    { lbl: '$/hr (API)',   val: `$${(eff.costPerActiveHour ?? 0).toFixed(2)}` },
  ];
  if ((eff.subCostPerActiveHour ?? 0) > 0) {
    tiles.push({ lbl: '$/hr (sub)', val: `$${eff.subCostPerActiveHour.toFixed(2)}` });
  }
  tiles.push({ lbl: '$/session',   val: `$${(eff.costPerSession ?? 0).toFixed(2)}` });
  tiles.push({ lbl: 'Out tok/hr',  val: QB.fmtTokens(Math.round(eff.outputTokensPerActiveHour ?? 0)) });
  tiles.push({ lbl: 'Tok/session', val: QB.fmtTokens(Math.round(eff.tokensPerSession ?? 0)) });

  elTiles.innerHTML = `<div class="an-stats-grid">` +
    tiles.map(_statTileHtml).join('') + '</div>';
  _bindAnalyticsStatTooltips(elTiles);
}

// ── 5h-Fenster-Historie: ein Chart, beide Anbieter, umschaltbare Metrik ──────
// Folgt dem Muster des Kosten/ROI-Linien-Charts: reagiert auf Datumswahl
// (_from/_to) und Auflösung (_agg), umschaltbar zwischen Auslastung %, genutzten
// und möglichen Fenstern.

const _WH_SERIES = [
  { id: 'claude', label: 'Claude', color: '#DA785B', bg: 'rgba(218,120,91,0.08)' },
  { id: 'codex',  label: 'Codex',  color: '#4B55C8', bg: 'rgba(75,85,200,0.07)' },
];

function _whTitle() {
  const m = _whMode === 'used' ? 'USED 5H WINDOWS'
          : _whMode === 'max'  ? 'POSSIBLE 5H WINDOWS'
          : '5H WINDOW UTILIZATION';
  const unit = _agg === 'monthly' ? 'PER MONTH' : 'PER WEEK';
  return `${m} · ${unit}`;
}

function _updateWhTitle() {
  const el = document.getElementById('an-wh-title');
  if (el) el.textContent = _whTitle();
}

async function _renderWindowHistory() {
  const canvas = document.getElementById('an-wh-canvas');
  if (!canvas) return;
  const token = ++_whGen;

  if (!_whData) {
    try {
      _whData = await QB.ipc.invoke('windowHistory:get');
      if (QB.isPortableDataPreparing(_whData)) {
        _whData = null;
        const note = document.getElementById('an-wh-note');
        if (note) { note.hidden = false; note.textContent = 'Preparing data…'; }
        QB.schedulePortableDataRetry('window-history', () => _renderWindowHistory());
        return;
      }
      QB.clearPortableDataRetry('window-history');
    } catch (e) {
      if (token !== _whGen) return;
      console.error('windowHistory:get failed', e);
      _whData = { entries: [], planChanges: [] };
    }
  }
  if (token !== _whGen) return; // veralteter Load
  _buildWindowHistoryChart();
  _bindWhToggles();
}

// Gemeinsame Buckets über beide Anbieter, da deren 7d-Reset-Zeitpunkte nicht
// aligned sind: monthly → Kalendermonat, sonst ISO-Kalenderwoche.
function _whBucketKey(weekEndIso) {
  const day = weekEndIso.slice(0, 10);
  return _agg === 'monthly' ? day.slice(0, 7) : _isoWeekStart(day);
}

function _whBucketLabel(key) {
  if (/^\d{4}-\d{2}$/.test(key)) {
    const d = new Date(key + '-01T00:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  return 'W' + _isoWeekNum(key);
}

function _buildWindowHistoryChart() {
  if (_whChart) { _whChart.destroy(); _whChart = null; }
  const ctx = document.getElementById('an-wh-canvas');
  const note = document.getElementById('an-wh-note');
  if (!ctx || typeof Chart === 'undefined') return;

  const entries = (_whData && _whData.entries) || [];
  const planChanges = (_whData && _whData.planChanges) || [];

  // Bewusst NICHT nach dem Analytics-Zeitraum gefiltert: Diese Historie ist als
  // Langzeit-Trend gedacht ("wird der Plan über die Wochen ausgereizt?") und
  // zeigt alle erfassten 7d-Fenster. Nur die Auflösung (Woche/Monat) greift.

  // Pro (Bucket, Anbieter) aggregieren: Ø genutzte, Ø mögliche Fenster, Bonus.
  const buckets = new Map();
  for (const e of entries) {
    const key = _whBucketKey(e.weekEnd);
    let b = buckets.get(key);
    if (!b) { b = { key, repDay: e.weekStart.slice(0, 10), prov: {} }; buckets.set(key, b); }
    if (e.weekStart.slice(0, 10) < b.repDay) b.repDay = e.weekStart.slice(0, 10);
    let pp = b.prov[e.provider];
    if (!pp) { pp = { used: 0, n: 0, max: 0, maxN: 0, bonus: false }; b.prov[e.provider] = pp; }
    pp.used += e.usedWindows; pp.n += 1;
    if (typeof e.maxWindows === 'number') { pp.max += e.maxWindows; pp.maxN += 1; }
    if (e.bonus) pp.bonus = true;
  }

  const keys = [...buckets.keys()].sort();
  if (!keys.length) {
    if (note) { note.hidden = false; note.textContent = 'No completed week recorded yet — history will fill in over time.'; }
    return;
  }
  if (note) note.hidden = true;

  const labels  = keys.map(_whBucketLabel);
  const dayKeys = keys.map(k => buckets.get(k).repDay);
  const isPct   = _whMode === 'util';

  const valueOf = (pp) => {
    if (!pp || pp.n === 0) return null;
    const avgUsed = pp.used / pp.n;
    const avgMax = pp.maxN > 0 ? pp.max / pp.maxN : null;
    if (_whMode === 'used') return avgUsed;
    if (_whMode === 'max') return avgMax;
    return avgMax && avgMax > 0 ? (avgUsed / avgMax) * 100 : null;
  };

  const datasets = _WH_SERIES.map(s => {
    const data = keys.map(k => {
      const v = valueOf(buckets.get(k).prov[s.id]);
      return v == null ? null : Number(v.toFixed(2));
    });
    const bonusFlags = keys.map(k => !!(buckets.get(k).prov[s.id] && buckets.get(k).prov[s.id].bonus));
    return {
      label: s.label,
      data,
      borderColor: s.color,
      backgroundColor: s.bg,
      borderWidth: 1.5,
      tension: 0.3,
      fill: false,
      spanGaps: false,
      pointRadius: bonusFlags.map(b => b ? 4 : 2),
      pointHoverRadius: 5,
      pointBackgroundColor: bonusFlags.map(b => b ? '#52d017' : s.color),
      pointBorderColor: bonusFlags.map(b => b ? '#52d017' : s.color),
    };
  });

  const changes = QB.charts.mapChangesToIndex(planChanges, dayKeys);

  _whChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    plugins: [QB.charts.planChangePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1319', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
          titleColor: '#b4c8d8', bodyColor: '#8298aa', padding: 8,
          callbacks: {
            label: (item) => {
              const v = item.parsed.y;
              if (v == null) return ` ${item.dataset.label}: —`;
              return isPct
                ? ` ${item.dataset.label}: ${v.toFixed(0)} %`
                : ` ${item.dataset.label}: ${_fmtWin(v)} windows`;
            },
            afterLabel: (item) => {
              const b = buckets.get(keys[item.dataIndex]);
              const s = _WH_SERIES[item.datasetIndex];
              return (b && b.prov[s.id] && b.prov[s.id].bonus) ? '⚡ Bonus week' : '';
            },
          },
        },
        planChanges: { changes },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' }, border: { color: 'rgba(255,255,255,0.07)' },
          ticks: { color: QB.charts.mutedTextColor, font: { family: "'IBM Plex Mono', monospace", size: 9 },
                   maxTicksLimit: 10, maxRotation: 0 },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.04)' }, border: { color: 'rgba(255,255,255,0.07)' },
          ticks: { color: QB.charts.mutedTextColor, font: { family: "'IBM Plex Mono', monospace", size: 9 },
                   callback: (val) => isPct ? val + ' %' : _fmtWin(Number(val)) },
        },
      },
    },
  });
}

function _bindWhToggles() {
  document.querySelectorAll('#an-wh-pills button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('#an-wh-pills button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _whMode = btn.dataset.whmode;
      _updateWhTitle();
      _buildWindowHistoryChart();
    });
  });
}

function _fmtWin(n) {
  return n.toFixed(1);
}

QB.__analyticsTest = {
  activityHeatColor: _activityHeatColor,
  statTooltip: _statTooltip,
  visibleLineDatasets: _visibleLineDatasets,
  sessionTimeAgg: _sessionTimeAgg,
  sessionDurationBucketsFor: _sessionDurationBucketsFor,
  weekdayLabel: _weekdayLabel,
};

})();
