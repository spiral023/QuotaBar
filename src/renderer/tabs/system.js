/* global QB */
'use strict';

window.QB = window.QB || {};

(function () {
const { kpi, agentCard, fmtCount, fmtBytes, categoryCard, pathRow, openPath, folderIcon, fmtSeconds, fmtOptionalSeconds, uniqueStrings, newestDate, formatDateTime, relativeTime, refreshIcon, warnIcon, trashIcon, deleteGroupRow, groupSizeBytes, dataSourcesPanelHtml } = QB.systemView;
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

  const { claudeRootsPanelHtml, codexRootsPanelHtml } = QB.createSystemRootsView(() => ({
    settings: _settings, claudeSuggestions: _claudeSuggestions, codexSuggestions: _codexSuggestions, rootSaveBusy: _rootSaveBusy,
  }));
  const updatePanelHtml = QB.systemUpdatePanelHtml;
  let _update = null;
  QB.ipc.on('update:state', (state) => {
    _update = state;
    renderUpdatePanel();
  });

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
      id: 'debug', label: 'Debug Logs', note: 'Diagnostic logs, legacy history files',
      pathIds: ['app-debug'],
      consequence: 'Diagnostic logs are permanently removed. Usage history and quota data stay intact.',
    },
  ];

  QB.renderSystem = async function renderSystem() {
    const wrap = document.getElementById('system-content');
    if (!wrap) return;
    if (_data && _settings) { await loadUpdateState(false); renderUI(wrap, _data); return; }
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

    const portableStatus = portableDataStatusLabel(report.app);

    wrap.innerHTML = `
      <div class="${_animated ? '' : 'sys-stagger'}">
        <div id="sys-update-panel-container">${updatePanelHtml(_update, report.app?.variant)}</div>
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
                  <span class="sys-section-count" id="sys-portable-status">${portableStatus}</span>
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

  function portableDataStatusLabel(app) {
    if (app?.portableMigrationStatus === 'complete' && app?.portableDataReady === true) {
      return 'Portable data: Ready';
    }
    if (app?.portableMigrationStatus === 'pending' || app?.portableMigrationStatus === 'running') {
      return 'Portable data: Preparing';
    }
    return 'Portable data: Needs attention';
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

  function renderUpdatePanel() {
    if (_transferBusy || !_systemWrap?.isConnected) return;
    const panel = _systemWrap.querySelector('#sys-update-panel-container');
    if (!panel) return;
    panel.innerHTML = updatePanelHtml(_update, _data?.app?.variant);
    bindUpdateActions(panel);
  }

  function bindUpdateActions(wrap) {
    wrap.querySelector('#sys-update-check')?.addEventListener('click', async () => {
      _update = { ...(_update || {}), status: 'checking', error: null };
      renderUpdatePanel();
      try {
        await QB.ipc.invoke('update:check');
        await loadUpdateState(false);
        renderUpdatePanel();
      } catch (e) { console.error('update:check failed', e); }
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

    bindUpdateActions(wrap);

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

})();
