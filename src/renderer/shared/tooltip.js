'use strict';

// Portal tooltip for plain-text `data-tip` attributes. Per the UI convention in
// AGENTS.md it is appended to <body>, so `overflow: hidden` or z-index stacking
// of the anchor cannot clip it. Text is set via textContent, never as HTML.
(function () {
  window.QB = window.QB || {};

  const TIP_ID = 'qb-portal-tip';
  const GAP = 9;
  const MARGIN = 6;

  function tipElement() {
    let tip = document.getElementById(TIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = TIP_ID;
      tip.className = 'qb-portal-tip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    return tip;
  }

  function show(anchor, text) {
    if (!anchor || !text) return;
    const tip = tipElement();
    tip.textContent = text;

    // Measure while invisible; the closed state is scaled down.
    tip.style.visibility = 'hidden';
    tip.classList.add('is-visible');
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.classList.remove('is-visible');
    tip.style.visibility = '';

    const r = anchor.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - MARGIN));
    let top = r.top - th - GAP;
    tip.style.transformOrigin = 'bottom center';
    if (top < MARGIN) {
      top = r.bottom + GAP;
      tip.style.transformOrigin = 'top center';
    }
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.classList.add('is-visible');
  }

  function hide() {
    const tip = document.getElementById(TIP_ID);
    if (tip) tip.classList.remove('is-visible');
  }

  // Delegated hover handling for every element matching `selector` inside a
  // container whose children are re-rendered via innerHTML. Bind once per container.
  function bindDataTips(container, selector) {
    let current = null;
    container.addEventListener('mouseover', (event) => {
      const anchor = event.target instanceof Element ? event.target.closest(selector) : null;
      if (!anchor || !container.contains(anchor) || anchor === current) return;
      current = anchor;
      show(anchor, anchor.getAttribute('data-tip'));
    });
    container.addEventListener('mouseout', (event) => {
      if (!current) return;
      if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return;
      current = null;
      hide();
    });
  }

  QB.portalTip = { show, hide, bindDataTips };
})();
