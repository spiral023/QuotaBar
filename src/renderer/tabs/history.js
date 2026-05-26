/* global QB, Chart */
'use strict';

window.QB = window.QB || {};

let _barChart   = null;
let _initialized = false;

QB.renderHistory = async function renderHistory() {
  const container = document.getElementById('history-content');
  if (!container) return;

  if (!_initialized) {
    _initialized = true;
    const minDate = await _fetchMinDate();
    _buildControls(container, minDate);
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

function _buildControls(container, minDate) {
  const today     = new Date().toISOString().slice(0, 10);
  const ninetyAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const fromDate  = minDate ?? ninetyAgo;

  container.innerHTML = `
    <div class="hr-controls">
      <label class="hr-date-label">Von</label>
      <input class="hr-date-input" type="date" id="hr-from" value="${fromDate}">
      <label class="hr-date-label">bis</label>
      <input class="hr-date-input" type="date" id="hr-to" value="${today}">
      <div class="hr-pill-group" id="hr-agg-pills">
        <button class="pill active" data-agg="daily">Tag</button>
        <button class="pill"        data-agg="weekly">Woche</button>
        <button class="pill"        data-agg="monthly">Monat</button>
      </div>
      <div class="hr-pill-group" id="hr-prov-pills">
        <button class="pill active" data-prov="all">Alle</button>
        <button class="pill"        data-prov="claude">Claude</button>
        <button class="pill"        data-prov="codex">Codex</button>
      </div>
      <button class="hr-load-btn" id="hr-load-btn">Laden</button>
    </div>
    <div id="hr-results"></div>
  `;

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
    const report = await QB.ipc.invoke('reports:get', {
      source:   'backfill',
      type:     agg,
      provider: prov === 'all' ? undefined : prov,
      since:    from || undefined,
      until:    to   || undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      order:    'asc',
      breakdown: false,
    });

    _renderResults(report);
  } catch (e) {
    console.error('history:get failed', e);
    results.innerHTML = '<div class="empty"><span style="color:var(--red)">Fehler beim Laden der Backfill-Daten.</span></div>';
  } finally {
    if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = 'Laden'; }
  }
}

function _renderResults(report) {
  const results = document.getElementById('hr-results');
  if (!results) return;

  const rows   = report.rows   ?? [];
  const totals = report.totals ?? {};

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

  // Group by bucket for chart
  const bucketMap = {};
  for (const r of rows) {
    if (!bucketMap[r.bucket]) bucketMap[r.bucket] = { claude: 0, codex: 0 };
    bucketMap[r.bucket][r.provider] = (bucketMap[r.bucket][r.provider] ?? 0) + r.costUSD;
  }
  const labels     = Object.keys(bucketMap).sort();
  const claudeData = labels.map(b => bucketMap[b].claude ?? 0);
  const codexData  = labels.map(b => bucketMap[b].codex  ?? 0);

  const claudeCost = rows.filter(r => r.provider === 'claude').reduce((s, r) => s + r.costUSD, 0);
  const codexCost  = rows.filter(r => r.provider === 'codex' ).reduce((s, r) => s + r.costUSD, 0);

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
        <div class="hr-kpi-val">${labels.length}</div>
      </div>
    </div>

    <div class="hr-chart-section">
      <div class="hr-section-head">
        <span class="hr-section-title">KOSTEN PRO PERIODE</span>
        <div class="hr-chart-legend">
          <span class="hr-legend-dot" style="background:var(--claude-col)"></span><span>Claude</span>
          <span class="hr-legend-dot" style="background:var(--codex-col)"></span><span>Codex</span>
        </div>
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
        </table>
      </div>
    </div>
  `;

  if (_barChart) { _barChart.destroy(); _barChart = null; }
  const ctx = document.getElementById('hr-bar-canvas');
  if (ctx && typeof Chart !== 'undefined') {
    _barChart = QB.charts.createStackedBar(ctx, labels, [
      { label: 'Claude', data: claudeData, backgroundColor: 'rgba(245,152,48,0.80)', borderRadius: 2 },
      { label: 'Codex',  data: codexData,  backgroundColor: 'rgba(82,208,23,0.70)',  borderRadius: 2 },
    ]);
  }
}
