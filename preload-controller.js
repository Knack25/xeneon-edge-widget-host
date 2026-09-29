'use strict';
const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('icueController', {
    nativeControls: process.platform === 'darwin',
    getState: () => ipcRenderer.invoke('app:get-state'),
    onState: callback => {
      if (typeof callback !== 'function') throw new TypeError('State callback must be a function.');
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('app:state', listener);
      return () => ipcRenderer.removeListener('app:state', listener);
    },
    selectWidget: id => ipcRenderer.invoke('scene:select-widget', id),
    updateSetting: (name, value) => ipcRenderer.invoke('scene:update-setting', name, value),
    selectDisplay: id => ipcRenderer.invoke('display:select', id),
    setEdgeVisible: visible => ipcRenderer.invoke('edge:set-visible', visible),
    rescanWidgets: () => ipcRenderer.invoke('widgets:rescan'),
    importWidget: () => ipcRenderer.invoke('widgets:import'),
    confirmImport: token => ipcRenderer.invoke('widgets:confirm-import', token),
    cancelImport: token => ipcRenderer.invoke('widgets:cancel-import', token),
    submitLegacySettings: settings => ipcRenderer.invoke('settings:migrate-legacy', settings),
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close')
  });
}
