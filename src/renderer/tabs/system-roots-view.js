/* global QB */
'use strict';
window.QB = window.QB || {};
QB.createSystemRootsView = function createSystemRootsView(getState) {
const { refreshIcon, plusIcon, saveIcon, trashIcon } = QB.systemView;
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
    if (!getState().claudeSuggestions) return '';
    const suggestions = Array.isArray(getState().claudeSuggestions) ? getState().claudeSuggestions : [];
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
    if (!getState().codexSuggestions) return '';
    const suggestions = Array.isArray(getState().codexSuggestions) ? getState().codexSuggestions : [];
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

return { claudeRootsPanelHtml, codexRootsPanelHtml };
};
