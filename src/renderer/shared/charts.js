/* global QB */
'use strict';

window.QB = window.QB || {};
QB.charts = QB.charts || {};
QB.charts.mutedTextColor = '#7e92a4';

QB.charts.createLine = function(ctx, labels, datasets, opts) {
  const isRoi  = opts?.yFormat === 'roi';
  const yFmt   = isRoi ? (v) => Number(v).toFixed(1) + '×' : (v) => '$' + Number(v).toFixed(0);
  const tipFmt = isRoi
    ? (item) => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)}×`
    : (item) => ` ${item.dataset.label}: $${item.parsed.y.toFixed(2)}`;
  return new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1319',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#b4c8d8',
          bodyColor: '#8298aa',
          padding: 8,
          callbacks: {
            label: tipFmt,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.07)' },
          ticks: {
            color: QB.charts.mutedTextColor,
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            maxTicksLimit: 8,
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.07)' },
          ticks: {
            color: QB.charts.mutedTextColor,
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            callback: yFmt,
          },
          beginAtZero: true,
        },
      },
    },
  });
};

QB.charts.createStackedBar = function(ctx, labels, datasets, opts) {
  const isTokens = opts?.yFormat === 'tokens';
  const yFmt  = isTokens
    ? (v) => QB.fmtTokens(v)
    : (v) => '$' + (v < 0.01 ? Number(v).toFixed(3) : Number(v).toFixed(2));
  const tipFmt = isTokens
    ? (item) => ` ${item.dataset.label}: ${QB.fmtTokens(item.parsed.y)}`
    : (item) => ` ${item.dataset.label}: $${item.parsed.y < 0.01 ? item.parsed.y.toFixed(4) : item.parsed.y.toFixed(3)}`;
  return new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1319',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#b4c8d8',
          bodyColor: '#8298aa',
          padding: 8,
          callbacks: { label: tipFmt },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: QB.charts.mutedTextColor,
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            maxRotation: 45,
            autoSkip: true,
            maxTicksLimit: 14,
          },
        },
        y: {
          stacked: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { display: false },
          beginAtZero: true,
          ticks: {
            color: QB.charts.mutedTextColor,
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            callback: yFmt,
          },
        },
      },
    },
  });
};

QB.charts.createDoughnut = function(ctx, labels, data, colors) {
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1319',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#b4c8d8',
          bodyColor: '#8298aa',
          callbacks: {
            label: (item) => ` ${item.label}: $${item.parsed.toFixed(2)}`,
          },
        },
      },
    },
  });
};

/**
 * Weekly-Budget-Verlauf: kumulierte Weekly-% über das aktuelle Fenster,
 * gestrichelte Projektion bis zur Prognose, vertikale 5h-Reset-Marker.
 */
QB.weeklyBudgetChart = function (ctx, series, forecast, windowEndIso) {
  const histData = series.points.map(p => ({ x: new Date(p.t).getTime(), y: p.weeklyPct }));
  const datasets = [{
    label: 'Weekly',
    data: histData,
    borderColor: '#4a9eda',
    backgroundColor: 'rgba(74,158,218,0.08)',
    borderWidth: 2,
    pointRadius: 0,
    fill: true,
    tension: 0.2,
    spanGaps: false, // null-Punkte (Lücke/Reset) unterbrechen Linie + Fläche
  }];
  if (histData.length > 0 && forecast && forecast.primaryAt && !forecast.primaryLastsUntilReset) {
    const last = histData[histData.length - 1];
    datasets.push({
      label: 'Prognose',
      data: [last, { x: new Date(forecast.primaryAt).getTime(), y: 100 }],
      borderColor: '#d95757',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      fill: false,
    });
  }
  const resetMs = series.fiveHourResets.map(t => new Date(t).getTime());
  const resetLines = {
    id: 'wbResetLines',
    afterDraw(chart) {
      const { ctx: c, chartArea, scales } = chart;
      if (!scales.x) return;
      c.save();
      c.strokeStyle = 'rgba(139,144,160,0.35)';
      c.setLineDash([3, 3]);
      for (const ms of resetMs) {
        const x = scales.x.getPixelForValue(ms);
        if (x < chartArea.left || x > chartArea.right) continue;
        c.beginPath();
        c.moveTo(x, chartArea.top);
        c.lineTo(x, chartArea.bottom);
        c.stroke();
      }
      c.restore();
    },
  };
  const xMax = windowEndIso ? new Date(windowEndIso).getTime() : undefined;
  return new Chart(ctx, {
    type: 'line',
    data: { datasets },
    plugins: [resetLines],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          type: 'linear',
          min: histData.length > 0 ? histData[0].x : undefined,
          max: xMax,
          grid: { color: 'rgba(255,255,255,0.04)' },
          // Genau ein Tick je Kalendertag (lokale Mitternacht) erzwingen, damit
          // auch in schmalen Fenstern alle Wochentage sichtbar bleiben.
          afterBuildTicks: (scale) => {
            const { min, max } = scale;
            if (min == null || max == null) return;
            const ticks = [];
            const d = new Date(min);
            d.setHours(0, 0, 0, 0);
            if (d.getTime() < min) d.setDate(d.getDate() + 1);
            while (d.getTime() <= max) {
              ticks.push({ value: d.getTime() });
              d.setDate(d.getDate() + 1);
            }
            scale.ticks = ticks;
          },
          ticks: {
            color: '#8b90a0',
            font: { size: 9 },
            autoSkip: false, // kein automatisches Ausdünnen der Wochentags-Labels
            maxRotation: 0,
            minRotation: 0,
            callback: (v) => new Date(v).toLocaleDateString('de-DE', { weekday: 'short' }),
          },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#8b90a0', font: { size: 9 }, callback: (v) => `${v}%` },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
            label: (item) => `${item.parsed.y.toFixed(1)} %`,
          },
        },
      },
    },
  });
};

// 100% gestapelte Balken für den Models-Tab. datasets[i].rawValues trägt die
// Absolutwerte für den Tooltip; data ist bereits in Prozent normalisiert.
QB.charts.createStacked100 = function(ctx, labels, datasets, opts) {
  // Format liegt in options.qbFormat, damit es bei chart.update() nach einem
  // Metrik-Wechsel mitwechseln kann (Closure würde das Erstellungsformat einfrieren).
  const fmtAbs = (chart, v) => chart.options.qbFormat === 'cost'
    ? '$' + (v < 0.01 ? Number(v).toFixed(4) : Number(v).toFixed(2))
    : QB.fmtTokens(v);
  return new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      qbFormat: opts && opts.format === 'cost' ? 'cost' : 'tokens',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      datasets: { bar: { categoryPercentage: 1.0, barPercentage: 0.96 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1319',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#b4c8d8',
          bodyColor: '#8298aa',
          padding: 8,
          filter: (item) => item.parsed.y > 0,
          callbacks: {
            label: (item) => {
              const raw = item.dataset.rawValues ? item.dataset.rawValues[item.dataIndex] : 0;
              return ' ' + item.dataset.label + ': ' + fmtAbs(item.chart, raw) + ' (' + item.parsed.y.toFixed(1) + '%)';
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: '#708090',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
          },
        },
        y: {
          stacked: true,
          min: 0,
          max: 100,
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { display: false },
          ticks: {
            color: '#708090',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            stepSize: 25,
            callback: (v) => (v === 0 || v === 100 ? '' : v + '%'),
          },
        },
      },
    },
  });
};
