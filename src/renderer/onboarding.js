'use strict';
    const STATUS_BADGES = {
      connected: { cls: 'b-connected', label: 'Connected' },
      detected:  { cls: 'b-detected',  label: 'Detected — not signed in' },
      not_found: { cls: 'b-missing',   label: 'Not found' },
    };

    function esc(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c]);
    }

    async function loadAgents() {
      const list = document.getElementById('agents-list');
      try {
        const agents = await QB.ipc.invoke('onboarding:agents');
        list.classList.add('stagger');
        list.innerHTML = agents.map(a => {
          const badge = STATUS_BADGES[a.status] ?? STATUS_BADGES.not_found;
          const muted = a.status === 'not_found' ? ' is-muted' : '';
          return `<div class="agent-card${muted}">
            <div class="agent-icon icon-${esc(a.id)}"><img src="${esc(a.logo)}" alt="" draggable="false"></div>
            <div class="agent-info">
              <div class="agent-name">${esc(a.name)}</div>
              <div class="agent-vendor">${esc(a.vendor)}</div>
            </div>
            <span class="badge ${badge.cls}"><span class="badge-dot"></span>${badge.label}</span>
          </div>`;
        }).join('');
      } catch (e) {
        console.error('onboarding:agents failed', e);
        list.innerHTML = '<div class="agents-loading">Could not detect agents.</div>';
      }
    }

    function complete() {
      QB.ipc.send('onboarding:complete', {
        autostart: document.getElementById('tog-autostart').checked,
      });
    }

    document.getElementById('btn-start').addEventListener('click', complete);
    document.getElementById('btn-close').addEventListener('click', () => window.close());

    void loadAgents();
