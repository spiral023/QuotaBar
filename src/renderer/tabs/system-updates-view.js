/* global QB */
'use strict';
window.QB = window.QB || {};
QB.systemUpdatePanelHtml = function systemUpdatePanelHtml(u, variant) {
    const { githubIcon } = QB.systemView;
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
            <div class="sys-update-title" style="font-weight:600">${QB.esc(title)}</div>
            <div class="sys-update-sub" style="opacity:.7;font-size:11px">${QB.esc(sub)}</div>
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
  };
