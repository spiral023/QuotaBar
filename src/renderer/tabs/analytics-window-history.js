/* global QB, Chart */
'use strict';
window.QB = window.QB || {};
QB.createAnalyticsWindowHistory = function createAnalyticsWindowHistory(getAggregation) {
let _whChart = null;
let _whData = null;
let _whMode = 'util';
let _whGen = 0;
const { _isoWeekStart, _isoWeekNum } = QB.analyticsHelpers;
const _WH_SERIES = [
  { id: 'claude', label: 'Claude', color: '#DA785B', bg: 'rgba(218,120,91,0.08)' },
  { id: 'codex',  label: 'Codex',  color: '#4B55C8', bg: 'rgba(75,85,200,0.07)' },
];

function _whTitle() {
  const m = _whMode === 'used' ? 'USED 5H WINDOWS'
          : _whMode === 'max'  ? 'POSSIBLE 5H WINDOWS'
          : '5H WINDOW UTILIZATION';
  const unit = getAggregation() === 'monthly' ? 'PER MONTH' : 'PER WEEK';
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
      const response = await QB.ipc.invoke('windowHistory:get');
      if (token !== _whGen) return;
      _whData = response;
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
  if (token !== _whGen) return; // Superseded request.
  _buildWindowHistoryChart();
  _bindWhToggles();
}

// Provider reset instants differ: use shared calendar months or ISO weeks.
function _whBucketKey(weekEndIso) {
  const day = weekEndIso.slice(0, 10);
  return getAggregation() === 'monthly' ? day.slice(0, 7) : _isoWeekStart(day);
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

  // Show all recorded weeks as a long-term trend; only aggregation changes.

  // Aggregate average used/possible windows and bonus flags per bucket/provider.
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


return {
  title: _whTitle, updateTitle: _updateWhTitle, render: _renderWindowHistory,
  rebuild: _buildWindowHistoryChart, mode: () => _whMode,
  clear() { _whGen++; _whData = null; QB.clearPortableDataRetry('window-history'); },
};
};
