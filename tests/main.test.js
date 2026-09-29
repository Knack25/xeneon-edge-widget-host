'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
const laptop = { id: 1, label: 'Mac', internal: true, scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const edge = { id: 2, label: 'XENEON Edge', internal: false, scaleFactor: 1,
  bounds: { x: 1440, y: 0, width: 2560, height: 720 }, workArea: { x: 1440, y: 0, width: 2560, height: 720 } };
const tick = () => new Promise(resolve => setImmediate(resolve));

function nativeRuntime({ platform = 'darwin', loadGate, readyGate, loadError } = {}) {
  const windows = [], app = new EventEmitter(), ipcMain = new EventEmitter(), handlers = new Map();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  const screen = new EventEmitter();
  screen.getAllDisplays = () => [laptop, edge]; screen.getPrimaryDisplay = () => laptop;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.destroyed = false; this.actions = [];
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.send = () => {}; this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
      this.webContents.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
        assert.equal(world, 1001);
        assert.equal(scripts.length, 2);
        this.navigationInitializations = (this.navigationInitializations || 0) + 1;
      };
      windows.push(this);
    }
    async loadURL(url) {
      this.url = url;
      const gate = typeof loadGate === 'function' ? loadGate(this) : loadGate;
      if (gate) await gate;
      if (loadError) throw loadError;
      this.webContents.emit('did-finish-load');
      if (readyGate) readyGate.then(() => this.emit('ready-to-show'));
      else this.emit('ready-to-show');
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; this.actions.push('bounds'); }
    setSimpleFullScreen(value) { this.simpleFullscreen = value; this.actions.push('simple-fullscreen'); }
    setFullScreen(value) { this.fullscreen = value; this.actions.push('fullscreen'); }
    setAlwaysOnTop(value, level) { this.top = { value, level }; this.actions.push('top'); }
    show() { assert.equal(this.destroyed, false); this.actions.push('show'); }
    focus() { this.actions.push('focus'); }
    close() { this.emit('close'); this.destroy(); if (windows.every(win => win.isDestroyed())) app.emit('window-all-closed'); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  }
  const electron = { app, BrowserWindow, ipcMain, screen, dialog: {} };
  function loadModule(name) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, name), 'utf8'), {
      __dirname: root, module, exports: module.exports, URL, console, process: { platform },
      require: name => name === 'electron' ? electron : require(name.startsWith('./') ? path.join(root, name) : name)
    });
    return module.exports;
  }
  return { platform, windows, app, electron, handlers, factories: () => loadModule('window-factories.js') };
}

async function boot(t, options = {}) {
  const r = nativeRuntime(options);
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-')));
  const runnerDir = path.join(temp, 'runner'), userData = path.join(temp, 'user-data');
  fs.mkdirSync(path.join(runnerDir, 'widgets', 'robex'), { recursive: true });
  fs.writeFileSync(path.join(runnerDir, 'web-server.js'), '');
  fs.writeFileSync(path.join(runnerDir, 'widgets', 'robex', 'index.html'), '<html>clock</html>');
  fs.writeFileSync(path.join(runnerDir, 'widgets', 'robex', 'manifest.json'), JSON.stringify({ id: 'com.shocksim.robextourbillon' }));
  r.app.whenReady = () => Promise.resolve(); r.app.getPath = name => { assert.equal(name, 'userData'); return userData; };
  let starts = 0, closes = 0, quits = 0, serverOptions;
  r.app.quit = () => { const event = { preventDefault() { this.prevented = true; } }; r.app.emit('before-quit', event); if (!event.prevented) quits++; };
  r.app.exit = code => { r.app.exitCode = code; };
  const server = { close(callback) { closes++; callback?.(); } };
  const webServer = { HOST: '127.0.0.1', PORT: 8080, startServer(args) {
    starts++; serverOptions = args;
    if (!options.serverGate) queueMicrotask(() => options.occupied ? args.onError(Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })) : args.onListening());
    else options.serverGate.then(() => args.onListening());
    return server;
  } };
  const errors = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    __dirname: root, URL, setTimeout, module: { exports: {} },
    console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
    process: { platform: r.platform, env: { ICUE_WIDGET_RUNNER_DIR: runnerDir }, exit(code) { r.app.exitCode = code; } },
    require(name) {
      if (name === 'electron') return r.electron;
      if (name === path.join(runnerDir, 'web-server.js')) return webServer;
      if (name === './window-factories') return r.factories();
      if (name.startsWith('./')) return require(path.join(root, name));
      return require(name);
    }
  });
  t.after(async () => { r.app.quit(); await tick(); fs.rmSync(temp, { recursive: true, force: true }); });
  await tick();
  return { ...r, temp, userData, runnerDir, errors, starts: () => starts, closes: () => closes, quits: () => quits, serverOptions: () => serverOptions };
}

test('startup wires two isolated pages, durable state/library and the managed serving roots', async t => {
  const r = await boot(t);
  assert.equal(r.windows.length, 2); assert.match(r.windows[0].url, /\/controller\.html$/);
  assert.match(r.windows[1].url, /\/edge\.html$/);
  assert.equal(r.serverOptions().root, r.runnerDir);
  assert.equal(r.serverOptions().widgetLibrary.getServingRoots().find(route => route.baseUrl === '/managed-widgets').root, path.join(r.userData, 'imports'));
  const controller = r.windows[0];
  const state = await r.handlers.get('app:get-state')({ sender: controller.webContents, senderFrame: controller.webContents.mainFrame });
  assert.equal(state.state.scene.pages[0].regions[0].widgetId, 'com.shocksim.robextourbillon');
  assert.equal(state.widgets[0].id, 'com.shocksim.robextourbillon');
  assert.equal(r.handlers.has('presentation:control'), false);
});

test('Edge reload reinstalls isolated navigation without exposing it in the main world', async () => {
  const r = nativeRuntime();
  const window = r.factories().createEdgeWindow({ display: edge });
  await window.presentationReady;
  assert.equal(window.navigationInitializations, 1);
  window.webContents.emit('did-finish-load');
  await tick();
  assert.equal(window.navigationInitializations, 2);
});

test('Edge page load failure reports the requested page and generation', async t => {
  const r = await boot(t, { loadGate: win => /edge\.html$/.test(win.url) ?
    Promise.reject(new Error('edge failed')) : null });
  await tick();
  const controller = r.windows[0];
  const state = await r.handlers.get('app:get-state')({ sender: controller.webContents,
    senderFrame: controller.webContents.mainFrame });
  assert.equal(state.edge.loadStatus, 'failed');
  assert.match(state.edge.error, /edge failed/);
  assert.equal(state.edge.requestedPageId, state.state.scene.activePageId);
});

test('controller close and activation retain Edge and one application server', async t => {
  const r = await boot(t); r.windows[0].close();
  assert.equal(r.windows[1].isDestroyed(), false); assert.equal(r.quits(), 0);
  r.app.emit('activate'); r.app.emit('activate'); await tick();
  assert.equal(r.windows.length, 3); assert.equal(r.starts(), 1);
  assert.equal(r.windows[1].isDestroyed(), false);
});

test('activation waits for successful controller loading and ready-to-show', async t => {
  let loaded, ready;
  const loadGate = new Promise(resolve => { loaded = resolve; });
  const readyGate = new Promise(resolve => { ready = resolve; });
  const r = await boot(t, { loadGate, readyGate });
  r.app.emit('activate'); r.app.emit('activate'); await tick();
  assert.deepEqual(r.windows[0].actions, []);
  loaded(); await tick(); assert.deepEqual(r.windows[0].actions, []);
  ready(); await tick();
  assert.ok(r.windows[0].actions.includes('show')); assert.ok(r.windows[0].actions.includes('focus'));
});

test('repeated activation waits for a recreated controller page to load', async t => {
  let loaded, controllerLoads = 0;
  const loadGate = new Promise(resolve => { loaded = resolve; });
  const r = await boot(t, { loadGate: win => /controller\.html$/.test(win.url) && controllerLoads++ > 0 ? loadGate : null });
  r.windows[0].close(); r.app.emit('activate'); r.app.emit('activate'); await tick();
  assert.equal(r.windows.length, 3); assert.deepEqual(r.windows[2].actions, []);
  loaded(); await tick(); assert.ok(r.windows[2].actions.includes('show'));
});

test('quit settles pending factory readiness and activation without a late show', async t => {
  let loaded; const loadGate = new Promise(resolve => { loaded = resolve; });
  const r = await boot(t, { loadGate });
  r.app.emit('activate'); await tick(); r.app.quit(); await tick();
  assert.deepEqual(r.windows[0].actions, []);
  assert.equal(await r.windows[0].presentationReady, false);
  loaded(); await tick();
  assert.deepEqual(r.windows[0].actions, []); assert.equal(r.quits(), 1); assert.deepEqual(r.errors, []);
});

test('a rejected controller load settles readiness and is never shown by pending activation', async t => {
  let fail; const loadGate = new Promise((_resolve, reject) => { fail = reject; });
  const r = await boot(t, { loadGate });
  r.app.emit('activate'); await tick(); assert.deepEqual(r.windows[0].actions, []);
  fail(new Error('load failed')); await tick();
  assert.equal(await r.windows[0].presentationReady, false);
  assert.deepEqual(r.windows[0].actions, []); assert.equal(r.windows[0].isDestroyed(), true);
  assert.equal(r.app.exitCode, 1);
});

test('before-quit waits for cleanup and repeated requests issue one actual quit', async t => {
  const r = await boot(t); r.app.quit(); r.app.quit();
  assert.equal(r.quits(), 0); await tick();
  assert.equal(r.quits(), 1); assert.equal(r.closes(), 1);
  assert.ok(r.windows.every(win => win.isDestroyed()));
  assert.ok(fs.existsSync(path.join(r.userData, 'state.json')));
});

test('before-quit immediately disables commands from the former controller', async t => {
  const r = await boot(t); const controller = r.windows[0];
  r.app.quit();
  await assert.rejects(r.handlers.get('scene:update-setting')({ sender: controller.webContents,
    senderFrame: controller.webContents.mainFrame }, 'gain', 5), /controller|quitting/i);
});

test('quit during pending server startup and activation creates no windows', async t => {
  let ready; const serverGate = new Promise(resolve => { ready = resolve; });
  const r = await boot(t, { serverGate });
  assert.equal(r.windows.length, 0); r.app.emit('activate'); r.app.quit(); ready(); await tick();
  assert.equal(r.windows.length, 0); assert.equal(r.closes(), 1); assert.equal(r.quits(), 1);
  assert.deepEqual(r.errors, []);
});

test('occupied port fails startup before loading either page', async t => {
  const r = await boot(t, { occupied: true });
  assert.equal(r.windows.length, 0); assert.equal(r.app.exitCode, 1);
  assert.ok(r.errors.flat().some(value => /Port 8080 is already in use/.test(String(value))));
});

test('Windows preserves frameless controller controls and quits after all windows close', async t => {
  const r = await boot(t, { platform: 'win32' });
  assert.equal(r.windows[0].options.frame, false);
  assert.equal(Object.hasOwn(r.windows[0].options, 'acceptFirstMouse'), false);
  r.windows[0].close(); assert.equal(r.quits(), 0);
  r.windows[1].close(); await tick(); assert.equal(r.quits(), 1);
});

test('macOS factories use secure preloads and complete Edge presentation before showing', async () => {
  const r = nativeRuntime(); const factories = r.factories();
  const controller = factories.createControllerWindow({ bounds: laptop.workArea });
  const win = factories.createEdgeWindow({ display: edge, scene: {}, baseUrl: 'http://127.0.0.1:8080/' });
  await tick();
  assert.equal(controller.options.frame, true); assert.equal(controller.options.fullscreenable, false);
  assert.equal(controller.options.acceptFirstMouse, true);
  assert.equal(win.options.frame, false); assert.equal(win.options.fullscreenable, false);
  assert.equal(win.options.acceptFirstMouse, true); assert.equal(win.options.show, false);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegrationInSubFrames, false);
  assert.match(win.options.webPreferences.preload, /preload-edge\.js$/);
  assert.match(controller.options.webPreferences.preload, /preload-controller\.js$/);
  assert.deepEqual(win.bounds, edge.bounds); assert.equal(win.simpleFullscreen, true);
  assert.deepEqual(win.top, { value: true, level: 'pop-up-menu' });
  assert.deepEqual(win.actions, ['bounds', 'simple-fullscreen', 'top', 'show']);
});

test('window factories block privileged navigation and popups while allowing widget subframes', async () => {
  const r = nativeRuntime(); const win = r.factories().createControllerWindow({ bounds: laptop.workArea });
  await tick();
  assert.equal(win.openHandler({ url: 'https://example.com' }).action, 'deny');
  for (const channel of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    win.webContents.emit(channel, { preventDefault() { prevented = true; } }, 'http://127.0.0.1:8080/widgets/bad/index.html');
    assert.equal(prevented, true);
  }
  let blockedFrame = false;
  win.webContents.emit('will-frame-navigate', { url: 'http://127.0.0.1:8080/widgets/clock/index.html', isMainFrame: false,
    preventDefault() { blockedFrame = true; } });
  assert.equal(blockedFrame, false);
});

test('window factories reject untrusted or non-root privileged page URLs before construction', () => {
  const r = nativeRuntime(); const factories = r.factories();
  for (const baseUrl of ['https://example.com/', 'http://127.0.0.1:9999/',
    'http://127.0.0.1:8080/widgets/clock/', 'http://user:pass@127.0.0.1:8080/', 'not a url']) {
    assert.throws(() => factories.createControllerWindow({ bounds: laptop.workArea, baseUrl }));
    assert.throws(() => factories.createEdgeWindow({ display: edge, scene: {}, baseUrl }));
  }
  assert.equal(r.windows.length, 0);
});

test('async load completion never shows a destroyed window and load failures stay hidden', async () => {
  let resolve; const loadGate = new Promise(done => { resolve = done; });
  const r = nativeRuntime({ loadGate }); const win = r.factories().createEdgeWindow({ display: edge, scene: {} });
  win.destroy(); resolve(); await tick(); assert.deepEqual(win.actions, []);
  const failed = nativeRuntime({ loadError: new Error('load failed') }); const errors = [];
  const broken = failed.factories().createControllerWindow({ bounds: laptop.workArea, onLoadError: error => errors.push(error) });
  await tick(); assert.equal(broken.actions.includes('show'), false); assert.equal(errors.length, 1);
  assert.equal(await broken.presentationReady, false);
});
