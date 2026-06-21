/* global QB */
'use strict';

window.QB = window.QB || {};

(function () {
  let _data = null;
  let _loading = null;
  let _animated = false;

  const DELETE_GROUPS = [
    {
      id: 'cache', label: 'Cache', note: 'Usage-Snapshots, FX-Kurse',
      pathIds: ['app-cache', 'app-fx-cache'],
      consequence: 'Wird beim nächsten App-Start aus den JSONL-Logs neu berechnet.',
    },
    {
      id: 'logs', label: 'Logs', note: 'App-Log, Notification-Log',
      pathIds: ['app-log', 'app-notification-log'],
      consequence: 'Log-Einträge werden dauerhaft entfernt. Die App läuft weiter.',
    },
    {
      id: 'state', label: 'Status-Daten', note: 'Window, Bonus, Notifications',
      pathIds: ['app-window-history', 'app-window-ratio', 'app-bonus-state', 'app-notification-state'],
      consequence: 'Window-Tracking und Bonus-Erkennung starten nach Neustart zurück.',
    },
    {
      id: 'debug', label: 'Debug-Logs', note: 'Backfill-Daten, Manifeste',
      pathIds: ['app-debug'],
      consequence: 'Backfill wird beim nächsten Start vollständig neu aufgebaut.',
    },
  ];

  function groupSizeBytes(pathIds, appPaths) {
    const ids = new Set(pathIds);
    return appPaths.filter((p) => ids.has(p.id) && p.exists).reduce((sum, p) => sum + p.totalBytes, 0);
  }

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
                <div style="display:flex;align-items:center;gap:6px">
                  <span class="sys-section-count">${fmtBytes(report.app.totals.totalBytes)}</span>
                  <button class="sys-action secondary" id="sys-delete-toggle"
                    style="min-height:26px;padding:0 8px;font-size:9.5px;gap:5px"
                    title="QuotaBar-Daten löschen">
                    ${trashIcon()} Löschen
                  </button>
                </div>
              </div>
              <div class="sys-path-list">
                ${report.app.paths.map((item) => pathRow(item, 'QuotaBar')).join('')}
              </div>
              <div class="sys-note">Explorer öffnet nur Ordner aus dieser Liste. Nicht vorhandene Pfade bleiben gesperrt.</div>
              <div class="sys-delete-panel" id="sys-delete-panel">
                <div id="sys-del-step-select">
                  <div class="sys-delete-title">Daten auswählen</div>
                  ${DELETE_GROUPS.map((g) => deleteGroupRow(g, report.app.paths)).join('')}
                  <div class="sys-del-footer">
                    <div class="sys-del-result" id="sys-del-result"></div>
                    <button class="sys-action secondary" id="sys-delete-cancel"
                      style="min-height:28px;padding:0 10px;font-size:9.5px">Abbrechen</button>
                    <button class="sys-action danger" id="sys-delete-confirm" disabled
                      style="min-height:28px;padding:0 10px;font-size:9.5px">Jetzt löschen</button>
                  </div>
                </div>
                <div id="sys-del-step-confirm" style="display:none"></div>
              </div>
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

    // Delete panel
    const deletePanel = wrap.querySelector('#sys-delete-panel');
    const stepSelect = wrap.querySelector('#sys-del-step-select');
    const stepConfirm = wrap.querySelector('#sys-del-step-confirm');

    function showSelectStep() {
      stepSelect.style.display = '';
      stepConfirm.style.display = 'none';
    }

    function showConfirmStep() {
      const selected = [...wrap.querySelectorAll('.sys-delete-row.selected')];
      const groups = selected.map((row) => DELETE_GROUPS.find((g) => g.id === row.dataset.deleteGroup)).filter(Boolean);
      const totalBytes = groups.reduce((sum, g) => sum + groupSizeBytes(g.pathIds, _data?.app?.paths ?? []), 0);

      const rows = groups.map((g) => {
        const size = groupSizeBytes(g.pathIds, _data?.app?.paths ?? []);
        return `<div class="sys-del-con-row">
          <div class="sys-del-con-name">${QB.esc(g.label)}${size > 0 ? `<span class="sys-del-con-size">${fmtBytes(size)}</span>` : ''}</div>
          <div class="sys-del-con-text">${QB.esc(g.consequence)}</div>
        </div>`;
      }).join('');

      stepConfirm.innerHTML = `
        <div class="sys-del-warn">
          ${warnIcon()} Diese Aktion kann nicht rückgängig gemacht werden.
        </div>
        ${rows}
        <div class="sys-del-footer" style="margin-top:8px">
          <div class="sys-del-result" id="sys-del-result2"></div>
          <button class="sys-action secondary" id="sys-del-back"
            style="min-height:28px;padding:0 10px;font-size:9.5px">Zurück</button>
          <button class="sys-action danger" id="sys-del-execute"
            style="min-height:28px;padding:0 10px;font-size:9.5px">
            Wirklich löschen · ${fmtBytes(totalBytes)}
          </button>
        </div>`;

      stepSelect.style.display = 'none';
      stepConfirm.style.display = '';

      wrap.querySelector('#sys-del-back')?.addEventListener('click', showSelectStep);
      wrap.querySelector('#sys-del-execute')?.addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        btn.disabled = true;
        wrap.querySelector('#sys-del-back').disabled = true;
        const resultEl = wrap.querySelector('#sys-del-result2');
        const groupIds = groups.map((g) => g.id);
        try {
          const result = await QB.ipc.invoke('system:delete-app-data', groupIds);
          if (result?.ok) {
            if (resultEl) resultEl.textContent = `${result.deleted.length} Datei(en) gelöscht`;
            _data = null;
            setTimeout(async () => {
              try {
                const report = await loadData(true);
                renderUI(wrap, report);
              } catch (e) { console.error('system refresh after delete failed', e); }
            }, 1200);
          } else {
            if (resultEl) { resultEl.textContent = 'Fehler beim Löschen'; resultEl.classList.add('error'); }
            btn.disabled = false;
            wrap.querySelector('#sys-del-back').disabled = false;
          }
        } catch (e) {
          console.error('system:delete-app-data failed', e);
          if (resultEl) { resultEl.textContent = 'Fehler beim Löschen'; resultEl.classList.add('error'); }
          btn.disabled = false;
          wrap.querySelector('#sys-del-back').disabled = false;
        }
      });
    }

    wrap.querySelector('#sys-delete-toggle')?.addEventListener('click', () => {
      const wasOpen = deletePanel.classList.contains('open');
      deletePanel.classList.toggle('open');
      if (!wasOpen) showSelectStep();
    });
    wrap.querySelector('#sys-delete-cancel')?.addEventListener('click', () => {
      deletePanel.classList.remove('open');
      showSelectStep();
    });
    wrap.querySelectorAll('.sys-delete-row').forEach((row) => {
      row.addEventListener('click', () => {
        row.classList.toggle('selected');
        updateDeleteConfirmBtn(wrap);
      });
    });
    wrap.querySelector('#sys-delete-confirm')?.addEventListener('click', () => {
      showConfirmStep();
    });
  }

  function updateDeleteConfirmBtn(wrap) {
    const selected = [...wrap.querySelectorAll('.sys-delete-row.selected')];
    const btn = wrap.querySelector('#sys-delete-confirm');
    if (!btn) return;
    const totalBytes = selected.reduce((sum, row) => {
      const group = DELETE_GROUPS.find((g) => g.id === row.dataset.deleteGroup);
      return group ? sum + groupSizeBytes(group.pathIds, _data?.app?.paths ?? []) : sum;
    }, 0);
    btn.disabled = selected.length === 0;
    btn.textContent = selected.length === 0 ? 'Jetzt löschen' : `Jetzt löschen · ${fmtBytes(totalBytes)}`;
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
})();
