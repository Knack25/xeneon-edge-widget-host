'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { registerIpc } = require('../ipc-contract');

function fixture() {
  const handlers = new Map(), listeners = new Map(), calls = [];
  const window = () => ({ webContents: { mainFrame: {} }, isDestroyed: () => false,
    minimize: () => calls.push(['minimize']), close: () => calls.push(['close']),
    isMaximized: () => false, maximize: () => calls.push(['maximize']) });
  let controller = window();
  const edge = window();
  const controllerEvent = { sender: controller.webContents, senderFrame: controller.webContents.mainFrame };
  const edgeEvent = { sender: edge.webContents, senderFrame: edge.webContents.mainFrame };
  const coordinator = {};
  for (const method of ['snapshot', 'getScene', 'selectWidget', 'updateSetting', 'selectDisplay',
    'setEdgeVisible', 'beginImport', 'confirmImport', 'cancelImport', 'mergeLegacySettings',
    'rescanWidgets', 'reportLoadResult']) {
    coordinator[method] = (...args) => { calls.push([method, ...args]); return { method, args }; };
  }
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: ['/chosen/widget'] }) };
  registerIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
    coordinator, dialog, getControllerWindow: () => controller, getEdgeWindow: () => edge });
  return { handlers, listeners, calls, coordinator, dialog, controllerEvent, edgeEvent,
    replaceController: () => { controller = window(); }, destroyController: () => { controller.isDestroyed = () => true; } };
}

test('controller IPC rejects Edge, subframe, stale, destroyed and absent senders', async () => {
  const r = fixture();
  const channels = ['app:get-state', 'scene:select-widget', 'scene:update-setting', 'display:select',
    'edge:set-visible', 'widgets:import', 'widgets:confirm-import', 'widgets:cancel-import',
    'settings:migrate-legacy', 'widgets:rescan'];
  for (const channel of channels) {
    const handler = r.handlers.get(channel);
    assert.equal(typeof handler, 'function', channel);
    await assert.rejects(handler(r.edgeEvent, 'clock'), /controller/i);
    await assert.rejects(handler({ ...r.controllerEvent, senderFrame: {} }, 'clock'), /controller/i);
    await assert.rejects(handler({}, 'clock'), /controller/i);
  }
  assert.deepEqual(r.calls, []);
  r.replaceController();
  await assert.rejects(r.handlers.get('scene:select-widget')(r.controllerEvent, 'clock'), /controller/i);
  r.destroyController();
  await assert.rejects(r.handlers.get('app:get-state')(r.controllerEvent), /controller/i);
});

test('controller commands preserve arguments and coordinator validation failures', async () => {
  const r = fixture();
  const cases = [
    ['app:get-state', 'snapshot', []], ['scene:select-widget', 'selectWidget', ['clock']],
    ['scene:update-setting', 'updateSetting', ['gain', 0]], ['display:select', 'selectDisplay', [2]],
    ['edge:set-visible', 'setEdgeVisible', [false]], ['widgets:confirm-import', 'confirmImport', ['one-use']],
    ['widgets:cancel-import', 'cancelImport', ['one-use']], ['settings:migrate-legacy', 'mergeLegacySettings', [{ clock: { gain: 2 } }]],
    ['widgets:rescan', 'rescanWidgets', []]
  ];
  for (const [channel, method, args] of cases) {
    assert.deepEqual(await r.handlers.get(channel)(r.controllerEvent, ...args), { method, args });
  }
  r.coordinator.updateSetting = () => { throw new Error('Invalid setting'); };
  await assert.rejects(r.handlers.get('scene:update-setting')(r.controllerEvent, '__proto__', {}), /Invalid setting/);
});

test('Edge scene and reports require only the current Edge main frame', async () => {
  const r = fixture();
  for (const channel of ['edge:get-scene', 'edge:load-result']) {
    await assert.rejects(r.handlers.get(channel)(r.controllerEvent, { revision: 2, ok: true }), /Edge/i);
    await assert.rejects(r.handlers.get(channel)({ ...r.edgeEvent, senderFrame: {} }), /Edge/i);
  }
  const report = { revision: 2, ok: true, message: 'loaded' };
  assert.deepEqual(await r.handlers.get('edge:load-result')(r.edgeEvent, report), { method: 'reportLoadResult', args: [report] });
  r.coordinator.reportLoadResult = () => { throw new Error('Stale revision'); };
  await assert.rejects(r.handlers.get('edge:load-result')(r.edgeEvent, report), /Stale revision/);
});

test('native controls act only on the authorized controller', () => {
  const r = fixture();
  for (const channel of ['window:minimize', 'window:toggle-maximize', 'window:close']) {
    r.listeners.get(channel)(r.edgeEvent);
    r.listeners.get(channel)({ ...r.controllerEvent, senderFrame: {} });
    r.listeners.get(channel)(r.controllerEvent);
  }
  assert.deepEqual(r.calls, [['minimize'], ['maximize'], ['close']]);
});

test('import uses the controller directory picker and passes one selected path', async () => {
  const r = fixture(); let picker;
  r.dialog.showOpenDialog = async (win, options) => {
    picker = { win, options }; return { canceled: false, filePaths: ['/chosen/widget'] };
  };
  assert.deepEqual(await r.handlers.get('widgets:import')(r.controllerEvent), { method: 'beginImport', args: ['/chosen/widget'] });
  assert.equal(picker.win.webContents, r.controllerEvent.sender);
  assert.deepEqual(picker.options, { properties: ['openDirectory'] });
  r.calls.length = 0;
  for (const result of [{ canceled: true, filePaths: ['/ignored'] }, { canceled: false, filePaths: [] },
    { canceled: false, filePaths: ['/one', '/two'] }]) {
    r.dialog.showOpenDialog = async () => result;
    assert.deepEqual(await r.handlers.get('widgets:import')(r.controllerEvent), { status: 'cancelled' });
  }
  assert.deepEqual(r.calls, []);
});

test('an import dialog returning after controller replacement cannot mutate the library', async () => {
  for (const invalidate of ['replaceController', 'destroyController']) {
    const r = fixture(); let finish;
    r.dialog.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
    const result = r.handlers.get('widgets:import')(r.controllerEvent);
    r[invalidate](); finish({ canceled: false, filePaths: ['/chosen/widget'] });
    await assert.rejects(result, /controller/i); assert.deepEqual(r.calls, []);
  }
});

function preload(name, isMainFrame = true) {
  const ipcRenderer = new EventEmitter(); const invocations = [], sends = [];
  ipcRenderer.invoke = (...args) => { invocations.push(args); return Promise.resolve('result'); };
  ipcRenderer.send = (...args) => sends.push(args);
  let globalName, bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), {
    process: { platform: 'darwin', isMainFrame },
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { globalName = name; bridge = value; } } })
  });
  return { ipcRenderer, invocations, sends, globalName, bridge };
}

test('controller preload exposes task methods, validates subscriptions and removes listeners', async () => {
  const r = preload('preload-controller.js');
  assert.equal(r.globalName, 'icueController'); assert.equal(r.bridge.nativeControls, true);
  assert.equal(r.bridge.ipcRenderer, undefined);
  await r.bridge.updateSetting('gain', 3); await r.bridge.rescanWidgets(); r.bridge.close();
  assert.deepEqual(r.invocations, [['scene:update-setting', 'gain', 3], ['widgets:rescan']]);
  assert.deepEqual(r.sends, [['window:close']]);
  assert.throws(() => r.bridge.onState(null), /callback/i);
  let payload; const unsubscribe = r.bridge.onState(value => { payload = value; });
  r.ipcRenderer.emit('app:state', { sender: 'private-event' }, { revision: 3 });
  assert.deepEqual(payload, { revision: 3 }); unsubscribe(); unsubscribe();
  assert.equal(r.ipcRenderer.listenerCount('app:state'), 0);
});

test('Edge preload has only its scene/report methods and removable subscriptions', async () => {
  const r = preload('preload-edge.js');
  assert.equal(r.globalName, 'icueEdge');
  assert.deepEqual(Object.keys(r.bridge).sort(), ['getScene', 'onScene', 'reportLoadResult']);
  await r.bridge.getScene(); await r.bridge.reportLoadResult({ revision: 3, ok: false });
  assert.deepEqual(r.invocations, [['edge:get-scene'], ['edge:load-result', { revision: 3, ok: false }]]);
  assert.throws(() => r.bridge.onScene('bad'), /callback/i);
  const unsubscribe = r.bridge.onScene(() => {}); unsubscribe();
  assert.equal(r.ipcRenderer.listenerCount('edge:scene'), 0);
});

test('preloads expose no host capability in widget subframes', () => {
  for (const file of ['preload-controller.js', 'preload-edge.js']) {
    assert.equal(preload(file, false).bridge, undefined);
  }
});
