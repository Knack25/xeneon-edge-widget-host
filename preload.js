'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('icueWindow', {
  nativeControls: process.platform === 'darwin',
  presentation(action, id) {
    return ipcRenderer.invoke('presentation:control', action, id);
  },
  onPresentationChanged(callback) {
    ipcRenderer.on('presentation:changed', (_event, state) => callback(state));
  },
  minimize() {
    ipcRenderer.send('window:minimize');
  },
  toggleMaximize() {
    ipcRenderer.send('window:toggle-maximize');
  },
  close() {
    ipcRenderer.send('window:close');
  }
});
