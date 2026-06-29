'use strict';

window.QB = window.QB || {};

QB.usageColor = function usageColor(pct) {
  if (pct < 70) return 'green';
  if (pct < 85) return 'yellow';
  if (pct < 95) return 'orange';
  return 'red';
};

QB.accentVar = function accentVar(pct) {
  if (typeof pct !== 'number') return 'var(--gray)';
  if (pct < 70) return 'var(--green)';
  if (pct < 85) return 'var(--yellow)';
  if (pct < 95) return 'var(--orange)';
  return 'var(--red)';
};

QB.providerColor = function providerColor(name) {
  const map = { claude: '#DA785B', codex: '#4B55C8', gemini: '#8b70f0' };
  return map[name] || '#7a8999';
};

QB.roiColor = function roiColor(factor) {
  if (factor >= 2) return 'var(--green)';
  if (factor >= 1) return 'var(--yellow)';
  return 'var(--gray)';
};
