'use strict';

window.QB = window.QB || {};

if (window.__QB_IPC_BRIDGE__) {
  QB.ipc = window.__QB_IPC_BRIDGE__;
} else if (!QB.ipc) {
  console.error('QuotaBar IPC bridge is unavailable');
}

QB.isPortableDataPreparing = function isPortableDataPreparing(value) {
  return Boolean(value && value.portableDataPreparing === true);
};

const portableDataRetries = new Map();

QB.schedulePortableDataRetry = function schedulePortableDataRetry(key, retry) {
  let state = portableDataRetries.get(key);
  if (!state) {
    state = { attempt: 0, timer: null, retry };
    portableDataRetries.set(key, state);
  }
  state.retry = retry;
  if (state.timer !== null) return;
  const delayMs = Math.min(500 * (2 ** state.attempt), 4_000);
  state.timer = setTimeout(() => {
    state.timer = null;
    state.attempt += 1;
    void state.retry();
  }, delayMs);
};

QB.clearPortableDataRetry = function clearPortableDataRetry(key) {
  const state = portableDataRetries.get(key);
  if (!state) return;
  if (state.timer !== null) clearTimeout(state.timer);
  portableDataRetries.delete(key);
};
