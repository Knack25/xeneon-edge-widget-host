'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, screen, dialog } = require('electron');
const { createStateStore } = require('./app-state');
const { createWidgetLibrary } = require('./widget-library');
const { createAppCoordinator } = require('./app-coordinator');
const { registerIpc } = require('./ipc-contract');
const { createControllerWindow, createEdgeWindow } = require('./window-factories');

const runnerDir = path.resolve(process.env.ICUE_WIDGET_RUNNER_DIR || __dirname);
const webServerPath = path.join(runnerDir, 'web-server.js');
if (!fs.existsSync(webServerPath)) {
  console.error(`Runner web server was not found: ${webServerPath}`);
  app.exit(1);
} else {
  const { startServer } = require(webServerPath);
  let coordinator = null;
  let quitting = false;
  let quitFinished = false;
  let shutdown = null;

  function shutdownCoordinator() {
    if (!shutdown) shutdown = coordinator ? coordinator.quit() : Promise.resolve();
    return shutdown;
  }

  async function failStartup(error) {
    if (quitting) return;
    quitting = true;
    console.error(error);
    try { await shutdownCoordinator(); } catch (cleanupError) { console.error(cleanupError); }
    app.exit(1);
  }

  const ready = app.whenReady().then(() => {
    if (quitting) return;
    const userData = app.getPath('userData');
    const stateStore = createStateStore({ statePath: path.join(userData, 'state.json'),
      defaultWidgetId: 'com.shocksim.robextourbillon' });
    const widgetLibrary = createWidgetLibrary({ bundledRoot: path.join(runnerDir, 'widgets'),
      managedRoot: path.join(userData, 'imports') });
    const startLocalServer = () => new Promise((resolve, reject) => {
      let server;
      server = startServer({ root: runnerDir, widgetLibrary, host: '127.0.0.1', port: 8080,
        onListening: () => resolve(server),
        onError(error) {
          if (error.code === 'EADDRINUSE') {
            console.error('Port 8080 is already in use. Stop the other runner or service, then retry.');
          }
          reject(error);
        }
      });
    });
    coordinator = createAppCoordinator({ stateStore, widgetLibrary, screen, startServer: startLocalServer,
      createControllerWindow: options => createControllerWindow({ ...options, onLoadError: failStartup }),
      createEdgeWindow: options => createEdgeWindow({ ...options, onLoadError(error, window) {
        if (quitting || coordinator.getEdgeWindow() !== window) return;
        coordinator.reportLoadResult({ revision: coordinator.getScene().revision, ok: false,
          message: `Edge page failed to load: ${error.message}` });
      } })
    });
    registerIpc({ ipcMain, coordinator, dialog,
      getControllerWindow: coordinator.getControllerWindow, getEdgeWindow: coordinator.getEdgeWindow });
    return coordinator.start();
  });
  ready.catch(failStartup);

  app.on('activate', () => {
    if (quitting) return;
    ready.then(() => {
      if (!quitting && coordinator) return coordinator.activate();
    }).catch(error => { if (!quitting) return failStartup(error); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !quitting) app.quit();
  });

  app.on('before-quit', event => {
    if (quitFinished) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    shutdownCoordinator().catch(error => console.error(error)).finally(() => {
      quitFinished = true;
      app.quit();
    });
  });
}
