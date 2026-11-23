/* global QB, Chart */
'use strict';

window.QB = window.QB || {};

// IIFE-gekapselt, damit top-level let/const/function (z. B. _initialized,
// _minDate, PRESETS) nicht mit gleichnamigen Symbolen anderer Tab-Skripte im
// gemeinsamen globalen Scope kollidieren (sonst SyntaxError beim Laden des
// nachfolgenden history.js → QB.renderHistory bliebe undefiniert).
(function () {
const _windowHistory = QB.createAnalyticsWindowHistory(() => _agg);
const { _buildHourHeatmap } = QB.createAnalyticsActivity(_pick);
const { _statTooltip, _activityHeatColor, _cumulativeRoiSeries, _isoWeekStart, _isoWeekNum, _aggregateBuckets, _bucketLabel, _visibleLineDatasets, _weekdayLabel } = QB.analyticsHelpers;

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
let _requestGeneration = 0;
let _cacheGeneration = 0;
const _analyticsData = QB.createAnalyticsData();


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

// Period presets come from QB.filterBar (shared/filter-bar.js).

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
  } else {
    // Revisited tabs must also render replacement data loaded by prefetch.
    await _loadAndRender();
  }
};

QB.prefetchAnalytics = function prefetchAnalytics() {
  const { from, to } = _presetDates('30d');
  void _analyticsData.load(_query(from, to)).catch(e => console.error('analytics prefetch failed', e));
};

QB.clearAnalyticsCache = function clearAnalyticsCache() {
  QB.clearPortableDataRetry('analytics');
  QB.clearPortableDataRetry('window-history');
  _requestGeneration++;
  _cacheGeneration++;
  _windowHistory.clear();
  _lastData = null;
  _analyticsData.clear();
  _hourlyBuckets = null;
  if (_initialized && document.getElementById('tab-analytics')?.classList.contains('active')) void _loadAndRender();
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
  return QB.presetRange(preset, _minDate);
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
  const today     = QB.localDayKey(new Date());
  const ninetyAgo = QB.localDayKeyDaysAgo(new Date(), 90);

  // Default-Zeitraum: letzte 30 Tage (wie bisher).
  if (_activePreset === null && _from === null) {
    _activePreset = '30d';
    const d = _presetDates('30d');
    _from = d.from;
    _to   = d.to;
  }

  const fb = QB.filterBar;
  container.innerHTML = `
    <div class="hr-controls">
      ${fb.periodRowHtml({ prefix: 'an', preset: _activePreset, from: _from ?? ninetyAgo, to: _to ?? today })}
      <div class="hr-ctrl-row2">
        ${fb.resolutionSegHtml({ id: 'an-agg-pills', active: _agg, extraClass: 'an-agg-seg' })}
        ${fb.providerSegHtml({ id: 'an-provider-pills', active: _provider })}
      </div>
    </div>
    <div id="an-results"></div>
  `;

  fb.bindPeriod({
    prefix: 'an',
    minDate: () => _minDate,
    onChange: ({ preset, from, to }) => {
      _activePreset = preset;
      _from = from;
      _to = to;
      _loadAndRender();
    },
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
      _windowHistory.updateTitle();
      _windowHistory.rebuild();
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

function _query(from = _from, to = _to) {
  return { since: from, until: to, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

async function _loadAndRender() {
  const results = document.getElementById('an-results');
  if (!results) return;

  const request = ++_requestGeneration;
  const key = _rangeKey();
  const isCurrent = () => request === _requestGeneration && key === _rangeKey();
  results.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';

  try {
    const data = await _analyticsData.load(_query());
    if (!isCurrent() || data === undefined) return;
    if (QB.isPortableDataPreparing(data)) {
      results.innerHTML = '<div class="empty"><span>Preparing data…</span></div>';
      QB.schedulePortableDataRetry('analytics', () => _loadAndRender());
      return;
    }
    QB.clearPortableDataRetry('analytics');
    _hourlyBuckets = null; // Datumsbereich geändert → Stunden-Cache invalidieren
    if (_agg === 'hourly') await _ensureHourlyBuckets();
    if (!isCurrent()) return;
    _renderResults(data);
  } catch (e) {
    if (!isCurrent()) return;
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
        <span class="an-section-title" id="an-wh-title">${_windowHistory.title()}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <div class="mod-seg" id="an-wh-pills">
            <button class="${_windowHistory.mode() === 'util' ? 'active' : ''}" data-whmode="util">%</button>
            <button class="${_windowHistory.mode() === 'used' ? 'active' : ''}" data-whmode="used">Cnt</button>
            <button class="${_windowHistory.mode() === 'max'  ? 'active' : ''}" data-whmode="max">Max</button>
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
  void _windowHistory.render();
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

async function _ensureHourlyBuckets() {
  if (_hourlyBuckets !== null) return;
  const key = _rangeKey();
  const generation = _cacheGeneration;
  const isCurrent = () => key === _rangeKey() && generation === _cacheGeneration;
  try {
    const base = {
      type: 'hourly', limit: 168,
      since: _from || undefined, until: _to || undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      order: 'asc', breakdown: false,
    };
    // One request for both providers: the main process then reads the range
    // once instead of once per provider.
    const batch = await QB.ipc.invoke('reports:get-batch', { ...base, providers: ['claude', 'codex'] });
    if (!isCurrent()) return;
    const cr = batch?.claude || {};
    const xr = batch?.codex || {};
    const cm = new Map((cr.rows || []).map(r => [r.bucket, r.costUSD || 0]));
    const xm = new Map((xr.rows || []).map(r => [r.bucket, r.costUSD || 0]));
    const all = new Set([...cm.keys(), ...xm.keys()]);
    _hourlyBuckets = Array.from(all).sort().map(b => ({
      date: b, days: 1, claudeUSD: cm.get(b) || 0, codexUSD: xm.get(b) || 0,
    }));
  } catch { if (isCurrent()) _hourlyBuckets = []; }
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
    ? ` tabindex="0" aria-label="${QB.esc(`${t.lbl}: ${tip}`)}" data-tip="${QB.esc(tip)}"`
    : '';
  return `
    <div class="an-stat-tile${tip ? ' an-stat-tip' : ''}"${tipAttrs}>
      <div class="an-stat-lbl">${QB.esc(t.lbl)}</div>
      <div class="an-stat-val" style="${t.color ? `color:${t.color}` : ''}">${QB.esc(String(t.val))}</div>
    </div>
  `;
}

// Stat tiles re-render via innerHTML; the delegated portal tooltip binds once per container.
function _bindAnalyticsStatTooltips(root) {
  QB.portalTip?.bindDataTips(root, '.an-stat-tip[data-tip]');
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

QB.__analyticsTest = {
  activityHeatColor: _activityHeatColor,
  statTooltip: _statTooltip,
  visibleLineDatasets: _visibleLineDatasets,
  sessionTimeAgg: _sessionTimeAgg,
  sessionDurationBucketsFor: _sessionDurationBucketsFor,
  weekdayLabel: _weekdayLabel,
};

})();
