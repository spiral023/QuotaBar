/* global QB */
'use strict';

window.QB = window.QB || {};
QB.charts = QB.charts || {};

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
            color: '#506070',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            maxTicksLimit: 8,
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.07)' },
          ticks: {
            color: '#506070',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            callback: (v) => '$' + Number(v).toFixed(0),
          },
          beginAtZero: true,
        },
      },
    },
  });
};

QB.charts.createStackedBar = function(ctx, labels, datasets) {
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
          callbacks: {
            label: (item) => ` ${item.dataset.label}: $${item.parsed.y < 0.01 ? item.parsed.y.toFixed(4) : item.parsed.y.toFixed(3)}`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: '#506070',
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
            color: '#506070',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            callback: (v) => '$' + (v < 0.01 ? Number(v).toFixed(3) : Number(v).toFixed(2)),
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
