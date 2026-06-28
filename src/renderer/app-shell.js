/* global QB */
'use strict';

// IIFE-gekapselt (wie die Tab-Skripte): die App-Shell-Symbole (switchTab,
// render, loadAnalyticsSummary, …) bleiben lokal statt den globalen Renderer-
// Scope zu verschmutzen. Nach außen wird nur über QB.* kommuniziert; nichts
// referenziert diese Symbole von außen (verifiziert).
(function () {

    let lastRefreshedAt = null;
    let footerTimer     = null;
    let activePillVal    = 60;
    let activeProxyMode  = 'auto';
    let _lastSnapshots   = null;
    let inSettings       = false;

    let activeTab = 'live';

    const TAB_ORDER = ['live', 'analytics', 'models', 'notifications', 'history', 'plans', 'system'];

    function switchTab(tab) {
      if (inSettings) {
        inSettings = false;
        document.getElementById('view-settings').hidden = true;
        document.getElementById('btn-settings').classList.remove('active');
      }
      activeTab = tab;
      document.getElementById('view-dashboard').hidden     = tab !== 'live';
      document.getElementById('view-analytics').hidden     = tab !== 'analytics';
      document.getElementById('view-models').hidden        = tab !== 'models';
      document.getElementById('view-notifications').hidden = tab !== 'notifications';
      document.getElementById('view-history').hidden       = tab !== 'history';
      document.getElementById('view-plans').hidden         = tab !== 'plans';
      document.getElementById('view-system').hidden        = tab !== 'system';
      document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab)
      );
      const idx = TAB_ORDER.indexOf(tab);
      if (idx >= 0) document.querySelector('.tab-nav').style.setProperty('--nav-idx', idx);
      if (tab === 'analytics')     QB.renderAnalytics();
      if (tab === 'models')        QB.renderModels();
      if (tab === 'notifications') QB.renderNotifications();
      if (tab === 'history')       QB.renderHistory();
      if (tab === 'plans' && QB.renderPlans) QB.renderPlans();
      if (tab === 'system')        QB.renderSystem();
    }

    document.getElementById('tab-live').addEventListener('click',          () => switchTab('live'));
    document.getElementById('tab-analytics').addEventListener('click',     () => switchTab('analytics'));
    document.getElementById('tab-models').addEventListener('click', () => switchTab('models'));
    document.getElementById('tab-notifications').addEventListener('click', () => switchTab('notifications'));
    document.getElementById('tab-history').addEventListener('click',       () => switchTab('history'));
    document.getElementById('tab-plans').addEventListener('click',         () => switchTab('plans'));
    document.getElementById('tab-system').addEventListener('click',        () => switchTab('system'));

    // ── IPC ──────────────────────────────────────────────────────

    QB.ipc.on('quota:update', (data) => {
      lastRefreshedAt = data.lastRefreshedAt ? new Date(data.lastRefreshedAt) : new Date();
      clearDashboardDataCache();
      // Models-Tab-Cache invalidieren — beim nächsten Tab-Besuch frisch laden
      if (QB.clearModelsCache) QB.clearModelsCache();
      render(data.snapshots);
      // Joins an in-progress cost-window switch (the skeleton then stays
      // until this fresher recompute lands too); a plain background refresh
      // updates the values silently without flashing a skeleton.
      void loadAnalyticsSummary(undefined, { skeleton: _statsLoadingCount > 0 }).finally(() => {
        void prefetchSummaryWindows(activeCostWindowFromUI());
      });
      startFooterTimer();
      restartRefreshFuse();
    });

    QB.ipc.on('ui:show-tab', (tab) => switchTab(tab));

    QB.ipc.send('quota:ready');

    QB.ipc.on('quota:ready-ack', async (data) => {
      document.body.classList.toggle('view-dashboard', data.viewMode === 'dashboard');
      document.body.classList.toggle('view-compact',   data.viewMode !== 'dashboard');
      const s = await QB.ipc.invoke('settings:get');
      QB.settings = s;
      pollIntervalSec = s.pollIntervalSeconds ?? 120;
      restartRefreshFuse();
      // Cost Window initialisieren
      const activeCostWindow = s.costWindow ?? '30d';
      document.querySelectorAll('#window-pill-grid .pill').forEach(p => {
        p.classList.toggle('active', p.dataset.win === activeCostWindow);
      });
      // Insights-Panel Zustand
      if (s.insightsPanelOpen) document.getElementById('insights-panel').classList.add('open');
      // Analytics sofort laden — Skeleton statt "—"/"Lädt…" beim Start
      void loadAnalyticsSummary(activeCostWindow, { skeleton: true }).finally(() => {
        void prefetchDashboardData(activeCostWindow);
      });
    });

    QB.ipc.on('window:pin-state', (pinned) => {
      document.getElementById('btn-pin').classList.toggle('active', pinned);
      document.getElementById('btn-pin').title = pinned ? 'Unpin window' : 'Keep window open';
    });

    void loadAppChromeMeta();

    // ── Global buttons ───────────────────────────────────────────

    document.getElementById('btn-pin').addEventListener('click', () => {
      QB.ipc.send('window:toggle-pin');
    });

    document.getElementById('btn-refresh').addEventListener('click', () => {
      const btn = document.getElementById('btn-refresh');
      btn.classList.add('spinning');
      QB.ipc.send('quota:refresh');
      setTimeout(() => btn.classList.remove('spinning'), 1600);
    });

    document.getElementById('btn-close').addEventListener('click', () => {
      QB.ipc.send('window:close');
    });

    document.getElementById('btn-view-switch').addEventListener('click', async () => {
      const settings = await QB.ipc.invoke('settings:get');
      const newMode = settings.viewMode === 'dashboard' ? 'compact' : 'dashboard';
      await QB.ipc.invoke('window:set-view', newMode);
    });

    document.getElementById('btn-settings').addEventListener('click', () => {
      inSettings = !inSettings;
      document.getElementById('view-dashboard').hidden     = inSettings || activeTab !== 'live';
      document.getElementById('view-analytics').hidden     = inSettings || activeTab !== 'analytics';
      document.getElementById('view-models').hidden        = inSettings || activeTab !== 'models';
      document.getElementById('view-notifications').hidden = inSettings || activeTab !== 'notifications';
      document.getElementById('view-history').hidden       = inSettings || activeTab !== 'history';
      document.getElementById('view-plans').hidden         = inSettings || activeTab !== 'plans';
      document.getElementById('view-system').hidden        = inSettings || activeTab !== 'system';
      document.getElementById('view-settings').hidden      = !inSettings;
      document.getElementById('btn-settings').classList.toggle('active', inSettings);
      if (inSettings) loadSettingsUI();
    });

    // ── Interval pills ───────────────────────────────────────────

    document.querySelectorAll('#pill-grid .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        activePillVal = parseInt(btn.dataset.val, 10);
        document.querySelectorAll('#pill-grid .pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // ── Proxy mode pills ─────────────────────────────────────────
    function applyProxyModeUI(mode) {
      activeProxyMode = mode;
      document.querySelectorAll('#proxy-mode-grid .pill').forEach(p => {
        p.classList.toggle('active', p.dataset.proxy === mode);
      });
      const urlRow = document.getElementById('proxy-url-row');
      if (urlRow) urlRow.style.display = mode === 'manual' ? '' : 'none';
    }

    document.querySelectorAll('#proxy-mode-grid .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        applyProxyModeUI(btn.dataset.proxy);
        const result = document.getElementById('proxy-test-result');
        if (result) { result.textContent = ''; result.classList.remove('error'); }
      });
    });

    document.getElementById('btn-proxy-test').addEventListener('click', async () => {
      const btn = document.getElementById('btn-proxy-test');
      const result = document.getElementById('proxy-test-result');
      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = 'Testing…';
      if (result) { result.textContent = ''; result.classList.remove('error'); }
      try {
        const res = await QB.ipc.invoke('settings:test-proxy', {
          mode: activeProxyMode,
          url: document.getElementById('inp-proxy-url').value.trim(),
        });
        if (result) {
          if (res?.ok) {
            const via = res.proxyUrl ? `via ${res.proxyUrl}` : 'direct';
            result.textContent = `✓ Reachable (${via}, HTTP ${res.status})`;
            result.classList.remove('error');
          } else {
            result.textContent = `✗ ${res?.error || 'Connection failed'}`;
            result.classList.add('error');
          }
        }
      } catch (e) {
        if (result) { result.textContent = '✗ Test failed'; result.classList.add('error'); }
        console.error('settings:test-proxy failed', e);
      } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    });

    // ── Settings: load ───────────────────────────────────────────

    async function loadSettingsUI() {
      try {
        const s = await QB.ipc.invoke('settings:get');
        document.getElementById('tog-offline').checked   = !!s.pricingOfflineMode;
        document.getElementById('tog-anonymize').checked = !!s.anonymizeAccounts;
        document.getElementById('inp-min-share').value   = s.minModelTokenSharePct ?? 0;
        const proxy = s.proxy || { mode: 'auto', url: '' };
        document.getElementById('inp-proxy-url').value = proxy.url || '';
        applyProxyModeUI(['off', 'auto', 'manual'].includes(proxy.mode) ? proxy.mode : 'auto');
        QB.settings = s;

        activePillVal = s.pollIntervalSeconds ?? 120;
        const stdVals = [30, 60, 120, 300];
        const closest = stdVals.reduce((a, b) =>
          Math.abs(b - activePillVal) < Math.abs(a - activePillVal) ? b : a);
        document.querySelectorAll('#pill-grid .pill').forEach(p => {
          p.classList.toggle('active', parseInt(p.dataset.val, 10) === closest);
        });
      } catch (e) {
        console.error('Failed to load settings', e);
      }
    }

    // ── Settings: save ───────────────────────────────────────────

    document.getElementById('btn-save').addEventListener('click', async () => {
      const btn = document.getElementById('btn-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      const rawShare = Number(document.getElementById('inp-min-share').value);
      const payload = {
        pollIntervalSeconds: activePillVal,
        pricingOfflineMode:  document.getElementById('tog-offline').checked,
        anonymizeAccounts:   document.getElementById('tog-anonymize').checked,
        minModelTokenSharePct: Number.isFinite(rawShare) ? Math.min(100, Math.max(0, rawShare)) : 0,
        proxy: {
          mode: activeProxyMode,
          url: document.getElementById('inp-proxy-url').value.trim(),
        },
      };

      try {
        await QB.ipc.invoke('settings:save', payload);
        pollIntervalSec = activePillVal;
        restartRefreshFuse();
        clearDashboardDataCache();
        if (QB.clearAnalyticsCache) QB.clearAnalyticsCache();
        if (QB.clearModelsCache) QB.clearModelsCache();
        QB.settings = { ...(QB.settings || {}), ...payload };
        if (_lastSnapshots) render(_lastSnapshots);
        btn.textContent = '✓ Saved';
        setTimeout(() => { btn.textContent = 'Save Settings'; btn.disabled = false; }, 1800);
      } catch {
        btn.textContent = 'Error — try again';
        btn.disabled = false;
      }
    });
    // ── Render ────────────────────────────────────────────

    function render(snapshots) {
      _lastSnapshots = snapshots;
      QB.renderLive(snapshots);
    }

    async function loadAppChromeMeta() {
      try {
        const meta = await QB.ipc.invoke('app:meta');
        const versionEl = document.getElementById('titlebar-version');
        if (versionEl && meta?.version) {
          versionEl.textContent = `v${meta.version}`;
          versionEl.title = meta.variant?.label ? `${meta.variant.label} build` : '';
        }
      } catch (e) {
        console.error('app:meta failed', e);
      }
    }

    // ── Analytics Summary laden ──────────────────────────────────────

    const analyticsSummaryCache = new Map();

    function activeCostWindowFromUI() {
      return document.querySelector('#window-pill-grid .pill.active')?.dataset.win ?? '30d';
    }

    async function loadAnalyticsSummary(costWindow, { skeleton = false } = {}) {
      const win = costWindow ?? activeCostWindowFromUI();
      // Synchronous (before the first await): the old values are already
      // replaced by skeleton bars when the click handler returns.
      if (skeleton) setQuickStatsLoading();
      const token = ++_summaryRenderToken;
      try {
        const s = await loadAnalyticsSummaryForWindow(win);
        if (token !== _summaryRenderToken) return; // stale — a newer request owns the UI
        if (_statsLoadingCount > 0) {
          // Hold the result until every in-flight load is done, so the
          // numbers appear exactly once instead of changing after the fact.
          _pendingSummary = { token, summary: s };
        } else {
          renderSummary(s);
        }
      } catch (e) {
        console.error('analytics:summary failed', e);
      } finally {
        if (skeleton) clearStatsLoading();
      }
    }

    function renderSummary(s) {
      updateQuickStats(s);
      updateTopModels(s);
      updateInsights(s);
    }

    function loadAnalyticsSummaryForWindow(costWindow) {
      if (!analyticsSummaryCache.has(costWindow)) {
        analyticsSummaryCache.set(
          costWindow,
          QB.ipc.invoke('analytics:summary', { costWindow }).catch(error => {
            analyticsSummaryCache.delete(costWindow);
            throw error;
          })
        );
      }
      return analyticsSummaryCache.get(costWindow);
    }

    async function prefetchSummaryWindows(activeCostWindow) {
      for (const win of ['7d', '30d', 'all']
        .filter(win => win !== activeCostWindow)
      ) {
        await loadAnalyticsSummaryForWindow(win).catch(e => console.error('analytics summary prefetch failed', e));
      }
    }

    async function prefetchDashboardData(activeCostWindow) {
      if (QB.prefetchAnalytics) QB.prefetchAnalytics();
      if (QB.prefetchModels) QB.prefetchModels();
      await prefetchSummaryWindows(activeCostWindow);
    }

    function clearDashboardDataCache() {
      analyticsSummaryCache.clear();
    }

    // Reference counter: the skeleton stays as long as at least one
    // skeleton-holding load is in flight; the result of the newest request
    // is rendered exactly once when the counter reaches zero.
    let _statsLoadingCount = 0;
    let _summaryRenderToken = 0;
    let _pendingSummary = null; // { token, summary }

    const TOP_MODELS_SKELETON = [72, 58, 44].map(w =>
      `<tr>
        <td><span class="skel-bar" style="width:${w}px"></span></td>
        <td><span class="skel-bar" style="width:34px"></span></td>
        <td><span class="skel-bar" style="width:20px"></span></td>
      </tr>`
    ).join('');

    function setQuickStatsLoading() {
      _statsLoadingCount++;
      if (_statsLoadingCount > 1) return; // skeleton already showing
      for (const el of document.querySelectorAll('#qs-grid .qs-tile-val')) {
        el.classList.remove('reveal');
        el.classList.add('skel');
      }
      const tbody = document.getElementById('top-models-body');
      if (tbody) {
        tbody.classList.remove('reveal');
        tbody.innerHTML = TOP_MODELS_SKELETON;
      }
      document.getElementById('qs-grid')?.closest('.rp-section')?.classList.add('cw-loading');
      document.getElementById('top-models-table')?.closest('.rp-section')?.classList.add('cw-loading');
    }

    function clearStatsLoading() {
      _statsLoadingCount = Math.max(0, _statsLoadingCount - 1);
      if (_statsLoadingCount > 0) return;
      // Write the held values first, then unmask — the skeleton is replaced
      // directly by the final numbers, never by a stale intermediate state.
      if (_pendingSummary && _pendingSummary.token === _summaryRenderToken) {
        renderSummary(_pendingSummary.summary);
      }
      _pendingSummary = null;
      const vals = document.querySelectorAll('#qs-grid .qs-tile-val');
      for (const el of vals) el.classList.remove('skel', 'reveal');
      // Force a reflow so the reveal animation restarts even when the cached
      // data resolved before the skeleton was ever painted (instant switch).
      void document.getElementById('qs-grid')?.offsetWidth;
      for (const el of vals) el.classList.add('reveal');
      document.getElementById('top-models-body')?.classList.add('reveal');
      document.getElementById('qs-grid')?.closest('.rp-section')?.classList.remove('cw-loading');
      document.getElementById('top-models-table')?.closest('.rp-section')?.classList.remove('cw-loading');
    }

    function updateQuickStats(s) {
      const roi = s.roiFactor?.combined ?? 0;
      const vals = {
        'qs-api-cost':    `$${(s.apiCostUSD?.total ?? 0).toFixed(0)}`,
        'qs-roi':         `${roi.toFixed(1)}×`,
        'qs-active-days': `${s.activeDays ?? 0}/${s.windowDays ?? 30}`,
        'qs-session':     `${s.avgSessionMinutes ?? 0} min`,
      };
      for (const [id, val] of Object.entries(vals)) {
        const el = document.getElementById(id);
        if (el) { el.textContent = val; }
      }
      const roiEl = document.getElementById('qs-roi');
      if (roiEl) roiEl.style.color = QB.roiColor(roi);

      const win = activeCostWindowFromUI();
      const winLabel = win === '7d' ? '7d' : win === 'all' ? 'all time' : '30d';
      const lbl = document.getElementById('qs-api-cost-lbl');
      if (lbl) lbl.textContent = `API Eq. (${winLabel})`;
      const tip = document.getElementById('qs-api-cost-tip');
      if (tip) tip.dataset.tip = `Projected API cost for the ${winLabel === 'all time' ? 'full history' : `last ${winLabel}`}.`;
    }

    function updateTopModels(s) {
      const tbody = document.getElementById('top-models-body');
      // Rows are recreated below; without this, silent background refreshes
      // would replay the staggered reveal animation on every poll.
      tbody.classList.remove('reveal');
      if (!s.topModels?.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--t400);text-align:center">Keine Daten</td></tr>';
        return;
      }
      tbody.innerHTML = s.topModels.map(m =>
        `<tr>
          <td class="model-name" title="${QB.esc(m.model)}">${QB.esc(QB.shortModelName(m.model))}</td>
          <td>$${(m.costUSD).toFixed(2)}</td>
          <td>${(m.pctOfTotal * 100).toFixed(0)}%</td>
        </tr>`
      ).join('');
    }

    function updateInsights(s) {
      const roi  = s.roiFactor?.combined ?? 0;
      const cost = s.apiCostUSD?.total ?? 0;
      const sub  = s.subscriptionCostUSD?.total ?? 0;
      document.getElementById('ins-cost-roi').textContent =
        `$${cost.toFixed(0)} API eq.  vs $${sub.toFixed(0)} sub  ${roi.toFixed(1)}×`;
      document.getElementById('ins-cost-roi').style.color = QB.roiColor(roi);
      document.getElementById('ins-days-session').textContent =
        `${s.activeDays ?? 0}/${s.windowDays ?? 30} days active · Avg ${s.avgSessionMinutes ?? 0} min/session`;
      renderSparkline(s.sparkline7d ?? []);
    }

    function renderSparkline(data) {
      const container = document.getElementById('ins-sparkline');
      if (!data.length) { container.innerHTML = ''; return; }
      const maxVal = Math.max(...data.map(d => d.claudeUSD + d.codexUSD), 0.01);
      container.innerHTML = data.map(d => {
        const total = d.claudeUSD + d.codexUSD;
        const totalPx = Math.round((total / maxVal) * 24);
        const cPx = Math.round((d.claudeUSD / maxVal) * 24);
        const dPx = Math.max(0, totalPx - cPx);
        return `<div class="sparkline-bar-wrap" title="${d.date}: $${total.toFixed(2)}">
          <div class="sparkline-bar" style="height:${cPx}px;background:var(--claude-col)"></div>
          <div class="sparkline-bar" style="height:${dPx}px;background:var(--codex-col)"></div>
        </div>`;
      }).join('');
    }

    // Insights-Panel Toggle
    document.getElementById('insights-toggle').addEventListener('click', async () => {
      const panel = document.getElementById('insights-panel');
      const isOpen = panel.classList.toggle('open');
      const s = await QB.ipc.invoke('settings:get');
      await QB.ipc.invoke('settings:save', { ...s, insightsPanelOpen: isOpen });
    });

    // Cost-Window-Pills im rechten Panel
    document.querySelectorAll('#window-pill-grid .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#window-pill-grid .pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const win = btn.dataset.win;
        void loadAnalyticsSummary(win, { skeleton: true });
        void QB.ipc.invoke('settings:save', { costWindow: win }).then(() => {
          QB.ipc.send('quota:recompute-cost');
        });
      });
    });

    // ── Footer ────────────────────────────────────────────────────

    function startFooterTimer() {
      if (footerTimer) clearInterval(footerTimer);
      updateFooter();
      footerTimer = setInterval(updateFooter, 5000);
    }
    function updateFooter() {
      const el = document.getElementById('footer-ts');
      if (!lastRefreshedAt || !el) return;
      const sec = Math.round((Date.now() - lastRefreshedAt.getTime()) / 1000);
      if (sec < 10)  { el.textContent = 'Just updated'; return; }
      if (sec < 60)  { el.textContent = `Updated ${sec}s ago`; return; }
      el.textContent = `Updated ${Math.floor(sec / 60)}m ago`;
    }

    // ── Refresh-Fuse ──────────────────────────────────────────────

    let pollIntervalSec = 60;

    function restartRefreshFuse() {
      const fill = document.getElementById('refresh-fuse-fill');
      if (!fill) return;
      // Beim Öffnen mitten im Intervall nicht bei 0 starten: bereits
      // verstrichene Zeit per negativem animation-delay überspringen.
      const elapsed = lastRefreshedAt
        ? Math.min(Math.max((Date.now() - lastRefreshedAt.getTime()) / 1000, 0), pollIntervalSec)
        : 0;
      fill.style.setProperty('--fuse-duration', pollIntervalSec + 's');
      fill.style.animationDelay = `-${elapsed}s, ${pollIntervalSec - elapsed}s`;
      fill.classList.remove('run');
      void fill.offsetWidth; // Reflow erzwingen, damit die Animation neu startet
      fill.classList.add('run');
    }
})();
