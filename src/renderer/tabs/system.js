/* global QB */
'use strict';

window.QB = window.QB || {};

(function () {
  let _data = null;
  let _loading = null;
  let _animated = false;

  QB.renderSystem = async function renderSystem() {
    const wrap = document.getElementById('system-content');
    if (!wrap) return;
    if (_data) { renderUI(wrap, _data); return; }
    wrap.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
    try {
      _data = await loadData();
      renderUI(wrap, _data);
    } catch (e) {
      console.error('system:get failed', e);
      wrap.innerHTML = '<div class="empty"><span>Systemdaten nicht verfügbar.</span></div>';
    }
  };

  function loadData(force) {
    if (!force && _data) return Promise.resolve(_data);
    if (!force && _loading) return _loading;
    _loading = QB.ipc.invoke('system:get')
      .then((report) => { _data = report; return report; })
      .finally(() => { _loading = null; });
    return _loading;
  }

  function renderUI(wrap, report) {
    const connected = report.agents.filter((agent) => agent.status === 'connected').length;
    const detected = report.agents.filter((agent) => agent.status !== 'not_found').length;
    const lastModified = newestDate([
      report.totals.lastModifiedAt,
      ...report.agents.map((agent) => agent.totals.lastModifiedAt),
      report.app.totals.lastModifiedAt,
    ]);

    wrap.innerHTML = `
      <div class="${_animated ? '' : 'sys-stagger'}">
        <div class="sys-toolbar">
          <div class="sys-toolbar-main">
            <div class="sys-title">Lokale Agent- und App-Daten</div>
            <div class="sys-sub">Scan: ${formatDateTime(report.generatedAt)} · Inhalte von Credentials werden nicht gelesen</div>
          </div>
          <button class="sys-action secondary" id="sys-open-app" title="QuotaBar-Datenordner öffnen">
            ${folderIcon()} App
          </button>
          <button class="sys-action" id="sys-refresh" title="Neu scannen">
            ${refreshIcon()} Scan
          </button>
        </div>

        <div class="sys-kpis">
          ${kpi('Agents', `${detected}/${report.agents.length}`, `${connected} verbunden`)}
          ${kpi('Dateien', fmtCount(report.totals.fileCount), 'erkannte lokale Daten')}
          ${kpi('Größe', fmtBytes(report.totals.totalBytes), 'Summe bekannter Pfade')}
          ${kpi('Zuletzt', lastModified ? relativeTime(lastModified) : '—', lastModified ? formatDateTime(lastModified) : 'keine Dateien')}
        </div>

        <div class="sys-layout">
          <div>
            <div class="sys-panel">
              <div class="sys-section-head">
                <span class="sys-section-title">Agents</span>
                <span class="sys-section-count">${report.agents.length}</span>
              </div>
              ${report.agents.map(agentCard).join('')}
              <div class="sys-note">Status basiert auf bekannten Auth- und Datenpfaden. Es findet keine breite Festplatten-Suche statt.</div>
            </div>
            <div class="sys-panel">
              <div class="sys-section-head">
                <span class="sys-section-title">Datenarten</span>
                <span class="sys-section-count">${fmtBytes(report.totals.totalBytes)}</span>
              </div>
              <div class="sys-cat-grid">
                ${report.categories.map(categoryCard).join('')}
              </div>
            </div>
          </div>

          <div>
            <div class="sys-panel">
              <div class="sys-section-head">
                <span class="sys-section-title">Agent-Pfade</span>
                <span class="sys-section-count">${report.agents.reduce((sum, agent) => sum + agent.paths.filter((p) => p.exists).length, 0)} aktiv</span>
              </div>
              <div class="sys-path-list">
                ${report.agents.flatMap((agent) => agent.paths.map((item) => pathRow(item, agent.name))).join('')}
              </div>
            </div>
            <div class="sys-panel">
              <div class="sys-section-head">
                <span class="sys-section-title">QuotaBar</span>
                <span class="sys-section-count">${fmtBytes(report.app.totals.totalBytes)}</span>
              </div>
              <div class="sys-path-list">
                ${report.app.paths.map((item) => pathRow(item, 'QuotaBar')).join('')}
              </div>
              <div class="sys-note">Explorer öffnet nur Ordner aus dieser Liste. Nicht vorhandene Pfade bleiben gesperrt.</div>
            </div>
          </div>
        </div>
      </div>`;
    _animated = true;
    bindEvents(wrap);
  }

  function bindEvents(wrap) {
    wrap.querySelector('#sys-refresh')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.classList.add('loading');
      try {
        const report = await loadData(true);
        renderUI(wrap, report);
      } catch (e) {
        console.error('system refresh failed', e);
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    });

    wrap.querySelector('#sys-open-app')?.addEventListener('click', () => {
      const first = _data?.app?.paths?.find((item) => item.openPath);
      if (first) void openPath(first.openPath);
    });

    wrap.querySelectorAll('.sys-open-btn[data-open-path]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.openPath;
        if (target) void openPath(target);
      });
    });
  }

  async function openPath(target) {
    try {
      const result = await QB.ipc.invoke('system:open-path', target);
      if (!result?.ok) console.error('system:open-path failed', result?.error);
    } catch (e) {
      console.error('system:open-path failed', e);
    }
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
          <div class="sys-mini-label">Dateien</div>
          <div class="sys-mini-value">${fmtCount(agent.totals.fileCount)}</div>
        </div>
        <div class="sys-mini-stat">
          <div class="sys-mini-label">Größe</div>
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
    const meta = exists ? `${fmtCount(item.fileCount)} · ${fmtBytes(item.totalBytes)}` : 'nicht gefunden';
    const title = `${owner} · ${item.label}`;
    return `<div class="sys-path-row">
      <div class="sys-path-label">
        <div class="sys-path-name" title="${QB.esc(title)}">${QB.esc(item.label)}</div>
        <div class="sys-path-kind">${QB.esc(owner)} · ${QB.esc(categoryLabel(item.category))}</div>
      </div>
      <div class="sys-path-value" title="${QB.esc(item.path)}">${QB.esc(item.path)}</div>
      <div class="sys-path-meta">${QB.esc(meta)}</div>
      <button class="sys-open-btn" ${item.openPath ? `data-open-path="${QB.esc(item.openPath)}"` : 'disabled'}
              title="${item.openPath ? 'Im Explorer öffnen' : 'Pfad nicht vorhanden'}" aria-label="Im Explorer öffnen">
        ${folderIcon()}
      </button>
    </div>`;
  }

  function statusLabel(status) {
    return ({ connected: 'Verbunden', detected: 'Daten', not_found: 'Fehlt' })[status] ?? status;
  }

  function categoryLabel(category) {
    return ({ logs: 'Logs', credentials: 'Credentials', config: 'Config', cache: 'Cache' })[category] ?? category;
  }

  function fmtCount(n) {
    if (!n) return '0';
    return Number(n).toLocaleString('de-DE');
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

  function newestDate(values) {
    return values.filter(Boolean).sort().pop() ?? null;
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function relativeTime(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return '—';
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 1) return 'gerade eben';
    if (min < 60) return `${min} min`;
    const hours = Math.round(min / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
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
})();
