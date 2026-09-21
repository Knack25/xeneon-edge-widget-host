'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise main.js's macOS branches without pretending Windows is a Mac.
// Electron/window and HTTP boundaries are substituted; production startup runs unchanged.
async function boot({ platform = 'darwin', occupied = false } = {}) {
  const root = path.resolve(__dirname, '..');
  const app = new EventEmitter();
  const windows = [];
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const screen = new EventEmitter();
  screen.getAllDisplays = () => [];
  let starts = 0;
  let closes = 0;
  app.whenReady = () => Promise.resolve();
  app.quit = () => { app.quitCalled = true; app.emit('before-quit'); };
  app.exit = code => { app.exitCode = code; app.emit('before-quit'); };
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); windows.push(this); }
    async loadURL(url) { this.url = url; }
    show() {}
    static getAllWindows() { return windows.filter(w => !w.closed); }
    close() { this.closed = true; this.emit('closed'); app.emit('window-all-closed'); }
  }
  const server = {
    HOST: '127.0.0.1', PORT: 8080,
    startServer(options) {
      starts++;
      queueMicrotask(() => occupied
        ? options.onError(Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }))
        : options.onListening());
      return { close() { closes++; } };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    __dirname: root, URL, setTimeout,
    console: { log() {}, warn() {}, error() {} },
    process: { platform, env: {}, exit(code) { app.exitCode = code; } },
    require(name) {
      if (name === 'electron') return { app, BrowserWindow, ipcMain, screen };
      if (name === './presentation') return require('../presentation');
      if (name === path.join(root, 'web-server.js')) return server;
      if (name === 'http') return { get(url, callback) {
        const request = new EventEmitter();
        request.setTimeout = () => {};
        queueMicrotask(() => callback({ statusCode: 200, resume() {} }));
        return request;
      } };
      return require(name);
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { app, windows, starts: () => starts, closes: () => closes };
}

test('macOS close/reopen retains one server and quits cleanly', async () => {
  const runtime = await boot();
  runtime.windows[0].close();
  assert.equal(runtime.app.quitCalled, undefined);
  runtime.app.emit('activate');
  runtime.app.emit('activate');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.windows.length, 2);
  assert.equal(runtime.starts(), 1, 'Dock reopen must not bind a second server');
  runtime.app.emit('before-quit');
  assert.equal(runtime.closes(), 1, 'original server remains owned until quit');
});

test('macOS starts the offline clock with native window controls', async () => {
  const { windows } = await boot();
  assert.equal(new URL(windows[0].url).searchParams.get('widget'), 'com.shocksim.robextourbillon');
  assert.equal(windows[0].options.frame, true);
  assert.equal(windows[0].options.fullscreenable, false, 'green button must not create a native fullscreen Space');
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
});

test('occupied port fails instead of loading an unrelated service', async () => {
  const { app, windows } = await boot({ occupied: true });
  assert.equal(windows.length, 0);
  assert.equal(app.exitCode, 1);
});

test('Windows retains frameless controls and quits on last window close', async () => {
  const { app, windows } = await boot({ platform: 'win32' });
  assert.equal(windows[0].options.frame, false);
  windows[0].close();
  assert.equal(app.quitCalled, true);
});
