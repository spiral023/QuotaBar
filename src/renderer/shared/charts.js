/* global QB */
'use strict';

window.QB = window.QB || {};
QB.charts = QB.charts || {};
QB.charts.mutedTextColor = '#7e92a4';

QB.charts.createLine = function(ctx, labels, datasets) {
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
            label: (item) => ` ${item.dataset.label}: $${item.parsed.y.toFixed(2)}`,
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
            callback: (v) => '$' + Number(v).toFixed(0),
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

// 100% gestapelte Balken für den Models-Tab. datasets[i].rawValues trägt die
// Absolutwerte für den Tooltip; data ist bereits in Prozent normalisiert.
QB.charts.createStacked100 = function(ctx, labels, datasets, opts) {
  const fmtAbs = opts && opts.format === 'cost'
    ? (v) => '$' + (v < 0.01 ? Number(v).toFixed(4) : Number(v).toFixed(2))
    : (v) => QB.fmtTokens(v);
  return new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
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
              return ' ' + item.dataset.label + ': ' + fmtAbs(raw) + ' (' + item.parsed.y.toFixed(1) + '%)';
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
