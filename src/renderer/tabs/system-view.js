/* global QB */
'use strict';

(function () {
  function groupSizeBytes(pathIds, appPaths) {
    const ids = new Set(pathIds);
    return appPaths.filter((p) => ids.has(p.id) && p.exists).reduce((sum, p) => sum + p.totalBytes, 0);
  }

  function deleteGroupRow(group, appPaths) {
    const size = groupSizeBytes(group.pathIds, appPaths);
    return `<div class="sys-delete-row" data-delete-group="${QB.esc(group.id)}">
      <div class="sys-del-check-box">
        <svg class="sys-del-check-mark" width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="var(--green)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 5l2.5 2.5L8 3"/>
        </svg>
      </div>
      <div class="sys-del-info">
        <div class="sys-del-label">${QB.esc(group.label)}</div>
        <div class="sys-del-note">${QB.esc(group.note)}</div>
      </div>
      <div class="sys-del-size">${size > 0 ? fmtBytes(size) : '—'}</div>
    </div>`;
  }

  async function openPath(target) {
    try {
      const result = await QB.ipc.invoke('system:open-path', target);
      if (!result?.ok) console.error('system:open-path failed', result?.error);
    } catch (e) {
      console.error('system:open-path failed', e);
    }
  }

  function dsRow(label, info) {
    const s = info?.status ?? null;
    let text, color, meta = '';
    if (!s) {
      text = 'Not loaded yet'; color = '#888';
    } else {
      if (s.ok && s.source === 'live') { text = 'Downloaded'; color = 'var(--green)'; }
      else if (s.source === 'offline') { text = 'Offline mode'; color = '#9aa0a6'; }
      else { text = 'Fallback (download failed)'; color = '#e0a030'; }
      const detailHtml = s.detail ? `<div class="sys-path-meta-detail">${QB.esc(s.detail)}</div>` : '';
      const timeLabel = s.ok && s.source === 'live' ? 'last refreshed' : 'last checked';
      const timeHtml = s.at ? `<div class="sys-path-meta-time">${timeLabel} ${relativeTime(s.at)}</div>` : '';
      meta = detailHtml + timeHtml;
    }
    const openFile = sourceOpenFile(info);
    const title = s && s.error ? QB.esc(s.error) : (s && s.at ? formatDateTime(s.at) : '');
    return `<div class="sys-path-row"${title ? ` title="${title}"` : ''}>
      <div class="sys-path-label"><div class="sys-path-name">${QB.esc(label)}</div></div>
      <div class="sys-path-value" style="color:${color}">● ${QB.esc(text)}</div>
      <div class="sys-path-meta">${meta}</div>
      <button class="sys-open-btn" ${openFile ? `data-open-path="${QB.esc(openFile.path)}"` : 'disabled'}
              title="${openFile ? `Open ${QB.esc(openFile.label)}` : 'No local file yet'}" aria-label="Open data source file">
        ${folderIcon()}
      </button>
    </div>`;
  }

  function sourceOpenFile(info) {
    if (info?.dataFile?.exists) return { path: info.dataFile.path, label: 'data file' };
    if (info && Object.prototype.hasOwnProperty.call(info, 'dataFile')) return null;
    if (info?.statusFile?.exists) return { path: info.statusFile.path, label: 'status file' };
    return null;
  }

  function dataSourcesPanelHtml(ds) {
    ds = ds || {};
    return `<div class="sys-panel">
      <div class="sys-section-head">
        <span class="sys-section-title">Pricing &amp; FX data</span>
      </div>
      <div class="sys-path-list">
        ${dsRow('LiteLLM model prices', ds.litellm)}
        ${dsRow('FX rates (EUR→USD)', ds.fx)}
      </div>
      <div class="sys-note">Downloaded = last successful remote refresh. Fallback = refresh failed and cached/built-in data is used. Offline = pricing offline mode.</div>
    </div>`;
  }

  function kpi(label, value, sub) {
    return `<div class="sys-kpi">
      <div class="sys-kpi-label">${QB.esc(label)}</div>
      <div class="sys-kpi-value">${QB.esc(value)}</div>
      <div class="sys-kpi-sub">${QB.esc(sub)}</div>
    </div>`;
  }

  function agentCard(agent) {
    return `<div class="sys-agent-card">
      <div class="sys-agent-top">
        <div class="sys-agent-logo"><img src="${QB.esc(agent.logo)}" alt="" aria-hidden="true" draggable="false"></div>
        <div class="sys-agent-info">
          <div class="sys-agent-name">${QB.esc(agent.name)}</div>
          <div class="sys-agent-vendor">${QB.esc(agent.vendor)}</div>
        </div>
        <span class="sys-status ${QB.esc(agent.status)}">${statusLabel(agent.status)}</span>
      </div>
      <div class="sys-agent-stats">
        <div class="sys-mini-stat">
          <div class="sys-mini-label">Files</div>
          <div class="sys-mini-value">${fmtCount(agent.totals.fileCount)}</div>
        </div>
        <div class="sys-mini-stat">
          <div class="sys-mini-label">Size</div>
          <div class="sys-mini-value">${fmtBytes(agent.totals.totalBytes)}</div>
        </div>
      </div>
    </div>`;
  }

  function categoryCard(category) {
    return `<div class="sys-cat">
      <div class="sys-cat-label">${QB.esc(category.label)}</div>
      <div class="sys-cat-value">${fmtCount(category.fileCount)}</div>
      <div class="sys-cat-sub">${fmtBytes(category.totalBytes)}</div>
    </div>`;
  }

  function pathRow(item, owner) {
    const exists = item.exists;
    const meta = exists ? `${fmtCount(item.fileCount)} · ${fmtBytes(item.totalBytes)}` : 'not found';
    const title = `${owner} · ${item.label}`;
    return `<div class="sys-path-row">
      <div class="sys-path-label">
        <div class="sys-path-name" title="${QB.esc(title)}">${QB.esc(item.label)}</div>
        <div class="sys-path-kind">${QB.esc(owner)} · ${QB.esc(categoryLabel(item.category))}</div>
      </div>
      <div class="sys-path-value" title="${QB.esc(item.path)}">${QB.esc(item.path)}</div>
      <div class="sys-path-meta">${QB.esc(meta)}</div>
      <button class="sys-open-btn" ${item.openPath ? `data-open-path="${QB.esc(item.openPath)}"` : 'disabled'}
              title="${item.openPath ? 'Open in Explorer' : 'Path not found'}" aria-label="Open in Explorer">
        ${folderIcon()}
      </button>
    </div>`;
  }

  function statusLabel(status) {
    return ({ connected: 'Connected', detected: 'Data', not_found: 'Missing' })[status] ?? status;
  }

  function categoryLabel(category) {
    return ({ logs: 'Logs', credentials: 'Credentials', config: 'Config', cache: 'Cache' })[category] ?? category;
  }

  function fmtCount(n) {
    if (!n) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function fmtBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unit]}`;
  }

  function fmtSeconds(ms) {
    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
  }

  function fmtOptionalSeconds(ms) {
    return typeof ms === 'number' && Number.isFinite(ms) ? fmtSeconds(ms) : '—';
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
      const trimmed = String(value || '').trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out;
  }

  function newestDate(values) {
    return values.filter(Boolean).sort().pop() ?? null;
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function relativeTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return '—';
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min`;
    const hours = Math.round(min / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
  }

  function githubIcon() {
    return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
        0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
        -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
        .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
        -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27
        c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
        .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
        0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
    </svg>`;
  }

  function folderIcon() {
    return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M1.5 4.3h4l1.1 1.2h5.9v5.2a1.3 1.3 0 0 1-1.3 1.3H2.8a1.3 1.3 0 0 1-1.3-1.3V4.3Z"/>
      <path d="M1.5 4.4V3.2A1.2 1.2 0 0 1 2.7 2h2.4l1.2 1.2h5a1.2 1.2 0 0 1 1.2 1.2v1.1"/>
    </svg>`;
  }

  function refreshIcon() {
    return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M1.5 7a5.5 5.5 0 0 1 9.9-3.3"/>
      <path d="M11 2.2 13 4l-2 1.8"/>
      <path d="M12.5 7a5.5 5.5 0 0 1-9.9 3.3"/>
      <path d="M3 11.8 1 10l2-1.8"/>
    </svg>`;
  }

  function warnIcon() {
    return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 1.5L12.5 11H1.5L7 1.5Z"/>
      <path d="M7 5.5v2.5M7 9.5v.5"/>
    </svg>`;
  }

  function trashIcon() {
    return `<svg width="12" height="12" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 4h10M5 4V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V4M12 4l-.8 7.5a1 1 0 0 1-1 .9H3.8a1 1 0 0 1-1-.9L2 4"/>
    </svg>`;
  }

  function plusIcon() {
    return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M7 2.5v9M2.5 7h9"/>
    </svg>`;
  }

  function saveIcon() {
    return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.2 2h8.1l1.5 1.5v8.3H2.2V2Z"/>
      <path d="M4 2v3.2h5.4V2M4.2 11.8V8h5.6v3.8"/>
    </svg>`;
  }

  QB.systemView = { kpi, agentCard, fmtCount, fmtBytes, categoryCard, pathRow, openPath, folderIcon, fmtSeconds, fmtOptionalSeconds, uniqueStrings, newestDate, formatDateTime, relativeTime, githubIcon, refreshIcon, warnIcon, trashIcon, plusIcon, saveIcon, deleteGroupRow, groupSizeBytes, dataSourcesPanelHtml };
})();
