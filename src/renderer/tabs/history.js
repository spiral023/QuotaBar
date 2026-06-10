/* global QB, Chart */
'use strict';

window.QB = window.QB || {};

let _barChart    = null;
let _initialized = false;
let _lastRows    = [];
let _chartMode   = 'cost';   // 'cost' | 'tokens'
let _tokenMode   = 'output'; // 'total' | 'input' | 'output' | 'cache'
let _minDate      = null;
let _activePreset = null;
let _showEmpty    = false;

QB.renderHistory = async function renderHistory() {
  const container = document.getElementById('history-content');
  if (!container) return;

  if (!_initialized) {
    _initialized = true;
    _minDate = await _fetchMinDate();
    _buildControls(container, _minDate);
    await _loadAndRender();
  }
};

async function _fetchMinDate() {
  try {
    const report = await QB.ipc.invoke('reports:get', {
      source:   'backfill',
      type:     'daily',
      order:    'asc',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      breakdown: false,
    });
    return report.rows?.[0]?.bucket ?? null;
  } catch {
    return null;
  }
}

const PRESETS = [
  { id: '7d',    label: 'Letzte 7 Tage' },
  { id: '30d',   label: 'Letzte 30 Tage' },
  { id: 'week',  label: 'Diese Woche' },
  { id: 'month', label: 'Dieser Monat' },
  { id: 'year',  label: 'Dieses Jahr' },
  { id: 'all',   label: 'Gesamt' },
];

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

function _buildControls(container, minDate) {
  const today     = new Date().toISOString().slice(0, 10);
  const ninetyAgo = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const fromDate  = minDate ?? ninetyAgo;

  const presetHtml = PRESETS.map(p =>
    `<button class="hr-preset-btn${_activePreset === p.id ? ' active' : ''}" data-preset="${p.id}">${p.label}</button>`
  ).join('');

  container.innerHTML = `
    <div class="hr-controls">
      <div class="hr-preset-row">${presetHtml}</div>
      <div class="hr-date-row">
        <label class="hr-date-label">Von</label>
        <input class="hr-date-input" type="date" id="hr-from" value="${fromDate}">
        <label class="hr-date-label">bis</label>
        <input class="hr-date-input" type="date" id="hr-to" value="${today}">
        <div class="hr-pill-group" id="hr-agg-pills">
          <button class="pill"        data-agg="hourly">Stunde</button>
          <button class="pill active" data-agg="daily">Tag</button>
          <button class="pill"        data-agg="weekly">Woche</button>
          <button class="pill"        data-agg="monthly">Monat</button>
        </div>
        <div class="hr-pill-group" id="hr-prov-pills">
          <button class="pill active" data-prov="all">Alle</button>
          <button class="pill"        data-prov="claude">Claude</button>
          <button class="pill"        data-prov="codex">Codex</button>
        </div>
        <button class="pill${_showEmpty ? ' active' : ''}" id="hr-empty-toggle" title="Leere Zeiteinheiten einblenden">Lücken</button>
        <button class="hr-load-btn" id="hr-load-btn">Laden</button>
      </div>
    </div>
    <div id="hr-results"></div>
  `;

  container.querySelectorAll('.hr-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activePreset = btn.dataset.preset;
      const { from, to } = _presetDates(_activePreset);
      document.getElementById('hr-from').value = from;
      document.getElementById('hr-to').value   = to;
      container.querySelectorAll('.hr-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _loadAndRender();
    });
  });

  ['hr-from', 'hr-to'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      _activePreset = null;
      container.querySelectorAll('.hr-preset-btn').forEach(b => b.classList.remove('active'));
    });
  });

  container.querySelectorAll('#hr-agg-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#hr-agg-pills .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  container.querySelectorAll('#hr-prov-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('#hr-prov-pills .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('hr-empty-toggle')?.addEventListener('click', () => {
    _showEmpty = !_showEmpty;
    const btn = document.getElementById('hr-empty-toggle');
    if (btn) btn.classList.toggle('active', _showEmpty);
    _loadAndRender();
  });

  document.getElementById('hr-load-btn').addEventListener('click', _loadAndRender);
}

async function _loadAndRender() {
  const container = document.getElementById('history-content');
  const results   = document.getElementById('hr-results');
  if (!results || !container) return;

  const from = document.getElementById('hr-from')?.value;
  const to   = document.getElementById('hr-to')?.value;
  const agg  = container.querySelector('#hr-agg-pills .pill.active')?.dataset.agg  ?? 'daily';
  const prov = container.querySelector('#hr-prov-pills .pill.active')?.dataset.prov ?? 'all';

  const loadBtn = document.getElementById('hr-load-btn');
  if (loadBtn) { loadBtn.disabled = true; loadBtn.textContent = '…'; }

  results.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';

  try {
    const isHourly = agg === 'hourly';
    const report = await QB.ipc.invoke('reports:get', {
      source:    isHourly ? 'live' : 'backfill',
      type:      agg,
      provider:  prov === 'all' ? undefined : prov,
      since:     from || undefined,
      until:     to   || undefined,
      timezone:  Intl.DateTimeFormat().resolvedOptions().timeZone,
      order:     'asc',
      breakdown: false,
      ...(isHourly ? { limit: 168 } : {}),
    });

    _renderResults(report, agg);
  } catch (e) {
    console.error('history:get failed', e);
    results.innerHTML = '<div class="empty"><span style="color:var(--red)">Fehler beim Laden der Backfill-Daten.</span></div>';
  } finally {
    if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = 'Laden'; }
  }
}

function _renderChart() {
  if (_barChart) { _barChart.destroy(); _barChart = null; }
  const ctx = document.getElementById('hr-bar-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const bucketMap = {};
  for (const r of _lastRows) {
    if (!bucketMap[r.bucket]) bucketMap[r.bucket] = { claude: 0, codex: 0 };
    let val;
    if (_chartMode === 'cost') {
      val = r.costUSD;
    } else if (_tokenMode === 'input') {
      val = r.inputTokens ?? 0;
    } else if (_tokenMode === 'output') {
      val = r.outputTokens ?? 0;
    } else if (_tokenMode === 'cache') {
      val = (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);
    } else {
      val = r.totalTokens ?? 0;
    }
    bucketMap[r.bucket][r.provider] = (bucketMap[r.bucket][r.provider] ?? 0) + val;
  }
  const labels     = Object.keys(bucketMap).sort();
  const claudeData = labels.map(b => bucketMap[b].claude ?? 0);
  const codexData  = labels.map(b => bucketMap[b].codex  ?? 0);

  const titleMap = { total: 'GESAMT-TOKENS', input: 'INPUT-TOKENS', output: 'OUTPUT-TOKENS', cache: 'CACHE-TOKENS' };
  const titleEl = document.getElementById('hr-chart-title');
  if (titleEl) titleEl.textContent = _chartMode === 'cost' ? 'KOSTEN PRO PERIODE' : `${titleMap[_tokenMode]} PRO PERIODE`;

  _barChart = QB.charts.createStackedBar(ctx, labels, [
    { label: 'Claude', data: claudeData, backgroundColor: 'rgba(218,120,91,0.85)',  borderRadius: 2 },
    { label: 'Codex',  data: codexData,  backgroundColor: 'rgba(75,85,200,0.85)',   borderRadius: 2 },
  ], { yFormat: _chartMode === 'tokens' ? 'tokens' : 'cost' });
}

function _bindChartToggles() {
  const ctypePills = document.querySelectorAll('#hr-chart-type-pills .pill');
  ctypePills.forEach(btn => {
    btn.addEventListener('click', () => {
      ctypePills.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _chartMode = btn.dataset.ctype;
      const tokenRow = document.getElementById('hr-token-type-row');
      if (tokenRow) tokenRow.style.display = _chartMode === 'tokens' ? 'flex' : 'none';
      _renderChart();
    });
  });

  document.querySelectorAll('#hr-token-type-row .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#hr-token-type-row .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _tokenMode = btn.dataset.ttype;
      _renderChart();
    });
  });
}

function _sumRows(rs) {
  return {
    costUSD:         rs.reduce((s, r) => s + (r.costUSD         ?? 0), 0),
    totalTokens:     rs.reduce((s, r) => s + (r.totalTokens     ?? 0), 0),
    inputTokens:     rs.reduce((s, r) => s + (r.inputTokens     ?? 0), 0),
    outputTokens:    rs.reduce((s, r) => s + (r.outputTokens    ?? 0), 0),
    cacheReadTokens: rs.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
  };
}

function _footRow(label, color, t, cls) {
  const pip = color ? `<span class="hr-prov-pip" style="background:${color}"></span>` : '';
  return `
    <tr class="${cls}">
      <td colspan="2">${pip}${label}</td>
      <td class="num cost-cell">$${t.costUSD.toFixed(3)}</td>
      <td class="num">${QB.fmtTokens(t.totalTokens)}</td>
      <td class="num dim">${QB.fmtTokens(t.inputTokens)}</td>
      <td class="num dim">${QB.fmtTokens(t.outputTokens)}</td>
      <td class="num dim">${QB.fmtTokens(t.cacheReadTokens)}</td>
    </tr>`;
}

function _renderResults(report, agg) {
  const results = document.getElementById('hr-results');
  if (!results) return;

  const rawRows = report.rows ?? [];
  const totals  = report.totals ?? {};
  // Chart uses gap-filled data; table/summaries use real data only
  _lastRows = _showEmpty ? _fillEmptyBuckets(rawRows, agg ?? 'daily') : rawRows;
  const rows = rawRows;

  if (!rows.length) {
    results.innerHTML = `
      <div class="hr-empty-state">
        <div class="hr-empty-icon">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
            <rect x="3" y="5" width="22" height="18" rx="2"/>
            <path d="M3 10h22"/><path d="M8 3v4"/><path d="M20 3v4"/>
            <path d="M8 15h5"/><path d="M8 19h3"/>
          </svg>
        </div>
        <div class="hr-empty-text">Keine Backfill-Daten für diesen Zeitraum</div>
        <div class="hr-empty-sub">Starte die App, um Backfill-Dateien zu erzeugen</div>
      </div>
    `;
    return;
  }

  const claudeRows = rows.filter(r => r.provider === 'claude');
  const codexRows  = rows.filter(r => r.provider === 'codex');
  const claudeSums = claudeRows.length ? _sumRows(claudeRows) : null;
  const codexSums  = codexRows.length  ? _sumRows(codexRows)  : null;
  const grandSums  = _sumRows(rows);

  const claudeCost  = claudeSums?.costUSD  ?? 0;
  const codexCost   = codexSums?.costUSD   ?? 0;
  const periodCount = [...new Set(rows.map(r => r.bucket))].length;

  const tTypeLabels = { total: 'Gesamt', input: 'Input', output: 'Output', cache: 'Cache' };
  const tokenTypePillsHtml = Object.keys(tTypeLabels).map(t =>
    `<button class="pill${_tokenMode === t ? ' active' : ''}" data-ttype="${t}">${tTypeLabels[t]}</button>`
  ).join('');

  const titleMap = { total: 'GESAMT-TOKENS', input: 'INPUT-TOKENS', output: 'OUTPUT-TOKENS', cache: 'CACHE-TOKENS' };
  const chartTitle = _chartMode === 'cost' ? 'KOSTEN PRO PERIODE' : `${titleMap[_tokenMode]} PRO PERIODE`;

  results.innerHTML = `
    <div class="hr-summary-row">
      <div class="hr-kpi">
        <div class="hr-kpi-lbl">Gesamt API-Kosten</div>
        <div class="hr-kpi-val">$${(totals.costUSD ?? 0).toFixed(2)}</div>
      </div>
      <div class="hr-kpi hr-kpi-provider" style="--prov-col:var(--claude-col)">
        <div class="hr-kpi-lbl">Claude</div>
        <div class="hr-kpi-val">$${claudeCost.toFixed(2)}</div>
      </div>
      <div class="hr-kpi hr-kpi-provider" style="--prov-col:var(--codex-col)">
        <div class="hr-kpi-lbl">Codex</div>
        <div class="hr-kpi-val">$${codexCost.toFixed(2)}</div>
      </div>
      <div class="hr-kpi">
        <div class="hr-kpi-lbl">Tokens</div>
        <div class="hr-kpi-val">${QB.fmtTokens(totals.totalTokens ?? 0)}</div>
      </div>
      <div class="hr-kpi">
        <div class="hr-kpi-lbl">Perioden</div>
        <div class="hr-kpi-val">${periodCount}</div>
      </div>
    </div>

    <div class="hr-chart-section">
      <div class="hr-section-head">
        <span class="hr-section-title" id="hr-chart-title">${chartTitle}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <div class="hr-pill-group hr-chart-pills" id="hr-chart-type-pills">
            <button class="pill${_chartMode === 'cost' ? ' active' : ''}" data-ctype="cost">Kosten</button>
            <button class="pill${_chartMode === 'tokens' ? ' active' : ''}" data-ctype="tokens">Tokens</button>
          </div>
          <div class="hr-chart-legend">
            <span class="hr-legend-dot" style="background:var(--claude-col)"></span><span>Claude</span>
            <span class="hr-legend-dot" style="background:var(--codex-col)"></span><span>Codex</span>
          </div>
        </div>
      </div>
      <div class="hr-pill-group hr-chart-pills" id="hr-token-type-row"
           style="display:${_chartMode === 'tokens' ? 'flex' : 'none'};margin-bottom:6px">
        ${tokenTypePillsHtml}
      </div>
      <div class="hr-chart-wrap">
        <canvas id="hr-bar-canvas"></canvas>
      </div>
    </div>

    <div class="hr-table-section">
      <div class="hr-section-head">
        <span class="hr-section-title">DETAILANSICHT</span>
        <span class="hr-row-count">${rows.length} Zeilen</span>
      </div>
      <div class="hr-table-scroll">
        <table class="hr-table">
          <thead>
            <tr>
              <th>Periode</th>
              <th>Anbieter</th>
              <th class="num">API-Kosten</th>
              <th class="num">Tokens</th>
              <th class="num">Input</th>
              <th class="num">Output</th>
              <th class="num">Cache</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const isC = r.provider === 'claude';
              const col = isC ? 'var(--claude-col)' : 'var(--codex-col)';
              return `
                <tr>
                  <td class="bucket-cell">${QB.esc(r.bucket)}</td>
                  <td>
                    <span class="hr-prov-pip" style="background:${col}"></span>
                    ${QB.esc(isC ? 'Claude' : 'Codex')}
                  </td>
                  <td class="num cost-cell">$${r.costUSD.toFixed(3)}</td>
                  <td class="num">${QB.fmtTokens(r.totalTokens)}</td>
                  <td class="num dim">${QB.fmtTokens(r.inputTokens)}</td>
                  <td class="num dim">${QB.fmtTokens(r.outputTokens)}</td>
                  <td class="num dim">${QB.fmtTokens(r.cacheReadTokens)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
          <tfoot>
            ${claudeSums ? _footRow('Claude', 'var(--claude-col)', claudeSums, 'hr-foot-sub') : ''}
            ${codexSums  ? _footRow('Codex',  'var(--codex-col)',  codexSums,  'hr-foot-sub') : ''}
            ${_footRow('Gesamt', '', grandSums, 'hr-foot-total')}
          </tfoot>
        </table>
      </div>
    </div>
  `;

  _renderChart();
  _bindChartToggles();
}

// ── Gap filling ───────────────────────────────────────────────────────────────

function _fillEmptyBuckets(rows, agg) {
  if (!rows.length) return rows;

  const allBuckets = rows.map(r => r.bucket).sort();
  const minB = allBuckets[0];
  const maxB = allBuckets[allBuckets.length - 1];
  const sequence = _bucketSequence(minB, maxB, agg);
  const providers = [...new Set(rows.map(r => r.provider))];
  const existing  = new Set(rows.map(r => `${r.provider}\0${r.bucket}`));

  const zero = () => ({
    costUSD: 0, totalTokens: 0, inputTokens: 0,
    outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    models: [],
  });

  const filled = [...rows];
  for (const bucket of sequence) {
    for (const provider of providers) {
      if (!existing.has(`${provider}\0${bucket}`)) {
        filled.push({ bucket, provider, ...zero() });
      }
    }
  }
  return filled.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function _bucketSequence(min, max, agg) {
  const buckets = [];
  let cur = min;
  for (let i = 0; i < 10000 && cur <= max; i++) {
    buckets.push(cur);
    cur = _nextBucket(cur, agg);
    if (!cur) break;
  }
  return buckets;
}

function _nextBucket(bucket, agg) {
  const p2 = n => String(n).padStart(2, '0');

  if (agg === 'hourly') {
    const [date, time] = bucket.split(' ');
    const h = parseInt(time, 10);
    if (h < 23) return `${date} ${p2(h + 1)}:00`;
    const [y, m, d] = date.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    return `${next.getUTCFullYear()}-${p2(next.getUTCMonth() + 1)}-${p2(next.getUTCDate())} 00:00`;
  }

  if (agg === 'daily') {
    const [y, m, d] = bucket.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    return `${next.getUTCFullYear()}-${p2(next.getUTCMonth() + 1)}-${p2(next.getUTCDate())}`;
  }

  if (agg === 'weekly') {
    const [yr, wk] = bucket.split('-W').map(Number);
    const thu  = _isoWeekThursday(yr, wk);
    const next = new Date(thu.getTime() + 7 * 86400000);
    return _isoWeekBucketFromDate(next);
  }

  if (agg === 'monthly') {
    const [yr, mo] = bucket.split('-').map(Number);
    return mo < 12 ? `${yr}-${p2(mo + 1)}` : `${yr + 1}-01`;
  }

  return null;
}

function _isoWeekThursday(year, week) {
  // Jan 4 is always in ISO week 1; find Thursday of that week, then advance.
  const jan4    = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const w1Thu   = new Date(jan4.getTime() + (4 - jan4Day) * 86400000);
  return new Date(w1Thu.getTime() + (week - 1) * 7 * 86400000);
}

function _isoWeekBucketFromDate(date) {
  const day = date.getUTCDay() || 7;
  const thu = new Date(date.getTime() + (4 - day) * 86400000);
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thu - yearStart) / 86400000 + 1) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
