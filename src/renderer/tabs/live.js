/* global QB */
'use strict';

window.QB = window.QB || {};

// IIFE-gekapselt, damit top-level let/const/function (z. B. _countdowns,
// renderStandard, clamp) nicht mit gleichnamigen Symbolen anderer Tab-Skripte
// im gemeinsamen globalen Scope kollidieren (sonst SyntaxError beim Laden des
// nachfolgenden Skripts → dessen QB.render* bliebe undefiniert).
(function () {

// ── Countdowns ───────────────────────────────────────────────────────
let _countdowns = [];
let _cdTimer    = null;

function startCd() {
  _cdTimer = setInterval(() => {
    for (const { id, resetsAt } of _countdowns) {
      const el = document.getElementById(id);
      if (el) el.textContent = QB.formatCountdown(resetsAt);
    }
  }, 1000);
}

function stopCd() {
  if (_cdTimer) { clearInterval(_cdTimer); _cdTimer = null; }
}

// ── Helpers ──────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function fmtDuration(seconds) {
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}min`;
}

function windowInsightHtml(win) {
  if (!win) return '';
  const pace = win.pace;
  const burnRate = win.burnRatePctPerHour;
  const burnStr = (burnRate !== null && burnRate !== undefined)
    ? `${burnRate >= 0 ? '+' : ''}${burnRate.toFixed(1)} %/h`
    : null;
  const burnTip = 'Ø burn rate from the last measurements.\nBasis: Δ% ÷ Δt (up to 5 snapshots).';
  let burnCls = 'b-stale', burnIcon = '';
  if (burnRate !== null && burnRate !== undefined) {
    if (burnRate > 100)     { burnCls = 'b-bad';  burnIcon = '⚠ '; }
    else if (burnRate > 50) { burnCls = 'b-warn'; }
    else if (burnRate > 0)  { burnCls = 'b-ok';   }
  }
  const burnHtml = burnStr
    ? `<span class="badge ${burnCls}" title="${QB.esc(burnTip)}">${burnIcon}${QB.esc(burnStr)}</span>`
    : '';

  if (!pace || pace.willLastToReset || pace.etaSeconds === null) {
    return burnHtml ? `<div class="bar-sub-row">${burnHtml}</div>` : '';
  }

  // Limit will be hit before the reset
  const etaMin = Math.round(pace.etaSeconds / 60);
  const isCritical = pace.etaSeconds <= 900;   // ≤ 15 min
  const isWarn     = pace.etaSeconds <= 1800;  // ≤ 30 min
  if (!isCritical && !isWarn) {
    // > 30 min: informational only, just show burn rate
    return burnHtml ? `<div class="bar-sub-row">${burnHtml}</div>` : '';
  }

  const cls = isCritical ? 'gap-critical' : 'gap-warn';
  let blockInfo = '';
  let tip = `Projection: at current pace the window will be full in ~${etaMin}min.`;
  if (win.safetyGapSeconds !== null && win.safetyGapSeconds !== undefined) {
    const blockMin = Math.round(win.safetyGapSeconds / 60);
    if (blockMin > 0) {
      blockInfo = ` · Reset in ${fmtDuration(win.safetyGapSeconds + pace.etaSeconds)}`;
      tip += `\nThen ~${blockMin}min until the next reset.`;
    }
  }
  if (burnStr) tip += `\nCurrent pace: ${burnStr}.`;
  const label = `⚠ Limit ~${etaMin}min${blockInfo}`;
  return `<div class="bar-sub-row">
    <span class="safety-gap ${cls}" title="${QB.esc(tip)}">${QB.esc(label)}</span>
    ${burnHtml}
  </div>`;
}

function paceClass(stage) {
  if (stage === 'onTrack') return 'b-ok';
  if (['slightlyAhead', 'ahead', 'farAhead'].includes(stage)) return 'b-warn';
  return 'b-bad';
}

function paceLabel(stage) {
  return ({
    onTrack:'On Track', slightlyAhead:'Slightly Ahead', ahead:'Ahead', farAhead:'Far Ahead',
    slightlyBehind:'Slightly Behind', behind:'Behind', farBehind:'Far Behind',
  })[stage] || stage;
}

function timeProgressPct(w) {
  if (!w?.resetsAt || !w?.windowSeconds) return null;
  const ms = new Date(w.resetsAt).getTime() - Date.now();
  const duration = w.windowSeconds;
  if (ms <= 0 || ms > duration * 1000) return null;
  const elapsed = duration - ms / 1000;
  return Math.min(100, Math.max(0, (elapsed / duration) * 100));
}

function markerCls(actual, expected) {
  const delta = actual - expected;
  if (Math.abs(delta) <= 2) return 'm-ok';
  return delta > 0 ? 'm-warn' : 'm-bad';
}

function timeMarkerHtml(actual, expected) {
  if (expected === null || expected === undefined) return '';
  const cls = markerCls(actual, expected);
  return `<div class="bar-time-marker ${cls}" style="left:${expected.toFixed(1)}%" title="Time progress: ${Math.round(expected)}%"></div>`;
}

function providerIconHtml(provider) {
  const cls = `prov-icon icon-${provider}`;
  const logos = { claude: '../../logos/claude.png', codex: '../../logos/codex.png', gemini: '../../logos/gemini.webp' };
  const src = logos[provider];
  if (!src) return `<div class="${cls}"></div>`;
  return `<div class="${cls}"><img class="prov-logo" src="${src}" alt="" aria-hidden="true" draggable="false"></div>`;
}

function tokenDetailInnerHtml(cf) {
  if (!cf?.tokenUsage) return '';
  const t = cf.tokenUsage;
  const cells = [
    ['Input',   QB.fmtTokens(t.inputTokens),        false],
    ['Output',  QB.fmtTokens(t.outputTokens),       false],
    ['Cache +', QB.fmtTokens(t.cacheCreationTokens),false],
    ['Cache ▷', QB.fmtTokens(t.cacheReadTokens),    false],
    ['Total',   QB.fmtTokens(t.totalTokens),         false],
    ['Cost',    `$${(cf.apiCostUSD || 0).toFixed(2)}`, true],
  ];
  const cellsHtml = cells.map(([lbl, val, isCost]) =>
    `<div class="token-cell">
      <span class="token-cell-lbl">${lbl}</span>
      <span class="token-cell-val${isCost ? ' is-cost' : ''}">${val}</span>
    </div>`
  ).join('');
  const modelsHtml = t.models?.length > 0
    ? `<div class="token-models">${QB.esc(t.models.join(', '))}</div>` : '';
  const missing = cf.missingPricingModels;
  const missingHtml = missing?.length > 0
    ? `<div class="token-missing" title="Tokens for these models are not included in the cost — the total is a lower bound">⚠ unpriced: ${QB.esc(missing.join(', '))}</div>`
    : '';
  return `<div class="token-section"><div class="token-grid">${cellsHtml}</div>${modelsHtml}${missingHtml}</div>`;
}

function fmtWindows(n) {
  return n.toFixed(1);
}

function windowBudgetRowHtml(snap, currentUsage) {
  const wb = snap.windowBudget;
  if (!wb) return '';
  const id = `wb-row-${QB.esc(snap.provider)}`;
  if (wb.learning) {
    const tip = 'QuotaBar is learning the ratio between the 5h and weekly limit from your usage.\n'
      + `Progress: ${Math.round(wb.sampleFivePct)} % of 200 % 5h usage observed.`;
    return `<div class="wb-wrap" id="${id}"><div class="wb-row"><span class="wb-learning" data-tip="${QB.esc(tip)}">Window budget: still learning…</span></div></div>`;
  }
  const adjusted = currentUsage && currentUsage.bonusResetCount > 0;
  const total = adjusted ? currentUsage.totalWindows : wb.windowsPerWeek;
  const usedWindows = adjusted ? currentUsage.budgetEquivalentUsedWindows : wb.usedWindows;
  const remainingWindows = adjusted ? currentUsage.remainingWindows : wb.remainingWindows;
  const priorWindows = adjusted ? currentUsage.preResetUsedWindows : 0;
  const segCount = Math.max(1, Math.ceil(total));
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const capacity = Math.min(1, total - i);          // letztes Segment ggf. partiell
    const totalUsed = clamp(usedWindows - i, 0, capacity);
    const priorUsed = clamp(priorWindows - i, 0, capacity);
    const currentUsed = Math.max(0, totalUsed - priorUsed);
    const priorPct = capacity > 0 ? (priorUsed / capacity) * 100 : 0;
    const currentPct = capacity > 0 ? (currentUsed / capacity) * 100 : 0;
    const isCurrent = usedWindows > i && usedWindows < i + capacity;
    const isFree = totalUsed === 0;
    segs.push(`<div class="wb-seg${isFree ? ' wb-free' : ''}" style="flex:${capacity.toFixed(2)}">` +
      (priorPct > 0 ? `<div class="wb-fill wb-prior" style="width:${priorPct.toFixed(0)}%"></div>` : '') +
      (currentPct > 0 ? `<div class="wb-fill${isCurrent ? ' wb-current' : ''}" style="left:${priorPct.toFixed(0)}%;width:${currentPct.toFixed(0)}%"></div>` : '') +
      `</div>`);
  }
  let tip = `Weekly budget converted to full 5h windows.\n`
    + `Learned from your usage: ~${fmtWindows(total)} full 5h windows fit in one weekly window.`;
  if (adjusted) {
    tip = `Unscheduled reset taken into account.\n`
      + `Budget equivalent: ${currentUsage.resetAdjustedWeeklyPercent.toFixed(0)} % weekly utilization across all reset segments.\n`
      + `Counted 5h windows: ${currentUsage.observedUsedWindows}.`;
  }
  const adjustedHtml = adjusted
    ? `<div class="wb-adjusted">
        <span>${Math.round(currentUsage.observedUsedWindows)} counted</span>
        <span>+${fmtWindows(currentUsage.preResetUsedWindows)} before reset</span>
      </div>`
    : '';
  return `<div class="wb-wrap" id="${id}">
  <div class="wb-row${adjusted ? ' wb-row-adjusted' : ''}" data-tip="${QB.esc(tip)}">
    <div class="wb-bar">${segs.join('')}</div>
    <div class="wb-stats">
      <span>5h windows: ${fmtWindows(usedWindows)} used</span>
      <span>${fmtWindows(remainingWindows)} remaining</span>
    </div>
    ${adjustedHtml}
  </div>${bonusBadgeHtml(wb, currentUsage)}
  </div>`;
}

function bonusBadgeHtml(wb, currentUsage) {
  const hasTrackerBonus = wb.bonus && wb.bonus.active;
  const hasObservedReset = currentUsage && currentUsage.bonusResetCount > 0;
  if (!hasTrackerBonus && !hasObservedReset) return '';
  const extra = hasTrackerBonus ? wb.bonus.estimatedExtraWindows : currentUsage.preResetUsedWindows;
  const label = hasTrackerBonus ? 'Bonus week' : 'Reset accounted for';
  const tip = hasTrackerBonus
    ? 'Unscheduled reset detected: the weekly budget was renewed without shifting the '
      + '7d reset point. Until then, effectively additional budget is available.\n'
      + 'The number is a rough estimate and capped by the remaining time.'
    : 'A weekly reset within the same 7d period was reconstructed from local snapshots. '
      + 'The window row counts usage before and after the reset together.';
  return `<div class="wb-bonus" data-tip="${QB.esc(tip)}">
    <span class="wb-bonus-icon" aria-hidden="true">⚡</span>
    <span class="wb-bonus-text">${label}${extra >= 0.1
      ? ` · ≈ +<span class="wb-bonus-num">${fmtWindows(extra)}</span> 5h windows`
      : ''}</span>
  </div>`;
}

// Chart-Instanzen pro Provider, damit Re-Renders sie sauber ersetzen
const _wbCharts = {};
let _wbDataPromise = null;
let _wbGeneration  = 0;

function windowBudgetCollapseHtml(snap) {
  const wb = snap.windowBudget;
  if (!wb || wb.learning) return '';
  const id = `wbc-${QB.esc(snap.provider)}`;
  let isOpen = false;
  try { isOpen = localStorage.getItem('windowBudgetOpen') === '1'; } catch {}
  return `<div class="token-collapse wb-collapse${isOpen ? ' open' : ''}" id="${id}">
    <button class="token-toggle" aria-expanded="${isOpen}"
            onclick="QB.toggleWindowBudget('${id}', '${QB.esc(snap.provider)}')">
      <svg class="toggle-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Window budget
    </button>
    <div class="token-body">
      <div class="wb-chart-wrap"><canvas id="wb-chart-${QB.esc(snap.provider)}"></canvas></div>
      <div class="wb-forecast" id="wb-forecast-${QB.esc(snap.provider)}">Loading…</div>
    </div>
  </div>`;
}

function wbForecastHtml(fc) {
  const fmt = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const CONF = { high: 'high confidence', medium: 'rough estimate', none: 'uncertain' };
  const kindLbl = fc.primaryKind === 'profile' ? 'weekly profile' : 'linear';
  const confLbl = CONF[fc.confidence] ? `, ${CONF[fc.confidence]}` : '';
  let mainCls = '';
  const main = fc.reason === 'insufficient-data'
    ? 'No reliable forecast (insufficient data)'
    : fc.primaryLastsUntilReset
      ? (mainCls = 'wb-fc-ok', `Expected to last until reset (${kindLbl}${confLbl})`)
      : fc.primaryAt
        ? (mainCls = 'wb-fc-bad', `Limit reached: ~${fmt(fc.primaryAt)} (${kindLbl}${confLbl})`)
        : 'No forecast available';
  let burn = '';
  if (fc.burnRateLastsUntilReset === true)
    burn = '<br><span class="wb-fc-burn wb-fc-ok">At current pace: will last until reset</span>';
  else if (fc.burnRateAt)
    burn = `<br><span class="wb-fc-burn wb-fc-bad">At current pace: ~${QB.esc(fmt(fc.burnRateAt))}</span>`;
  return `<span class="wb-fc-main ${mainCls}">${QB.esc(main)}</span>${burn}`;
}

async function hydrateWindowBudgets(snapshots, gen) {
  const wanted = snapshots.filter(s => s.windowBudget && !s.windowBudget.learning);
  if (wanted.length === 0) return;
  try {
    if (!_wbDataPromise) _wbDataPromise = QB.ipc.invoke('windowBudget:get');
    const data = await _wbDataPromise;
    if (gen !== _wbGeneration) return; // ein neuerer Render-Zyklus hat das DOM bereits ersetzt
    for (const snap of wanted) {
      const d = data.perProvider?.[snap.provider];
      const fcEl = document.getElementById(`wb-forecast-${snap.provider}`);
      const canvas = document.getElementById(`wb-chart-${snap.provider}`);
      if (!d || !fcEl || !canvas) continue;
      fcEl.innerHTML = wbForecastHtml(d.forecast);
      const row = document.getElementById(`wb-row-${snap.provider}`);
      if (row && d.currentUsage) row.outerHTML = windowBudgetRowHtml(snap, d.currentUsage);
      if (_wbCharts[snap.provider]) { _wbCharts[snap.provider].destroy(); delete _wbCharts[snap.provider]; }
      if (d.hasSeriesData) {
        const weekly = snap.windows.find(w => w.name === 'weekly');
        _wbCharts[snap.provider] = QB.weeklyBudgetChart(
          canvas.getContext('2d'), d.series, d.forecast, weekly?.resetsAt ?? null);
      } else {
        canvas.closest('.wb-chart-wrap').innerHTML =
          '<div class="wb-hint">No history available — debug logging is disabled (Settings).</div>';
      }
    }
  } catch (e) {
    console.error('windowBudget:get failed', e);
  }
}

function windowBadgeHtml(cf) {
  if (!cf || !cf.windowLabel) return '';
  const days = cf.windowDays ?? '?';
  const mode = cf.calculationMode === 'actual-span' ? 'actual span' : 'fixed window';
  const text = cf.calculationMode === 'actual-span' ? `${days}d (all)` : cf.windowLabel;
  const tip = `Cost window: ${cf.windowLabel}\nDays: ${days}\nMode: ${mode}`;
  return `<span class="badge b-window" data-tip="${QB.esc(tip)}">${QB.esc(text)}</span>`;
}

function costBadgeHtml(cf) {
  if (!cf) return '';
  const roiTip = cf.factor !== null
    ? `API cost ÷ proportional subscription price\nfor ${cf.windowLabel || 'this window'} (${cf.windowDays ?? '?'}d).\n1× = subscription equivalent.`
    : '';
  const infoIcon = roiTip
    ? `<i class="info-icon" data-tip="${roiTip}" style="display:inline-flex;margin-left:3px">i</i>`
    : '';
  if (cf.factor === null) return `<span class="badge b-cost">${QB.esc(cf.label || 'No logs')}</span>`;
  const pre = cf.isEstimate ? '~' : '';
  const factorPart = `${pre}${cf.factor.toFixed(2)}× sub`;
  if (cf.apiCostUSD >= 0.005) {
    return `<span class="badge b-cost" style="display:inline-flex;align-items:center">$${cf.apiCostUSD.toFixed(2)} (${factorPart})${infoIcon}</span>`;
  }
  return `<span class="badge b-cost" style="display:inline-flex;align-items:center">${factorPart}${infoIcon}</span>`;
}

// ── Standard provider card ─────────────────────────────────────────────
function renderStandard(snap, name, delay, acctIdx) {
  const fiveH  = snap.windows.find(w => w.name === 'fiveHour');
  const weekly = snap.windows.find(w => w.name === 'weekly');
  const rawPct = fiveH?.usedPercent;
  const hasPct = typeof rawPct === 'number';
  const pct    = hasPct ? rawPct : 0;
  const color  = hasPct ? QB.usageColor(pct) : 'gray';
  const pctTxt = hasPct ? `${Math.round(pct)}%` : '—';
  const fhId   = `cd-${snap.provider}-5h`;
  const wkId   = `cd-${snap.provider}-wk`;
  if (fiveH?.resetsAt)  _countdowns.push({ id: fhId, resetsAt: fiveH.resetsAt });
  if (weekly?.resetsAt) _countdowns.push({ id: wkId, resetsAt: weekly.resetsAt });
  const fhCd = fiveH?.resetsAt  ? QB.formatCountdown(fiveH.resetsAt)  : '';
  const wkCd = weekly?.resetsAt ? QB.formatCountdown(weekly.resetsAt) : '';
  const fhExpected = timeProgressPct(fiveH);
  const fhInsight  = windowInsightHtml(fiveH);

  let bars = `<div class="bar-group">
    <div class="bar-meta">
      <span class="bar-tag">5-Hour</span>
      <span class="bar-cd" id="${fhId}">${fhCd}</span>
    </div>
    <div class="bar-track thick">
      <div class="bar-fill c-${color}" style="width:${clamp(pct,0,100)}%"></div>
      ${timeMarkerHtml(pct, fhExpected)}
    </div>
    ${fhInsight}
  </div>`;

  if (weekly && typeof weekly.usedPercent === 'number') {
    const wc = QB.usageColor(weekly.usedPercent);
    const wkExpected = weekly.pace?.expectedUsedPercent ?? timeProgressPct(weekly);
    bars += `<div class="bar-group">
      <div class="bar-meta">
        <span class="bar-tag">Weekly</span>
        <span class="bar-cd" id="${wkId}">${wkCd}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill c-${wc}" style="width:${clamp(weekly.usedPercent,0,100)}%"></div>
        ${timeMarkerHtml(weekly.usedPercent, wkExpected)}
      </div>
      ${windowBudgetRowHtml(snap)}
    </div>`;
  }

  const bdgs = [];
  if (snap.status === 'stale') bdgs.push(`<span class="badge b-stale">Stale</span>`);
  if (weekly?.pace) bdgs.push(`<span class="badge ${paceClass(weekly.pace.stage)}">${paceLabel(weekly.pace.stage)}</span>`);
  const costHtml = costBadgeHtml(snap.costFactor);
  if (costHtml) bdgs.push(costHtml);
  const winHtml = windowBadgeHtml(snap.costFactor);
  if (winHtml) bdgs.push(winHtml);
  const accent = QB.accentVar(hasPct ? pct : null);

  return `<div class="card has-accent" style="--card-accent:${accent};${delay}">
    <div class="card-body">
      ${providerIconHtml(snap.provider)}
      <div class="card-info">
        <div class="card-head">
          <span class="prov-name">${QB.esc(name)}</span>
          <div class="card-right">
            <span class="prov-pct" style="color:var(--${color})">${pctTxt}</span>
            <span class="card-chevron">›</span>
          </div>
        </div>
        ${snap.identity?.email ? (QB.settings?.anonymizeAccounts ? `<div class="prov-account" title="${QB.esc(snap.identity.email)}">Account ${acctIdx}</div>` : `<div class="prov-account" title="Active account">${QB.esc(snap.identity.email)}</div>`) : ''}
        ${bars}
        ${bdgs.length ? `<div class="badges">${bdgs.join('')}</div>` : ''}
        ${windowBudgetCollapseHtml(snap)}
      </div>
    </div>
  </div>`;
}

function renderGemini(snap, name, delay) {
  const label = snap.windows[0]?.label ?? (snap.status === 'error' ? 'Unavailable' : 'No local session data');
  const bdgs = [];
  if (snap.status === 'stale') bdgs.push(`<span class="badge b-stale">Stale</span>`);
  if (snap.status === 'error') bdgs.push(`<span class="badge b-error">Error</span>`);
  const costHtml = costBadgeHtml(snap.costFactor);
  if (costHtml) bdgs.push(costHtml);
  const winHtml = windowBadgeHtml(snap.costFactor);
  if (winHtml) bdgs.push(winHtml);
  return `<div class="card has-accent" style="--card-accent:var(--gray);${delay}">
    <div class="card-body">
      ${providerIconHtml('gemini')}
      <div class="card-info">
        <div class="card-head"><span class="prov-name">${QB.esc(name)}</span><span class="card-chevron">›</span></div>
        <div class="gemini-lbl">${QB.esc(label)}</div>
        ${bdgs.length ? `<div class="badges">${bdgs.join('')}</div>` : ''}
        ${tokenDetailInnerHtml(snap.costFactor)}
      </div>
    </div>
  </div>`;
}

function renderCard(snap, idx, acctIdx) {
  const name  = snap.provider.charAt(0).toUpperCase() + snap.provider.slice(1);
  const delay = `animation-delay:${idx * 65}ms`;
  if (snap.status === 'not_authenticated') {
    return `<div class="card card-status-row" style="--card-accent:var(--gray);${delay}"><span class="prov-name">${QB.esc(name)}</span><span class="badge b-auth">Not Authenticated</span></div>`;
  }
  if (snap.status === 'error' && snap.windows.length === 0) {
    const msg = (snap.errorMessage || 'Error').slice(0, 42);
    return `<div class="card card-status-row has-accent" style="--card-accent:var(--red);${delay}"><span class="prov-name">${QB.esc(name)}</span><span class="badge b-error">${QB.esc(msg)}</span></div>`;
  }
  if (snap.provider === 'gemini') return renderGemini(snap, name, delay);
  return renderStandard(snap, name, delay, acctIdx);
}

// ── Main render ───────────────────────────────────────────────────────
QB.toggleTokenSection = function toggleTokenSection(id) {
  const container = document.getElementById(id);
  if (!container) return;
  const isOpen = container.classList.toggle('open');
  const btn = container.querySelector('.token-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(isOpen));
  try { localStorage.setItem('tokenDetailsOpen', isOpen ? '1' : '0'); } catch {}
};

QB.toggleWindowBudget = function toggleWindowBudget(id, _provider) {
  const container = document.getElementById(id);
  if (!container) return;
  const isOpen = container.classList.toggle('open');
  const btn = container.querySelector('.token-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(isOpen));
  try { localStorage.setItem('windowBudgetOpen', isOpen ? '1' : '0'); } catch {}
};

QB.renderLive = function renderLive(snapshots) {
  const el = document.getElementById('content');
  stopCd();
  _countdowns = [];
  if (snapshots === null) {
    el.innerHTML = '<div class="empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>';
    return;
  }
  if (!snapshots || snapshots.length === 0) {
    el.innerHTML = '<div class="empty"><span>No provider data</span></div>';
    return;
  }
  const providerSeq = {};
  const cards    = snapshots.map((snap, i) => {
    providerSeq[snap.provider] = (providerSeq[snap.provider] || 0) + 1;
    return renderCard(snap, i + 1, providerSeq[snap.provider]);
  }).join('');
  el.innerHTML   = cards;
  _wbDataPromise = null; // neue Snapshots → Budget-Daten neu laden
  const wbGen = ++_wbGeneration;
  void hydrateWindowBudgets(snapshots, wbGen);
  startCd();
};

})();
