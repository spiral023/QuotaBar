/* global QB */
'use strict';

window.QB = window.QB || {};

(function () {
  const RELEASES_URL = 'https://github.com/spiral023/QuotaBar/releases/latest';

  let _data = null;
  let _dataSources = null;
  let _settings = null;
  let _claudeSuggestions = null;
  let _codexSuggestions = null;
  let _loading = null;
  let _rootSaveBusy = false;
  let _transferBusy = false;
  let _stagedPortableImport = null;
  let _portableRestartFailed = false;
  let _deleteRefreshBlocked = false;
  let _systemWrap = null;
  let _animated = false;

  let _update = null;

  QB.importPortableData = async function importPortableData(processSuccess) {
    const result = await QB.ipc.invoke('system:import-portable-data');
    if (!result?.ok || !result.restartScheduled) return result;
    if (typeof processSuccess !== 'function') throw new Error('Portable import success handler is required');
    await processSuccess(result);
    const confirmation = await QB.ipc.invoke('system:confirm-portable-import-restart');
    if (!confirmation?.ok) throw new Error('Portable import restart confirmation failed');
    return result;
  };

  async function loadUpdateState(force) {
    try {
      _update = await QB.ipc.invoke(force ? 'update:check' : 'update:get-state');
    } catch (e) {
      console.error('update:get-state failed', e);
      _update = null;
    }
    return _update;
  }

  function updatePanelHtml(u, variant) {
    if (!u) return '';
    const map = {
      disabled: ['Development Build', 'Auto-updates are only active in the installed build.'],
      idle: ['Up to date', 'You are using the latest version.'],
      checking: ['Checking for updates…', ''],
      available: [`Update ${u.newVersion || ''} found`, 'Downloading in the background…'],
      downloading: [`Downloading ${u.newVersion || ''}…`, `${u.downloadPercent}%`],
      ready: [`Update ${u.newVersion || ''} ready`, 'Will be installed on exit.'],
      manual: [`Update ${u.newVersion || ''} available`, 'This build does not auto-update — download it from GitHub.'],
      error: ['Update error', u.error || ''],
    };
    const [title, sub] = map[u.status] || ['—', ''];
    const canCheck = u.status !== 'disabled' && u.status !== 'checking' && u.status !== 'downloading';
    const canInstall = u.status === 'ready';
    const canDownload = u.status === 'manual';
    const variantLabel = variant?.label || 'Unknown';
    return `
      <div class="sys-panel">
        <div class="sys-section-head">
          <span class="sys-section-title">Version & Updates</span>
          <span class="sys-section-count sys-version-meta">
            <span>v${QB.esc(u.currentVersion)}</span>
            <span class="sys-variant-badge">${QB.esc(variantLabel)}</span>
          </span>
          <button class="sys-open-btn" id="sys-github-link" title="Open GitHub repository" aria-label="Open GitHub repository" style="margin-left:4px">
            ${githubIcon()}
          </button>
        </div>
        <div class="sys-update-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0">
          <div>
            <div class="sys-update-title" style="font-weight:600">${title}</div>
            <div class="sys-update-sub" style="opacity:.7;font-size:11px">${sub}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="sys-action secondary" id="sys-update-check" ${canCheck ? '' : 'disabled'}
              style="min-height:28px;padding:0 10px;font-size:9.5px">Check for updates</button>
            ${canInstall ? `<button class="sys-action" id="sys-update-install"
              style="min-height:28px;padding:0 10px;font-size:9.5px">Restart now</button>` : ''}
            ${canDownload ? `<button class="sys-action" id="sys-update-download"
              style="min-height:28px;padding:0 10px;font-size:9.5px">Download on GitHub</button>` : ''}
          </div>
        </div>
      </div>`;
  }

  const DELETE_GROUPS = [
    {
      id: 'cache', label: 'Cache', note: 'Usage snapshots, FX rates',
      pathIds: ['app-cache', 'app-fx-cache'],
      consequence: 'Will be recalculated from JSONL logs on next app start.',
    },
    {
      id: 'logs', label: 'Logs', note: 'App log, notification log',
      pathIds: ['app-log', 'app-notification-log'],
      consequence: 'Log entries are permanently removed. The app continues to run.',
    },
    {
      id: 'state', label: 'State Data', note: 'Window, Bonus, Notifications',
      pathIds: ['app-window-history', 'app-window-ratio', 'app-bonus-state', 'app-notification-state'],
      consequence: 'Window tracking and bonus detection reset on next restart.',
    },
    {
      id: 'debug', label: 'Debug Logs', note: 'Backfill data, manifests',
      pathIds: ['app-debug'],
      consequence: 'Backfill will be fully rebuilt on next start.',
    },
  ];

  function groupSizeBytes(pathIds, appPaths) {
    const ids = new Set(pathIds);
    return appPaths.filter((p) => ids.has(p.id) && p.exists).reduce((sum, p) => sum + p.totalBytes, 0);
  }

  QB.renderSystem = async function renderSystem() {
    const wrap = document.getElementById('system-content');
    if (!wrap) return;
    if (_data && _settings) { renderUI(wrap, _data); return; }
    wrap.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
    try {
      const [report] = await Promise.all([loadData(), loadUpdateState(false), loadDataSources(), loadSystemSettings()]);
      _data = report;
      renderUI(wrap, _data);
    } catch (e) {
      console.error('system:get failed', e);
      wrap.innerHTML = '<div class="empty"><span>System data not available.</span></div>';
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

  function loadDataSources() {
    return QB.ipc.invoke('dataSources:get')
      .then((d) => { _dataSources = d; return d; })
      .catch((e) => { console.error('dataSources:get failed', e); _dataSources = null; return null; });
  }

  function loadSystemSettings() {
    return QB.ipc.invoke('settings:get')
      .then((settings) => { _settings = settings; return settings; })
      .catch((e) => { console.error('settings:get failed', e); _settings = null; return null; });
  }

  function renderUI(wrap, report) {
    _systemWrap = wrap;
    const connected = report.agents.filter((agent) => agent.status === 'connected').length;
    const detected = report.agents.filter((agent) => agent.status !== 'not_found').length;
    const lastModified = newestDate([
      report.totals.lastModifiedAt,
      ...report.agents.map((agent) => agent.totals.lastModifiedAt),
      report.app.totals.lastModifiedAt,
    ]);

    wrap.innerHTML = `
      <div class="${_animated ? '' : 'sys-stagger'}">
        ${updatePanelHtml(_update, report.app?.variant)}
        <div class="sys-toolbar">
          <div class="sys-toolbar-main">
            <div class="sys-title">Local Agent &amp; App Data</div>
            <div class="sys-sub">Scan: ${formatDateTime(report.generatedAt)}</div>
          </div>
          <button class="sys-action secondary" id="sys-open-app" title="Open QuotaBar data folder">
            ${folderIcon()} App
          </button>
          <button class="sys-action" id="sys-refresh" title="Re-scan">
            ${refreshIcon()} Scan
          </button>
        </div>

        <div class="sys-kpis">
          ${kpi('Agents', `${detected}/${report.agents.length}`, `${connected} connected`)}
          ${kpi('Files', fmtCount(report.totals.fileCount), 'detected local data')}
          ${kpi('Size', fmtBytes(report.totals.totalBytes), 'sum of known paths')}
          ${kpi('Quick Stats', fmtOptionalSeconds(report.quickStatsLoadDurationMs), report.quickStatsLoadDurationMs == null ? 'not measured yet' : 'first summary load')}
          ${kpi('Scan', fmtSeconds(report.scanDurationMs), 'system data load')}
          ${kpi('Last', lastModified ? relativeTime(lastModified) : '—', lastModified ? formatDateTime(lastModified) : 'no files')}
        </div>

        ${dataSourcesPanelHtml(_dataSources)}

        <div class="sys-layout">
          <div>
            <div class="sys-panel">
              <div class="sys-section-head">
                <span class="sys-section-title">Agents</span>
                <span class="sys-section-count">${report.agents.length}</span>
              </div>
              ${report.agents.map(agentCard).join('')}
              <div class="sys-note">Status is based on known auth and data paths. No broad disk scan is performed.</div>
            </div>
            <div class="sys-panel">
              <div class="sys-section-head">
                <span class="sys-section-title">Data types</span>
                <span class="sys-section-count">${fmtBytes(report.totals.totalBytes)}</span>
              </div>
              <div class="sys-cat-grid">
                ${report.categories.map(categoryCard).join('')}
              </div>
            </div>
          </div>

          <div>
            ${claudeRootsPanelHtml(_settings, report)}
            ${codexRootsPanelHtml(_settings, report)}
            <div class="sys-panel">
              <div class="sys-section-head">
                <span class="sys-section-title">Agent Paths</span>
                <span class="sys-section-count">${report.agents.reduce((sum, agent) => sum + agent.paths.filter((p) => p.exists).length, 0)} active</span>
              </div>
              <div class="sys-path-list">
                ${report.agents.flatMap((agent) => agent.paths.map((item) => pathRow(item, agent.name))).join('')}
              </div>
            </div>
            <div class="sys-panel">
              <div class="sys-section-head">
                <span class="sys-section-title">QuotaBar</span>
                <div class="sys-transfer-actions">
                  <span class="sys-section-count">${fmtBytes(report.app.totals.totalBytes)}</span>
                  <button class="sys-action secondary" id="sys-export-portable-data"
                    title="Export portable statistics and settings">
                    Export data
                  </button>
                  <button class="sys-action secondary" id="sys-import-portable-data"
                    title="Import portable statistics and settings"
                    aria-expanded="false" aria-controls="sys-import-portable-panel">
                    Import data
                  </button>
                  <button class="sys-action secondary" id="sys-delete-toggle"
                    title="Delete QuotaBar data"
                    aria-expanded="false" aria-controls="sys-delete-panel">
                    ${trashIcon()} Delete
                  </button>
                </div>
              </div>
              <div class="sys-path-list">
                ${report.app.paths.map((item) => pathRow(item, 'QuotaBar')).join('')}
              </div>
              <div class="sys-note">Explorer only opens folders from this list. Non-existent paths remain locked.</div>
              <div class="sys-transfer-result" id="sys-transfer-result" role="status" aria-live="polite"></div>
              <div class="sys-transfer-panel" id="sys-import-portable-panel" hidden>
                <div class="sys-del-warn">
                  ${warnIcon()} Import replaces portable statistics and settings.
                </div>
                <div class="sys-transfer-copy">
                  A backup is created automatically. QuotaBar restarts after a successful import.
                </div>
                <div class="sys-del-footer">
                  <button class="sys-action secondary" id="sys-import-portable-cancel">Cancel</button>
                  <button class="sys-action secondary" id="sys-import-restart-retry" hidden>Retry restart</button>
                  <button class="sys-action" id="sys-import-portable-confirm">Confirm import</button>
                </div>
              </div>
              <div class="sys-delete-panel" id="sys-delete-panel" hidden>
                <div id="sys-del-step-select">
                  <div class="sys-delete-title">Select data</div>
                  ${DELETE_GROUPS.map((g) => deleteGroupRow(g, report.app.paths)).join('')}
                  <div class="sys-del-footer">
                    <div class="sys-del-result" id="sys-del-result"></div>
                    <button class="sys-action secondary" id="sys-delete-cancel"
                      style="min-height:28px;padding:0 10px;font-size:9.5px">Cancel</button>
                    <button class="sys-action danger" id="sys-delete-confirm" disabled
                      style="min-height:28px;padding:0 10px;font-size:9.5px">Delete now</button>
                  </div>
                </div>
                <div id="sys-del-step-confirm" hidden></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    _animated = true;
    bindEvents(wrap);
  }

  function activeSystemWrap(fallback) {
    return _systemWrap?.isConnected ? _systemWrap : fallback;
  }

  function setTransferBusy(wrap, busy) {
    _transferBusy = busy;
    [
      '#sys-export-portable-data',
      '#sys-import-portable-data',
      '#sys-delete-toggle',
      '#sys-import-portable-cancel',
      '#sys-import-portable-confirm',
      '#sys-import-restart-retry',
      '#sys-delete-cancel',
      '#sys-delete-confirm',
      '#sys-del-back',
      '#sys-del-execute',
    ].forEach((selector) => {
      const button = wrap.querySelector(selector);
      if (!button) return;
      const deleteBlocked = _deleteRefreshBlocked && [
        '#sys-delete-toggle',
        '#sys-delete-confirm',
        '#sys-del-execute',
      ].includes(selector);
      if (selector === '#sys-delete-confirm' && !busy && !deleteBlocked) {
        updateDeleteConfirmBtn(wrap);
        return;
      }
      button.disabled = busy || deleteBlocked;
    });
    const importButton = wrap.querySelector('#sys-import-portable-data');
    if (importButton) importButton.disabled = busy || Boolean(_stagedPortableImport);
  }

  function setTransferResult(wrap, text, isError = false) {
    const resultEl = wrap.querySelector('#sys-transfer-result');
    if (!resultEl) return;
    resultEl.textContent = text;
    resultEl.classList.toggle('error', isError);
  }

  function transferError(result, fallback) {
    return typeof result?.message === 'string' && result.message.trim() ? result.message : fallback;
  }

  function waitForTransferResultPaint() {
    return new Promise((resolve) => {
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        clearTimeout(fallback);
        resolve();
      };
      const fallback = setTimeout(finish, 180);
      if (typeof requestAnimationFrame !== 'function') return;
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
  }

  function setDisclosure(panel, toggle, open, focusTarget, returnFocus = false) {
    panel.hidden = !open;
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) focusTarget?.focus();
    else if (returnFocus) toggle.focus();
  }

  function applyStagedImportState(wrap, focusRetry = false) {
    if (!_stagedPortableImport) return;
    const panel = wrap.querySelector('#sys-import-portable-panel');
    const toggle = wrap.querySelector('#sys-import-portable-data');
    const retry = wrap.querySelector('#sys-import-restart-retry');
    const cancel = wrap.querySelector('#sys-import-portable-cancel');
    const confirm = wrap.querySelector('#sys-import-portable-confirm');
    if (!panel || !toggle || !retry) return;
    if (retry) retry.hidden = false;
    if (cancel) cancel.hidden = true;
    if (confirm) confirm.hidden = true;
    setDisclosure(panel, toggle, true, null);
    if (_portableRestartFailed) {
      setTransferResult(
        wrap,
        `Import is ready. Backup created at ${_stagedPortableImport.backupPath}. Restart confirmation failed. Retry restart.`,
        true,
      );
    } else {
      setTransferResult(wrap, `Backup created at ${_stagedPortableImport.backupPath}`);
    }
    if (focusRetry && !_transferBusy) retry.focus();
  }

  function showStagedImportRecovery(wrap, focusRetry = false) {
    _portableRestartFailed = true;
    applyStagedImportState(wrap, focusRetry);
  }

  function bindEvents(wrap) {
    wrap.querySelector('#sys-refresh')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.classList.add('loading');
      try {
        const [report] = await Promise.all([loadData(true), loadDataSources()]);
        await loadSystemSettings();
        _deleteRefreshBlocked = false;
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

    const importPanel = wrap.querySelector('#sys-import-portable-panel');
    const importToggle = wrap.querySelector('#sys-import-portable-data');
    const deletePanel = wrap.querySelector('#sys-delete-panel');
    const deleteToggle = wrap.querySelector('#sys-delete-toggle');

    function showImport(open, returnFocus = false) {
      setDisclosure(importPanel, importToggle, open, wrap.querySelector('#sys-import-portable-confirm'), returnFocus);
    }

    function showDelete(open, returnFocus = false) {
      setDisclosure(deletePanel, deleteToggle, open, wrap.querySelector('#sys-delete-cancel'), returnFocus);
    }

    wrap.querySelector('#sys-export-portable-data')?.addEventListener('click', async () => {
      if (_transferBusy) return;
      setTransferBusy(wrap, true);
      setTransferResult(wrap, 'Preparing archive…');
      try {
        const result = await QB.ipc.invoke('system:export-portable-data');
        const liveWrap = activeSystemWrap(wrap);
        if (result?.ok) {
          setTransferResult(liveWrap, `Exported to ${result.path}`);
        } else if (result?.cancelled) {
          setTransferResult(liveWrap, 'Export cancelled.');
        } else {
          setTransferResult(liveWrap, transferError(result, 'Export failed.'), true);
        }
      } catch {
        console.error('system:export-portable-data failed');
        setTransferResult(activeSystemWrap(wrap), 'Export failed.', true);
      } finally {
        setTransferBusy(activeSystemWrap(wrap), false);
      }
    });

    importToggle?.addEventListener('click', () => {
      if (_transferBusy) return;
      const open = importPanel.hidden;
      if (open) showDelete(false);
      showImport(open, !open);
    });

    wrap.querySelector('#sys-import-portable-cancel')?.addEventListener('click', () => {
      if (_transferBusy) return;
      showImport(false, true);
      setTransferResult(wrap, 'Import cancelled.');
    });

    wrap.querySelector('#sys-import-portable-confirm')?.addEventListener('click', async () => {
      if (_transferBusy) return;
      _stagedPortableImport = null;
      _portableRestartFailed = false;
      const retry = wrap.querySelector('#sys-import-restart-retry');
      if (retry) retry.hidden = true;
      setTransferBusy(wrap, true);
      setTransferResult(wrap, 'Validating and backing up…');
      let restartFailed = false;
      try {
        const result = await QB.importPortableData(async (success) => {
          _stagedPortableImport = success;
          _portableRestartFailed = false;
          applyStagedImportState(activeSystemWrap(wrap));
          await waitForTransferResultPaint();
        });
        const liveWrap = activeSystemWrap(wrap);
        if (!result?.ok && result?.cancelled) {
          setTransferResult(liveWrap, 'Import cancelled.');
        } else if (!result?.ok) {
          setTransferResult(liveWrap, transferError(result, 'Import failed.'), true);
        }
      } catch {
        console.error('system:import-portable-data failed');
        if (_stagedPortableImport) {
          restartFailed = true;
          showStagedImportRecovery(activeSystemWrap(wrap));
        } else {
          setTransferResult(activeSystemWrap(wrap), 'Import failed.', true);
        }
      } finally {
        setTransferBusy(activeSystemWrap(wrap), false);
      }
      if (restartFailed) applyStagedImportState(activeSystemWrap(wrap), true);
    });

    wrap.querySelector('#sys-import-restart-retry')?.addEventListener('click', async () => {
      if (_transferBusy || !_stagedPortableImport) return;
      setTransferBusy(wrap, true);
      setTransferResult(wrap, 'Restarting QuotaBar…');
      _portableRestartFailed = false;
      let failed = false;
      try {
        const confirmation = await QB.ipc.invoke('system:confirm-portable-import-restart');
        if (!confirmation?.ok) throw new Error('Portable import restart confirmation failed');
        const retry = activeSystemWrap(wrap).querySelector('#sys-import-restart-retry');
        if (retry) retry.hidden = true;
      } catch {
        console.error('system:confirm-portable-import-restart failed');
        failed = true;
        showStagedImportRecovery(activeSystemWrap(wrap));
      } finally {
        setTransferBusy(activeSystemWrap(wrap), false);
      }
      if (failed) applyStagedImportState(activeSystemWrap(wrap), true);
    });

    // Delete panel
    const stepSelect = wrap.querySelector('#sys-del-step-select');
    const stepConfirm = wrap.querySelector('#sys-del-step-confirm');

    function showSelectStep(focusBack = false) {
      stepSelect.hidden = false;
      stepConfirm.hidden = true;
      if (focusBack) wrap.querySelector('#sys-delete-confirm')?.focus();
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
          ${warnIcon()} This action cannot be undone.
        </div>
        ${rows}
        <div class="sys-del-footer" style="margin-top:8px">
          <div class="sys-del-result" id="sys-del-result2"></div>
          <button class="sys-action secondary" id="sys-del-back"
            style="min-height:28px;padding:0 10px;font-size:9.5px">Back</button>
          <button class="sys-action danger" id="sys-del-execute"
            style="min-height:28px;padding:0 10px;font-size:9.5px">
            Confirm delete · ${fmtBytes(totalBytes)}
          </button>
        </div>`;

      stepSelect.hidden = true;
      stepConfirm.hidden = false;

      wrap.querySelector('#sys-del-back')?.addEventListener('click', () => {
        if (_transferBusy) return;
        showSelectStep(true);
      });
      wrap.querySelector('#sys-del-execute')?.focus();
      wrap.querySelector('#sys-del-execute')?.addEventListener('click', async () => {
        if (_transferBusy) return;
        setTransferBusy(wrap, true);
        wrap.querySelector('#sys-del-back').disabled = true;
        const resultEl = wrap.querySelector('#sys-del-result2');
        const groupIds = groups.map((g) => g.id);
        let deletionSucceeded = false;
        try {
          const result = await QB.ipc.invoke('system:delete-app-data', groupIds);
          if (result?.ok) {
            deletionSucceeded = true;
            if (resultEl) resultEl.textContent = `${result.deleted.length} file(s) deleted`;
            _data = null;
            setTimeout(async () => {
              try {
                const report = await loadData(true);
                _transferBusy = false;
                _deleteRefreshBlocked = false;
                renderUI(activeSystemWrap(wrap), report);
              } catch {
                console.error('system refresh after delete failed');
                _transferBusy = false;
                _deleteRefreshBlocked = true;
                const liveWrap = activeSystemWrap(wrap);
                setTransferBusy(liveWrap, false);
                setTransferResult(liveWrap, 'Data was deleted, but the System view could not refresh. Select Scan before deleting again.', true);
              }
            }, 1200);
          } else {
            if (resultEl) { resultEl.textContent = 'Error deleting'; resultEl.classList.add('error'); }
            wrap.querySelector('#sys-del-back').disabled = false;
          }
        } catch {
          console.error('system:delete-app-data failed');
          if (resultEl) { resultEl.textContent = 'Error deleting'; resultEl.classList.add('error'); }
          wrap.querySelector('#sys-del-back').disabled = false;
        } finally {
          if (!deletionSucceeded) setTransferBusy(wrap, false);
        }
      });
    }

    deleteToggle?.addEventListener('click', () => {
      if (_transferBusy || _deleteRefreshBlocked) return;
      const open = deletePanel.hidden;
      if (open) {
        showImport(false);
        showSelectStep();
      }
      showDelete(open, !open);
    });
    wrap.querySelector('#sys-delete-cancel')?.addEventListener('click', () => {
      if (_transferBusy) return;
      showDelete(false, true);
      showSelectStep();
    });
    wrap.querySelectorAll('.sys-delete-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (_transferBusy || _deleteRefreshBlocked) return;
        row.classList.toggle('selected');
        updateDeleteConfirmBtn(wrap);
      });
    });
    wrap.querySelector('#sys-delete-confirm')?.addEventListener('click', () => {
      if (_transferBusy || _deleteRefreshBlocked) return;
      showConfirmStep();
    });

    wrap.querySelector('#sys-update-check')?.addEventListener('click', async () => {
        _update = { ...(_update || {}), status: 'checking', error: null };
      if (_data) renderUI(wrap, _data);
      try { await QB.ipc.invoke('update:check'); } catch (e) { console.error('update:check failed', e); }
      // Poll briefly until status changes
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await loadUpdateState(false);
        if (!_update || _update.status !== 'checking') break;
      }
      if (!_data) return;
      renderUI(wrap, _data);
    });

    wrap.querySelector('#sys-update-install')?.addEventListener('click', () => {
      void QB.ipc.invoke('update:quit-and-install');
    });

    wrap.querySelector('#sys-update-download')?.addEventListener('click', () => {
      void QB.ipc.invoke('shell:open-url', RELEASES_URL);
    });

    wrap.querySelector('#sys-github-link')?.addEventListener('click', () => {
      void QB.ipc.invoke('shell:open-url', 'https://github.com/spiral023/QuotaBar');
    });

    bindClaudeRootEvents(wrap);
    bindCodexRootEvents(wrap);
    setTransferBusy(wrap, _transferBusy);
    if (_stagedPortableImport) applyStagedImportState(wrap, _portableRestartFailed && !_transferBusy);
  }

  function bindClaudeRootEvents(wrap) {
    const resultEl = wrap.querySelector('#sys-claude-roots-result');
    const setResult = (text, isError) => {
      if (!resultEl) return;
      resultEl.textContent = text || '';
      resultEl.classList.toggle('error', Boolean(isError));
    };

    wrap.querySelector('#sys-claude-roots-save')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      setResult('Saving…', false);
      try {
        if (await saveClaudeRoots(collectClaudeRootInputs(wrap, false))) setResult('Saved', false);
      } catch (e) {
        console.error('saving Claude roots failed', e);
        setResult('Error saving', true);
      } finally {
        btn.disabled = false;
      }
    });

    wrap.querySelector('#sys-claude-root-add')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      const next = collectClaudeRootInputs(wrap, true);
      try {
        if (next.length !== collectClaudeRootInputs(wrap, false).length) {
          setResult('Saving…', false);
          if (await saveClaudeRoots(next)) setResult('Added', false);
        }
      } catch (e) {
        console.error('adding Claude root failed', e);
        setResult('Error adding', true);
      } finally {
        btn.disabled = false;
      }
    });

    wrap.querySelectorAll('.sys-claude-root-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const index = Number(btn.dataset.index);
        const current = collectClaudeRootInputs(wrap, false);
        current.splice(index, 1);
        setResult('Saving…', false);
        try {
          if (await saveClaudeRoots(current)) setResult('Removed', false);
        } catch (e) {
          console.error('removing Claude root failed', e);
          setResult('Error removing', true);
        }
      });
    });

    wrap.querySelector('#sys-claude-wsl-detect')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.classList.add('loading');
      setResult('Scanning WSL…', false);
      try {
        _claudeSuggestions = await QB.ipc.invoke('system:claude-roots:suggest');
        renderUI(wrap, _data);
      } catch (e) {
        console.error('system:claude-roots:suggest failed', e);
        setResult('WSL scan failed', true);
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    });

    wrap.querySelectorAll('.sys-claude-suggestion-add').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const root = btn.dataset.path;
        if (!root) return;
        btn.disabled = true;
        const current = collectClaudeRootInputs(wrap, false);
        setResult('Saving…', false);
        try {
          if (await saveClaudeRoots([...current, root])) setResult('Added', false);
        } catch (e) {
          console.error('adding WSL Claude root failed', e);
          setResult('Error adding', true);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function bindCodexRootEvents(wrap) {
    const resultEl = wrap.querySelector('#sys-codex-roots-result');
    const setResult = (text, isError) => {
      if (!resultEl) return;
      resultEl.textContent = text || '';
      resultEl.classList.toggle('error', Boolean(isError));
    };

    wrap.querySelector('#sys-codex-roots-save')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      setResult('Saving…', false);
      try {
        if (await saveCodexHomes(collectCodexHomeInputs(wrap, false))) setResult('Saved', false);
      } catch (e) {
        console.error('saving Codex roots failed', e);
        setResult('Error saving', true);
      } finally {
        btn.disabled = false;
      }
    });

    wrap.querySelector('#sys-codex-root-add')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      const next = collectCodexHomeInputs(wrap, true);
      try {
        if (next.length !== collectCodexHomeInputs(wrap, false).length) {
          setResult('Saving…', false);
          if (await saveCodexHomes(next)) setResult('Added', false);
        }
      } catch (e) {
        console.error('adding Codex root failed', e);
        setResult('Error adding', true);
      } finally {
        btn.disabled = false;
      }
    });

    wrap.querySelectorAll('.sys-codex-root-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const index = Number(btn.dataset.index);
        const current = collectCodexHomeInputs(wrap, false);
        current.splice(index, 1);
        setResult('Saving…', false);
        try {
          if (await saveCodexHomes(current)) setResult('Removed', false);
        } catch (e) {
          console.error('removing Codex root failed', e);
          setResult('Error removing', true);
        }
      });
    });

    wrap.querySelector('#sys-codex-wsl-detect')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.classList.add('loading');
      setResult('Scanning WSL…', false);
      try {
        _codexSuggestions = await QB.ipc.invoke('system:codex-homes:suggest');
        renderUI(wrap, _data);
      } catch (e) {
        console.error('system:codex-homes:suggest failed', e);
        setResult('WSL scan failed', true);
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    });

    wrap.querySelectorAll('.sys-codex-suggestion-add').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const root = btn.dataset.path;
        if (!root) return;
        btn.disabled = true;
        const current = collectCodexHomeInputs(wrap, false);
        setResult('Saving…', false);
        try {
          if (await saveCodexHomes([...current, root])) setResult('Added', false);
        } catch (e) {
          console.error('adding WSL Codex root failed', e);
          setResult('Error adding', true);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function collectCodexHomeInputs(wrap, includeNew) {
    const values = [...wrap.querySelectorAll('.sys-codex-root-input')]
      .map((input) => input.value.trim())
      .filter(Boolean);
    if (includeNew) {
      const next = wrap.querySelector('#sys-codex-root-new')?.value?.trim();
      if (next) values.push(next);
    }
    return uniqueStrings(values);
  }

  function collectClaudeRootInputs(wrap, includeNew) {
    const values = [...wrap.querySelectorAll('.sys-claude-root-input')]
      .map((input) => input.value.trim())
      .filter(Boolean);
    if (includeNew) {
      const next = wrap.querySelector('#sys-claude-root-new')?.value?.trim();
      if (next) values.push(next);
    }
    return uniqueStrings(values);
  }

  async function saveClaudeRoots(claudeRoots) {
    if (_rootSaveBusy) return false;
    _rootSaveBusy = true;
    try {
      await QB.ipc.invoke('settings:save', { claudeRoots: uniqueStrings(claudeRoots) });
      _settings = await QB.ipc.invoke('settings:get');
      _data = await loadData(true);
      QB.ipc.send('quota:refresh');
      QB.ipc.send('quota:recompute-cost');
      const wrap = document.getElementById('system-content');
      if (wrap) renderUI(wrap, _data);
      return true;
    } finally {
      _rootSaveBusy = false;
    }
  }

  async function saveCodexHomes(codexHomes) {
    if (_rootSaveBusy) return false;
    _rootSaveBusy = true;
    try {
      await QB.ipc.invoke('settings:save', { codexHomes: uniqueStrings(codexHomes) });
      _settings = await QB.ipc.invoke('settings:get');
      _data = await loadData(true);
      QB.ipc.send('quota:refresh');
      QB.ipc.send('quota:recompute-cost');
      const wrap = document.getElementById('system-content');
      if (wrap) renderUI(wrap, _data);
      return true;
    } finally {
      _rootSaveBusy = false;
    }
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
    btn.textContent = selected.length === 0 ? 'Delete now' : `Delete now · ${fmtBytes(totalBytes)}`;
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

  function claudeRootsPanelHtml(settings, report) {
    const roots = Array.isArray(settings?.claudeRoots) ? settings.claudeRoots : [];
    const claude = report.agents.find((agent) => agent.id === 'claude');
    const activeProjectRoots = (claude?.paths ?? [])
      .filter((item) => item.id.startsWith('claude-projects-') && item.exists)
      .length;
    return `<div class="sys-panel">
      <div class="sys-section-head">
        <span class="sys-section-title">Claude Data Roots</span>
        <span class="sys-section-count">${activeProjectRoots} active</span>
      </div>
      <div class="sys-root-list">
        ${roots.length ? roots.map((root, index) => claudeRootRow(root, index)).join('') : '<div class="sys-root-empty">Using CLAUDE_CONFIG_DIR and the default Windows Claude folders.</div>'}
      </div>
      <div class="sys-root-add-row">
        <input class="sys-root-input" id="sys-claude-root-new" type="text" spellcheck="false"
          placeholder="C:\\Users\\you\\.claude or \\\\wsl.localhost\\Ubuntu\\home\\you\\.claude">
        <button class="sys-action" id="sys-claude-root-add" title="Add Claude data root">
          ${plusIcon()} Add
        </button>
      </div>
      <div class="sys-root-actions">
        <button class="sys-action secondary" id="sys-claude-wsl-detect" title="Find Claude data roots in WSL">
          ${refreshIcon()} Detect WSL
        </button>
        <button class="sys-action secondary" id="sys-claude-roots-save" title="Save edited Claude data roots">
          ${saveIcon()} Save
        </button>
        <div class="sys-del-result" id="sys-claude-roots-result"></div>
      </div>
      ${claudeSuggestionsHtml(roots)}
      <div class="sys-note">Roots are merged with CLAUDE_CONFIG_DIR. The first root with .credentials.json is used for live quota; projects from all roots are combined for history and cost analytics.</div>
    </div>`;
  }

  function claudeRootRow(root, index) {
    return `<div class="sys-root-row">
      <input class="sys-root-input sys-claude-root-input" type="text" value="${QB.esc(root)}" spellcheck="false" aria-label="Claude data root">
      <button class="sys-open-btn sys-claude-root-remove" data-index="${index}" title="Remove Claude data root" aria-label="Remove Claude data root">
        ${trashIcon()}
      </button>
    </div>`;
  }

  function claudeSuggestionsHtml(roots) {
    if (!_claudeSuggestions) return '';
    const suggestions = Array.isArray(_claudeSuggestions) ? _claudeSuggestions : [];
    if (suggestions.length === 0) {
      return '<div class="sys-root-suggestions"><div class="sys-root-empty">No WSL Claude folders found.</div></div>';
    }
    const rootKeys = new Set(roots.map((root) => root.toLowerCase()));
    return `<div class="sys-root-suggestions">
      ${suggestions.map((item) => {
        const added = rootKeys.has(String(item.path).toLowerCase());
        const meta = [
          item.hasCredentials ? 'credentials' : null,
          item.hasProjects ? 'projects' : null,
        ].filter(Boolean).join(' + ') || 'detected';
        return `<div class="sys-root-suggestion">
          <div class="sys-root-suggestion-main">
            <div class="sys-root-suggestion-label">${QB.esc(item.label || 'WSL')}</div>
            <div class="sys-root-suggestion-path" title="${QB.esc(item.path)}">${QB.esc(item.path)}</div>
          </div>
          <div class="sys-root-suggestion-meta">${QB.esc(meta)}</div>
          <button class="sys-action secondary sys-claude-suggestion-add" data-path="${QB.esc(item.path)}" ${added ? 'disabled' : ''}>
            ${added ? 'Added' : 'Add'}
          </button>
        </div>`;
      }).join('')}
    </div>`;
  }

  function codexRootsPanelHtml(settings, report) {
    const roots = Array.isArray(settings?.codexHomes) ? settings.codexHomes : [];
    const codex = report.agents.find((agent) => agent.id === 'codex');
    const activeSessionRoots = (codex?.paths ?? [])
      .filter((item) => item.id.startsWith('codex-sessions-') && item.exists)
      .length;
    return `<div class="sys-panel">
      <div class="sys-section-head">
        <span class="sys-section-title">Codex Data Roots</span>
        <span class="sys-section-count">${activeSessionRoots} active</span>
      </div>
      <div class="sys-root-list">
        ${roots.length ? roots.map((root, index) => codexRootRow(root, index)).join('') : '<div class="sys-root-empty">Using CODEX_HOME and the default Windows Codex folder.</div>'}
      </div>
      <div class="sys-root-add-row">
        <input class="sys-root-input" id="sys-codex-root-new" type="text" spellcheck="false"
          placeholder="C:\\Users\\you\\.codex or \\\\wsl.localhost\\Ubuntu\\home\\you\\.codex">
        <button class="sys-action" id="sys-codex-root-add" title="Add Codex data root">
          ${plusIcon()} Add
        </button>
      </div>
      <div class="sys-root-actions">
        <button class="sys-action secondary" id="sys-codex-wsl-detect" title="Find Codex data roots in WSL">
          ${refreshIcon()} Detect WSL
        </button>
        <button class="sys-action secondary" id="sys-codex-roots-save" title="Save edited Codex data roots">
          ${saveIcon()} Save
        </button>
        <div class="sys-del-result" id="sys-codex-roots-result"></div>
      </div>
      ${codexSuggestionsHtml(roots)}
      <div class="sys-note">Roots are merged with CODEX_HOME. The first root with auth.json is used for live quota; sessions from all roots are combined for history and cost analytics.</div>
    </div>`;
  }

  function codexRootRow(root, index) {
    return `<div class="sys-root-row">
      <input class="sys-root-input sys-codex-root-input" type="text" value="${QB.esc(root)}" spellcheck="false" aria-label="Codex data root">
      <button class="sys-open-btn sys-codex-root-remove" data-index="${index}" title="Remove Codex data root" aria-label="Remove Codex data root">
        ${trashIcon()}
      </button>
    </div>`;
  }

  function codexSuggestionsHtml(roots) {
    if (!_codexSuggestions) return '';
    const suggestions = Array.isArray(_codexSuggestions) ? _codexSuggestions : [];
    if (suggestions.length === 0) {
      return '<div class="sys-root-suggestions"><div class="sys-root-empty">No WSL Codex folders found.</div></div>';
    }
    const rootKeys = new Set(roots.map((root) => root.toLowerCase()));
    return `<div class="sys-root-suggestions">
      ${suggestions.map((item) => {
        const added = rootKeys.has(String(item.path).toLowerCase());
        const meta = [
          item.hasAuth ? 'auth' : null,
          item.hasSessions ? 'sessions' : null,
        ].filter(Boolean).join(' + ') || 'detected';
        return `<div class="sys-root-suggestion">
          <div class="sys-root-suggestion-main">
            <div class="sys-root-suggestion-label">${QB.esc(item.label || 'WSL')}</div>
            <div class="sys-root-suggestion-path" title="${QB.esc(item.path)}">${QB.esc(item.path)}</div>
          </div>
          <div class="sys-root-suggestion-meta">${QB.esc(meta)}</div>
          <button class="sys-action secondary sys-codex-suggestion-add" data-path="${QB.esc(item.path)}" ${added ? 'disabled' : ''}>
            ${added ? 'Added' : 'Add'}
          </button>
        </div>`;
      }).join('')}
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
})();
