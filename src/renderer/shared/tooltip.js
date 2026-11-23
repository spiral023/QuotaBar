'use strict';

// Portal tooltip shared by every tab. Per the UI convention in AGENTS.md it is
// appended to <body>, so `overflow: hidden` or z-index stacking of the anchor
// cannot clip it. Plain text is set via textContent; only the `rows` variant
// takes markup, built by the caller from formatted numbers.
(function () {
  window.QB = window.QB || {};

  const TIP_ID = 'qb-portal-tip';
  const BASE_CLASS = 'qb-portal-tip';
  const VARIANTS = { rows: 'qb-portal-tip--rows' };
  const GAP = 9;
  const MARGIN = 6;

  function tipElement() {
    let tip = document.getElementById(TIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = TIP_ID;
      tip.className = BASE_CLASS;
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    return tip;
  }

  /**
   * Shows the tooltip centred above `anchor` (below when there is no room).
   * `content` is plain text. With `options.variant === 'rows'`, `options.html`
   * replaces it with label/value rows (see .hr-tok-tip-row in history.css).
   */
  function show(anchor, content, options) {
    const opts = options || {};
    const html = opts.variant === 'rows' ? opts.html : undefined;
    if (!anchor || (!content && !html)) return;
    const tip = tipElement();
    tip.className = opts.variant && VARIANTS[opts.variant] ? `${BASE_CLASS} ${VARIANTS[opts.variant]}` : BASE_CLASS;
    if (html !== undefined) tip.innerHTML = html;
    else tip.textContent = content;

    // Measure while invisible at the origin: a fixed box near the right edge
    // shrinks to the remaining width, so measuring in place under-reports it.
    // The closed state is scaled down, so measure with the open class.
    tip.style.left = '0px';
    tip.style.top = '0px';
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

  const bound = new WeakMap();

  // Delegated hover and keyboard-focus handling for every element matching
  // `selector` inside a container whose children are re-rendered via
  // innerHTML. Binding the same container and selector again is a no-op.
  function bindDataTips(container, selector) {
    if (!container) return;
    const selectors = bound.get(container) || new Set();
    if (selectors.has(selector)) return;
    selectors.add(selector);
    bound.set(container, selectors);

    let current = null;
    const anchorOf = (target) => {
      const anchor = target instanceof Element ? target.closest(selector) : null;
      return anchor && container.contains(anchor) ? anchor : null;
    };
    const enter = (event) => {
      const anchor = anchorOf(event.target);
      if (!anchor || anchor === current) return;
      current = anchor;
      show(anchor, anchor.getAttribute('data-tip'));
    };
    const leave = (event) => {
      if (!current) return;
      if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return;
      current = null;
      hide();
    };
    container.addEventListener('mouseover', enter);
    container.addEventListener('mouseout', leave);
    container.addEventListener('focusin', enter);
    container.addEventListener('focusout', leave);
  }

  QB.portalTip = { show, hide, bindDataTips };
})();
