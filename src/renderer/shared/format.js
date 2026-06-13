'use strict';

window.QB = window.QB || {};

QB.esc = function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

QB.fmtTokens = function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)         return (n / 1_000).toFixed(1) + 'K';
  return String(n);
};

QB.formatCountdown = function formatCountdown(isoStr) {
  const ms = new Date(isoStr).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return 'now';
  const s  = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p  = n => String(n).padStart(2, '0');
  return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
};

QB.fmtDate = function fmtDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleDateString('de-AT', { day: '2-digit', month: 'short' });
};

QB.fmtUSD = function fmtUSD(n) {
  if (typeof n !== 'number') return '—';
  return '$' + n.toFixed(2);
};
