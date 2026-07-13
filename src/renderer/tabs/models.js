/* global QB, Chart */
'use strict';

window.QB = window.QB || {};

(function () {
  const calc = QB.modelsCalc;

  let _data = null;
  let _dataPromise = null;
  let _stale = false;
  let _stackChart = null;
  let _scatterChart = null;
  let _animated = false;

  // UI-State. Zeitraum (from/to) + Auflösung steuern den ganzen Tab (wie History).
  // day/week/month rechnen lokal aus _data.days; nur 'hourly' holt per IPC nach.
  let _preset = '30d';
  let _from = null;
  let _to = null;
  let _resolution = 'daily';
  let _metric = 'output';
  let _provider = 'all';
  let _benchmarkIndex = 'intelligence';
  let _showEmpty = true; // Leere Zeiteinheiten im Verteilungs-Chart einblenden (wie History)
  let _sortKey = 'costUSD';
  let _sortDesc = true;
  // Cache für Stundendaten (reports:get live), Key = `${from}|${to}`.
  let _hourlyCache = { key: null, cells: null };

  const METRIC_LABELS = [
    ['output', 'Out'], ['input', 'In'], ['cacheRead', 'CR'],
    ['cacheCreation', 'CC'], ['total', '∑'], ['cost', '$'], ['rate', '$/MTok'],
  ];

  const PRESETS = [
    ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['week', 'This week'],
    ['month', 'This month'], ['year', 'This year'], ['all', 'All time'],
  ];

  const RESOLUTIONS = [
    ['hourly', 'Hr'], ['daily', 'Day'], ['weekly', 'Wk'], ['monthly', 'Mo'],
  ];

  function pad2(n) { return String(n).padStart(2, '0'); }

  function minDataDate() {
    return (_data && _data.days.length > 0) ? _data.days[0].date : null;
  }

  // Liefert { from, to } für ein Preset (analog History).
  function presetDates(preset) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    switch (preset) {
      case '7d':  return { from: new Date(now - 6  * 864e5).toISOString().slice(0, 10), to: today };
      case '30d': return { from: new Date(now - 29 * 864e5).toISOString().slice(0, 10), to: today };
      case 'week': {
        const d = new Date(now); const day = d.getDay();
        d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
        return { from: d.toISOString().slice(0, 10), to: today };
      }
      case 'month': return { from: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`, to: today };
      case 'year':  return { from: `${now.getFullYear()}-01-01`, to: today };
      case 'all':
      default:      return { from: minDataDate() ?? new Date(now - 89 * 864e5).toISOString().slice(0, 10), to: today };
    }
  }

  const COLUMNS_COMPACT = [
    ['model', 'Model', 'txt'],
    ['outputTokens', 'Output', 'num'],
    ['costUSD', 'Cost', 'num'],
    ['effPerMTok', '$/MTok', 'num'],
    ['sharePct', 'Share', 'num'],
  ];
  const CLAUDE_PALETTE = ['#DA785B', '#E89B6F', '#C05A45', '#F0B27A', '#A8442F', '#F5D0A9'];
  const CODEX_PALETTE  = ['#4B55C8', '#6E8EE8', '#56C8D8', '#3A3F8F', '#7A6FF0', '#2E6FBF'];
  const OTHER_COLOR = '#475460';
  const SCATTER_OPTIMUM_PLUGIN = {
    id: 'scatterOptimumRegion',
    beforeDatasetsDraw(chart, _args, opts) {
      const region = opts && opts.region;
      const x = chart.scales && chart.scales.x;
      const y = chart.scales && chart.scales.y;
      if (!region || !x || !y || !chart.chartArea) return;
      const { ctx, chartArea } = chart;
      const left = chartArea.left;
      const top = chartArea.top;
      const right = chartArea.right;
      const bottom = chartArea.bottom;
      const xRight = clamp(x.getPixelForValue(region.xMax), left, right);
      const yBottom = clamp(y.getPixelForValue(region.yMin), top, bottom);
      if (xRight <= left + 4 || yBottom <= top + 4) return;

      ctx.save();
      ctx.fillStyle = 'rgba(82, 208, 23, 0.085)';
      ctx.strokeStyle = 'rgba(82, 208, 23, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      roundedRect(ctx, left + 1, top + 1, xRight - left - 2, yBottom - top - 2, 5);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "700 9px 'IBM Plex Mono', monospace";
      ctx.fillStyle = 'rgba(155, 255, 113, 0.92)';
      ctx.textBaseline = 'top';
      ctx.fillText('OPTIMUM', left + 8, top + 8);
      ctx.restore();
    },
  };

  QB.renderModels = async function renderModels() {
    const container = document.getElementById('models-content');
    if (!container) return;
    if (_data && !_stale) { renderUI(); return; }
    // Nur einen Spinner zeigen, wenn noch GAR keine Daten vorliegen. Bei
    // bloß veralteten Daten (Cache invalidiert durch quota:update) bleibt die
    // bisherige Ansicht stehen und wird nach dem Reload still ersetzt.
    if (!_data) {
      container.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
    }
    try {
      _data = await loadData();
      if (QB.isPortableDataPreparing(_data)) {
        container.innerHTML = '<div class="empty"><span>Preparing data…</span></div>';
        return;
      }
      renderUI();
    } catch (e) {
      console.error('models:get failed', e);
      const msg = (e && e.message) ? e.message : String(e);
      container.innerHTML = `<div class="empty"><span>Error: ${QB.esc(msg.slice(0, 300))}</span></div>`;
    }
  };

  QB.prefetchModels = function prefetchModels() {
    void loadData().catch((e) => console.error('models prefetch failed', e));
  };

  QB.clearModelsCache = function clearModelsCache() {
    // _data bewusst NICHT nullen: Der Models-Tab kann gerade sichtbar sein,
    // und seine Pill-Handler greifen synchron auf _data.days zu. Würde _data
    // hier null, käme es beim nächsten Pill-Klick zu einem TypeError und die
    // Umschaltung "reagiert nicht mehr". Stattdessen nur als veraltet markieren
    // → beim nächsten Render werden frische Daten geladen.
    _stale = true;
    _dataPromise = null;
    _hourlyCache = { key: null, cells: null };
  };

  function loadData() {
    if (_data && !_stale) return Promise.resolve(_data);
    if (!_dataPromise) {
      _dataPromise = QB.ipc.invoke('models:get')
        .then((d) => {
          if (QB.isPortableDataPreparing(d)) {
            _dataPromise = null;
            _stale = true;
            return d;
          }
          _data = d; _stale = false; return d;
        })
        .catch((err) => { _dataPromise = null; throw err; });
    }
    return _dataPromise;
  }

  // Stellt sicher, dass _from/_to gesetzt sind (aus aktivem Preset abgeleitet).
  function ensureRange() {
    if (!_from || !_to) {
      const { from, to } = presetDates(_preset || '30d');
      _from = from; _to = to;
    }
  }

  // Alle Tage im Zeitraum, OHNE Provider-Filter (für $/MTok-Linie nötig).
  function rangeDays() {
    ensureRange();
    return calc.filterRange(_data.days, _from, _to);
  }

  // Zeitraum + Provider-Filter — Basis für KPIs, Scatter, Tabelle, Stapelbalken.
  function visibleDays() {
    const inRange = rangeDays();
    return _provider === 'all' ? inRange : inRange.filter((d) => d.provider === _provider);
  }

  let _modelProvider = new Map();
  let _colorOrder = [];

  function colorFor(model, provider, order) {
    if (model === 'Other') return OTHER_COLOR;
    const palette = provider === 'claude' ? CLAUDE_PALETTE : CODEX_PALETTE;
    const siblings = order.filter((m) => _modelProvider.get(m) === provider);
    return palette[Math.max(siblings.indexOf(model), 0) % palette.length];
  }

  function selectedBenchmark() {
    const indexes = _data?.benchmarkIndexes || {};
    if (!indexes[_benchmarkIndex]) {
      _benchmarkIndex = indexes.intelligence ? 'intelligence' : (Object.keys(indexes)[0] || 'intelligence');
    }
    return indexes[_benchmarkIndex] || {
      label: 'Intelligence',
      asOf: _data?.benchmarksAsOf || '',
      methodology: '',
      methodologyUrl: '',
      reasoningNote: '',
      scores: _data?.benchmarks || {},
    };
  }

  function benchmarkAxisTitle(benchmark) {
    return `${benchmark?.label || 'Intelligence'} Index`;
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function renderUI() {
    const container = document.getElementById('models-content');
    ensureRange();
    _modelProvider = new Map(_data.days.map((d) => [d.model, d.provider]));
    _colorOrder = calc.modelColorOrder(_data.days);
    const benchmark = selectedBenchmark();
    const hasBenchmarks = Object.keys(benchmark.scores).length > 0;

    container.innerHTML = `
      <div class="${_animated ? '' : 'mod-stagger'}" id="mod-root">
        <div class="mod-kpi-grid" id="mod-kpis"></div>

        <div class="an-section mod-chart-sec">
          <div class="mod-chart-hd">
            <span class="mod-chart-ttl">DISTRIBUTION</span>
          </div>
          <div class="hr-controls mod-chart-controls">
            <div class="hr-ctrl-row1">
              <div class="hr-select-wrap">
                <select class="hr-preset-select" id="mod-preset" aria-label="Period" title="Select period">
                  <option value="custom" hidden${_preset ? '' : ' selected'}>Custom range</option>
                  ${PRESETS.map(([id, label]) => `<option value="${id}"${_preset === id ? ' selected' : ''}>${label}</option>`).join('')}
                </select>
                <svg class="hr-select-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none"
                     stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1.5 3 4 5.5 6.5 3"/>
                </svg>
              </div>
              <div class="hr-date-pair">
                <input class="hr-date-input" type="date" id="mod-from" value="${_from}" aria-label="From" title="Start date">
                <span class="hr-date-sep" aria-hidden="true">–</span>
                <input class="hr-date-input" type="date" id="mod-to" value="${_to}" aria-label="To" title="End date">
              </div>
              <button class="hr-reload" id="mod-load-btn" title="Reload" aria-label="Reload">
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
                     stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1.5 7a5.5 5.5 0 0 1 9.9-3.3"/>
                  <path d="M12.5 7a5.5 5.5 0 0 1-9.9 3.3"/>
                  <path d="M11 2.2 13 4l-2 1.8"/>
                  <path d="M3 11.8 1 10l2-1.8"/>
                </svg>
              </button>
            </div>
            <div class="hr-ctrl-row2">
              <div class="hr-seg" id="mod-agg-pills" role="group" aria-label="Resolution">
                ${RESOLUTIONS.map(([id, label]) => `<button class="hr-seg-btn${_resolution === id ? ' active' : ''}" data-agg="${id}">${label}</button>`).join('')}
              </div>
              <div class="hr-seg" id="mod-prov-pills" role="group" aria-label="Provider">
                <button class="hr-seg-btn${_provider === 'all' ? ' active' : ''}" data-prov="all">All</button>
                <button class="hr-seg-btn hr-seg-claude${_provider === 'claude' ? ' active' : ''}" data-prov="claude"><span class="hr-seg-dot"></span>Claude</button>
                <button class="hr-seg-btn hr-seg-codex${_provider === 'codex' ? ' active' : ''}" data-prov="codex"><span class="hr-seg-dot"></span>Codex</button>
              </div>
              <button class="hr-tgl${_showEmpty ? ' active' : ''}" id="mod-empty-toggle"
                      title="Show empty time units" aria-pressed="${_showEmpty}">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none"
                     stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                  <path d="M1.5 9.5V5"/><path d="M5.5 9.5V7" stroke-dasharray="1.5 1.5"/><path d="M9.5 9.5V2.5"/>
                </svg>
                <span class="hr-tgl-label">Gaps</span>
              </button>
            </div>
          </div>
          <div class="mod-seg mod-metric-seg" id="mod-metric-pills">
            ${METRIC_LABELS.map(([k, l]) => `<button data-metric="${k}">${l}</button>`).join('')}
          </div>
          <div class="mod-hero-wrap"><canvas id="mod-stack-canvas"></canvas></div>
          <div class="mod-ribbon" id="mod-ribbon"></div>
          <div class="mod-legend" id="mod-legend"></div>
          <div class="mod-note" id="mod-stack-note" hidden></div>
          <div class="mod-note" id="mod-stack-source"></div>
        </div>

        ${hasBenchmarks ? `
        <div class="an-section">
          <div class="an-section-head mod-scatter-head">
            <span class="an-section-title">COST vs. INTELLIGENCE</span>
            <div class="hr-seg mod-benchmark-switch" role="group" aria-label="Benchmark index">
              ${Object.entries(_data.benchmarkIndexes || { intelligence: benchmark }).map(([key, index]) =>
                `<button class="hr-seg-btn${key === _benchmarkIndex ? ' active' : ''}" data-benchmark-index="${QB.esc(key)}" aria-pressed="${key === _benchmarkIndex}">${QB.esc(index.label)}</button>`).join('')}
            </div>
          </div>
          <div class="mod-scatter-wrap"><canvas id="mod-scatter-canvas"></canvas></div>
          <div class="mod-note" id="mod-scatter-empty" hidden></div>
          <div class="mod-scatter-note" id="mod-scatter-note"></div>
          <div class="mod-scatter-methodology"><span id="mod-methodology-text"></span> <button type="button" class="mod-methodology-link" id="mod-methodology-link" hidden>Methodology</button></div>
          <div class="mod-scatter-reasoning" id="mod-scatter-reasoning" hidden></div>
        </div>` : ''}

        <div id="mod-tt-section" hidden></div>

        <div id="mod-cost-section" hidden></div>

        <div class="an-section">
          <div class="an-section-head"><span class="an-section-title">MODEL DETAILS</span></div>
          <div class="mod-table-scroll"><table class="mod-table" id="mod-table"></table></div>
        </div>
      </div>`;
    _animated = true;

    bindPills();
    syncPills();
    syncBenchmarkContent();
    renderKpis();
    renderProviderCosts();
    renderStack();
    renderTokenTypes();
    if (hasBenchmarks) renderScatter(true);
    renderTable();
  }

  function bindPills() {
    const presetSel = document.getElementById('mod-preset');
    presetSel?.addEventListener('change', () => {
      if (presetSel.value === 'custom') return;
      _preset = presetSel.value;
      const { from, to } = presetDates(_preset);
      _from = from; _to = to;
      const fromEl = document.getElementById('mod-from');
      const toEl = document.getElementById('mod-to');
      if (fromEl) fromEl.value = from;
      if (toEl) toEl.value = to;
      refreshLocal();
    });
    ['mod-from', 'mod-to'].forEach((id) =>
      document.getElementById(id)?.addEventListener('change', () => {
        _preset = null;
        _from = document.getElementById('mod-from')?.value || _from;
        _to = document.getElementById('mod-to')?.value || _to;
        if (presetSel) presetSel.value = 'custom';
        refreshLocal();
      }));
    document.querySelectorAll('#mod-agg-pills .hr-seg-btn').forEach((b) =>
      b.addEventListener('click', () => { if (_resolution === b.dataset.agg) return; _resolution = b.dataset.agg; syncPills(); refreshChart(); }));
    document.querySelectorAll('#mod-metric-pills button').forEach((p) =>
      p.addEventListener('click', () => { _metric = p.dataset.metric; syncPills(); refreshChart(); }));
    document.querySelectorAll('#mod-prov-pills .hr-seg-btn').forEach((b) =>
      b.addEventListener('click', () => { _provider = b.dataset.prov; refreshLocal(); }));
    document.getElementById('mod-empty-toggle')?.addEventListener('click', () => {
      _showEmpty = !_showEmpty;
      const btn = document.getElementById('mod-empty-toggle');
      if (btn) { btn.classList.toggle('active', _showEmpty); btn.setAttribute('aria-pressed', String(_showEmpty)); }
      refreshChart();
    });
    document.getElementById('mod-load-btn')?.addEventListener('click', reloadData);
    document.querySelectorAll('[data-benchmark-index]').forEach((button) =>
      button.addEventListener('click', () => {
        _benchmarkIndex = button.dataset.benchmarkIndex || 'intelligence';
        renderBenchmarkView(button);
      }));
    document.getElementById('mod-methodology-link')?.addEventListener('click', (event) => {
      event.preventDefault();
      const url = event.currentTarget.dataset.methodologyUrl;
      if (url) void QB.ipc.invoke('shell:open-url', url);
    });
  }

  // Daten frisch aus dem Hauptprozess holen und den ganzen Tab neu rendern.
  async function reloadData() {
    const btn = document.getElementById('mod-load-btn');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    _stale = true;
    _dataPromise = null;
    _hourlyCache = { key: null, cells: null };
    try {
      _data = await loadData();
      renderUI(); // baut DOM neu auf → Button-Zustand wird zurückgesetzt
    } catch (e) {
      console.error('models reload failed', e);
      if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
    }
  }

  function syncPills() {
    document.querySelectorAll('#mod-metric-pills button').forEach((p) => p.classList.toggle('active', p.dataset.metric === _metric));
    document.querySelectorAll('#mod-agg-pills .hr-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.agg === _resolution));
    document.querySelectorAll('#mod-prov-pills .hr-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.prov === _provider));
  }

  function syncBenchmarkContent() {
    const benchmark = selectedBenchmark();
    document.querySelectorAll('[data-benchmark-index]').forEach((button) => {
      const active = button.dataset.benchmarkIndex === _benchmarkIndex;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    const note = document.getElementById('mod-scatter-note');
    if (note) {
      note.textContent = 'x = $/MTok effective (incl. cache) · green = better, red = worse · white line = expected score for price'
        + (benchmark.asOf ? ` · as of ${benchmark.asOf}` : '');
    }

    const methodology = document.getElementById('mod-methodology-text');
    if (methodology) methodology.textContent = benchmark.methodology || '';
    const methodologyLink = document.getElementById('mod-methodology-link');
    if (methodologyLink) {
      methodologyLink.hidden = !benchmark.methodologyUrl;
      methodologyLink.dataset.methodologyUrl = benchmark.methodologyUrl || '';
    }

    const reasoning = document.getElementById('mod-scatter-reasoning');
    if (reasoning) {
      reasoning.hidden = !benchmark.reasoningNote;
      reasoning.textContent = benchmark.reasoningNote || '';
    }
  }

  function renderBenchmarkView(focusButton) {
    syncBenchmarkContent();
    renderKpis();
    renderScatter(false);
    renderTable();
    focusButton?.focus();
  }

  // Voller Refresh (Zeitraum-/Provider-Wechsel betreffen den ganzen Tab).
  function refreshLocal() {
    syncPills();
    renderKpis();
    renderProviderCosts();
    renderStack();
    renderTokenTypes();
    renderScatter(false);
    renderTable();
  }

  // Nur der Chart (Auflösung/Metrik sind reine Chart-Optionen).
  function refreshChart() { renderStack(); }

  function renderKpis() {
    const el = document.getElementById('mod-kpis');
    const days = visibleDays();
    const prevAll = calc.previousRange(_data.days, _from, _to);
    const prev = _provider === 'all' ? prevAll : prevAll.filter((d) => d.provider === _provider);
    const k = calc.computeKpis(days, prev, selectedBenchmark().scores, _data.minModelTokenSharePct || 0);

    const trend = (deltaPct, invert) => {
      if (deltaPct == null) return '';
      const good = invert ? deltaPct < 0 : deltaPct > 0;
      const cls = deltaPct === 0 ? 'flat' : good ? 'good' : 'bad';
      const arrow = deltaPct === 0 ? '→' : deltaPct > 0 ? '▲' : '▼';
      return `<span class="mod-kpi-trend ${cls}">${arrow}${Math.abs(deltaPct).toFixed(0)}%</span>`;
    };

    el.innerHTML = `
      <div class="an-stat-tile mod-kpi-lead">
        <div class="an-stat-lbl">Avg $/MTok effective</div>
        <span class="kv-fill"></span>
        <div class="an-stat-val">${k.effPerMTok != null ? '$' + k.effPerMTok.toFixed(2) : '—'}${trend(k.effPerMTokDeltaPct, true)}</div>
        <div class="mod-kpi-sub">Total cost ÷ total tokens, incl. cache</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Active models</div>
        <span class="kv-fill"></span>
        <div class="an-stat-val">${k.activeModels}${k.activeModelsDelta != null
          ? `<span class="mod-kpi-trend flat">${k.activeModelsDelta >= 0 ? '+' : ''}${k.activeModelsDelta}</span>` : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top by cost</div>
        <span class="kv-fill"></span>
        <div class="an-stat-val" title="${k.topCost ? QB.esc(k.topCost.model) : ''}">${k.topCost ? QB.esc(shortName(k.topCost.model)) : '—'}</div>
        <div class="mod-kpi-sub">${k.topCost ? '$' + k.topCost.costUSD.toFixed(0) + ' · ' + k.topCost.sharePct.toFixed(0) + '%' : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top by output</div>
        <span class="kv-fill"></span>
        <div class="an-stat-val" title="${k.topOutput ? QB.esc(k.topOutput.model) : ''}">${k.topOutput ? QB.esc(shortName(k.topOutput.model)) : '—'}</div>
        <div class="mod-kpi-sub">${k.topOutput ? QB.fmtTokens(k.topOutput.outputTokens) : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Best value</div>
        <span class="kv-fill"></span>
        <div class="an-stat-val" title="${k.bestValue ? QB.esc(k.bestValue.model) : ''}">${k.bestValue ? QB.esc(shortName(k.bestValue.model)) : '—'}</div>
        <div class="mod-kpi-sub">${k.bestValue ? 'Highest score/$' : 'no score available'}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top-3 share</div>
        <span class="kv-fill"></span>
        <div class="an-stat-val">${k.top3SharePct.toFixed(0)}%</div>
        <div class="mod-kpi-sub">Cost concentration</div>
      </div>`;
  }

  function shortName(model) {
    return QB.shortModelName(model);
  }

  // reports:get-Zeilen (Stunde, live) → ModelDay-ähnliche Zellen für die calc-Funktionen.
  function reportRowsToCells(rows) {
    const cells = [];
    for (const r of rows) {
      for (const m of (r.modelBreakdowns || [])) {
        cells.push({
          date: r.bucket, provider: r.provider, model: m.model,
          inputTokens: m.inputTokens, outputTokens: m.outputTokens,
          cacheCreationTokens: m.cacheCreationTokens, cacheReadTokens: m.cacheReadTokens,
          totalTokens: m.totalTokens, costUSD: m.costUSD,
          inputCostUSD: m.inputCostUSD || 0, outputCostUSD: m.outputCostUSD || 0,
          cacheCreationCostUSD: m.cacheCreationCostUSD || 0, cacheReadCostUSD: m.cacheReadCostUSD || 0,
        });
      }
    }
    return cells;
  }

  // Stundenraster gibt es nur über die Live-Quelle (Backfill ist tagesweise).
  // max. 168 h wie im History-Tab. Cache pro Zeitraum.
  async function getHourlyCells() {
    const key = `${_from}|${_to}`;
    if (_hourlyCache.key === key && _hourlyCache.cells) return _hourlyCache.cells;
    const report = await QB.ipc.invoke('reports:get', {
      source: 'live', type: 'hourly',
      since: _from || undefined, until: _to || undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      order: 'asc', breakdown: true, limit: 168,
    });
    const cells = reportRowsToCells(report.rows || []);
    _hourlyCache = { key, cells };
    return cells;
  }

  let _stackSeq = 0;

  async function renderStack() {
    const seq = ++_stackSeq;
    const note = document.getElementById('mod-stack-note');
    const srcNote = document.getElementById('mod-stack-source');
    const granularity = _resolution;

    let cells;
    if (_resolution === 'hourly') {
      try {
        cells = await getHourlyCells();
      } catch (e) {
        console.error('models hourly fetch failed', e);
        if (seq === _stackSeq && note) { note.hidden = false; note.textContent = 'Failed to load hourly data.'; }
        return;
      }
      if (seq !== _stackSeq) return; // durch neuere Auswahl überholt
      // Stundenmodelle (evtl. nicht normalisiert) für Farbzuordnung ergänzen.
      for (const c of cells) if (!_modelProvider.has(c.model)) _modelProvider.set(c.model, c.provider);
    } else {
      cells = rangeDays();
    }

    if (srcNote) {
      srcNote.textContent = _resolution === 'hourly'
        ? `Hourly · live source · max. 168 h · ${_from} – ${_to}`
        : `${_from} – ${_to}`;
    }

    if (_metric === 'rate') {
      renderRateLines(cells, granularity, note);
    } else {
      renderStackBars(cells, granularity, note);
    }
  }

  function renderStackBars(cellsAll, granularity, note) {
    const cells = _provider === 'all' ? cellsAll : cellsAll.filter((d) => d.provider === _provider);
    const order = _resolution === 'hourly' ? calc.modelColorOrder(cells) : _colorOrder;
    const stack = calc.buildStack(cells, _metric, granularity, 0.01, _showEmpty);

    const empty = stack.series.length === 0 || stack.series.every((s) => s.values.every((v) => v === 0));
    note.hidden = !empty;
    if (empty) {
      note.textContent = _metric === 'cacheCreation' && _provider === 'codex'
        ? 'Cache creation tokens are only available for Claude.'
        : 'No data for the selected period.';
    }

    const datasets = stack.series.map((s) => ({
      label: s.model,
      data: s.values,
      backgroundColor: colorFor(s.model, s.provider, order),
      hoverBackgroundColor: colorFor(s.model, s.provider, order) + 'E6',
    }));

    if (_stackChart) { _stackChart.destroy(); _stackChart = null; }
    const ctx = document.getElementById('mod-stack-canvas').getContext('2d');
    _stackChart = QB.charts.createStackedBar(ctx, stack.buckets, datasets,
      { yFormat: _metric === 'cost' ? 'cost' : 'tokens' });

    renderRibbon(cells, granularity);
    renderLegend(stack.series, order);
  }

  // $/MTok-Linie: effektiver Token-Preis je Bucket, getrennt nach Provider + Gesamt.
  function renderRateLines(cellsAll, granularity, note) {
    const rate = calc.buildRateSeries(cellsAll, granularity, _showEmpty);

    const lineDefs = [];
    if (_provider === 'all' || _provider === 'claude') lineDefs.push({ label: 'Claude', values: rate.claude, color: QB.providerColor('claude') });
    if (_provider === 'all' || _provider === 'codex')  lineDefs.push({ label: 'Codex',  values: rate.codex,  color: QB.providerColor('codex') });
    if (_provider === 'all')                            lineDefs.push({ label: 'Total', values: rate.total,  color: '#8298aa' });

    const empty = lineDefs.every((l) => l.values.every((v) => v == null));
    note.hidden = !empty;
    if (empty) note.textContent = 'No data for the selected period.';

    const datasets = lineDefs.map((l) => ({
      label: l.label, data: l.values,
      borderColor: l.color, backgroundColor: l.color,
      pointRadius: 0, pointHoverRadius: 3, borderWidth: 2, tension: 0.25, spanGaps: false,
    }));

    if (_stackChart) { _stackChart.destroy(); _stackChart = null; }
    const ctx = document.getElementById('mod-stack-canvas').getContext('2d');
    _stackChart = QB.charts.createLine(ctx, rate.buckets, datasets, { yFormat: 'rate' });

    // Ribbon ergibt für die Rate keinen Sinn → leeren; Provider-Legende zeigen.
    const ribbonEl = document.getElementById('mod-ribbon');
    if (ribbonEl) ribbonEl.innerHTML = '';
    renderProviderLegend(lineDefs);
  }

  // Legende in Stapel-Reihenfolge; Farben identisch zu den Balkensegmenten.
  function renderLegend(series, order) {
    const el = document.getElementById('mod-legend');
    el.innerHTML = series.map((s) => `
      <div class="mod-legend-item" title="${QB.esc(s.model)}">
        <span class="mod-legend-swatch" style="background:${colorFor(s.model, s.provider, order)}"></span>${QB.esc(s.model)}
      </div>`).join('');
  }

  function renderProviderLegend(lineDefs) {
    const el = document.getElementById('mod-legend');
    el.innerHTML = lineDefs.map((l) => `
      <div class="mod-legend-item" title="${QB.esc(l.label)}">
        <span class="mod-legend-swatch" style="background:${l.color}"></span>${QB.esc(l.label)}
      </div>`).join('');
  }

  function renderRibbon(days, granularity) {
    const el = document.getElementById('mod-ribbon');
    const ribbon = calc.providerRibbon(days, _metric, granularity);
    el.innerHTML = ribbon.map((r) => `
      <div class="mod-ribbon-cell" title="${QB.esc(r.bucket)}: Claude ${(r.claudeShare * 100).toFixed(0)}%">
        <div class="mod-ribbon-claude" style="width:${(r.claudeShare * 100).toFixed(1)}%"></div>
        <div class="mod-ribbon-codex" style="width:${((1 - r.claudeShare) * 100).toFixed(1)}%"></div>
      </div>`).join('');
  }

  function renderScatter(initial) {
    const canvas = document.getElementById('mod-scatter-canvas');
    if (!canvas) return; // Benchmark-Sektion nicht gerendert (keine Benchmarks)

    const benchmark = selectedBenchmark();
    const rows = calc.tableRows(visibleDays(), benchmark.scores);
    const pts = calc.scatterPoints(rows, _data.minModelTokenSharePct || 0);

    // Hinweis statt leerem Graph, wenn im gewählten Fenster/Provider-Filter
    // kein Modell mit Benchmark-Score Kosten verursacht hat.
    const emptyNote = document.getElementById('mod-scatter-empty');
    if (emptyNote) {
      const isEmpty = pts.length === 0;
      emptyNote.hidden = !isEmpty;
      emptyNote.textContent = isEmpty
        ? 'No models with benchmark score in the selected period/filter.'
        : '';
      canvas.style.visibility = isEmpty ? 'hidden' : '';
    }

    // Trendkurve „erwartete Intelligenz für diesen Preis" (y = a + b·ln x) über die
    // sichtbaren Punkte; null bei < 4 Punkten o. entarteten x → keine Linie.
    const trendFit = calc.scatterTrendCurve(pts);
    const datasets = [{
      data: pts.map((p) => ({ x: p.x, y: p.y, r: p.r })),
      pointsMeta: pts,
      trendFit, // vom Tooltip fürs Residuum gelesen (überlebt den Update-Pfad)
      ...calc.scatterBubbleColors(pts, QB.providerColor),
      borderWidth: 1,
      hoverRadius: 2,
      order: 0, // über der Trendlinie
    }];
    if (trendFit) {
      datasets.push({
        type: 'line',
        data: trendFit.samples,
        parsing: false,
        pointRadius: 0,
        pointHitRadius: 0,
        fill: false,
        borderColor: 'rgba(255,255,255,0.7)',
        borderWidth: 2,
        tension: 0,
        order: 10, // hinter den Blasen gezeichnet
      });
    }
    const data = { datasets };
    const axisColors = calc.scatterAxisColorScale(pts);
    const optimumRegion = calc.scatterOptimumRegion(pts);
    // Beim (Neu-)Aufbau der UI ist das Canvas-Element frisch — ein zuvor an das
    // alte (jetzt detachte) Canvas gebundenes Chart würde sonst ins Leere
    // zeichnen. Daher bei initial=true zerstören und neu erstellen.
    if (_scatterChart && !initial) {
      _scatterChart.data = data;
      applyScatterAxisColors(_scatterChart, axisColors);
      _scatterChart.options.scales.y.title.text = benchmarkAxisTitle(benchmark);
      _scatterChart.options.plugins.scatterOptimumRegion.region = optimumRegion;
      _scatterChart.update();
      return;
    }
    if (_scatterChart) _scatterChart.destroy();
    const ctx = canvas.getContext('2d');
    _scatterChart = new Chart(ctx, {
      type: 'bubble',
      data,
      plugins: [SCATTER_OPTIMUM_PLUGIN],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0f1319', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
            titleColor: '#b4c8d8', bodyColor: '#8298aa', padding: 8,
            filter: (item) => Array.isArray(item.dataset.pointsMeta), // Trendlinie nicht hoverbar
            callbacks: {
              label: (item) => {
                const p = item.dataset.pointsMeta[item.dataIndex];
                const base = ' ' + p.model + ': Score ' + p.y + ' · $' + p.x.toFixed(2) + '/MTok · ' + p.sharePct.toFixed(1) + '% of cost';
                const resid = calc.trendResidual(p, item.dataset.trendFit);
                if (resid == null) return base;
                const sign = resid >= 0 ? '+' : '−';
                const arrow = resid >= 0 ? '▲' : '▼';
                return [base, ' ' + sign + Math.abs(resid).toFixed(1) + ' ' + (resid >= 0 ? 'above' : 'below') + ' trend ' + arrow];
              },
            },
          },
          scatterOptimumRegion: { region: optimumRegion },
        },
        scales: {
          x: {
            title: { display: true, text: '$ / MTok (effective)', color: '#708090', font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false },
            ticks: { color: (ctx) => axisColors.costColor(tickValue(ctx)), font: { family: "'IBM Plex Mono', monospace", size: 9 },
                     callback: (v) => '$' + Number(v).toFixed(1) },
          },
          y: {
            title: { display: true, text: benchmarkAxisTitle(benchmark), color: '#708090', font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false },
            ticks: { color: (ctx) => axisColors.scoreColor(tickValue(ctx)), font: { family: "'IBM Plex Mono', monospace", size: 9 } },
          },
        },
      },
    });
  }

  function applyScatterAxisColors(chart, axisColors) {
    chart.options.scales.x.ticks.color = (ctx) => axisColors.costColor(tickValue(ctx));
    chart.options.scales.y.ticks.color = (ctx) => axisColors.scoreColor(tickValue(ctx));
  }

  function tickValue(ctx) {
    return ctx && ctx.tick ? ctx.tick.value : 0;
  }

  const COLUMNS = [
    ['model', 'Model', 'txt'], ['inputTokens', 'Input', 'num'], ['outputTokens', 'Output', 'num'],
    ['cacheReadTokens', 'Cache R', 'num'], ['cacheCreationTokens', 'Cache C', 'num'],
    ['totalTokens', 'Total', 'num'], ['costUSD', 'Cost', 'num'], ['effPerMTok', '$/MTok', 'num'],
    ['score', 'Score', 'num'], ['scorePerDollar', 'Score/$', 'num'], ['sharePct', 'Share', 'num'],
    ['cacheHitRate', 'Cache hit', 'num'], ['firstUsed', 'First', 'num'], ['lastUsed', 'Last', 'num'],
  ];

  function renderTable() {
    const table = document.getElementById('mod-table');
    const compact = document.body.classList.contains('view-compact');
    const cols = compact ? COLUMNS_COMPACT : COLUMNS;

    const rows = calc.tableRows(visibleDays(), selectedBenchmark().scores);
    rows.sort((a, b) => {
      const av = a[_sortKey], bv = b[_sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return _sortDesc ? -cmp : cmp;
    });

    const fmt = {
      model: (r) => `<span class="mod-dot" style="background:${QB.providerColor(r.provider)}"></span>${QB.esc(r.model)}`,
      inputTokens: (r) => QB.fmtTokens(r.inputTokens),
      outputTokens: (r) => QB.fmtTokens(r.outputTokens),
      cacheReadTokens: (r) => QB.fmtTokens(r.cacheReadTokens),
      cacheCreationTokens: (r) => r.provider === 'codex' ? '—' : QB.fmtTokens(r.cacheCreationTokens),
      totalTokens: (r) => QB.fmtTokens(r.totalTokens),
      costUSD: (r) => '$' + r.costUSD.toFixed(2),
      effPerMTok: (r) => r.effPerMTok != null ? '$' + r.effPerMTok.toFixed(2) : '—',
      score: (r) => r.score != null ? r.score : '—',
      scorePerDollar: (r) => r.scorePerDollar != null ? r.scorePerDollar.toFixed(1) : '—',
      sharePct: (r) => r.sharePct.toFixed(1) + '%',
      cacheHitRate: (r) => r.cacheHitRate != null ? (r.cacheHitRate * 100).toFixed(0) + '%' : '—',
      firstUsed: (r) => r.firstUsed,
      lastUsed: (r) => r.lastUsed,
    };

    const totals = rows.reduce((acc, r) => ({
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      costUSD: acc.costUSD + r.costUSD,
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUSD: 0 });

    const totalRow = compact
      ? `<td class="txt">Σ ${rows.length}</td>
         <td>${QB.fmtTokens(totals.outputTokens)}</td>
         <td>$${totals.costUSD.toFixed(2)}</td>
         <td>${totals.totalTokens > 0 ? '$' + ((totals.costUSD / totals.totalTokens) * 1e6).toFixed(2) : '—'}</td>
         <td></td>`
      : `<td class="txt">Σ ${rows.length} models</td>
         <td>${QB.fmtTokens(totals.inputTokens)}</td><td>${QB.fmtTokens(totals.outputTokens)}</td>
         <td>${QB.fmtTokens(totals.cacheReadTokens)}</td><td>${QB.fmtTokens(totals.cacheCreationTokens)}</td>
         <td>${QB.fmtTokens(totals.totalTokens)}</td><td>$${totals.costUSD.toFixed(2)}</td>
         <td>${totals.totalTokens > 0 ? '$' + ((totals.costUSD / totals.totalTokens) * 1e6).toFixed(2) : '—'}</td>
         <td colspan="6"></td>`;

    table.innerHTML = `
      <thead><tr>${cols.map(([key, label, cls]) => `
        <th class="${cls === 'txt' ? 'txt' : ''} ${_sortKey === key ? (_sortDesc ? 'sorted-desc' : 'sorted-asc') : ''}" data-key="${key}">
          ${label}${_sortKey === key ? '<span class="sort-caret">▾</span>' : ''}
        </th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>${cols.map(([key, , cls]) =>
          `<td class="${cls === 'txt' ? 'txt' : ''}">${fmt[key](r)}</td>`).join('')}</tr>`).join('')}
        <tr class="mod-total">${totalRow}</tr>
      </tbody>`;

    table.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (_sortKey === key) { _sortDesc = !_sortDesc; } else { _sortKey = key; _sortDesc = true; }
      renderTable();
    }));
  }

  const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', other: 'Other' };
  // Token-Typ → Akzentfarbe (identisch zur TOKEN-TYPEN-Sektion, visuell verzahnt).
  const COST_TYPE_COLORS = { input: '#6E8EE8', output: '#52d017', cacheRead: '#56C8D8', cacheCreation: '#E89B6F' };

  // „Echte Nutzung": je Provider eine Tabelle mit Menge + Kosten je Token-Typ,
  // Gesamtzeile zeigt Total-Tokens, Total-$ und effektiven $/MTok. Backend-exakt:
  // Σ Typ-Kosten == Gesamtkosten.
  function renderProviderCosts() {
    const el = document.getElementById('mod-cost-section');
    if (!el) return;
    const providers = calc.providerCostBreakdown(visibleDays());
    const withData = providers.filter((p) => p.totalTokens > 0);
    if (withData.length === 0) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.className = 'an-section';

    const fmtUSD = (v) => '$' + v.toFixed(2);
    const fmtRate = (v) => v != null ? '$' + v.toFixed(2) : '—';

    const blocks = withData.map((p) => {
      const col = QB.providerColor(p.provider);
      const name = QB.esc(PROVIDER_LABELS[p.provider] || p.provider);
      const bodyRows = p.rows.map((r) => `
        <tr>
          <td class="mod-cost-type"><span class="mod-cost-tdot" style="background:${COST_TYPE_COLORS[r.key] || OTHER_COLOR}"></span>${QB.esc(r.label)}</td>
          <td class="mod-cost-share">${r.tokenPct.toFixed(1)}%</td>
          <td>${QB.fmtTokens(r.tokens)}</td>
          <td>${fmtUSD(r.costUSD)}</td>
          <td class="mod-cost-perm">${fmtRate(r.perMTok)}</td>
        </tr>`).join('');
      return `
        <div class="mod-cost-provider" style="--prov-col:${col}">
          <div class="mod-cost-hd">
            <span class="mod-cost-name"><span class="mod-cost-dot"></span>${name}</span>
            <span class="mod-cost-spend">${fmtUSD(p.totalCostUSD)}</span>
          </div>
          <table class="mod-cost-table">
            <thead><tr><th>Token type</th><th class="mod-cost-share">Share</th><th>Amount</th><th>Cost</th><th class="mod-cost-perm">$/MTok</th></tr></thead>
            <tbody>
              ${bodyRows}
              <tr class="mod-cost-total">
                <td>Total</td>
                <td class="mod-cost-share">100.0%</td>
                <td>${QB.fmtTokens(p.totalTokens)}</td>
                <td>${fmtUSD(p.totalCostUSD)}</td>
                <td class="mod-cost-effcell">${fmtRate(p.effPerMTok)}</td>
              </tr>
            </tbody>
          </table>
        </div>`;
    }).join('');

    const anyStale = withData.some((p) => !p.hasCostBreakdown && p.totalCostUSD > 0);

    el.innerHTML = `
      <div class="an-section-head">
        <span class="an-section-title">ACTUAL USAGE · COST BY TOKEN TYPE</span>
      </div>
      <div class="mod-cost-sub">Amount × own $/MTok = cost per type; Total $/MTok = cost per million tokens of actual usage</div>
      ${blocks}
      ${anyStale ? '<div class="mod-cost-note">Per-type costs will be fully populated after the next backfill run.</div>' : ''}`;
  }

  const TOKEN_TYPE_META = [
    { pctKey: 'inputPct',         absKey: 'input',         label: 'Input',   col: '#6E8EE8' },
    { pctKey: 'outputPct',        absKey: 'output',        label: 'Output',  col: '#52d017' },
    { pctKey: 'cacheReadPct',     absKey: 'cacheRead',     label: 'Cache R', col: '#56C8D8' },
    { pctKey: 'cacheCreationPct', absKey: 'cacheCreation', label: 'Cache C', col: '#E89B6F' },
  ];

  function renderTokenTypes() {
    const el = document.getElementById('mod-tt-section');
    if (!el) return;
    const b = calc.tokenTypeBreakdown(visibleDays());
    if (b.total === 0) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.className = 'an-section';
    el.innerHTML = `
      <div class="an-section-head"><span class="an-section-title">TOKEN TYPES</span></div>
      <div class="mod-tt-grid">
        ${TOKEN_TYPE_META.map((t) => `
          <div class="an-stat-tile mod-tt-tile" style="--tt-col:${t.col}">
            <div class="an-stat-lbl"><span class="mod-tt-dot"></span>${QB.esc(t.label)}</div>
            <span class="kv-fill"></span>
            <div class="an-stat-val">${b[t.pctKey].toFixed(2)}%</div>
            <div class="mod-tt-abs">${QB.fmtTokens(b[t.absKey])}</div>
          </div>`).join('')}
      </div>`;
  }

  QB.__modelsTest = { benchmarkAxisTitle };

})();
