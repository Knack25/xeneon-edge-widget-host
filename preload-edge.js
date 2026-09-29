'use strict';
const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  // Selection exists only in a dedicated isolated world. Same-origin legacy
  // widgets can reach the main-world bridge, so it must not grant this command.
  let latestScene = null, presentedPageId = null;
  const navigationListeners = new Set();
  const navigationState = () => latestScene && ({ pages: latestScene.scene.pages,
    requestedPageId: latestScene.scene.activePageId, presentedPageId,
    position: latestScene.scene.navigationPosition || 'bottom-right' });
  function publishNavigation() {
    const value = navigationState();
    if (value) for (const listener of navigationListeners) listener(value);
  }
  function receiveScene(value) {
    if (!value?.scene || (latestScene && value.revision < latestScene.revision)) return;
    latestScene = value;
    if (!value.scene.pages.some(page => page.id === presentedPageId)) presentedPageId = null;
    publishNavigation();
  }
  const getScene = async () => {
    const value = await ipcRenderer.invoke('edge:get-scene');
    receiveScene(value);
    return value;
  };
  ipcRenderer.on('edge:scene', (_event, value) => receiveScene(value));
  contextBridge.exposeInIsolatedWorld(1001, 'icueNavigation', {
    getState: async () => { await getScene(); return navigationState(); },
    onState: callback => {
      if (typeof callback !== 'function') throw new TypeError('Navigation callback must be a function.');
      navigationListeners.add(callback);
      return () => navigationListeners.delete(callback);
    },
    selectPage: target => {
      if (!latestScene?.scene.pages.some(page => page.id === target?.pageId)) return Promise.reject(new Error('Unknown page.'));
      return ipcRenderer.invoke('edge:select-page', { pageId: target.pageId });
    }
  });
  contextBridge.exposeInMainWorld('icueEdge', {
    getScene,
    onScene: callback => {
      if (typeof callback !== 'function') throw new TypeError('Scene callback must be a function.');
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('edge:scene', listener);
      return () => ipcRenderer.removeListener('edge:scene', listener);
    },
    reportLoadResult: async report => {
      const result = await ipcRenderer.invoke('edge:load-result', report);
      if (result?.state?.scene && (!latestScene || result.revision >= latestScene.revision)) {
        presentedPageId = result.edge.presentedPageId;
        receiveScene({ revision: result.revision, scene: result.state.scene });
      }
      return result;
    }
  });
}
