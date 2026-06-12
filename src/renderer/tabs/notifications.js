/* Notifications-Tab ─ Regeln, Globale Einstellungen, Verlauf */

window.QB = window.QB || {};

QB.renderNotifications = async function () {
  const wrap = document.getElementById('notifications-content');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty"><div class="spinner"></div><span>Lädt…</span></div>';

  let settings;
  try {
    settings = await QB.ipc.invoke('settings:get');
  } catch (e) {
    wrap.innerHTML = '<div class="empty"><span>Fehler beim Laden der Einstellungen.</span></div>';
    return;
  }

  const ns = settings.notifications ?? {};
  const rules = ns.rules ?? {};

  wrap.innerHTML = buildNotificationsHTML(ns, rules);
  bindNotificationsEvents(wrap, ns, rules);
  loadNotificationHistory(wrap, rules);
};

// ── HTML aufbauen ──────────────────────────────────────────────────────────

function buildNotificationsHTML(ns, rules) {
  return `
    <div class="notif-global-section">
      <div class="notif-section-title">Global</div>

      <div class="toggle-row">
        <span class="toggle-label">Benachrichtigungen aktivieren</span>
        <label class="tgl">
          <input type="checkbox" id="notif-master" ${ns.enabled ? 'checked' : ''}>
          <span class="tgl-track"></span>
        </label>
      </div>

      <div class="notif-row-group" id="notif-global-detail" ${ns.enabled ? '' : 'hidden'}>
        <div class="toggle-row">
          <span class="toggle-label">Stille Stunden</span>
          <label class="tgl">
            <input type="checkbox" id="notif-quiet-enabled" ${ns.quietHours?.enabled ? 'checked' : ''}>
            <span class="tgl-track"></span>
          </label>
        </div>
        <div class="notif-time-row" id="notif-quiet-times" ${ns.quietHours?.enabled ? '' : 'hidden'}>
          <span class="cost-label">Von</span>
          <input class="cost-field notif-time-field" type="time" id="notif-quiet-start" value="${ns.quietHours?.start ?? '22:30'}">
          <span class="cost-label">Bis</span>
          <input class="cost-field notif-time-field" type="time" id="notif-quiet-end" value="${ns.quietHours?.end ?? '08:00'}">
        </div>

        <div class="toggle-row">
          <span class="toggle-label">Mindestabstand zwischen Meldungen</span>
          <div class="pill-grid notif-gap-pills">
            ${[0, 5, 15, 30].map(v =>
              `<button class="pill${(ns.minimumGapMinutes ?? 0) === v ? ' active' : ''}" data-gap="${v}">
                ${v === 0 ? 'Aus' : v + ' min'}
              </button>`
            ).join('')}
          </div>
        </div>

        <button class="notif-test-btn" id="notif-test-btn">Test-Benachrichtigung senden</button>
      </div>
    </div>

    <div class="notif-rules-section">
      <div class="notif-section-title">Regeln</div>
      ${buildRuleGroups(rules)}
    </div>

    <div class="notif-save-row">
      <button class="save-btn" id="notif-save-btn">Speichern</button>
      <span class="save-note" id="notif-save-note"></span>
    </div>

    <div class="notif-history-section">
      <div class="notif-section-title">Letzte Meldungen</div>
      <div id="notif-history-list"><div class="empty" style="padding:12px 0"><span>Lädt…</span></div></div>
    </div>
  `;
}

// ── Regelgruppen ──────────────────────────────────────────────────────────

const RULE_GROUPS = [
  {
    label: 'Kontingent-Fenster',
    rules: [
      { id: 'confirmedReset',     label: 'Bestätigter Reset',           tooltip: 'Das Kontingent wurde zur erwarteten Zeit zurückgesetzt – ein neuer Zyklus hat begonnen.' },
      { id: 'unexpectedReset',    label: 'Unerwarteter Reset',          tooltip: 'Ein Reset außerhalb des normalen Zyklus wurde erkannt, z.B. nach einem Planwechsel.' },
      { id: 'resetSoon',          label: 'Reset in Kürze',              tooltip: 'Das Kontingent setzt sich bald zurück.',
        extras: [{ key: 'minutesBeforeReset', label: 'Min. vor Reset', type: 'number', min: 1, max: 120 }] },
      { id: 'highUsage',          label: 'Hoher Verbrauch',             tooltip: 'Eine hohe Verbrauchsschwelle wurde überschritten.',
        extras: [{ key: 'thresholdPercent', label: 'Schwelle %', type: 'number', min: 50, max: 99 }] },
      { id: 'criticalUsage',      label: 'Kritischer Verbrauch',        tooltip: 'Kritische Schwelle erreicht – das Kontingent wird bald erschöpft sein.',
        extras: [{ key: 'thresholdPercent', label: 'Schwelle %', type: 'number', min: 50, max: 99 }] },
    ],
  },
  {
    label: 'Tempo & Prognose',
    rules: [
      { id: 'projectedDepletion', label: 'Erschöpfung vor Reset',       tooltip: 'Beim aktuellen Tempo wird das Kontingent vor dem nächsten Reset aufgebraucht.' },
      { id: 'farAhead',           label: 'Deutlich zu schnell',         tooltip: 'Verbrauchstempo liegt deutlich über dem geplanten Tagesdurchschnitt.',
        extras: [{ key: 'minDeltaPercent', label: 'Min. Delta %', type: 'number', min: 5, max: 50 }] },
      { id: 'farBehind',          label: 'Deutlich zu langsam',         tooltip: 'Deutlich weniger Nutzung als möglich. Noch viel Kontingent verfügbar.',
        extras: [{ key: 'minDeltaPercent', label: 'Min. Delta %', type: 'number', min: 5, max: 50 }] },
    ],
  },
  {
    label: 'Historische Nutzung',
    rules: [
      { id: 'freshQuotaWorkWindow',     label: 'Frisches Kontingent (Arbeitszeit)', tooltip: 'Nach einem Reset steht ein frisches Arbeitsfenster bereit.',
        extras: [{ key: 'maxUsedPercent', label: 'Max. Verbrauch %', type: 'number', min: 5, max: 50 }] },
      { id: 'quotaIdleAfterReset',      label: 'Kontingent ungenutzt',              tooltip: 'Das Kontingent wurde zurückgesetzt, aber keine Aktivität erkannt.' },
      { id: 'weeklyReserveOpportunity', label: 'Wöchentliche Reserve',              tooltip: 'Wöchentliches Restbudget kann noch eingesetzt werden, bevor der Zyklus endet.' },
      { id: 'rolling5hOutputSpike',     label: 'Output-Token-Spike (5h)',           tooltip: 'Ungewöhnlich hoher Output-Token-Anstieg im gleitenden 5h-Fenster.' },
      { id: 'rolling5hProxyLimit',      label: 'Proxy-Limit (5h)',                  tooltip: 'Output-Token-Proxy-Schwelle im 5h-Fenster erreicht.',
        extras: [{ key: 'thresholdPercent', label: 'Schwelle %', type: 'number', min: 50, max: 100 }, { key: 'customOutputTokenLimit', label: 'Token-Limit', type: 'number', min: 10000, max: 5000000 }] },
      { id: 'burnRateSpike',            label: 'Burn-Rate ungewöhnlich hoch',       tooltip: 'Token-Verbrauchsrate pro Stunde ist ungewöhnlich hoch.',
        extras: [{ key: 'factor', label: 'Faktor', type: 'number', min: 1.1, max: 10, step: 0.1 }] },
    ],
  },
  {
    label: 'Wirtschaftlichkeit',
    rules: [
      { id: 'cacheHitDrop',        label: 'Cache-Hit-Rate gesunken',     tooltip: 'Die Prompt-Cache-Trefferrate ist gesunken. Höhere Kosten möglich.' },
      { id: 'expensiveModelShare', label: 'Teure Modelle (Spike)',        tooltip: 'Plötzlicher Anstieg bei teuren Modellen (z.B. Opus).',
        extras: [{ key: 'thresholdPercent', label: 'Schwelle %', type: 'number', min: 5, max: 100 }] },
      { id: 'roiMilestone',        label: 'ROI-Meilenstein',             tooltip: 'Ein ROI-Meilenstein wurde basierend auf Nutzungsmustern erreicht.' },
    ],
  },
  {
    label: 'Datenqualität',
    rules: [
      { id: 'providerDataHealth', label: 'Daten veraltet / wiederhergestellt', tooltip: 'API-Daten wurden längere Zeit nicht aktualisiert oder sind wieder verfügbar.',
        extras: [{ key: 'staleMinutes', label: 'Minuten bis Alert', type: 'number', min: 1, max: 60 }] },
    ],
  },
];

const SEVERITY_BADGE = { critical: 'badge-critical', warning: 'badge-warning', watch: 'badge-watch', info: 'badge-info' };

function buildRuleGroups(rules) {
  return RULE_GROUPS.map(group => `
    <div class="notif-rule-group">
      <div class="notif-group-label">${group.label}</div>
      ${group.rules.map(def => buildRuleCard(def, rules[def.id] ?? {})).join('')}
    </div>
  `).join('');
}

function buildRuleCard(def, cfg) {
  const enabled = cfg.enabled ?? false;
  const cooldown = cfg.cooldownMinutes ?? 60;
  const extrasHtml = (def.extras ?? []).map(ex => {
    const val = cfg[ex.key] ?? '';
    const step = ex.step ? `step="${ex.step}"` : '';
    return `
      <label class="notif-extra-label">
        <span>${ex.label}</span>
        <input class="cost-field notif-extra-field" type="${ex.type}"
               min="${ex.min}" max="${ex.max}" ${step}
               data-rule="${def.id}" data-key="${ex.key}" value="${val}">
      </label>`;
  }).join('');

  return `
    <div class="notif-rule-card" data-rule-id="${def.id}">
      <div class="notif-rule-header">
        <label class="tgl notif-rule-tgl">
          <input type="checkbox" class="notif-rule-toggle" data-rule="${def.id}" ${enabled ? 'checked' : ''}>
          <span class="tgl-track"></span>
        </label>
        <div class="notif-rule-info">
          <span class="notif-rule-name">${def.label}</span>
          <span class="notif-rule-tip" title="${def.tooltip}">?</span>
        </div>
        <label class="notif-cooldown-label">
          Cooldown
          <input class="cost-field notif-cooldown-field" type="number" min="0" max="10080"
                 data-rule="${def.id}" data-key="cooldownMinutes" value="${cooldown}">
          <span class="notif-cooldown-unit">min</span>
        </label>
      </div>
      ${extrasHtml ? `<div class="notif-extras">${extrasHtml}</div>` : ''}
    </div>
  `;
}

// ── Event-Binding ──────────────────────────────────────────────────────────

function bindNotificationsEvents(wrap, ns, rules) {
  // Master switch
  const masterToggle = wrap.querySelector('#notif-master');
  const globalDetail = wrap.querySelector('#notif-global-detail');
  masterToggle?.addEventListener('change', () => {
    if (globalDetail) globalDetail.hidden = !masterToggle.checked;
  });

  // Quiet hours toggle
  const quietToggle = wrap.querySelector('#notif-quiet-enabled');
  const quietTimes  = wrap.querySelector('#notif-quiet-times');
  quietToggle?.addEventListener('change', () => {
    if (quietTimes) quietTimes.hidden = !quietToggle.checked;
  });

  // Gap pills
  wrap.querySelectorAll('.notif-gap-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.notif-gap-pills .pill').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Test button
  wrap.querySelector('#notif-test-btn')?.addEventListener('click', async () => {
    try { await QB.ipc.invoke('notification:test'); } catch (e) { console.error(e); }
  });

  // Save
  wrap.querySelector('#notif-save-btn')?.addEventListener('click', () => saveNotificationSettings(wrap));
}

// ── Speichern ──────────────────────────────────────────────────────────────

async function saveNotificationSettings(wrap) {
  const btn  = wrap.querySelector('#notif-save-btn');
  const note = wrap.querySelector('#notif-save-note');
  btn.disabled = true;
  btn.textContent = 'Speichert…';

  const enabled      = wrap.querySelector('#notif-master')?.checked ?? true;
  const quietEnabled = wrap.querySelector('#notif-quiet-enabled')?.checked ?? false;
  const quietStart   = wrap.querySelector('#notif-quiet-start')?.value ?? '22:30';
  const quietEnd     = wrap.querySelector('#notif-quiet-end')?.value   ?? '08:00';
  const activeGap    = wrap.querySelector('.notif-gap-pills .pill.active');
  const minimumGapMinutes = activeGap ? parseInt(activeGap.dataset.gap, 10) : 15;

  const rulesPayload = {};
  wrap.querySelectorAll('.notif-rule-toggle').forEach(tog => {
    const ruleId = tog.dataset.rule;
    if (!rulesPayload[ruleId]) rulesPayload[ruleId] = {};
    rulesPayload[ruleId].enabled = tog.checked;
  });
  wrap.querySelectorAll('.notif-cooldown-field, .notif-extra-field').forEach(inp => {
    const ruleId = inp.dataset.rule;
    const key    = inp.dataset.key;
    if (!rulesPayload[ruleId]) rulesPayload[ruleId] = {};
    rulesPayload[ruleId][key] = inp.type === 'number' ? parseFloat(inp.value) : inp.value;
  });

  const payload = {
    enabled,
    quietHours: { enabled: quietEnabled, start: quietStart, end: quietEnd },
    minimumGapMinutes,
    rules: rulesPayload,
  };

  try {
    await QB.ipc.invoke('notification:settings:save', payload);
    btn.textContent = '✓ Gespeichert';
    if (note) note.textContent = '';
    setTimeout(() => { btn.textContent = 'Speichern'; btn.disabled = false; }, 1800);
  } catch (e) {
    btn.textContent = 'Fehler – erneut versuchen';
    btn.disabled = false;
    console.error(e);
  }
}

// ── Verlauf laden ──────────────────────────────────────────────────────────

function ruleLabel(ruleId) {
  for (const group of RULE_GROUPS) {
    const def = group.rules.find(r => r.id === ruleId);
    if (def) return def.label;
  }
  return ruleId;
}

async function loadNotificationHistory(wrap, rules) {
  const list = wrap.querySelector('#notif-history-list');
  if (!list) return;
  try {
    const history = await QB.ipc.invoke('notification:history');
    if (!history || history.length === 0) {
      list.innerHTML = '<div class="empty" style="padding:12px 0"><span>Noch keine Meldungen.</span></div>';
      return;
    }
    list.innerHTML = history.map(e => {
      const time = new Date(e.firedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const date = new Date(e.firedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      const providerLabel = e.provider ? e.provider[0].toUpperCase() + e.provider.slice(1) : '';
      const isMuteEntry = e.reason === 'rule-muted';
      const ruleEnabled = rules[e.ruleId]?.enabled !== false;
      const muteBtn = isMuteEntry ? '' : `
        <button class="notif-hist-mute" data-rule="${e.ruleId}" ${ruleEnabled ? '' : 'disabled'}
                title="Benachrichtigungstyp „${ruleLabel(e.ruleId)}" dauerhaft deaktivieren">
          ${ruleEnabled ? 'Stumm' : 'Typ deaktiviert'}
        </button>`;
      return `
        <div class="notif-hist-entry${isMuteEntry ? ' notif-hist-muted' : ''}">
          <div class="notif-hist-meta">
            <span class="notif-hist-time">${date} ${time}</span>
            <span class="notif-hist-provider">${providerLabel}</span>
            ${e.windowName ? `<span class="notif-hist-window">${e.windowName}</span>` : ''}
            ${muteBtn}
          </div>
          <div class="notif-hist-body">${isMuteEntry ? `Typ „${ruleLabel(e.ruleId)}" deaktiviert` : e.body}</div>
          <div class="notif-hist-reason">${e.reason}</div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.notif-hist-mute').forEach(btn => {
      btn.addEventListener('click', () => void muteRuleFromHistory(wrap, rules, btn.dataset.rule));
    });
  } catch (e) {
    list.innerHTML = '<div class="empty" style="padding:12px 0"><span>Verlauf nicht verfügbar.</span></div>';
    console.error(e);
  }
}

async function muteRuleFromHistory(wrap, rules, ruleId) {
  try {
    // Vollständiges Rule-Objekt senden — der Handler ersetzt rules[ruleId] komplett
    await QB.ipc.invoke('notification:settings:save', {
      rules: { [ruleId]: { ...(rules[ruleId] ?? {}), enabled: false } },
    });
    if (rules[ruleId]) rules[ruleId].enabled = false;
    // Alle Buttons dieses Typs und den Regel-Toggle oben synchronisieren
    wrap.querySelectorAll(`.notif-hist-mute[data-rule="${ruleId}"]`).forEach(b => {
      b.disabled = true;
      b.textContent = 'Typ deaktiviert';
    });
    const toggle = wrap.querySelector(`.notif-rule-toggle[data-rule="${ruleId}"]`);
    if (toggle) toggle.checked = false;
  } catch (e) {
    console.error('Mute via Verlauf fehlgeschlagen', e);
  }
}
