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
  container.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';

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

    <div class="an-row2">
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">STUNDEN-HEATMAP (UTC, 30D)</span></div>
        <div id="an-hour-heatmap"></div>
      </div>
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">WOCHENTAG (30D)</span></div>
        <div id="an-weekday-bars"></div>
        <div class="an-section-head" style="margin-top:8px"><span class="an-section-title">TOP 5 TAGE</span></div>
        <div id="an-top-days"></div>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">5H-FENSTER-PEAK (CLAUDE, 30D)</span></div>
      <div id="an-peak"></div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">WÖCHENTLICHER VERLAUF (30D)</span></div>
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
  `;

  _buildLineChart(data);
  _buildDonut(data);
  _buildTopModels(data);
  _buildStats(data);
  _buildHourHeatmap(data);
  _buildWeekdayBars(data);
  _buildTopDays(data);
  _buildFiveHourPeak(data);
  _buildWeeklySummary(data);
  _buildCostEfficiency(data);

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
  const eff = data.costEfficiency ?? { costPer1kOutputTokens: 0, costPerActiveHour: 0, roiByTier: [] };

  if (elTiles) {
    const tiles = [
      { lbl: '$/1k Output',   val: `$${eff.costPer1kOutputTokens.toFixed(3)}` },
      { lbl: '$/Arbeitsstd',  val: `$${eff.costPerActiveHour.toFixed(2)}` },
    ];
    elTiles.innerHTML = `<div class="an-stats-grid" style="grid-template-columns:1fr 1fr">` +
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
