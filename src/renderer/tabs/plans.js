/* global QB */
'use strict';
window.QB = window.QB || {};

// IIFE-gekapselt, damit top-level let/const/function (_plans, _editing,
// PROVIDERS, _renderUI, …) nicht mit gleichnamigen Symbolen anderer Tab-Skripte
// im gemeinsamen globalen Scope kollidieren (sonst SyntaxError → das
// nachfolgende Skript würde verworfen).
(function () {

let _plans = [];
let _fxEstimated = false;
let _editing = null; // transient editor draft (carries _mode/_fromId) or null
let _escHandler = null;

const PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];
const NAME_SUGGESTIONS = ['Pro', 'Max', 'Max 20×', 'Team'];

QB.renderPlans = async function renderPlans() {
  const c = document.getElementById('plans-content');
  if (!c) return;
  try {
    const [plans, fx] = await Promise.all([
      QB.ipc.invoke('plans:get'),
      QB.ipc.invoke('fx:status').catch(() => ({ estimated: false })),
    ]);
    _plans = Array.isArray(plans) ? plans : [];
    _fxEstimated = !!(fx && fx.estimated);
    _renderUI();
  } catch (e) {
    console.error('plans:get failed', e);
    c.innerHTML = '<div class="empty"><span>Failed to load</span></div>';
  }
};

function _uid() { return 'p_' + Math.random().toString(36).slice(2, 10); }

// Erster erfasster Nutzungstag (YYYY-MM-DD) des Anbieters aus den Backfill-
// Reports; null, wenn (noch) keine Nutzungsdaten vorliegen.
async function _firstUsageDate(provider) {
  try {
    const report = await QB.ipc.invoke('reports:get', {
      source: 'backfill', type: 'daily', provider,
      order: 'asc', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, breakdown: false,
    });
    return report?.rows?.[0]?.bucket ?? null;
  } catch {
    return null;
  }
}

async function _save() {
  // Strip any transient editor fields — only the 7 PlanPeriod fields persist.
  const clean = _plans.map((p) => ({
    id: p.id,
    provider: p.provider,
    name: p.name,
    amount: p.amount,
    currency: p.currency,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
  }));
  await QB.ipc.invoke('plans:save', clean);
  if (QB.clearAnalyticsCache) QB.clearAnalyticsCache();
}

function _isActive(p) {
  const now = Date.now();
  return new Date(p.startsAt).getTime() <= now
    && (!p.endsAt || new Date(p.endsAt).getTime() > now);
}

function _fmtAmount(p) {
  const sym = p.currency === 'EUR' ? '€' : '$';
  return `${sym}${Number(p.amount).toFixed(0)}`;
}

function _fmtDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: '2-digit' });
}

function _nowLocalIso() {
  const d = new Date(); d.setSeconds(0, 0);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ── Rendering ─────────────────────────────────────────────── */

function _rowHtml(p) {
  const active = _isActive(p);
  const end = p.endsAt
    ? _fmtDate(p.endsAt)
    : '<span class="pl-row-open">ongoing</span>';
  return `
    <div class="pl-row${active ? ' is-active' : ''}">
      <div class="pl-row-info">
        <div class="pl-row-top">
          <span class="pl-row-name">${QB.esc(p.name)}</span>
          ${active ? '<span class="pl-badge">active</span>' : ''}
        </div>
        <div class="pl-row-range">${_fmtDate(p.startsAt)} <span class="pl-row-dash">–</span> ${end}</div>
      </div>
      <div class="pl-row-amt">${_fmtAmount(p)}<span class="pl-row-cyc">/mo</span></div>
      <div class="pl-row-actions">
        <button class="pl-mini" data-act="edit" data-id="${p.id}" title="Edit">Edit</button>
        ${active ? `<button class="pl-mini" data-act="change" data-id="${p.id}" title="New price/tier from today">Change price from…</button>` : ''}
        <button class="pl-mini pl-danger" data-act="del" data-id="${p.id}" title="Delete" aria-label="Delete">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
        </button>
      </div>
    </div>`;
}

function _cardHtml(prov) {
  const list = _plans
    .filter((p) => p.provider === prov.id)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const hasActive = list.some(_isActive);

  const body = list.length
    ? `<div class="pl-list">${list.map(_rowHtml).join('')}</div>`
    : `<div class="pl-empty">
         <div class="pl-empty-text">No subscription added for ${prov.label} yet</div>
         <button class="pl-add-cta" data-act="add" data-prov="${prov.id}">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
           Add subscription
         </button>
       </div>`;

  return `
    <section class="pl-card pl-card-${prov.id}">
      <header class="pl-card-head">
        <div class="pl-card-titlewrap">
          <span class="pl-card-dot"></span>
          <span class="pl-card-title">${prov.label}</span>
          ${hasActive ? '' : (list.length ? '<span class="pl-card-sub">no active subscription</span>' : '')}
        </div>
        ${list.length ? `<button class="pl-mini pl-add-inline" data-act="add" data-prov="${prov.id}" title="Add another subscription">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Add
        </button>` : ''}
      </header>
      ${body}
    </section>`;
}

function _renderUI() {
  const c = document.getElementById('plans-content');
  if (!c) return;
  c.innerHTML = `
    <div class="pl-stack">
      ${PROVIDERS.map(_cardHtml).join('')}
      ${_fxEstimated
    ? `<div class="pl-fx-note">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>
           Exchange rates partially estimated (offline / no rate available).
         </div>`
    : ''}
    </div>`;

  c.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', () => _onAction(btn.dataset)));

  if (_editing) _renderEditor();
}

/* ── Actions ───────────────────────────────────────────────── */

function _onAction(ds) {
  if (ds.act === 'add') {
    _editing = {
      id: _uid(), provider: ds.prov, name: '', amount: '',
      currency: 'USD', startsAt: _nowLocalIso(), endsAt: null, _mode: 'add',
    };
  } else if (ds.act === 'edit') {
    const o = _plans.find((p) => p.id === ds.id);
    if (!o) return;
    _editing = { ...o, _mode: 'edit' };
  } else if (ds.act === 'change') {
    const o = _plans.find((p) => p.id === ds.id);
    if (!o) return;
    _editing = {
      id: _uid(), provider: o.provider, name: o.name, amount: o.amount,
      currency: o.currency, startsAt: _nowLocalIso(), endsAt: null,
      _mode: 'change', _fromId: o.id,
    };
  } else if (ds.act === 'del') {
    if (confirm('Delete this subscription?')) {
      _plans = _plans.filter((p) => p.id !== ds.id);
      _save().then(_renderUI).catch((e) => console.error('plans:save failed', e));
    }
    return;
  }
  _renderUI();
}

/* ── Editor modal ──────────────────────────────────────────── */

function _closeEditor() {
  _editing = null;
  if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
  _renderUI();
}

function _renderEditor() {
  const e = _editing;
  const prov = PROVIDERS.find((p) => p.id === e.provider) || PROVIDERS[0];
  const title = e._mode === 'edit' ? 'Edit subscription'
    : e._mode === 'change' ? 'Change price / tier' : 'Add subscription';

  const wrap = document.createElement('div');
  wrap.className = `pl-modal pl-modal-${prov.id}`;
  wrap.innerHTML = `
    <div class="pl-dialog" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="pl-dialog-head">
        <span class="pl-card-dot"></span>
        <span class="pl-dialog-title">${title}</span>
        <span class="pl-dialog-prov">${prov.label}</span>
      </div>

      <label class="pl-f">
        <span class="pl-f-lbl">Name</span>
        <input id="pl-name" class="pl-input" list="pl-name-sugg" autocomplete="off"
               value="${QB.esc(e.name)}" placeholder="e.g. Pro">
        <datalist id="pl-name-sugg">${NAME_SUGGESTIONS.map((s) => `<option value="${QB.esc(s)}"></option>`).join('')}</datalist>
      </label>
      <div class="pl-chips">${NAME_SUGGESTIONS.map((s) => `<button type="button" class="pl-chip" data-name="${QB.esc(s)}">${QB.esc(s)}</button>`).join('')}</div>

      <label class="pl-f">
        <span class="pl-f-lbl">Amount / month</span>
        <span class="pl-amt-wrap">
          <input id="pl-amount" class="pl-input pl-input-num" type="number" min="0" step="1"
                 inputmode="decimal" value="${e.amount}" placeholder="0">
          <span class="pl-cur-toggle" role="group" aria-label="Währung">
            <button type="button" class="pl-cur-btn${e.currency === 'USD' ? ' active' : ''}" data-cur="USD">$</button>
            <button type="button" class="pl-cur-btn${e.currency === 'EUR' ? ' active' : ''}" data-cur="EUR">€</button>
          </span>
        </span>
      </label>
      <div class="pl-fx-preview" id="pl-fx-preview"></div>

      <div class="pl-f-grid">
        <label class="pl-f">
          <span class="pl-f-lbl">Start
            <button type="button" class="pl-f-link" id="pl-start-begin" title="Set first recorded usage day for ${prov.label}">since start</button>
          </span>
          <input id="pl-start" class="pl-input" type="datetime-local" value="${(e.startsAt || '').slice(0, 16)}">
        </label>
        <label class="pl-f">
          <span class="pl-f-lbl">End <span class="pl-f-hint">empty = ongoing</span></span>
          <input id="pl-end" class="pl-input" type="datetime-local" value="${(e.endsAt || '').slice(0, 16)}">
        </label>
      </div>

      <div class="pl-err" id="pl-err" hidden></div>

      <div class="pl-dialog-actions">
        <button type="button" class="pl-mini" id="pl-cancel">Cancel</button>
        <button type="button" class="pl-add-cta pl-save" id="pl-ok">Save</button>
      </div>
    </div>`;

  const content = document.getElementById('plans-content');
  content.appendChild(wrap);

  // animate in on next frame
  requestAnimationFrame(() => wrap.classList.add('is-open'));

  const $ = (id) => document.getElementById(id);
  let currency = e.currency;

  const updatePreview = () => {
    const amt = parseFloat($('pl-amount').value) || 0;
    const prev = $('pl-fx-preview');
    if (currency === 'EUR' && amt > 0) {
      prev.textContent = '≈ will be converted to USD at current daily rate';
      prev.hidden = false;
    } else {
      prev.textContent = '';
      prev.hidden = true;
    }
  };

  // currency toggle
  wrap.querySelectorAll('.pl-cur-btn').forEach((b) => b.addEventListener('click', () => {
    currency = b.dataset.cur;
    wrap.querySelectorAll('.pl-cur-btn').forEach((x) => x.classList.toggle('active', x === b));
    updatePreview();
  }));

  // name suggestion chips
  wrap.querySelectorAll('.pl-chip').forEach((b) => b.addEventListener('click', () => {
    $('pl-name').value = b.dataset.name;
    $('pl-name').focus();
  }));

  $('pl-amount').addEventListener('input', updatePreview);
  updatePreview();

  // "seit Beginn": trägt den ersten erfassten Nutzungstag des Anbieters ein.
  const beginBtn = $('pl-start-begin');
  beginBtn?.addEventListener('click', async () => {
    const original = beginBtn.textContent;
    beginBtn.disabled = true;
    beginBtn.textContent = '…';
    const first = await _firstUsageDate(e.provider);
    if (first) {
      $('pl-start').value = first + 'T00:00';
      beginBtn.textContent = original;
    } else {
      beginBtn.textContent = 'no data';
      setTimeout(() => { beginBtn.textContent = original; }, 1800);
    }
    beginBtn.disabled = false;
  });

  $('pl-cancel').addEventListener('click', _closeEditor);
  $('pl-ok').addEventListener('click', () => _submitEditor(currency));

  // close on backdrop click
  wrap.addEventListener('mousedown', (ev) => { if (ev.target === wrap) _closeEditor(); });
  // close on Esc
  _escHandler = (ev) => { if (ev.key === 'Escape') _closeEditor(); };
  document.addEventListener('keydown', _escHandler);

  // focus first field
  setTimeout(() => $('pl-name').focus(), 30);
}

function _submitEditor(currency) {
  const name = document.getElementById('pl-name').value.trim();
  const amount = parseFloat(document.getElementById('pl-amount').value);
  const startsAt = document.getElementById('pl-start').value;
  const endVal = document.getElementById('pl-end').value;
  const err = document.getElementById('pl-err');

  const showErr = (msg) => {
    err.textContent = msg;
    err.hidden = false;
    err.classList.remove('pl-err-shake');
    void err.offsetWidth; // restart animation
    err.classList.add('pl-err-shake');
  };

  if (!name) return showErr('Please enter a name.');
  if (!(amount >= 0)) return showErr('Amount must be 0 or greater.');
  if (!startsAt) return showErr('Please enter a start date.');
  if (endVal && new Date(endVal).getTime() <= new Date(startsAt).getTime()) {
    return showErr('End must be after start.');
  }

  const endsAt = endVal ? new Date(endVal).toISOString() : null;
  const rec = {
    id: _editing.id,
    provider: _editing.provider,
    name,
    amount,
    currency,
    startsAt: new Date(startsAt).toISOString(),
    endsAt,
  };

  if (_editing._mode === 'edit') {
    _plans = _plans.map((p) => (p.id === rec.id ? rec : p));
  } else {
    _plans = [..._plans, rec];
  }
  // price-change: end the previous plan exactly when the new one begins
  if (_editing._mode === 'change' && _editing._fromId) {
    _plans = _plans.map((p) => (p.id === _editing._fromId ? { ...p, endsAt: rec.startsAt } : p));
  }

  if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
  _editing = null;
  _save().then(_renderUI).catch((e) => {
    console.error('plans:save failed', e);
    _renderUI();
  });
}

})();
