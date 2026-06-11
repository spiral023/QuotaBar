/* global QB */
'use strict';

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
  const burnTip = 'Ø Verbrauchsrate aus den letzten Messungen.\nBasis: Δ% ÷ Δt (bis zu 5 Snapshots).';
  const burnHtml = burnStr
    ? `<span class="burn-rate" title="${QB.esc(burnTip)}">${QB.esc(burnStr)}</span>`
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
  let tip = `Hochrechnung: bei aktuellem Tempo wird das Fenster in ~${etaMin}min voll.`;
  if (win.safetyGapSeconds !== null && win.safetyGapSeconds !== undefined) {
    const blockMin = Math.round(win.safetyGapSeconds / 60);
    if (blockMin > 0) {
      blockInfo = ` · Reset in ${fmtDuration(win.safetyGapSeconds + pace.etaSeconds)}`;
      tip += `\nDann noch ~${blockMin}min bis zum nächsten Reset.`;
    }
  }
  if (burnStr) tip += `\nAktuelles Tempo: ${burnStr}.`;
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
  return `<div class="bar-time-marker ${cls}" style="left:${expected.toFixed(1)}%" title="Zeitfortschritt: ${Math.round(expected)}%"></div>`;
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
  return `<div class="token-section"><div class="token-grid">${cellsHtml}</div>${modelsHtml}</div>`;
}

function tokenCollapseHtml(cf, provider) {
  const inner = tokenDetailInnerHtml(cf);
  if (!inner) return '';
  const id = `tc-${QB.esc(provider)}`;
  let isOpen = false;
  try { isOpen = localStorage.getItem('tokenDetailsOpen') === '1'; } catch {}
  const periodSuffix = cf?.windowLabel ? ` · ${QB.esc(cf.windowLabel)}` : '';
  return `<div class="token-collapse${isOpen ? ' open' : ''}" id="${QB.esc(id)}">
    <button class="token-toggle" aria-expanded="${isOpen}"
            onclick="QB.toggleTokenSection('${QB.esc(id)}')">
      <svg class="toggle-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Token Details${periodSuffix}
    </button>
    <div class="token-body">${inner}</div>
  </div>`;
}

function fmtWindows(n) {
  return n.toFixed(1).replace('.', ',');
}

function windowBudgetRowHtml(snap) {
  const wb = snap.windowBudget;
  if (!wb) return '';
  if (wb.learning) {
    const tip = 'QuotaBar lernt das Verhältnis zwischen 5h- und Weekly-Limit aus deiner Nutzung.\n'
      + `Fortschritt: ${Math.round(wb.sampleFivePct)} % von 200 % 5h-Nutzung beobachtet.`;
    return `<div class="wb-row"><span class="wb-learning" data-tip="${QB.esc(tip)}">Fenster-Budget: lernt noch…</span></div>`;
  }
  const total = wb.windowsPerWeek;
  const segCount = Math.max(1, Math.ceil(total));
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const capacity = Math.min(1, total - i);          // letztes Segment ggf. partiell
    const used = clamp(wb.usedWindows - i, 0, capacity);
    const fillPct = capacity > 0 ? (used / capacity) * 100 : 0;
    const isCurrent = wb.usedWindows > i && wb.usedWindows < i + capacity;
    const isFree = used === 0;
    segs.push(`<div class="wb-seg${isFree ? ' wb-free' : ''}" style="flex:${capacity.toFixed(2)}">` +
      (fillPct > 0 ? `<div class="wb-fill${isCurrent ? ' wb-current' : ''}" style="width:${fillPct.toFixed(0)}%"></div>` : '') +
      `</div>`);
  }
  const tip = `Weekly-Budget umgerechnet in volle 5h-Fenster.\n`
    + `Gelernt aus deiner Nutzung: ~${fmtWindows(total)} volle 5h-Fenster passen in ein Weekly-Fenster.`;
  return `<div class="wb-row" data-tip="${QB.esc(tip)}">
    <div class="wb-bar">${segs.join('')}</div>
    <div class="wb-stats">
      <span>5h-Fenster: ${fmtWindows(wb.usedWindows)} verbraucht</span>
      <span>${fmtWindows(wb.remainingWindows)} übrig</span>
    </div>
  </div>`;
}

function windowBadgeHtml(cf) {
  if (!cf || !cf.windowLabel) return '';
  const days = cf.windowDays ?? '?';
  const mode = cf.calculationMode === 'actual-span' ? 'tatsächlicher Zeitraum' : 'festes Fenster';
  const text = cf.calculationMode === 'actual-span' ? `${days}d (all)` : cf.windowLabel;
  const tip = `Kostenfenster: ${cf.windowLabel}\nTage: ${days}\nModus: ${mode}`;
  return `<span class="badge b-window" data-tip="${QB.esc(tip)}">${QB.esc(text)}</span>`;
}

function costBadgeHtml(cf) {
  if (!cf) return '';
  const roiTip = cf.factor !== null
    ? `API-Kosten ÷ anteiliger Abo-Preis\nfür ${cf.windowLabel || 'dieses Fenster'} (${cf.windowDays ?? '?'}d).\n1× = Abo-äquivalent.`
    : '';
  const infoIcon = roiTip
    ? `<i class="info-icon" data-tip="${roiTip}" style="display:inline-flex;margin-left:3px">i</i>`
    : '';
  if (cf.factor === null) return `<span class="badge b-cost">${QB.esc(cf.label || 'Keine Logs')}</span>`;
  const pre = cf.isEstimate ? '~' : '';
  const factorPart = `${pre}${cf.factor.toFixed(2)}× sub`;
  if (cf.apiCostUSD >= 0.005) {
    return `<span class="badge b-cost" style="display:inline-flex;align-items:center">$${cf.apiCostUSD.toFixed(2)} (${factorPart})${infoIcon}</span>`;
  }
  return `<span class="badge b-cost" style="display:inline-flex;align-items:center">${factorPart}${infoIcon}</span>`;
}

// ── Overview card ─────────────────────────────────────────────────────
function renderOverview(snapshots) {
  const provData = snapshots.map(s => {
    const win = s.windows.find(w => w.name === 'fiveHour');
    const hasData = s.status === 'ok' || s.status === 'stale';
    return { name: s.provider, pct: hasData && typeof win?.usedPercent === 'number' ? win.usedPercent : null };
  });
  if (provData.length === 0) return '';
  const validPcts = provData.filter(p => p.pct !== null).map(p => p.pct);
  const maxPct    = validPcts.length > 0 ? Math.max(...validPcts) : 0;
  const pctStr    = validPcts.length > 0 ? `${Math.round(maxPct)}%` : '—';
  const pctColor  = validPcts.length > 0 ? `color:var(--${QB.usageColor(maxPct)})` : '';
  const rows = provData.map(p => {
    const col      = QB.providerColor(p.name);
    const fill     = p.pct !== null ? clamp(p.pct, 0, 100) : 0;
    const pctText  = p.pct !== null ? `${Math.round(p.pct)}%` : '—';
    const nameStr  = p.name.charAt(0).toUpperCase() + p.name.slice(1);
    const glow     = fill > 0 ? `box-shadow:0 0 6px ${col}66` : '';
    const pctStyle = p.pct !== null ? `color:var(--${QB.usageColor(p.pct)})` : 'color:var(--t400)';
    return `<div class="mini-row">
      <div class="mini-label"><span class="mini-dot" style="background:${col}"></span>${nameStr}</div>
      <div class="mini-track"><div class="mini-fill" style="width:${fill}%;background:${col};${glow}"></div></div>
      <span class="mini-pct" style="${pctStyle}">${pctText}</span>
    </div>`;
  }).join('');
  return `<div class="card" style="animation-delay:0ms">
    <div class="overview-head">
      <span class="overview-label">Overview</span>
      <div class="overview-right"><span class="overview-total-lbl">Peak Usage</span><span class="overview-pct" style="${pctColor}">${pctStr}</span></div>
    </div>
    <div class="mini-bars">${rows}</div>
  </div>`;
}

// ── Tip card ──────────────────────────────────────────────────────────
function renderTip(snapshots) {
  let worstStage = null, worstProvider = null;
  const stageOrder = ['farBehind','behind','slightlyBehind','onTrack','slightlyAhead','ahead','farAhead'];
  for (const snap of snapshots) {
    const weekly = snap.windows.find(w => w.name === 'weekly');
    if (weekly?.pace?.stage) {
      const idx = stageOrder.indexOf(weekly.pace.stage);
      const worstIdx = worstStage ? stageOrder.indexOf(worstStage) : 999;
      if (idx < worstIdx) { worstStage = weekly.pace.stage; worstProvider = snap.provider; }
    }
  }
  if (!worstStage || worstStage === 'onTrack') return '';
  const name = worstProvider ? worstProvider.charAt(0).toUpperCase() + worstProvider.slice(1) : '';
  const tips = {
    farBehind:`You're far behind on ${name}. Your usage is well above the expected pace.`,
    behind:`${name} usage is running behind the expected weekly pace.`,
    slightlyBehind:`${name} is slightly behind pace — you may hit limits before reset.`,
    slightlyAhead:`${name} usage is slightly ahead of pace this week.`,
    ahead:`${name} is well ahead of pace — quota should last until reset.`,
    farAhead:`${name} quota is very underutilized this week.`,
  };
  const text = tips[worstStage] || '';
  if (!text) return '';
  const delay = (snapshots.length + 1) * 65;
  return `<div class="card" style="animation-delay:${delay}ms">
    <div class="tip-body-wrap">
      <div class="tip-icon-box"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="7.5" cy="6" r="3.5" stroke="#52d017" stroke-width="1.4"/><path d="M5.5 10.5h4M6 12h3" stroke="#52d017" stroke-width="1.4" stroke-linecap="round"/></svg></div>
      <div class="tip-content"><div class="tip-label">Tip</div><div class="tip-text">${QB.esc(text)}</div></div>
    </div>
  </div>`;
}

// ── Standard provider card ─────────────────────────────────────────────
function renderStandard(snap, name, delay) {
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
  const tokenHtml = tokenCollapseHtml(snap.costFactor, snap.provider);

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
        ${bars}
        ${bdgs.length ? `<div class="badges">${bdgs.join('')}</div>` : ''}
        ${tokenHtml}
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

function renderCard(snap, idx) {
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
  return renderStandard(snap, name, delay);
}

// ── Main render ───────────────────────────────────────────────────────
window.QB = window.QB || {};

QB.toggleTokenSection = function toggleTokenSection(id) {
  const container = document.getElementById(id);
  if (!container) return;
  const isOpen = container.classList.toggle('open');
  const btn = container.querySelector('.token-toggle');
  if (btn) btn.setAttribute('aria-expanded', String(isOpen));
  try { localStorage.setItem('tokenDetailsOpen', isOpen ? '1' : '0'); } catch {}
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
  const overview = renderOverview(snapshots);
  const cards    = snapshots.map((snap, i) => renderCard(snap, i + 1)).join('');
  const tip      = renderTip(snapshots);
  el.innerHTML   = overview + cards + tip;
  startCd();
};
