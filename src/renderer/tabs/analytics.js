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
let _initialized  = false;
let _minDate      = null;
let _activePreset = null;
let _from         = null;
let _to           = null;
let _lastData     = null;     // aktuell gerendertes AnalyticsData (für Chart-Toggles)
let _chartMode    = 'cost';   // 'cost' | 'roi'
let _agg          = 'daily';  // 'daily' | 'weekly' | 'monthly' (Auflösung des Linien-Charts)
const _cache      = new Map(); // `${from}:${to}` → AnalyticsData
let _whChart      = null;      // Chart-Instanz der 5h-Fenster-Historie
let _whData       = null;      // { entries, planChanges } (zeitraum-unabhängig gecacht)
let _whMode       = 'util';    // 'util' | 'used' | 'max'
let _whGen        = 0;         // Race-Schutz für den asynchron geladenen Verlauf

const PRESETS = [
  { id: '7d',    label: 'Letzte 7 Tage' },
  { id: '30d',   label: 'Letzte 30 Tage' },
  { id: 'week',  label: 'Diese Woche' },
  { id: 'month', label: 'Dieser Monat' },
  { id: 'year',  label: 'Dieses Jahr' },
  { id: 'all',   label: 'Gesamt' },
];

// Kurzlabel für die dynamischen Section-Titel (z. B. "(30 Tage)").
const PRESET_LABELS = {
  '7d': '7 Tage', '30d': '30 Tage', week: 'diese Woche',
  month: 'dieser Monat', year: 'dieses Jahr', all: 'Gesamt',
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
  QB.ipc.invoke('analytics:get', { since: from, until: to })
    .then(data => _cache.set(key, data))
    .catch(e => console.error('analytics prefetch failed', e));
};

QB.clearAnalyticsCache = function clearAnalyticsCache() {
  _cache.clear();
  _whData = null; // Plan-/Settings-Änderung → Fenster-Historie neu laden
};

async function _fetchMinDate() {
  try {
    const report = await QB.ipc.invoke('reports:get', {
      source:    'backfill',
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
      return { from: new Date(now - 7  * 864e5).toISOString().slice(0, 10), to: today };
    case '30d':
      return { from: new Date(now - 30 * 864e5).toISOString().slice(0, 10), to: today };
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
    return `${days} Tage`;
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
      <div class="hr-select-wrap">
        <select class="hr-preset-select" id="an-preset" aria-label="Zeitraum" title="Zeitraum wählen">
          <option value="custom" hidden${_activePreset ? '' : ' selected'}>Eigene Auswahl</option>
          ${presetOptions}
        </select>
        <svg class="hr-select-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1.5 3 4 5.5 6.5 3"/>
        </svg>
      </div>
      <div class="hr-date-pair">
        <input class="hr-date-input" type="date" id="an-from" value="${_from ?? ninetyAgo}" aria-label="Von" title="Startdatum">
        <span class="hr-date-sep" aria-hidden="true">–</span>
        <input class="hr-date-input" type="date" id="an-to" value="${_to ?? today}" aria-label="Bis" title="Enddatum">
      </div>
      <div class="hr-tb-sep" aria-hidden="true"></div>
      <div class="hr-seg" id="an-agg-pills" role="group" aria-label="Auflösung">
        <button class="hr-seg-btn${_agg === 'daily'   ? ' active' : ''}" data-agg="daily"   title="Täglich">Tag</button>
        <button class="hr-seg-btn${_agg === 'weekly'  ? ' active' : ''}" data-agg="weekly"  title="Wöchentlich">Wo</button>
        <button class="hr-seg-btn${_agg === 'monthly' ? ' active' : ''}" data-agg="monthly" title="Monatlich">Mon</button>
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

  // Auflösungs-Umschaltung (Tag/Woche/Monat): betrifft nur den Linien-Chart,
  // daher nur lokal neu aggregieren statt erneut per IPC zu laden.
  container.querySelectorAll('#an-agg-pills .hr-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      container.querySelectorAll('#an-agg-pills .hr-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _agg = btn.dataset.agg;
      _updateLineTitle();
      if (_lastData) _buildLineChart(_lastData);
      // Auch die 5h-Fenster-Historie folgt der Auflösung (Woche ↔ Monat).
      _updateWhTitle();
      _buildWindowHistoryChart();
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
      data = await QB.ipc.invoke('analytics:get', { since: _from, until: _to });
      _cache.set(key, data);
    }
    _renderResults(data);
  } catch (e) {
    console.error('analytics:get failed', e);
    results.innerHTML = '<div class="empty"><span>Fehler beim Laden</span></div>';
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
        <div style="display:flex;gap:6px;align-items:center">
          <div class="an-window-pills" id="an-ctype-pills">
            <button class="pill${_chartMode === 'cost' ? ' active' : ''}" data-ctype="cost">Kosten</button>
            <button class="pill${_chartMode === 'roi'  ? ' active' : ''}" data-ctype="roi">ROI</button>
          </div>
          <div class="hr-chart-legend">
            <span class="hr-legend-dot" style="background:var(--claude-col)"></span><span>Claude</span>
            <span class="hr-legend-dot" style="background:var(--codex-col)"></span><span>Codex</span>
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
          <thead><tr><th>Modell</th><th>Kosten</th><th>%</th></tr></thead>
          <tbody id="an-top-models-body"></tbody>
        </table>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">AKTIVITÄTSSTATS (${winLabel})</span></div>
      <div class="an-stats-grid" id="an-stats-grid"></div>
    </div>

    <div class="an-row2">
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">STUNDEN-HEATMAP (${winLabel})</span></div>
        <div id="an-hour-heatmap"></div>
      </div>
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">WOCHENTAG (${winLabel})</span></div>
        <div id="an-weekday-bars"></div>
        <div class="an-section-head" style="margin-top:8px"><span class="an-section-title">TOP 5 TAGE</span></div>
        <div id="an-top-days"></div>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">5H-FENSTER-PEAK (CLAUDE, ${winLabel})</span></div>
      <div id="an-peak"></div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">WÖCHENTLICHER VERLAUF (${winLabel})</span></div>
      <div id="an-weekly"></div>
    </div>

    <div class="an-row2">
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">KOSTENEFFIZIENZ</span></div>
        <div id="an-cost-eff"></div>
      </div>
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">ROI NACH ABO-TIER</span></div>
        <div id="an-roi-tiers"></div>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head">
        <span class="an-section-title" id="an-wh-title">${_whTitle()}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <div class="an-window-pills" id="an-wh-pills">
            <button class="pill${_whMode === 'util' ? ' active' : ''}" data-whmode="util">% genutzt</button>
            <button class="pill${_whMode === 'used' ? ' active' : ''}" data-whmode="used">Genutzt</button>
            <button class="pill${_whMode === 'max'  ? ' active' : ''}" data-whmode="max">Möglich</button>
          </div>
          <div class="hr-chart-legend">
            <span class="hr-legend-dot" style="background:var(--claude-col)"></span><span>Claude</span>
            <span class="hr-legend-dot" style="background:var(--codex-col)"></span><span>Codex</span>
          </div>
        </div>
      </div>
      <div class="an-wh-sub">5h-Fenster genutzt (≥5 %) vs. laut Nutzung mögliche Fenster je 7d-Fenster — zeigt, ob der Plan ausgereizt wird.</div>
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
  _buildHourHeatmap(data);
  _buildWeekdayBars(data);
  _buildTopDays(data);
  _buildFiveHourPeak(data);
  _buildWeeklySummary(data);
  _buildCostEfficiency(data);
  void _renderWindowHistory();
}

function _lineTitle() {
  const winLabel = _winLabel();
  if (_chartMode === 'roi') {
    return `API-ÄQUIVALENT-FAKTOR · LAUFEND (${winLabel})`;
  }
  const per = _agg === 'monthly' ? 'Ø API-KOSTEN/TAG · MONAT'
            : _agg === 'weekly'  ? 'Ø API-KOSTEN/TAG · WOCHE'
            : 'API-KOSTEN PRO TAG';
  return `${per} (${winLabel})`;
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
  const d = new Date(dateStr + 'T00:00:00Z');
  if (agg === 'monthly') return d.toLocaleDateString('de-AT', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  if (agg === 'weekly')  return 'KW ' + _isoWeekNum(dateStr);
  return d.toLocaleDateString('de-AT', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function _buildLineChart(data) {
  if (_lineChart) { _lineChart.destroy(); _lineChart = null; }
  const ctx = document.getElementById('an-line-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const buckets = _aggregateBuckets(data.dailyBuckets || [], _agg);
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

  // Plan-Wechsel-Marker (beide Modi): Bucket-Datum → Chart-Index.
  const dayKeys = buckets.map(b => b.date);
  const changes = QB.charts.mapChangesToIndex(data.planChanges || [], dayKeys);

  // "Kein Abo"-Hinweis (nur ROI): keine Abo-Baseline im sichtbaren Bereich.
  const totalSub = buckets.reduce((s, b) => s + (b.claudeSubUSD || 0) + (b.codexSubUSD || 0), 0);
  _renderNoPlanChip(isRoi && totalSub === 0);

  _lineChart = QB.charts.createLine(ctx, labels, [
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
  ], { yFormat: isRoi ? 'roi' : 'cost', planChanges: changes });
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
  chip.textContent = 'Kein Abo hinterlegt — im Tab ‚Abos‘ einrichten';
  const go = () => document.getElementById('tab-plans')?.click();
  chip.addEventListener('click', go);
  chip.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  wrap.parentNode.insertBefore(chip, wrap);
}

function _bindLineToggles() {
  document.querySelectorAll('#an-ctype-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('#an-ctype-pills .pill').forEach(b => b.classList.remove('active'));
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

  _donutChart = QB.charts.createDoughnut(ctx, labels, chartData, chartColors);

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
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--t400);text-align:center;padding:8px">Keine Daten</td></tr>';
    return;
  }
  tbody.innerHTML = data.topModels.map(m => `
    <tr>
      <td class="model-name" title="${QB.esc(m.model)}">${QB.esc(m.model.replace(/^claude-|^gpt-/, ''))}</td>
      <td>$${(m.costUSD).toFixed(2)}</td>
      <td>${(m.pctOfTotal * 100).toFixed(0)}%</td>
    </tr>
  `).join('');
}

function _buildStats(data) {
  const grid = document.getElementById('an-stats-grid');
  if (!grid) return;

  const cacheAvg  = ((data.cacheHitRate?.claude ?? 0) + (data.cacheHitRate?.codex ?? 0)) / 2;
  const totalIn   = (data.totalTokens?.claude?.input  ?? 0) + (data.totalTokens?.codex?.input  ?? 0);
  const totalOut  = (data.totalTokens?.claude?.output ?? 0) + (data.totalTokens?.codex?.output ?? 0);
  const roi       = data.roiFactor?.combined ?? 0;

  const sessions = data.sessionStats ?? {};

  const tiles = [
    { lbl: 'Aktive Tage',      val: `${data.activeDays ?? 0}/${data.windowDays ?? 30}` },
    { lbl: 'Cache-Hit',        val: `${(cacheAvg * 100).toFixed(1)}%` },
    { lbl: 'Ø Session',        val: `${sessions.avgMinutes ?? data.avgSessionMinutes ?? 0} min` },
    { lbl: 'Sitzungen',        val: `${sessions.count ?? 0}` },
    { lbl: 'Ses/Tag',          val: `${sessions.sessionsPerActiveDay ?? 0}` },
    { lbl: 'Gesamtstunden',    val: `${sessions.totalHours ?? 0} h` },
    { lbl: 'API-Kosten',       val: `$${(data.apiCostUSD?.total ?? 0).toFixed(0)}`,   color: 'var(--t100)' },
    { lbl: 'ROI',              val: `${roi.toFixed(1)}×`,                             color: QB.roiColor(roi) },
    { lbl: 'Tokens',           val: QB.fmtTokens(totalIn + totalOut) },
  ];

  grid.innerHTML = tiles.map(t => `
    <div class="an-stat-tile">
      <div class="an-stat-lbl">${QB.esc(t.lbl)}</div>
      <div class="an-stat-val" style="${t.color ? `color:${t.color}` : ''}">${QB.esc(String(t.val))}</div>
    </div>
  `).join('');
}

function _buildHourHeatmap(data) {
  const el = document.getElementById('an-hour-heatmap');
  if (!el) return;
  const buckets = data.hourHeatmap ?? [];
  if (buckets.every(b => b.count === 0)) {
    el.innerHTML = '<div style="color:var(--t400);font-size:10px;padding:4px 0">Keine Daten</div>';
    return;
  }
  el.innerHTML = '<div class="an-heatmap">' + buckets.map(b => `
    <div class="an-heatmap-row">
      <span class="an-heatmap-lbl">H${String(b.hour).padStart(2, '0')}</span>
      <div class="an-heatmap-track">
        <div class="an-heatmap-fill" style="width:${(b.pct * 100).toFixed(1)}%"></div>
      </div>
      <span class="an-heatmap-count">${b.count}</span>
    </div>
  `).join('') + '</div>';
}

function _buildWeekdayBars(data) {
  const el = document.getElementById('an-weekday-bars');
  if (!el) return;
  const dist = data.weekdayDistribution ?? [];
  el.innerHTML = dist.map(d => `
    <div class="an-wkday-row">
      <span class="an-wkday-lbl">${QB.esc(d.label)}</span>
      <div class="an-wkday-track">
        <div class="an-wkday-fill" style="width:${(d.pct * 100).toFixed(1)}%"></div>
      </div>
      <span class="an-wkday-pct">${(d.pct * 100).toFixed(0)}%</span>
    </div>
  `).join('');
}

function _buildTopDays(data) {
  const el = document.getElementById('an-top-days');
  if (!el) return;
  const days = data.topActiveDays ?? [];
  if (!days.length) {
    el.innerHTML = '<div style="color:var(--t400);font-size:10px">Keine Daten</div>';
    return;
  }
  el.innerHTML = '<div class="an-top-days">' + days.map(d => `
    <div class="an-top-day-row">
      <span class="an-top-day-date">${QB.esc(d.date)}</span>
      <span class="an-top-day-count">${d.count} Calls</span>
      <span class="an-top-day-tokens">${QB.fmtTokens(d.outputTokens)} out</span>
    </div>
  `).join('') + '</div>';
}

const _FIVE_HOUR_THRESHOLDS = [
  { label: '200k Output', limit: 200_000 },
  { label: '500k Output', limit: 500_000 },
  { label: '800k Output', limit: 800_000 },
];

function _buildFiveHourPeak(data) {
  const el = document.getElementById('an-peak');
  if (!el) return;
  const peak = data.fiveHourPeak ?? { maxOutputTokens: 0, maxTotalTokens: 0, peakWindowStart: null };

  const dateStr = peak.peakWindowStart
    ? new Date(peak.peakWindowStart).toLocaleString('de-AT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    : '—';

  const thresholdRows = _FIVE_HOUR_THRESHOLDS.map(t => {
    const pct = Math.min(peak.maxOutputTokens / t.limit, 1);
    const color = pct >= 1 ? '#e55' : pct >= 0.7 ? '#f59830' : '#52d017';
    return `
      <div class="an-threshold-row">
        <span class="an-threshold-lbl">${QB.esc(t.label)}</span>
        <div class="an-threshold-track">
          <div class="an-threshold-fill" style="width:${(pct * 100).toFixed(1)}%;background:${color}"></div>
        </div>
        <span class="an-threshold-pct" style="color:${color}">${(pct * 100).toFixed(0)}%</span>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="an-peak-hero">${QB.fmtTokens(peak.maxOutputTokens)}</div>
    <div class="an-peak-sub">Output-Token · Fenster: ${QB.esc(dateStr)} · Gesamt ${QB.fmtTokens(peak.maxTotalTokens)}</div>
    <div class="an-threshold">${thresholdRows}</div>
  `;
}

function _buildWeeklySummary(data) {
  const el = document.getElementById('an-weekly');
  if (!el) return;
  const weeks = data.weeklySummary ?? [];
  if (!weeks.length) {
    el.innerHTML = '<div style="color:var(--t400);font-size:10px;padding:4px 0">Keine Daten</div>';
    return;
  }
  el.innerHTML = `
    <table class="an-weekly-table">
      <thead>
        <tr>
          <th>Woche ab</th>
          <th>Claude Msg</th>
          <th>Claude Token</th>
          <th>Kosten</th>
          <th>Codex Ev.</th>
        </tr>
      </thead>
      <tbody>
        ${weeks.map(w => {
          const d = new Date(w.weekStart + 'T00:00:00Z');
          const label = d.toLocaleDateString('de-AT', { day: '2-digit', month: 'short', timeZone: 'UTC' });
          return `
            <tr>
              <td>${QB.esc(label)}</td>
              <td>${w.claudeMessages}</td>
              <td>${QB.fmtTokens(w.claudeTokens)}</td>
              <td>$${w.claudeCostUSD.toFixed(2)}</td>
              <td>${w.codexEvents}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function _buildCostEfficiency(data) {
  const elTiles = document.getElementById('an-cost-eff');
  const elRoi   = document.getElementById('an-roi-tiers');
  const eff = data.costEfficiency ?? { costPer1kOutputTokens: 0, costPerActiveHour: 0, subCostPerActiveHour: 0, roiByTier: [] };

  if (elTiles) {
    const tiles = [
      { lbl: '$/1k Output',  val: `$${eff.costPer1kOutputTokens.toFixed(3)}` },
      { lbl: '$/Std (API)',  val: `$${eff.costPerActiveHour.toFixed(2)}` },
    ];
    if (eff.subCostPerActiveHour > 0) {
      tiles.push({ lbl: '$/Std (Abo)', val: `$${eff.subCostPerActiveHour.toFixed(2)}` });
    }
    const cols = tiles.length === 3 ? '1fr 1fr 1fr' : '1fr 1fr';
    elTiles.innerHTML = `<div class="an-stats-grid" style="grid-template-columns:${cols}">` +
      tiles.map(t => `
        <div class="an-stat-tile">
          <div class="an-stat-lbl">${QB.esc(t.lbl)}</div>
          <div class="an-stat-val">${QB.esc(t.val)}</div>
        </div>
      `).join('') + '</div>';
  }

  if (elRoi) {
    elRoi.innerHTML = `
      <table class="an-roi-table">
        <thead><tr><th>Abo</th><th>Preis/Mo</th><th>ROI</th></tr></thead>
        <tbody>
          ${(eff.roiByTier ?? []).map(t => {
            const color = t.roi >= 5 ? '#52d017' : t.roi >= 1 ? '#f59830' : '#e55';
            return `
              <tr>
                <td>${QB.esc(t.tier)}</td>
                <td>$${t.price}</td>
                <td style="color:${color}">${t.roi.toFixed(1)}×</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }
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
  const m = _whMode === 'used' ? 'GENUTZTE 5H-FENSTER'
          : _whMode === 'max'  ? 'MÖGLICHE 5H-FENSTER'
          : '5H-FENSTER-AUSLASTUNG';
  // Bewusst zeitraum-unabhängig (gesamter Verlauf); nur die Auflösung greift.
  const unit = _agg === 'monthly' ? 'PRO MONAT' : 'PRO WOCHE';
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
    return d.toLocaleDateString('de-AT', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  return 'KW ' + _isoWeekNum(key);
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
    if (note) { note.hidden = false; note.textContent = 'Noch keine abgeschlossene Woche erfasst — der Verlauf füllt sich mit der Zeit.'; }
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
      spanGaps: true,
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
                : ` ${item.dataset.label}: ${_fmtWin(v)} Fenster`;
            },
            afterLabel: (item) => {
              const b = buckets.get(keys[item.dataIndex]);
              const s = _WH_SERIES[item.datasetIndex];
              return (b && b.prov[s.id] && b.prov[s.id].bonus) ? '⚡ Bonus-Woche' : '';
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
  document.querySelectorAll('#an-wh-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('#an-wh-pills .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _whMode = btn.dataset.whmode;
      _updateWhTitle();
      _buildWindowHistoryChart();
    });
  });
}

function _fmtWin(n) {
  return n.toFixed(1).replace('.', ',');
}

})();
