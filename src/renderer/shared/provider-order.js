/* global QB */
'use strict';

window.QB = window.QB || {};

(function () {
  const CARD_SELECTOR = '[data-provider-card]';
  const DRAG_THRESHOLD_PX = 6;

  function hasPassedThreshold(start, current, threshold = DRAG_THRESHOLD_PX) {
    return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
  }

  function insertionIndex(midpoints, pointerY) {
    const index = midpoints.findIndex(midpoint => pointerY < midpoint);
    return index === -1 ? midpoints.length : index;
  }

  async function persistOrder(next, previous, save) {
    try {
      const result = await save(next);
      return {
        order: Array.isArray(result?.providerOrder) ? result.providerOrder : next,
        saved: true,
      };
    } catch {
      return { order: previous, saved: false };
    }
  }

  function cardOrder(container) {
    return Array.from(container.querySelectorAll(CARD_SELECTOR))
      .map(card => card.dataset.provider)
      .filter(Boolean);
  }

  function applyOrder(container, order) {
    const cards = new Map(Array.from(container.querySelectorAll(CARD_SELECTOR))
      .map(card => [card.dataset.provider, card]));
    for (const provider of order) {
      const card = cards.get(provider);
      if (!card) continue;
      container.appendChild(card);
      cards.delete(provider);
    }
    for (const card of cards.values()) container.appendChild(card);
  }

  function attach(container, { onCommit }) {
    let pending = null;
    let active = null;
    let attached = true;
    let suppressClick = false;

    function onPointerDown(event) {
      if (pending || active || event.button !== 0 || event.isPrimary === false) return;
      const card = event.target?.closest?.(CARD_SELECTOR);
      if (!card || !container.contains(card)) return;
      if (container.querySelectorAll(CARD_SELECTOR).length < 2) return;
      pending = {
        pointerId: event.pointerId,
        card,
        start: { x: event.clientX, y: event.clientY },
        originalOrder: cardOrder(container),
      };
    }

    function beginDrag(event) {
      const card = pending.card;
      const rect = card.getBoundingClientRect();
      const placeholder = document.createElement('div');
      placeholder.className = 'provider-card-placeholder';
      placeholder.style.height = `${rect.height}px`;
      placeholder.setAttribute('aria-hidden', 'true');
      card.parentNode.insertBefore(placeholder, card);

      const previousInline = {};
      for (const property of ['position', 'left', 'top', 'width', 'height', 'margin', 'zIndex']) {
        previousInline[property] = card.style[property];
      }
      card.style.position = 'fixed';
      card.style.left = `${rect.left}px`;
      card.style.top = `${rect.top}px`;
      card.style.width = `${rect.width}px`;
      card.style.height = `${rect.height}px`;
      card.style.margin = '0';
      card.style.zIndex = '10000';
      card.classList.add('is-dragging');
      card.setAttribute('aria-grabbed', 'true');
      document.body.classList.add('is-provider-dragging');
      document.body.appendChild(card);
      card.setPointerCapture?.(event.pointerId);

      active = {
        ...pending,
        placeholder,
        previousInline,
        grabOffsetY: event.clientY - rect.top,
      };
      pending = null;
    }

    function moveDrag(event) {
      active.card.style.top = `${event.clientY - active.grabOffsetY}px`;
      const cards = Array.from(container.querySelectorAll(CARD_SELECTOR));
      const index = insertionIndex(
        cards.map(card => {
          const rect = card.getBoundingClientRect();
          return rect.top + rect.height / 2;
        }),
        event.clientY,
      );
      if (index >= cards.length) container.appendChild(active.placeholder);
      else container.insertBefore(active.placeholder, cards[index]);
    }

    function onPointerMove(event) {
      if ((!pending && !active) || event.pointerId !== (pending?.pointerId ?? active?.pointerId)) return;
      if (pending && !hasPassedThreshold(pending.start, { x: event.clientX, y: event.clientY })) return;
      if (pending) beginDrag(event);
      event.preventDefault();
      moveDrag(event);
    }

    function restoreCard() {
      const drag = active;
      if (!drag) return null;
      drag.placeholder.replaceWith(drag.card);
      for (const [property, value] of Object.entries(drag.previousInline)) {
        drag.card.style[property] = value;
      }
      drag.card.classList.remove('is-dragging');
      drag.card.removeAttribute('aria-grabbed');
      drag.card.releasePointerCapture?.(drag.pointerId);
      document.body.classList.remove('is-provider-dragging');
      active = null;
      return drag;
    }

    function cancelDrag() {
      pending = null;
      const drag = restoreCard();
      if (drag) applyOrder(container, drag.originalOrder);
    }

    function onPointerUp(event) {
      if (pending?.pointerId === event.pointerId) {
        pending = null;
        return;
      }
      if (active?.pointerId !== event.pointerId) return;
      const drag = restoreCard();
      if (!drag) return;
      const nextOrder = cardOrder(container);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      void persistOrder(nextOrder, drag.originalOrder, onCommit).then(result => {
        if (attached) applyOrder(container, result.order);
      });
    }

    function onPointerCancel(event) {
      if (event.pointerId === pending?.pointerId || event.pointerId === active?.pointerId) cancelDrag();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && (pending || active)) {
        event.preventDefault();
        cancelDrag();
      }
    }

    function onClick(event) {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('lostpointercapture', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('click', onClick, true);

    return function detach() {
      attached = false;
      cancelDrag();
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('lostpointercapture', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('click', onClick, true);
    };
  }

  QB.providerOrderDrag = {
    attach,
    hasPassedThreshold,
    insertionIndex,
    persistOrder,
  };
})();
