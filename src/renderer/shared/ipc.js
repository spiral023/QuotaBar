'use strict';

window.QB = window.QB || {};

if (window.__QB_IPC_BRIDGE__) {
  QB.ipc = window.__QB_IPC_BRIDGE__;
} else if (!QB.ipc) {
  console.error('QuotaBar IPC bridge is unavailable');
}
