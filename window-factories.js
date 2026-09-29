'use strict';
const path = require('node:path');
const { BrowserWindow } = require('electron');

const APP_ORIGIN = 'http://127.0.0.1:8080';

function rendererUrl(page, baseUrl = `${APP_ORIGIN}/`) {
  const url = new URL(page, baseUrl);
  if (url.origin !== APP_ORIGIN || url.username || url.password || url.pathname !== `/${page}` || url.search || url.hash) {
    throw new Error('Privileged renderer must use the application loopback URL.');
  }
  return url.href;
}

function preferences(preload) {
  return { preload: path.join(__dirname, preload), nodeIntegration: false,
    contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: false, webviewTag: false };
}

function protectNavigation(window, url) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, legacyUrl) => {
    if ((event.url || legacyUrl) !== url) event.preventDefault();
  });
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame && event.url !== url) event.preventDefault();
  });
  contents.on('will-redirect', (event, legacyUrl, _inPlace, legacyMainFrame) => {
    if ((event.isMainFrame ?? legacyMainFrame) !== false && (event.url || legacyUrl) !== url) event.preventDefault();
  });
}

function load(window, url, present, onLoadError = error => console.error(error)) {
  protectNavigation(window, url);
  let ready = false, loaded = false, shown = false;
  const show = () => {
    if (!ready || !loaded || shown || window.isDestroyed()) return;
    shown = true;
    present();
    window.show();
  };
  window.once('ready-to-show', () => { ready = true; show(); });
  // Deferral lets the coordinator install its window ownership before callbacks.
  Promise.resolve().then(() => {
    if (!window.isDestroyed()) return window.loadURL(url);
  }).then(() => {
    loaded = true;
    show();
  }).catch(error => {
    if (!window.isDestroyed()) onLoadError(error, window);
  });
  return window;
}

function createControllerWindow({ bounds, baseUrl, onLoadError } = {}) {
  const url = rendererUrl('controller.html', baseUrl);
  const mac = process.platform === 'darwin';
  const window = new BrowserWindow({ ...bounds, minWidth: 520, minHeight: 360,
    frame: mac, fullscreenable: !mac, ...(mac ? { acceptFirstMouse: true } : {}),
    resizable: true, show: false, autoHideMenuBar: true, backgroundColor: '#111111',
    webPreferences: preferences('preload-controller.js') });
  return load(window, url, () => {}, onLoadError);
}

function createEdgeWindow({ display, baseUrl, onLoadError }) {
  const url = rendererUrl('edge.html', baseUrl);
  const window = new BrowserWindow({ ...display.bounds, frame: false, fullscreenable: false,
    acceptFirstMouse: true, show: false, autoHideMenuBar: true, backgroundColor: '#000000',
    webPreferences: preferences('preload-edge.js') });
  return load(window, url, () => {
    window.setBounds(display.bounds);
    if (process.platform === 'darwin') {
      window.setSimpleFullScreen(true);
      window.setAlwaysOnTop(true, 'pop-up-menu');
    } else {
      window.setFullScreen(true);
    }
  }, onLoadError);
}

module.exports = { createControllerWindow, createEdgeWindow };
