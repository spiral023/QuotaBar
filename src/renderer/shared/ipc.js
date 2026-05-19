/* global require */
'use strict';

const { ipcRenderer } = require('electron');

window.QB = window.QB || {};

QB.ipc = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on:     (channel, fn)      => ipcRenderer.on(channel, fn),
  send:   (channel, ...args) => ipcRenderer.send(channel, ...args),
};
