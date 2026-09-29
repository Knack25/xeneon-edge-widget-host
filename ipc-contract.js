'use strict';

function authorizedWindow(event, getWindow, role) {
  const window = getWindow();
  const contents = window && !window.isDestroyed() && window.webContents;
  if (!contents || !contents.mainFrame || !event || event.sender !== contents ||
    event.senderFrame !== contents.mainFrame) {
    throw new Error(`Only the current ${role} main frame may use this command.`);
  }
  return window;
}

function registerIpc({ ipcMain, coordinator, getControllerWindow, getEdgeWindow, dialog }) {
  const controller = event => authorizedWindow(event, getControllerWindow, 'controller');
  const edge = event => authorizedWindow(event, getEdgeWindow, 'Edge');
  const handle = (channel, authorize, method) => {
    ipcMain.handle(channel, async (event, ...args) => {
      authorize(event);
      return coordinator[method](...args);
    });
  };
  handle('app:get-state', controller, 'snapshot');
  handle('scene:select-widget', controller, 'selectWidget');
  handle('scene:update-setting', controller, 'updateSetting');
  handle('pages:create', controller, 'createPage');
  handle('pages:rename', controller, 'renamePage');
  handle('pages:move', controller, 'movePage');
  handle('pages:delete', controller, 'deletePage');
  handle('pages:select', controller, 'selectPage');
  handle('pages:set-navigation-position', controller, 'setNavigationPosition');
  handle('display:select', controller, 'selectDisplay');
  handle('edge:set-visible', controller, 'setEdgeVisible');
  handle('widgets:rescan', controller, 'rescanWidgets');
  handle('widgets:confirm-import', controller, 'confirmImport');
  handle('widgets:cancel-import', controller, 'cancelImport');
  handle('settings:migrate-legacy', controller, 'mergeLegacySettings');
  handle('edge:get-scene', edge, 'getScene');
  handle('edge:load-result', edge, 'reportLoadResult');
  handle('edge:select-page', edge, 'selectPage');

  ipcMain.handle('widgets:import', async event => {
    const window = controller(event);
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    // Native dialogs outlive their owner; a stale sender cannot install a widget.
    if (controller(event) !== window) throw new Error('The controller changed during import.');
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length !== 1) {
      return { status: 'cancelled' };
    }
    return coordinator.beginImport(result.filePaths[0]);
  });

  const control = (channel, action) => ipcMain.on(channel, event => {
    let window;
    try { window = controller(event); } catch { return; }
    action(window);
  });
  control('window:minimize', window => window.minimize());
  control('window:toggle-maximize', window => window.isMaximized() ? window.unmaximize() : window.maximize());
  control('window:close', window => window.close());
}

module.exports = { registerIpc };
