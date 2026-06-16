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

  // UI-State (lokales Recompute, kein IPC bei Wechsel)
  let _win = 'all';
  let _metric = 'output';
  let _provider = 'all';
  let _sortKey = 'costUSD';
  let _sortDesc = true;

  const METRIC_LABELS = [
    ['output', 'Out'], ['input', 'In'], ['cacheRead', 'CR'],
    ['cacheCreation', 'CC'], ['total', '∑'], ['cost', '$'],
  ];

  const COLUMNS_COMPACT = [
    ['model', 'Modell', 'txt'],
    ['outputTokens', 'Output', 'num'],
    ['costUSD', 'Kosten', 'num'],
    ['effPerMTok', '$/MTok', 'num'],
    ['sharePct', 'Anteil', 'num'],
  ];
  const CLAUDE_PALETTE = ['#DA785B', '#E89B6F', '#C05A45', '#F0B27A', '#A8442F', '#F5D0A9'];
  const CODEX_PALETTE  = ['#4B55C8', '#6E8EE8', '#56C8D8', '#3A3F8F', '#7A6FF0', '#2E6FBF'];
  const OTHER_COLOR = '#475460';

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
      renderUI();
    } catch (e) {
      console.error('models:get failed', e);
      const msg = (e && e.message) ? e.message : String(e);
      container.innerHTML = `<div class="empty"><span>Fehler: ${QB.esc(msg.slice(0, 300))}</span></div>`;
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
  };

  function loadData() {
    if (_data && !_stale) return Promise.resolve(_data);
    if (!_dataPromise) {
      _dataPromise = QB.ipc.invoke('models:get')
        .then((d) => { _data = d; _stale = false; return d; })
        .catch((err) => { _dataPromise = null; throw err; });
    }
    return _dataPromise;
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  function visibleDays() {
    const byWin = calc.filterWindow(_data.days, _win, today());
    return _provider === 'all' ? byWin : byWin.filter((d) => d.provider === _provider);
  }

  let _modelProvider = new Map();
  let _colorOrder = [];

  function colorFor(model, provider, order) {
    if (model === 'Andere') return OTHER_COLOR;
    const palette = provider === 'claude' ? CLAUDE_PALETTE : CODEX_PALETTE;
    const siblings = order.filter((m) => _modelProvider.get(m) === provider);
    return palette[Math.max(siblings.indexOf(model), 0) % palette.length];
  }

  function renderUI() {
    const container = document.getElementById('models-content');
    _modelProvider = new Map(_data.days.map((d) => [d.model, d.provider]));
    _colorOrder = calc.modelColorOrder(_data.days);
    const hasBenchmarks = Object.keys(_data.benchmarks).length > 0;

    container.innerHTML = `
      <div class="${_animated ? '' : 'mod-stagger'}" id="mod-root">
        <div class="mod-kpi-grid" id="mod-kpis"></div>

        <div class="an-section mod-chart-sec">
          <div class="mod-chart-hd">
            <span class="mod-chart-ttl">VERTEILUNG</span>
            <div class="mod-chart-segs">
              <div class="mod-seg" id="mod-win-pills">
                <button data-win="30d">30T</button>
                <button data-win="90d">90T</button>
                <button data-win="all">∞</button>
              </div>
              <div class="mod-seg" id="mod-provider-pills">
                <button data-prov="all">Alle</button>
                <button data-prov="claude">Claude</button>
                <button data-prov="codex">Codex</button>
              </div>
            </div>
          </div>
          <div class="mod-seg mod-metric-seg" id="mod-metric-pills">
            ${METRIC_LABELS.map(([k, l]) => `<button data-metric="${k}">${l}</button>`).join('')}
          </div>
          <div class="mod-hero-wrap"><canvas id="mod-stack-canvas"></canvas></div>
          <div class="mod-ribbon" id="mod-ribbon"></div>
          <div class="mod-legend" id="mod-legend"></div>
          <div class="mod-note" id="mod-stack-note" hidden></div>
          <div class="mod-note">Ab ${_data.days.length > 0 ? _data.days[0].date : '—'}</div>
        </div>

        ${hasBenchmarks ? `
        <div class="an-section">
          <div class="an-section-head"><span class="an-section-title">PREIS vs. INTELLIGENZ</span></div>
          <div class="mod-scatter-wrap"><canvas id="mod-scatter-canvas"></canvas></div>
          <div class="mod-note" id="mod-scatter-empty" hidden></div>
          <div class="mod-scatter-note">x = $/MTok effektiv (inkl. Cache) · grün = besser, rot = schlechter · ${_data.benchmarksAsOf ? 'Stand ' + QB.esc(_data.benchmarksAsOf) : 'Artificial Analysis'}</div>
        </div>` : ''}

        <div class="an-section">
          <div class="an-section-head"><span class="an-section-title">MODELLE IM DETAIL</span></div>
          <div class="mod-table-scroll"><table class="mod-table" id="mod-table"></table></div>
        </div>
      </div>`;
    _animated = true;

    bindPills();
    syncPills();
    renderKpis();
    renderStack(true);
    if (hasBenchmarks) renderScatter(true);
    renderTable();
  }

  function bindPills() {
    document.querySelectorAll('#mod-win-pills button').forEach((p) =>
      p.addEventListener('click', () => { _win = p.dataset.win; refreshLocal(); }));
    document.querySelectorAll('#mod-metric-pills button').forEach((p) =>
      p.addEventListener('click', () => { _metric = p.dataset.metric; refreshLocal(); }));
    document.querySelectorAll('#mod-provider-pills button').forEach((p) =>
      p.addEventListener('click', () => { _provider = p.dataset.prov; refreshLocal(); }));
  }

  function syncPills() {
    document.querySelectorAll('#mod-win-pills button').forEach((p) => p.classList.toggle('active', p.dataset.win === _win));
    document.querySelectorAll('#mod-metric-pills button').forEach((p) => p.classList.toggle('active', p.dataset.metric === _metric));
    document.querySelectorAll('#mod-provider-pills button').forEach((p) => p.classList.toggle('active', p.dataset.prov === _provider));
  }

  function refreshLocal() {
    syncPills();
    renderKpis();
    renderStack(false);
    renderScatter(false);
    renderTable();
  }

  function renderKpis() {
    const el = document.getElementById('mod-kpis');
    const days = visibleDays();
    const prev = _provider === 'all'
      ? calc.previousWindow(_data.days, _win, today())
      : calc.previousWindow(_data.days, _win, today()).filter((d) => d.provider === _provider);
    const k = calc.computeKpis(days, prev, _data.benchmarks);

    const trend = (deltaPct, invert) => {
      if (deltaPct == null) return '';
      const good = invert ? deltaPct < 0 : deltaPct > 0;
      const cls = deltaPct === 0 ? 'flat' : good ? 'good' : 'bad';
      const arrow = deltaPct === 0 ? '→' : deltaPct > 0 ? '▲' : '▼';
      return `<span class="mod-kpi-trend ${cls}">${arrow}${Math.abs(deltaPct).toFixed(0)}%</span>`;
    };

    el.innerHTML = `
      <div class="an-stat-tile mod-kpi-lead">
        <div class="an-stat-lbl">Ø $/MTok effektiv</div>
        <div class="an-stat-val">${k.effPerMTok != null ? '$' + k.effPerMTok.toFixed(2) : '—'}${trend(k.effPerMTokDeltaPct, true)}</div>
        <div class="mod-kpi-sub">Gesamtkosten ÷ Gesamttokens, inkl. Cache</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Aktive Modelle</div>
        <div class="an-stat-val">${k.activeModels}${k.activeModelsDelta != null
          ? `<span class="mod-kpi-trend flat">${k.activeModelsDelta >= 0 ? '+' : ''}${k.activeModelsDelta}</span>` : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top nach Kosten</div>
        <div class="an-stat-val" title="${k.topCost ? QB.esc(k.topCost.model) : ''}">${k.topCost ? QB.esc(shortName(k.topCost.model)) : '—'}</div>
        <div class="mod-kpi-sub">${k.topCost ? '$' + k.topCost.costUSD.toFixed(0) + ' · ' + k.topCost.sharePct.toFixed(0) + '%' : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top nach Output</div>
        <div class="an-stat-val" title="${k.topOutput ? QB.esc(k.topOutput.model) : ''}">${k.topOutput ? QB.esc(shortName(k.topOutput.model)) : '—'}</div>
        <div class="mod-kpi-sub">${k.topOutput ? QB.fmtTokens(k.topOutput.outputTokens) : ''}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Preis/Leistung</div>
        <div class="an-stat-val" title="${k.bestValue ? QB.esc(k.bestValue.model) : ''}">${k.bestValue ? QB.esc(shortName(k.bestValue.model)) : '—'}</div>
        <div class="mod-kpi-sub">${k.bestValue ? 'Score/$ am höchsten' : 'kein Score verfügbar'}</div>
      </div>
      <div class="an-stat-tile">
        <div class="an-stat-lbl">Top-3-Anteil</div>
        <div class="an-stat-val">${k.top3SharePct.toFixed(0)}%</div>
        <div class="mod-kpi-sub">Kosten-Konzentration</div>
      </div>`;
  }

  function shortName(model) {
    return QB.shortModelName(model);
  }

  function renderStack(initial) {
    const note = document.getElementById('mod-stack-note');
    const days = visibleDays();
    const granularity = _win === 'all' ? 'weekly' : 'daily';
    const stack = calc.buildStack(days, _metric, granularity, 0.01);

    const empty = stack.series.length === 0
      || stack.series.every((s) => s.values.every((v) => v === 0));
    note.hidden = !empty;
    if (empty) {
      note.textContent = _metric === 'cacheCreation' && _provider === 'codex'
        ? 'Cache-Creation-Tokens gibt es nur bei Claude.'
        : 'Keine Daten im gewählten Fenster.';
    }

    const totals = stack.buckets.map((_, i) => stack.series.reduce((s, x) => s + x.values[i], 0));
    const datasets = stack.series.map((s) => ({
      label: s.model,
      data: s.values.map((v, i) => (totals[i] > 0 ? (v / totals[i]) * 100 : 0)),
      rawValues: s.values,
      backgroundColor: colorFor(s.model, s.provider, _colorOrder),
      hoverBackgroundColor: colorFor(s.model, s.provider, _colorOrder) + 'E6',
    }));

    if (_stackChart && !initial) {
      _stackChart.data.labels = stack.buckets;
      _stackChart.data.datasets = datasets;
      _stackChart.options.qbFormat = _metric === 'cost' ? 'cost' : 'tokens';
      _stackChart.update();
    } else {
      if (_stackChart) _stackChart.destroy();
      const ctx = document.getElementById('mod-stack-canvas').getContext('2d');
      _stackChart = QB.charts.createStacked100(ctx, stack.buckets, datasets,
        { format: _metric === 'cost' ? 'cost' : 'tokens' });
    }

    renderRibbon(days, granularity);
    renderLegend(stack.series);
  }

  // Legende in Stapel-Reihenfolge; Farben identisch zu den Balkensegmenten.
  function renderLegend(series) {
    const el = document.getElementById('mod-legend');
    el.innerHTML = series.map((s) => `
      <div class="mod-legend-item" title="${QB.esc(s.model)}">
        <span class="mod-legend-swatch" style="background:${colorFor(s.model, s.provider, _colorOrder)}"></span>${QB.esc(s.model)}
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

    const rows = calc.tableRows(visibleDays(), _data.benchmarks);
    const pts = calc.scatterPoints(rows);

    // Hinweis statt leerem Graph, wenn im gewählten Fenster/Provider-Filter
    // kein Modell mit Benchmark-Score Kosten verursacht hat.
    const emptyNote = document.getElementById('mod-scatter-empty');
    if (emptyNote) {
      const isEmpty = pts.length === 0;
      emptyNote.hidden = !isEmpty;
      emptyNote.textContent = isEmpty
        ? 'Keine Modelle mit Benchmark-Score im gewählten Zeitraum/Filter.'
        : '';
      canvas.style.visibility = isEmpty ? 'hidden' : '';
    }

    const data = {
      datasets: [{
        data: pts.map((p) => ({ x: p.x, y: p.y, r: p.r })),
        pointsMeta: pts,
        ...calc.scatterBubbleColors(pts, QB.providerColor),
        borderWidth: 1,
        hoverRadius: 2,
      }],
    };
    const axisColors = calc.scatterAxisColorScale(pts);
    // Beim (Neu-)Aufbau der UI ist das Canvas-Element frisch — ein zuvor an das
    // alte (jetzt detachte) Canvas gebundenes Chart würde sonst ins Leere
    // zeichnen. Daher bei initial=true zerstören und neu erstellen.
    if (_scatterChart && !initial) {
      _scatterChart.data = data;
      applyScatterAxisColors(_scatterChart, axisColors);
      _scatterChart.update();
      return;
    }
    if (_scatterChart) _scatterChart.destroy();
    const ctx = canvas.getContext('2d');
    _scatterChart = new Chart(ctx, {
      type: 'bubble',
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0f1319', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
            titleColor: '#b4c8d8', bodyColor: '#8298aa', padding: 8,
            callbacks: {
              label: (item) => {
                const p = item.dataset.pointsMeta[item.dataIndex];
                return ' ' + p.model + ': Score ' + p.y + ' · $' + p.x.toFixed(2) + '/MTok · ' + p.sharePct.toFixed(1) + '% der Kosten';
              },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: '$ / MTok (effektiv)', color: '#708090', font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false },
            ticks: { color: (ctx) => axisColors.costColor(tickValue(ctx)), font: { family: "'IBM Plex Mono', monospace", size: 9 },
                     callback: (v) => '$' + Number(v).toFixed(1) },
          },
          y: {
            title: { display: true, text: 'Intelligence Index', color: '#708090', font: { size: 9 } },
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
    ['model', 'Modell', 'txt'], ['inputTokens', 'Input', 'num'], ['outputTokens', 'Output', 'num'],
    ['cacheReadTokens', 'Cache R', 'num'], ['cacheCreationTokens', 'Cache C', 'num'],
    ['totalTokens', 'Total', 'num'], ['costUSD', 'Kosten', 'num'], ['effPerMTok', '$/MTok', 'num'],
    ['score', 'Score', 'num'], ['scorePerDollar', 'Score/$', 'num'], ['sharePct', 'Anteil', 'num'],
    ['cacheHitRate', 'Cache-Hit', 'num'], ['firstUsed', 'Erste', 'num'], ['lastUsed', 'Letzte', 'num'],
  ];

  function renderTable() {
    const table = document.getElementById('mod-table');
    const compact = document.body.classList.contains('view-compact');
    const cols = compact ? COLUMNS_COMPACT : COLUMNS;

    const rows = calc.tableRows(visibleDays(), _data.benchmarks);
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
      : `<td class="txt">Σ ${rows.length} Modelle</td>
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

})();
