/* Notifications / Alerts tab: status header, rules accordion, history, sticky save bar */

window.QB = window.QB || {};

// Wrapped in an IIFE so top-level const/let/function names (SEV_COLOR,
// RULE_GROUPS, initialSnapshot, ...) do not collide with other tab scripts in
// the shared global scope.
(function () {

// Severity to accent color, derived from notificationEngine.ts.
const SEV_COLOR = {
  critical: 'var(--red)',
  warning:  'var(--orange)',
  watch:    'var(--yellow)',
  info:     'var(--t300)',
};
const sevColor = sev => SEV_COLOR[sev] ?? 'var(--t300)';

// Rule definitions, including severity for the accent bar.
const RULE_GROUPS = [
  {
    label: 'Quota Window',
    rules: [
      { id: 'confirmedReset',  sev: 'info',     label: 'Confirmed Reset',    tooltip: 'Quota was reset at the expected time – a new cycle has started.' },
      { id: 'unexpectedReset', sev: 'watch',    label: 'Unexpected Reset',   tooltip: 'A reset outside the normal cycle was detected, e.g. after a plan change.' },
      { id: 'resetSoon',       sev: 'info',     label: 'Reset Soon',         tooltip: 'Quota will reset soon.',
        extras: [{ key: 'minutesBeforeReset', label: 'Min. before reset', type: 'number', min: 1, max: 120 }] },
      { id: 'highUsage',       sev: 'warning',  label: 'High Usage',         tooltip: 'A high usage threshold has been exceeded.',
        extras: [{ key: 'thresholdPercent', label: 'Threshold %', type: 'number', min: 50, max: 99 }] },
      { id: 'criticalUsage',   sev: 'critical', label: 'Critical Usage',     tooltip: 'Critical threshold reached – quota will be exhausted soon.',
        extras: [{ key: 'thresholdPercent', label: 'Threshold %', type: 'number', min: 50, max: 99 }] },
    ],
  },
  {
    label: 'Pace & Forecast',
    rules: [
      { id: 'projectedDepletion', sev: 'warning', label: 'Depletion Before Reset', tooltip: 'At the current pace, the quota will run out before the next reset.' },
      { id: 'farAhead',           sev: 'watch',   label: 'Much Too Fast',          tooltip: 'Consumption rate is significantly above the planned daily average.',
        extras: [{ key: 'minDeltaPercent', label: 'Min. Delta %', type: 'number', min: 5, max: 50 }] },
      { id: 'farBehind',          sev: 'info',    label: 'Much Too Slow',          tooltip: 'Significantly less usage than possible. Plenty of quota remaining.',
        extras: [{ key: 'minDeltaPercent', label: 'Min. Delta %', type: 'number', min: 5, max: 50 }] },
    ],
  },
  {
    // Phase 3 — history-based rules. These have config shape but no engine
    // implementation yet, so they render as disabled "Soon" cards (pending: true)
    // instead of toggles that would do nothing when enabled.
    label: 'Historical Usage',
    rules: [
      { id: 'freshQuotaWorkWindow',     sev: 'info',    label: 'Fresh Quota (Work Hours)',  pending: true, tooltip: 'A fresh work window is available after a reset.' },
      { id: 'quotaIdleAfterReset',      sev: 'info',    label: 'Quota Idle',                pending: true, tooltip: 'Quota was reset but no activity detected.' },
      { id: 'weeklyReserveOpportunity', sev: 'info',    label: 'Weekly Reserve',            pending: true, tooltip: 'Weekly remaining budget can still be used before the cycle ends.' },
      { id: 'rolling5hOutputSpike',     sev: 'watch',   label: 'Output Token Spike (5h)',   pending: true, tooltip: 'Unusually high output token surge in the rolling 5h window.' },
      { id: 'rolling5hProxyLimit',      sev: 'warning', label: 'Proxy Limit (5h)',          pending: true, tooltip: 'Output token proxy threshold reached in the 5h window.' },
      { id: 'burnRateSpike',            sev: 'warning', label: 'Burn Rate Unusually High',  pending: true, tooltip: 'Token consumption rate per hour is unusually high.' },
    ],
  },
  {
    label: 'Cost Efficiency',
    rules: [
      { id: 'missingPlan',       sev: 'info',    label: 'Missing Plan',             tooltip: 'Local provider usage data exists, but no active subscription plan is configured for ROI calculation.' },
      { id: 'cacheHitDrop',        sev: 'watch',   label: 'Cache Hit Rate Dropped',  pending: true, tooltip: 'Prompt cache hit rate has dropped. Higher costs possible.' },
      { id: 'expensiveModelShare', sev: 'watch',   label: 'Expensive Models (Spike)', pending: true, tooltip: 'Sudden spike in expensive model usage (e.g. Opus).' },
      { id: 'roiMilestone',        sev: 'info',    label: 'ROI Milestone',            pending: true, tooltip: 'An ROI milestone was reached based on usage patterns.' },
    ],
  },
  {
    label: 'Data Quality',
    rules: [
      { id: 'providerDataHealth', sev: 'watch', label: 'Data Stale / Restored', tooltip: 'API data has not been updated for a while or is available again.',
        extras: [{ key: 'staleMinutes', label: 'Minutes until alert', type: 'number', min: 1, max: 60 }] },
    ],
  },
];

const ALL_RULES = RULE_GROUPS.flatMap(g => g.rules);
// Only implemented rules count toward the "X of N active" status; pending
// (Phase 3) rules are shown as disabled and cannot be enabled.
const RULE_COUNT = ALL_RULES.filter(r => !r.pending).length;

// Module state for dirty tracking and header text.
let initialSnapshot = '';
let lastFiredText = '';

QB.renderNotifications = async function () {
  const wrap = document.getElementById('notifications-content');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty"><div class="spinner"></div><span>Loading…</span></div>';

  let settings;
  try {
    settings = await QB.ipc.invoke('settings:get');
  } catch {
    wrap.innerHTML = '<div class="empty"><span>Failed to load settings.</span></div>';
    return;
  }

  const ns = settings.notifications ?? {};
  const rules = ns.rules ?? {};

  lastFiredText = '';
  wrap.innerHTML = buildNotificationsHTML(ns, rules);
  bindNotificationsEvents(wrap);

  initialSnapshot = JSON.stringify(collectPayload(wrap));
  refreshCounts(wrap);
  updateSaveBar(wrap);

  loadNotificationHistory(wrap, rules);
};

// Build HTML.

function buildNotificationsHTML(ns, rules) {
  const enabled = ns.enabled ?? false;
  return `
    <div class="notif-head">
      <div class="notif-head-top">
        <div class="notif-head-titles">
          <div class="notif-head-title">
            Notifications
            <span class="notif-paused-badge">Paused</span>
          </div>
          <div class="notif-head-sub" id="notif-status-sub">—</div>
        </div>
        <label class="notif-master-wrap tgl" title="Enable all notifications">
          <input type="checkbox" id="notif-master" ${enabled ? 'checked' : ''}>
          <span class="tgl-track"></span>
        </label>
      </div>

      <div class="notif-segment" data-active="rules">
        <span class="notif-segment-thumb"></span>
        <button class="notif-seg-btn active" data-seg="rules">
          Rules <span class="notif-seg-count" id="notif-seg-rules">0</span>
        </button>
        <button class="notif-seg-btn" data-seg="history">
          History <span class="notif-seg-count" id="notif-seg-history">0</span>
        </button>
      </div>
    </div>

    <div class="notif-body">
      <div class="notif-view" data-view="rules">
        ${buildGlobalPanel(ns)}
        ${buildRuleGroups(rules)}
      </div>
      <div class="notif-view" data-view="history" hidden>
        <div id="notif-history-list"><div class="empty" style="padding:24px 0"><span>Loading…</span></div></div>
      </div>
    </div>

    <div class="notif-savebar" id="notif-savebar">
      <div class="notif-savebar-info">
        <span class="notif-savebar-dot"></span>
        <span id="notif-savebar-text">No changes</span>
      </div>
      <button class="notif-btn notif-btn-ghost" id="notif-discard-btn">Discard</button>
      <button class="notif-btn notif-btn-save" id="notif-save-btn">Save</button>
    </div>
  `;
}

function buildGlobalPanel(ns) {
  const quietOn = ns.quietHours?.enabled ?? false;
  const gap = ns.minimumGapMinutes ?? 0;
  return `
    <div class="notif-panel" id="notif-global-panel">
      <button class="notif-collap-head" data-collap>
        ${chevron()}
        <span class="notif-collap-title">Global Settings</span>
        <span class="notif-collap-meta">Quiet Hours · Gap</span>
      </button>
      <div class="notif-collap-body"><div class="notif-collap-inner"><div class="notif-collap-pad">

        <div class="notif-set-row">
          <div class="notif-set-col">
            <div class="notif-set-label">Quiet Hours</div>
            <div class="notif-set-hint">Only critical alerts during this period</div>
          </div>
          <label class="tgl">
            <input type="checkbox" id="notif-quiet-enabled" ${quietOn ? 'checked' : ''}>
            <span class="tgl-track"></span>
          </label>
        </div>
        <div class="notif-set-row notif-times" id="notif-quiet-times" ${quietOn ? '' : 'hidden'}>
          <div class="notif-set-label">From</div>
          <span class="notif-time-field"><input class="cost-field" type="time" id="notif-quiet-start" value="${ns.quietHours?.start ?? '22:30'}"></span>
          <div class="notif-set-label">To</div>
          <span class="notif-time-field"><input class="cost-field" type="time" id="notif-quiet-end" value="${ns.quietHours?.end ?? '08:00'}"></span>
        </div>

        <div class="notif-set-row" style="display:block">
          <div class="notif-set-label">Minimum gap between alerts</div>
          <div class="notif-gap" id="notif-gap-pills">
            ${[0, 5, 15, 30].map(v =>
              `<button class="pill${gap === v ? ' active' : ''}" data-gap="${v}">${v === 0 ? 'Off' : v + ' min'}</button>`
            ).join('')}
          </div>
          <button class="notif-test-btn" id="notif-test-btn">Send test notification</button>
        </div>

      </div></div></div>
    </div>
  `;
}

function buildRuleGroups(rules) {
  return RULE_GROUPS.map((group, gi) => {
    const open = gi === 0 ? ' is-open' : '';
    const implemented = group.rules.filter(r => !r.pending).length;
    const metaHtml = implemented === 0
      ? `<span class="notif-collap-soon">Soon</span>`
      : `<span class="notif-collap-active-dot"></span><span data-group-count>0/${implemented}</span>`;
    return `
      <div class="notif-panel notif-group-panel${open} notif-anim" data-group="${gi}" style="animation-delay:${gi * 45}ms">
        <button class="notif-collap-head" data-collap>
          ${chevron()}
          <span class="notif-collap-title">${group.label}</span>
          <span class="notif-collap-meta" data-group-meta>
            ${metaHtml}
          </span>
        </button>
        <div class="notif-collap-body"><div class="notif-collap-inner"><div class="notif-collap-pad">
          <div class="notif-cards">
            ${group.rules.map(def => buildRuleCard(def, rules[def.id] ?? {})).join('')}
          </div>
        </div></div></div>
      </div>
    `;
  }).join('');
}

function buildRuleCard(def, cfg) {
  if (def.pending) {
    // Not implemented in the engine yet — render a disabled card so it cannot be
    // toggled on. No .notif-rule-toggle here, so it is excluded from active counts
    // and from the saved payload (collectPayload).
    return `
    <div class="notif-rule is-pending" data-rule-id="${def.id}" style="--sev:${sevColor(def.sev)}">
      <div class="notif-rule-head">
        <label class="tgl tgl-disabled" title="Not available yet">
          <input type="checkbox" disabled>
          <span class="tgl-track"></span>
        </label>
        <span class="notif-rule-name">${def.label}</span>
        <span class="notif-rule-soon">Soon</span>
        <span class="notif-tip" tabindex="0" role="img" aria-label="${attrEscape(def.tooltip)}" data-tip="${attrEscape(def.tooltip)}">
          <span class="notif-tip-icon">?</span>
        </span>
      </div>
    </div>
  `;
  }

  const enabled = cfg.enabled ?? false;
  const cooldown = cfg.cooldownMinutes ?? 60;
  const extrasHtml = (def.extras ?? []).map(ex => {
    const val = cfg[ex.key] ?? '';
    const step = ex.step ? `step="${ex.step}"` : '';
    return `
      <label class="notif-field">
        <span class="notif-field-label">${ex.label}</span>
        <span class="notif-field-box">
          <input class="notif-field-input notif-extra-field" type="${ex.type}"
                 min="${ex.min}" max="${ex.max}" ${step}
                 data-rule="${def.id}" data-key="${ex.key}" value="${val}">
        </span>
      </label>`;
  }).join('');

  return `
    <div class="notif-rule ${enabled ? 'is-on' : 'is-off'}" data-rule-id="${def.id}" style="--sev:${sevColor(def.sev)}">
      <div class="notif-rule-head">
        <label class="tgl">
          <input type="checkbox" class="notif-rule-toggle" data-rule="${def.id}" ${enabled ? 'checked' : ''}>
          <span class="tgl-track"></span>
        </label>
        <span class="notif-rule-name">${def.label}</span>
        <span class="notif-tip" tabindex="0" role="img" aria-label="${attrEscape(def.tooltip)}" data-tip="${attrEscape(def.tooltip)}">
          <span class="notif-tip-icon">?</span>
        </span>
      </div>
      <div class="notif-rule-config">
        <div class="notif-rule-config-inner">
          <div class="notif-rule-fields">
            <label class="notif-field">
              <span class="notif-field-label">Cooldown</span>
              <span class="notif-field-box">
                <input class="notif-field-input notif-cooldown-field" type="number" min="0" max="10080"
                       data-rule="${def.id}" data-key="cooldownMinutes" value="${cooldown}">
                <span class="notif-field-unit">min</span>
              </span>
            </label>
            ${extrasHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}

function chevron() {
  return `<svg class="notif-collap-icon" width="11" height="11" viewBox="0 0 16 16" fill="none">
    <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function attrEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Tooltip portal, avoiding overflow clipping in accordion and scroll containers.

function ensureTooltipEl() {
  let el = document.getElementById('notif-tooltip-float');
  if (!el) {
    el = document.createElement('div');
    el.id = 'notif-tooltip-float';
    el.className = 'notif-tooltip-float';
    document.body.appendChild(el);
  }
  return el;
}

function showTooltip(tip, anchor) {
  tip.textContent = anchor.dataset.tip || '';
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
  let top = r.top - th - 9;
  tip.style.transformOrigin = 'bottom center';
  if (top < 6) { top = r.bottom + 9; tip.style.transformOrigin = 'top center'; }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.classList.add('is-visible');
}

function hideTooltip(tip) {
  tip.classList.remove('is-visible');
}

// Event binding.

function bindNotificationsEvents(wrap) {
  // Segmented control
  const segment = wrap.querySelector('.notif-segment');
  wrap.querySelectorAll('.notif-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const seg = btn.dataset.seg;
      segment.dataset.active = seg;
      wrap.querySelectorAll('.notif-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      wrap.querySelectorAll('.notif-view').forEach(v => { v.hidden = v.dataset.view !== seg; });
    });
  });

  // Accordion for global settings and rule groups
  wrap.querySelectorAll('[data-collap]').forEach(head => {
    head.addEventListener('click', () => head.closest('.notif-panel').classList.toggle('is-open'));
  });

  // Tooltips rendered as a body-level portal to avoid overflow clipping
  const tip = ensureTooltipEl();
  wrap.querySelectorAll('.notif-tip').forEach(el => {
    el.addEventListener('mouseenter', () => showTooltip(tip, el));
    el.addEventListener('mouseleave', () => hideTooltip(tip));
    el.addEventListener('focusin',  () => showTooltip(tip, el));
    el.addEventListener('focusout', () => hideTooltip(tip));
  });
  // Hide while scrolling so the tooltip does not remain detached from its anchor
  wrap.addEventListener('scroll', () => hideTooltip(tip), { passive: true });

  // Master switch updates the paused badge
  const master = wrap.querySelector('#notif-master');
  const syncPaused = () => wrap.classList.toggle('is-paused', !master.checked);
  master?.addEventListener('change', syncPaused);
  syncPaused();

  // Quiet hours toggle
  const quietToggle = wrap.querySelector('#notif-quiet-enabled');
  const quietTimes  = wrap.querySelector('#notif-quiet-times');
  quietToggle?.addEventListener('change', () => { if (quietTimes) quietTimes.hidden = !quietToggle.checked; });

  // Gap pills
  wrap.querySelectorAll('#notif-gap-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('#notif-gap-pills .pill').forEach(p => p.classList.toggle('active', p === btn));
      updateSaveBar(wrap);
    });
  });

  // Rule toggles update is-on/is-off classes, counts, and save bar
  wrap.querySelectorAll('.notif-rule-toggle').forEach(tog => {
    tog.addEventListener('change', () => {
      tog.closest('.notif-rule')?.classList.toggle('is-on', tog.checked);
      tog.closest('.notif-rule')?.classList.toggle('is-off', !tog.checked);
      refreshCounts(wrap);
      updateSaveBar(wrap);
    });
  });

  // Any field change → save bar
  wrap.querySelectorAll('.notif-cooldown-field, .notif-extra-field, #notif-quiet-start, #notif-quiet-end')
    .forEach(inp => inp.addEventListener('input', () => updateSaveBar(wrap)));
  wrap.querySelector('#notif-master')?.addEventListener('change', () => updateSaveBar(wrap));
  wrap.querySelector('#notif-quiet-enabled')?.addEventListener('change', () => updateSaveBar(wrap));

  // Test button
  wrap.querySelector('#notif-test-btn')?.addEventListener('click', async () => {
    try { await QB.ipc.invoke('notification:test'); } catch (e) { console.error(e); }
  });

  // Save and discard
  wrap.querySelector('#notif-save-btn')?.addEventListener('click', () => saveNotificationSettings(wrap));
  wrap.querySelector('#notif-discard-btn')?.addEventListener('click', () => QB.renderNotifications());
}

// Counts and status header.

function refreshCounts(wrap) {
  let activeTotal = 0;
  wrap.querySelectorAll('.notif-group-panel').forEach(panel => {
    const toggles = panel.querySelectorAll('.notif-rule-toggle');
    const active = panel.querySelectorAll('.notif-rule-toggle:checked').length;
    activeTotal += active;
    const countEl = panel.querySelector('[data-group-count]');
    if (countEl) countEl.textContent = `${active}/${toggles.length}`;
    const dot = panel.querySelector('.notif-collap-active-dot');
    if (dot) dot.classList.toggle('is-zero', active === 0);
  });

  const segRules = wrap.querySelector('#notif-seg-rules');
  if (segRules) segRules.textContent = String(activeTotal);

  updateStatusSub(wrap, activeTotal);
}

function updateStatusSub(wrap, activeTotal) {
  const sub = wrap.querySelector('#notif-status-sub');
  if (!sub) return;
  if (activeTotal == null) {
    activeTotal = wrap.querySelectorAll('.notif-rule-toggle:checked').length;
  }
  let text = `${activeTotal} of ${RULE_COUNT} rules active`;
  if (lastFiredText) text += ` · last ${lastFiredText}`;
  sub.textContent = text;
}

// Dirty tracking and save bar.

function collectPayload(wrap) {
  const enabled      = wrap.querySelector('#notif-master')?.checked ?? true;
  const quietEnabled = wrap.querySelector('#notif-quiet-enabled')?.checked ?? false;
  const quietStart   = wrap.querySelector('#notif-quiet-start')?.value ?? '22:30';
  const quietEnd     = wrap.querySelector('#notif-quiet-end')?.value   ?? '08:00';
  const activeGap    = wrap.querySelector('#notif-gap-pills .pill.active');
  const minimumGapMinutes = activeGap ? parseInt(activeGap.dataset.gap, 10) : 0;

  const rules = {};
  wrap.querySelectorAll('.notif-rule-toggle').forEach(tog => {
    const id = tog.dataset.rule;
    (rules[id] ??= {}).enabled = tog.checked;
  });
  wrap.querySelectorAll('.notif-cooldown-field, .notif-extra-field').forEach(inp => {
    const id = inp.dataset.rule;
    (rules[id] ??= {})[inp.dataset.key] =
      inp.type === 'number' ? (inp.value === '' ? null : parseFloat(inp.value)) : inp.value;
  });

  return { enabled, quietHours: { enabled: quietEnabled, start: quietStart, end: quietEnd }, minimumGapMinutes, rules };
}

function countChanges(a, b) {
  if (a === b) return 0;
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return 1;
  let n = 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) n += countChanges(a[k], b[k]);
  return n;
}

function updateSaveBar(wrap) {
  const bar = wrap.querySelector('#notif-savebar');
  if (!bar || !initialSnapshot) return;
  const current = collectPayload(wrap);
  const diff = countChanges(JSON.parse(initialSnapshot), current);
  const txt = wrap.querySelector('#notif-savebar-text');
  if (diff > 0) {
    if (txt) txt.textContent = diff === 1 ? '1 change' : `${diff} changes`;
    bar.classList.add('is-open');
  } else {
    bar.classList.remove('is-open');
  }
}

async function saveNotificationSettings(wrap) {
  const btn  = wrap.querySelector('#notif-save-btn');
  const bar  = wrap.querySelector('#notif-savebar');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const payload = collectPayload(wrap);

  try {
    await QB.ipc.invoke('notification:settings:save', payload);
    initialSnapshot = JSON.stringify(payload);
    btn.textContent = '✓ Saved';
    bar?.classList.remove('is-open');
    setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1600);
  } catch (e) {
    btn.textContent = 'Error – retry';
    btn.disabled = false;
    console.error(e);
  }
}

// Load history.

function ruleLabel(ruleId) {
  return ALL_RULES.find(r => r.id === ruleId)?.label ?? ruleId;
}

function ruleSeverity(ruleId, fallback) {
  return ALL_RULES.find(r => r.id === ruleId)?.sev ?? fallback ?? 'info';
}

function formatRelative(date) {
  const diffMs = Date.now() - date.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

async function loadNotificationHistory(wrap, rules) {
  const list = wrap.querySelector('#notif-history-list');
  const segHist = wrap.querySelector('#notif-seg-history');
  if (!list) return;
  try {
    const history = await QB.ipc.invoke('notification:history');
    if (segHist) segHist.textContent = String(history?.length ?? 0);

    if (history && history.length > 0) {
      lastFiredText = formatRelative(new Date(history[0].firedAt));
      updateStatusSub(wrap, null);
    }

    if (!history || history.length === 0) {
      list.innerHTML = '<div class="empty notif-hist-empty"><span>No alerts yet.</span></div>';
      return;
    }

    list.className = 'notif-hist';
    list.innerHTML = history.map((e, i) => {
      const time = new Date(e.firedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const date = new Date(e.firedAt).toLocaleDateString('en-US', { day: '2-digit', month: '2-digit' });
      const providerLabel = e.provider ? e.provider[0].toUpperCase() + e.provider.slice(1) : '';
      const providerCls = e.provider === 'claude' ? 'is-claude' : e.provider === 'codex' ? 'is-codex' : '';
      const sev = ruleSeverity(e.ruleId, e.severity);
      const isMuteEntry = e.reason === 'rule-muted';
      const ruleEnabled = rules[e.ruleId]?.enabled !== false;
      const delay = `animation-delay:${Math.min(i, 14) * 40}ms`;
      const muteBtn = isMuteEntry ? '' : `
        <button class="notif-hist-mute" data-rule="${e.ruleId}" ${ruleEnabled ? '' : 'disabled'}
                title="Permanently disable notification type &quot;${ruleLabel(e.ruleId)}&quot;">
          ${ruleEnabled ? 'Mute' : 'Disabled'}
        </button>`;
      return `
        <div class="notif-hist-entry notif-anim${isMuteEntry ? ' notif-hist-muted' : ''}" style="--sev:${sevColor(sev)};${delay}">
          <div class="notif-hist-meta">
            <span class="notif-hist-time">${date} ${time}</span>
            ${providerLabel ? `<span class="notif-hist-provider ${providerCls}">${providerLabel}</span>` : ''}
            ${e.windowName ? `<span class="notif-hist-window">${e.windowName}</span>` : ''}
            ${muteBtn}
          </div>
          <div class="notif-hist-body">${isMuteEntry ? `Type &quot;${ruleLabel(e.ruleId)}&quot; disabled` : e.body}</div>
          <div class="notif-hist-reason">${e.reason}</div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.notif-hist-mute').forEach(btn => {
      btn.addEventListener('click', () => void muteRuleFromHistory(wrap, rules, btn.dataset.rule));
    });
  } catch (e) {
    list.innerHTML = '<div class="empty notif-hist-empty"><span>History not available.</span></div>';
    console.error(e);
  }
}

async function muteRuleFromHistory(wrap, rules, ruleId) {
  try {
    await QB.ipc.invoke('notification:settings:save', {
      rules: { [ruleId]: { ...(rules[ruleId] ?? {}), enabled: false } },
    });
    if (rules[ruleId]) rules[ruleId].enabled = false; else rules[ruleId] = { enabled: false };

    wrap.querySelectorAll(`.notif-hist-mute[data-rule="${ruleId}"]`).forEach(b => {
      b.disabled = true;
      b.textContent = 'Disabled';
    });
    // Sync rule toggle + card in rules tab
    const toggle = wrap.querySelector(`.notif-rule-toggle[data-rule="${ruleId}"]`);
    if (toggle) {
      toggle.checked = false;
      toggle.closest('.notif-rule')?.classList.replace('is-on', 'is-off');
    }
    refreshCounts(wrap);
    // Sync snapshot so direct mute doesn't trigger an "unsaved change"
    const snap = JSON.parse(initialSnapshot || '{}');
    if (snap.rules?.[ruleId]) snap.rules[ruleId].enabled = false;
    initialSnapshot = JSON.stringify(snap);
    updateSaveBar(wrap);
  } catch (e) {
    console.error('Mute via history failed', e);
  }
}

})();
