/* Notifications / Alerts-Tab ─ Status-Header, Regeln (Akkordeon), Verlauf, Sticky Save-Bar */

window.QB = window.QB || {};

// ── Severity → Akzentfarbe (abgeleitet aus notificationEngine.ts) ───────────
const SEV_COLOR = {
  critical: 'var(--red)',
  warning:  'var(--orange)',
  watch:    'var(--yellow)',
  info:     'var(--t300)',
};
const sevColor = sev => SEV_COLOR[sev] ?? 'var(--t300)';

// ── Regeldefinitionen (inkl. Severity für die Akzentleiste) ─────────────────
const RULE_GROUPS = [
  {
    label: 'Kontingent-Fenster',
    rules: [
      { id: 'confirmedReset',  sev: 'info',     label: 'Bestätigter Reset',    tooltip: 'Das Kontingent wurde zur erwarteten Zeit zurückgesetzt – ein neuer Zyklus hat begonnen.' },
      { id: 'unexpectedReset', sev: 'watch',    label: 'Unerwarteter Reset',   tooltip: 'Ein Reset außerhalb des normalen Zyklus wurde erkannt, z.B. nach einem Planwechsel.' },
      { id: 'resetSoon',       sev: 'info',     label: 'Reset in Kürze',       tooltip: 'Das Kontingent setzt sich bald zurück.',
        extras: [{ key: 'minutesBeforeReset', label: 'Min. vor Reset', type: 'number', min: 1, max: 120 }] },
      { id: 'highUsage',       sev: 'warning',  label: 'Hoher Verbrauch',      tooltip: 'Eine hohe Verbrauchsschwelle wurde überschritten.',
        extras: [{ key: 'thresholdPercent', label: 'Schwelle %', type: 'number', min: 50, max: 99 }] },
      { id: 'criticalUsage',   sev: 'critical', label: 'Kritischer Verbrauch', tooltip: 'Kritische Schwelle erreicht – das Kontingent wird bald erschöpft sein.',
        extras: [{ key: 'thresholdPercent', label: 'Schwelle %', type: 'number', min: 50, max: 99 }] },
    ],
  },
  {
    label: 'Tempo & Prognose',
    rules: [
      { id: 'projectedDepletion', sev: 'warning', label: 'Erschöpfung vor Reset', tooltip: 'Beim aktuellen Tempo wird das Kontingent vor dem nächsten Reset aufgebraucht.' },
      { id: 'farAhead',           sev: 'watch',   label: 'Deutlich zu schnell',  tooltip: 'Verbrauchstempo liegt deutlich über dem geplanten Tagesdurchschnitt.',
        extras: [{ key: 'minDeltaPercent', label: 'Min. Delta %', type: 'number', min: 5, max: 50 }] },
      { id: 'farBehind',          sev: 'info',    label: 'Deutlich zu langsam',  tooltip: 'Deutlich weniger Nutzung als möglich. Noch viel Kontingent verfügbar.',
        extras: [{ key: 'minDeltaPercent', label: 'Min. Delta %', type: 'number', min: 5, max: 50 }] },
    ],
  },
  {
    label: 'Historische Nutzung',
    rules: [
      { id: 'freshQuotaWorkWindow',     sev: 'info',    label: 'Frisches Kontingent (Arbeitszeit)', tooltip: 'Nach einem Reset steht ein frisches Arbeitsfenster bereit.',
        extras: [{ key: 'maxUsedPercent', label: 'Max. Verbrauch %', type: 'number', min: 5, max: 50 }] },
      { id: 'quotaIdleAfterReset',      sev: 'info',    label: 'Kontingent ungenutzt',              tooltip: 'Das Kontingent wurde zurückgesetzt, aber keine Aktivität erkannt.' },
      { id: 'weeklyReserveOpportunity', sev: 'info',    label: 'Wöchentliche Reserve',              tooltip: 'Wöchentliches Restbudget kann noch eingesetzt werden, bevor der Zyklus endet.' },
      { id: 'rolling5hOutputSpike',     sev: 'watch',   label: 'Output-Token-Spike (5h)',           tooltip: 'Ungewöhnlich hoher Output-Token-Anstieg im gleitenden 5h-Fenster.' },
      { id: 'rolling5hProxyLimit',      sev: 'warning', label: 'Proxy-Limit (5h)',                  tooltip: 'Output-Token-Proxy-Schwelle im 5h-Fenster erreicht.',
        extras: [{ key: 'thresholdPercent', label: 'Schwelle %', type: 'number', min: 50, max: 100 }, { key: 'customOutputTokenLimit', label: 'Token-Limit', type: 'number', min: 10000, max: 5000000 }] },
      { id: 'burnRateSpike',            sev: 'warning', label: 'Burn-Rate ungewöhnlich hoch',       tooltip: 'Token-Verbrauchsrate pro Stunde ist ungewöhnlich hoch.',
        extras: [{ key: 'factor', label: 'Faktor', type: 'number', min: 1.1, max: 10, step: 0.1 }] },
    ],
  },
  {
    label: 'Wirtschaftlichkeit',
    rules: [
      { id: 'cacheHitDrop',        sev: 'watch',   label: 'Cache-Hit-Rate gesunken', tooltip: 'Die Prompt-Cache-Trefferrate ist gesunken. Höhere Kosten möglich.' },
      { id: 'expensiveModelShare', sev: 'watch',   label: 'Teure Modelle (Spike)',   tooltip: 'Plötzlicher Anstieg bei teuren Modellen (z.B. Opus).',
        extras: [{ key: 'thresholdPercent', label: 'Schwelle %', type: 'number', min: 5, max: 100 }] },
      { id: 'roiMilestone',        sev: 'info',    label: 'ROI-Meilenstein',         tooltip: 'Ein ROI-Meilenstein wurde basierend auf Nutzungsmustern erreicht.' },
    ],
  },
  {
    label: 'Datenqualität',
    rules: [
      { id: 'providerDataHealth', sev: 'watch', label: 'Daten veraltet / wiederhergestellt', tooltip: 'API-Daten wurden längere Zeit nicht aktualisiert oder sind wieder verfügbar.',
        extras: [{ key: 'staleMinutes', label: 'Minuten bis Alert', type: 'number', min: 1, max: 60 }] },
    ],
  },
];

const ALL_RULES = RULE_GROUPS.flatMap(g => g.rules);
const RULE_COUNT = ALL_RULES.length;

// ── Modulzustand für Dirty-Tracking & Header ────────────────────────────────
let initialSnapshot = '';
let lastFiredText = '';

QB.renderNotifications = async function () {
  const wrap = document.getElementById('notifications-content');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty"><div class="spinner"></div><span>Lädt…</span></div>';

  let settings;
  try {
    settings = await QB.ipc.invoke('settings:get');
  } catch {
    wrap.innerHTML = '<div class="empty"><span>Fehler beim Laden der Einstellungen.</span></div>';
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

// ── HTML aufbauen ────────────────────────────────────────────────────────────

function buildNotificationsHTML(ns, rules) {
  const enabled = ns.enabled ?? false;
  return `
    <div class="notif-head">
      <div class="notif-head-top">
        <div class="notif-head-titles">
          <div class="notif-head-title">
            Benachrichtigungen
            <span class="notif-paused-badge">Pausiert</span>
          </div>
          <div class="notif-head-sub" id="notif-status-sub">—</div>
        </div>
        <label class="notif-master-wrap tgl" title="Alle Benachrichtigungen aktivieren">
          <input type="checkbox" id="notif-master" ${enabled ? 'checked' : ''}>
          <span class="tgl-track"></span>
        </label>
      </div>

      <div class="notif-segment" data-active="rules">
        <span class="notif-segment-thumb"></span>
        <button class="notif-seg-btn active" data-seg="rules">
          Regeln <span class="notif-seg-count" id="notif-seg-rules">0</span>
        </button>
        <button class="notif-seg-btn" data-seg="history">
          Verlauf <span class="notif-seg-count" id="notif-seg-history">0</span>
        </button>
      </div>
    </div>

    <div class="notif-body">
      <div class="notif-view" data-view="rules">
        ${buildGlobalPanel(ns)}
        ${buildRuleGroups(rules)}
      </div>
      <div class="notif-view" data-view="history" hidden>
        <div id="notif-history-list"><div class="empty" style="padding:24px 0"><span>Lädt…</span></div></div>
      </div>
    </div>

    <div class="notif-savebar" id="notif-savebar">
      <div class="notif-savebar-info">
        <span class="notif-savebar-dot"></span>
        <span id="notif-savebar-text">Keine Änderungen</span>
      </div>
      <button class="notif-btn notif-btn-ghost" id="notif-discard-btn">Verwerfen</button>
      <button class="notif-btn notif-btn-save" id="notif-save-btn">Speichern</button>
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
        <span class="notif-collap-title">Globale Einstellungen</span>
        <span class="notif-collap-meta">Stille Stunden · Abstand</span>
      </button>
      <div class="notif-collap-body"><div class="notif-collap-inner"><div class="notif-collap-pad">

        <div class="notif-set-row">
          <div class="notif-set-col">
            <div class="notif-set-label">Stille Stunden</div>
            <div class="notif-set-hint">Nur kritische Meldungen in diesem Zeitraum</div>
          </div>
          <label class="tgl">
            <input type="checkbox" id="notif-quiet-enabled" ${quietOn ? 'checked' : ''}>
            <span class="tgl-track"></span>
          </label>
        </div>
        <div class="notif-set-row notif-times" id="notif-quiet-times" ${quietOn ? '' : 'hidden'}>
          <div class="notif-set-label">Von</div>
          <span class="notif-time-field"><input class="cost-field" type="time" id="notif-quiet-start" value="${ns.quietHours?.start ?? '22:30'}"></span>
          <div class="notif-set-label">Bis</div>
          <span class="notif-time-field"><input class="cost-field" type="time" id="notif-quiet-end" value="${ns.quietHours?.end ?? '08:00'}"></span>
        </div>

        <div class="notif-set-row" style="display:block">
          <div class="notif-set-label">Mindestabstand zwischen Meldungen</div>
          <div class="notif-gap" id="notif-gap-pills">
            ${[0, 5, 15, 30].map(v =>
              `<button class="pill${gap === v ? ' active' : ''}" data-gap="${v}">${v === 0 ? 'Aus' : v + ' min'}</button>`
            ).join('')}
          </div>
          <button class="notif-test-btn" id="notif-test-btn">Test-Benachrichtigung senden</button>
        </div>

      </div></div></div>
    </div>
  `;
}

function buildRuleGroups(rules) {
  return RULE_GROUPS.map((group, gi) => {
    const open = gi === 0 ? ' is-open' : '';
    return `
      <div class="notif-panel notif-group-panel${open} notif-anim" data-group="${gi}" style="animation-delay:${gi * 45}ms">
        <button class="notif-collap-head" data-collap>
          ${chevron()}
          <span class="notif-collap-title">${group.label}</span>
          <span class="notif-collap-meta" data-group-meta>
            <span class="notif-collap-active-dot"></span>
            <span data-group-count>0/${group.rules.length}</span>
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

// ── Tooltip-Portal (umgeht Overflow-Clipping der Akkordeon-/Scroll-Container) ─

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

// ── Event-Binding ──────────────────────────────────────────────────────────

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

  // Akkordeon (global + Gruppen)
  wrap.querySelectorAll('[data-collap]').forEach(head => {
    head.addEventListener('click', () => head.closest('.notif-panel').classList.toggle('is-open'));
  });

  // Tooltips (Portal an <body>, gegen Overflow-Clipping)
  const tip = ensureTooltipEl();
  wrap.querySelectorAll('.notif-tip').forEach(el => {
    el.addEventListener('mouseenter', () => showTooltip(tip, el));
    el.addEventListener('mouseleave', () => hideTooltip(tip));
    el.addEventListener('focusin',  () => showTooltip(tip, el));
    el.addEventListener('focusout', () => hideTooltip(tip));
  });
  // Beim Scrollen ausblenden, damit der Tooltip nicht "stehen bleibt"
  wrap.addEventListener('scroll', () => hideTooltip(tip), { passive: true });

  // Master switch → Pausiert-Badge
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

  // Regel-Toggles → is-on/is-off Klasse, Zähler & Save-Bar
  wrap.querySelectorAll('.notif-rule-toggle').forEach(tog => {
    tog.addEventListener('change', () => {
      tog.closest('.notif-rule')?.classList.toggle('is-on', tog.checked);
      tog.closest('.notif-rule')?.classList.toggle('is-off', !tog.checked);
      refreshCounts(wrap);
      updateSaveBar(wrap);
    });
  });

  // Beliebige Feld-Änderung → Save-Bar
  wrap.querySelectorAll('.notif-cooldown-field, .notif-extra-field, #notif-quiet-start, #notif-quiet-end')
    .forEach(inp => inp.addEventListener('input', () => updateSaveBar(wrap)));
  wrap.querySelector('#notif-master')?.addEventListener('change', () => updateSaveBar(wrap));
  wrap.querySelector('#notif-quiet-enabled')?.addEventListener('change', () => updateSaveBar(wrap));

  // Test button
  wrap.querySelector('#notif-test-btn')?.addEventListener('click', async () => {
    try { await QB.ipc.invoke('notification:test'); } catch (e) { console.error(e); }
  });

  // Speichern / Verwerfen
  wrap.querySelector('#notif-save-btn')?.addEventListener('click', () => saveNotificationSettings(wrap));
  wrap.querySelector('#notif-discard-btn')?.addEventListener('click', () => QB.renderNotifications());
}

// ── Zähler & Status-Header ───────────────────────────────────────────────────

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
  let text = `${activeTotal} von ${RULE_COUNT} Regeln aktiv`;
  if (lastFiredText) text += ` · zuletzt ${lastFiredText}`;
  sub.textContent = text;
}

// ── Dirty-Tracking & Save-Bar ────────────────────────────────────────────────

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
    if (txt) txt.textContent = diff === 1 ? '1 Änderung' : `${diff} Änderungen`;
    bar.classList.add('is-open');
  } else {
    bar.classList.remove('is-open');
  }
}

async function saveNotificationSettings(wrap) {
  const btn  = wrap.querySelector('#notif-save-btn');
  const bar  = wrap.querySelector('#notif-savebar');
  btn.disabled = true;
  btn.textContent = 'Speichert…';

  const payload = collectPayload(wrap);

  try {
    await QB.ipc.invoke('notification:settings:save', payload);
    initialSnapshot = JSON.stringify(payload);
    btn.textContent = '✓ Gespeichert';
    bar?.classList.remove('is-open');
    setTimeout(() => { btn.textContent = 'Speichern'; btn.disabled = false; }, 1600);
  } catch (e) {
    btn.textContent = 'Fehler – erneut';
    btn.disabled = false;
    console.error(e);
  }
}

// ── Verlauf laden ──────────────────────────────────────────────────────────

function ruleLabel(ruleId) {
  return ALL_RULES.find(r => r.id === ruleId)?.label ?? ruleId;
}

function ruleSeverity(ruleId, fallback) {
  return ALL_RULES.find(r => r.id === ruleId)?.sev ?? fallback ?? 'info';
}

function formatRelative(date) {
  const diffMs = Date.now() - date.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} h`;
  const d = Math.round(h / 24);
  return `vor ${d} ${d === 1 ? 'Tag' : 'Tagen'}`;
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
      list.innerHTML = '<div class="empty notif-hist-empty"><span>Noch keine Meldungen.</span></div>';
      return;
    }

    list.className = 'notif-hist';
    list.innerHTML = history.map((e, i) => {
      const time = new Date(e.firedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const date = new Date(e.firedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      const providerLabel = e.provider ? e.provider[0].toUpperCase() + e.provider.slice(1) : '';
      const providerCls = e.provider === 'claude' ? 'is-claude' : e.provider === 'codex' ? 'is-codex' : '';
      const sev = ruleSeverity(e.ruleId, e.severity);
      const isMuteEntry = e.reason === 'rule-muted';
      const ruleEnabled = rules[e.ruleId]?.enabled !== false;
      const delay = `animation-delay:${Math.min(i, 14) * 40}ms`;
      const muteBtn = isMuteEntry ? '' : `
        <button class="notif-hist-mute" data-rule="${e.ruleId}" ${ruleEnabled ? '' : 'disabled'}
                title="Benachrichtigungstyp „${ruleLabel(e.ruleId)}“ dauerhaft deaktivieren">
          ${ruleEnabled ? 'Stumm' : 'Deaktiviert'}
        </button>`;
      return `
        <div class="notif-hist-entry notif-anim${isMuteEntry ? ' notif-hist-muted' : ''}" style="--sev:${sevColor(sev)};${delay}">
          <div class="notif-hist-meta">
            <span class="notif-hist-time">${date} ${time}</span>
            ${providerLabel ? `<span class="notif-hist-provider ${providerCls}">${providerLabel}</span>` : ''}
            ${e.windowName ? `<span class="notif-hist-window">${e.windowName}</span>` : ''}
            ${muteBtn}
          </div>
          <div class="notif-hist-body">${isMuteEntry ? `Typ „${ruleLabel(e.ruleId)}“ deaktiviert` : e.body}</div>
          <div class="notif-hist-reason">${e.reason}</div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.notif-hist-mute').forEach(btn => {
      btn.addEventListener('click', () => void muteRuleFromHistory(wrap, rules, btn.dataset.rule));
    });
  } catch (e) {
    list.innerHTML = '<div class="empty notif-hist-empty"><span>Verlauf nicht verfügbar.</span></div>';
    console.error(e);
  }
}

async function muteRuleFromHistory(wrap, rules, ruleId) {
  try {
    await QB.ipc.invoke('notification:settings:save', {
      rules: { [ruleId]: { ...(rules[ruleId] ?? {}), enabled: false } },
    });
    if (rules[ruleId]) rules[ruleId].enabled = false; else rules[ruleId] = { enabled: false };

    // Verlauf-Buttons synchronisieren
    wrap.querySelectorAll(`.notif-hist-mute[data-rule="${ruleId}"]`).forEach(b => {
      b.disabled = true;
      b.textContent = 'Deaktiviert';
    });
    // Regel-Toggle + Karte im Regeln-Tab synchronisieren
    const toggle = wrap.querySelector(`.notif-rule-toggle[data-rule="${ruleId}"]`);
    if (toggle) {
      toggle.checked = false;
      toggle.closest('.notif-rule')?.classList.replace('is-on', 'is-off');
    }
    refreshCounts(wrap);
    // Snapshot mitziehen, damit die direkte Mute-Aktion keine "ungespeicherte Änderung" auslöst
    const snap = JSON.parse(initialSnapshot || '{}');
    if (snap.rules?.[ruleId]) snap.rules[ruleId].enabled = false;
    initialSnapshot = JSON.stringify(snap);
    updateSaveBar(wrap);
  } catch (e) {
    console.error('Mute via Verlauf fehlgeschlagen', e);
  }
}
