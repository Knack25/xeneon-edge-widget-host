'use strict';
const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('icueEdge', {
    getScene: () => ipcRenderer.invoke('edge:get-scene'),
    onScene: callback => {
      if (typeof callback !== 'function') throw new TypeError('Scene callback must be a function.');
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('edge:scene', listener);
      return () => ipcRenderer.removeListener('edge:scene', listener);
    },
    reportLoadResult: report => ipcRenderer.invoke('edge:load-result', report)
  });
}
