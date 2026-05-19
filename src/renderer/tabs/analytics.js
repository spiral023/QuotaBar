/* global QB, Chart */
'use strict';

window.QB = window.QB || {};

let _lineChart    = null;
let _donutChart   = null;
let _currentData  = null;
let _timeWindow   = '30d';

QB.renderAnalytics = async function renderAnalytics() {
  const container = document.getElementById('analytics-content');
  if (!container) return;
  container.innerHTML = '<div class="empty"><div class="spinner"></div><span>Lädt…</span></div>';

  try {
    _currentData = await QB.ipc.invoke('analytics:get');
    _renderUI(_currentData);
  } catch (e) {
    console.error('analytics:get failed', e);
    container.innerHTML = '<div class="empty"><span>Fehler beim Laden</span></div>';
  }
};

function _renderUI(data) {
  const container = document.getElementById('analytics-content');
  const winLabel  = _timeWindow === '7d' ? '7D' : '30D';

  container.innerHTML = `
    <div class="an-section">
      <div class="an-section-head">
        <span class="an-section-title">USAGE OVER TIME</span>
        <div class="an-window-pills">
          <button class="pill ${_timeWindow === '7d'  ? 'active' : ''}" data-win="7d">7D</button>
          <button class="pill ${_timeWindow === '30d' ? 'active' : ''}" data-win="30d">30D</button>
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
        <div class="an-section-head"><span class="an-section-title">TOP MODELS BY COST (30D)</span></div>
        <table class="top-models-table">
          <thead><tr><th>Modell</th><th>Kosten</th><th>%</th></tr></thead>
          <tbody id="an-top-models-body"></tbody>
        </table>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">AKTIVITÄTSSTATS (30D)</span></div>
      <div class="an-stats-grid" id="an-stats-grid"></div>
    </div>
  `;

  _buildLineChart(data);
  _buildDonut(data);
  _buildTopModels(data);
  _buildStats(data);

  container.querySelectorAll('.an-window-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      _timeWindow = btn.dataset.win;
      _renderUI(_currentData);
    });
  });
}

function _buckets(data) {
  const all = data.dailyBuckets || [];
  return _timeWindow === '7d' ? all.slice(-7) : all;
}

function _buildLineChart(data) {
  if (_lineChart) { _lineChart.destroy(); _lineChart = null; }
  const ctx = document.getElementById('an-line-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const buckets = _buckets(data);
  const labels  = buckets.map(b => {
    const d = new Date(b.date);
    return d.toLocaleDateString('de-AT', { day: '2-digit', month: 'short' });
  });

  _lineChart = QB.charts.createLine(ctx, labels, [
    {
      label: 'Claude',
      data: buckets.map(b => b.claudeUSD),
      borderColor: '#f59830',
      backgroundColor: 'rgba(245,152,48,0.08)',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
    {
      label: 'Codex',
      data: buckets.map(b => b.codexUSD),
      borderColor: '#52d017',
      backgroundColor: 'rgba(82,208,23,0.06)',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
  ]);
}

function _buildDonut(data) {
  if (_donutChart) { _donutChart.destroy(); _donutChart = null; }
  const ctx = document.getElementById('an-donut-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const claudeCost = data.apiCostUSD?.claude ?? 0;
  const codexCost  = data.apiCostUSD?.codex  ?? 0;
  const total      = claudeCost + codexCost;

  const chartData   = total > 0 ? [claudeCost, codexCost] : [1, 1];
  const chartColors = ['#f59830', '#52d017'];
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
      { label: 'Claude', cost: claudeCost, color: '#f59830' },
      { label: 'Codex',  cost: codexCost,  color: '#52d017' },
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
