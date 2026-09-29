'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStateStore } = require('../app-state');
const { createWidgetLibrary } = require('../widget-library');
const { createAppCoordinator } = require('../app-coordinator');

const laptop = { id: 1, label: 'Mac', internal: true, scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const edge = { id: 2, label: 'XENEON Edge', internal: false, scaleFactor: 1,
  bounds: { x: 1440, y: 0, width: 2560, height: 720 }, workArea: { x: 1440, y: 0, width: 2560, height: 720 } };

class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.destroyed = false; this.focused = false;
    this.bounds = options.bounds || options.display.bounds;
    this.messages = [];
    this.webContents = new EventEmitter();
    this.webContents.send = (channel, value) => this.messages.push({ channel, value });
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { return this.bounds; }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

function writeWidget(root, folder, id, version = '1') {
  const directory = path.join(root, folder);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), '<html>widget</html>');
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ id, name: id, version }));
  return directory;
}

function fixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-coordinator-'));
  const bundledRoot = path.join(temp, 'widgets');
  writeWidget(bundledRoot, 'clock', 'clock');
  writeWidget(bundledRoot, 'other', 'other');
  const widgetLibrary = createWidgetLibrary({ bundledRoot, managedRoot: path.join(temp, 'managed') });
  const stateStore = createStateStore({ statePath: path.join(temp, 'state.json'), defaultWidgetId: 'clock', writeDelayMs: 10000 });
  if (options.prepare) options.prepare(stateStore);
  const screen = new EventEmitter();
  let displays = options.displays || [laptop, edge];
  screen.getAllDisplays = () => displays;
  screen.getPrimaryDisplay = () => displays.find(display => display.id === 1) || displays[0];
  const controllers = [], edges = [];
  let serverStarts = 0, clock = 0;
  const server = { closed: false, close(callback) { this.closed = true; callback(); } };
  const coordinator = createAppCoordinator({ stateStore, widgetLibrary, screen,
    createControllerWindow: args => { const win = new FakeWindow(args); controllers.push(win); return win; },
    createEdgeWindow: args => { const win = new FakeWindow(args); edges.push(win); return win; },
    startServer: async () => { serverStarts++; if (options.serverGate) await options.serverGate; return server; }, now: () => clock });
  t.after(async () => { await coordinator.quit().catch(() => {}); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, coordinator, stateStore, widgetLibrary, screen, controllers, edges, server,
    get serverStarts() { return serverStarts; }, tick(value) { clock += value; },
    topology(next, event = 'display-added') { displays = next; screen.emit(event, {}, next.at(-1)); } };
}

test('startup waits for the server and gives factories safe bounds and an isolated scene', async t => {
  const r = fixture(t, { prepare: store => store.update(state => { state.controllerBounds = { x: 1600, y: 0, width: 500, height: 300 }; }) });
  await r.coordinator.start(); await r.coordinator.start();
  assert.equal(r.serverStarts, 1);
  assert.equal(r.controllers.length, 1);
  assert.deepEqual(r.controllers[0].options.bounds, { x: 170, y: 102, width: 1100, height: 720 });
  assert.equal(r.edges[0].options.display.id, 2);
  assert.equal(r.edges[0].options.scene.widget.id, 'clock');
  assert.equal(r.coordinator.getControllerWindow(), r.controllers[0]);
  assert.equal(r.coordinator.getEdgeWindow(), r.edges[0]);
});

test('closing controller leaves Edge and server alive; activate restores controller bounds', async t => {
  const r = fixture(t); await r.coordinator.start();
  r.controllers[0].bounds = { x: 40, y: 50, width: 800, height: 600 }; r.controllers[0].close();
  assert.equal(r.edges[0].destroyed, false); assert.equal(r.server.closed, false);
  assert.deepEqual(r.coordinator.snapshot().state.controllerBounds, { x: 40, y: 50, width: 800, height: 600 });
  await r.coordinator.activate();
  assert.equal(r.controllers.length, 2);
  assert.deepEqual(r.controllers[1].options.bounds, { x: 40, y: 50, width: 800, height: 600 });
  await r.coordinator.activate(); assert.equal(r.controllers.length, 2); assert.equal(r.controllers[1].focused, true);
});

test('settings and widget switches preserve per-widget values without recreating Edge', async t => {
  const r = fixture(t); await r.coordinator.start();
  r.coordinator.updateSetting('gain', 1); r.coordinator.updateSetting('gain', 2);
  r.coordinator.selectWidget('other'); r.coordinator.updateSetting('color', 'red'); r.coordinator.selectWidget('clock');
  assert.equal(r.edges.length, 1);
  assert.deepEqual(r.coordinator.getScene().scene.pages[0].regions[0].settings, { gain: 2 });
  assert.deepEqual(r.coordinator.snapshot().state.widgetSettings, { clock: { gain: 2 }, other: { color: 'red' } });
  const messages = r.edges[0].messages.filter(item => item.channel === 'edge:scene');
  assert.ok(messages.some(item => item.value.scene.pages[0].regions[0].settings.gain === 1));
  assert.ok(messages.some(item => item.value.scene.pages[0].regions[0].settings.gain === 2));
  assert.ok(r.controllers[0].messages.some(item => item.channel === 'app:state'));
  await r.stateStore.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.temp, 'state.json'))).widgetSettings.clock.gain, 2);
});

test('migration merges inactive settings once and startup synchronizes the active cache', async t => {
  const r = fixture(t, { prepare: store => store.update(state => { state.scene.pages[0].regions[0].settings = { gain: 7 }; }) });
  await r.coordinator.start();
  assert.deepEqual(r.coordinator.snapshot().state.widgetSettings.clock, { gain: 7 });
  assert.equal(r.coordinator.mergeLegacySettings({ clock: { gain: 3, color: 'blue' }, other: { speed: 5 } }), true);
  assert.equal(r.coordinator.mergeLegacySettings({ clock: { gain: 9 } }), false);
  r.coordinator.selectWidget('other'); assert.deepEqual(r.coordinator.getScene().scene.pages[0].regions[0].settings, { speed: 5 });
  r.coordinator.selectWidget('clock'); assert.deepEqual(r.coordinator.getScene().scene.pages[0].regions[0].settings, { gain: 7, color: 'blue' });
});

test('invalid commands fail closed without changing revision', async t => {
  const r = fixture(t); await r.coordinator.start(); const revision = r.coordinator.snapshot().revision;
  for (const id of ['missing', '', '__proto__', 1]) assert.throws(() => r.coordinator.selectWidget(id));
  for (const name of ['', ' ', '__proto__', 'constructor', 'prototype', 1]) assert.throws(() => r.coordinator.updateSetting(name, 1));
  for (const value of [NaN, Infinity, undefined, {}, [], () => 1, 1n]) assert.throws(() => r.coordinator.updateSetting('gain', value));
  for (const id of [99, '2', null, {}, Infinity]) assert.throws(() => r.coordinator.selectDisplay(id));
  for (const visible of [0, 1, 'true', null]) assert.throws(() => r.coordinator.setEdgeVisible(visible));
  assert.equal(r.coordinator.snapshot().revision, revision);
});

test('missing saved widget remains selected and reports failure', async t => {
  const r = fixture(t, { prepare: store => store.update(state => { state.scene.pages[0].regions[0].widgetId = 'uninstalled'; }) });
  await r.coordinator.start();
  assert.equal(r.coordinator.getScene().scene.pages[0].regions[0].widgetId, 'uninstalled');
  assert.equal(r.coordinator.getScene().widget, null);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'failed');
  assert.match(r.coordinator.snapshot().edge.error, /uninstalled/);
});

test('ambiguous automatic selection waits for explicit display selection', async t => {
  const r = fixture(t, { displays: [laptop, edge, { ...edge, id: 3 }] }); await r.coordinator.start();
  assert.equal(r.edges.length, 0); assert.equal(r.coordinator.snapshot().edge.status, 'ambiguous');
  r.topology([laptop, edge, { ...edge, id: 3, label: 'Second Edge' }]);
  r.coordinator.selectDisplay(2); assert.equal(r.edges.length, 1);
  assert.equal(r.coordinator.snapshot().state.displayPreference.mode, 'manual');
});

test('disconnect pins the target and restores only a unique matching reconnect', async t => {
  const r = fixture(t); await r.coordinator.start();
  r.topology([laptop], 'display-removed');
  assert.equal(r.edges[0].destroyed, true); assert.equal(r.coordinator.snapshot().edge.status, 'disconnected');
  r.topology([laptop, { ...edge, id: 3, label: 'Other XENEON Edge' }]); assert.equal(r.edges.length, 1);
  r.topology([laptop, { ...edge, id: 44 }]); assert.equal(r.edges.length, 2);
  assert.equal(r.edges[1].options.display.id, 44);
  r.topology([laptop, { ...edge, id: 44 }, { ...edge, id: 45 }]);
  assert.equal(r.edges[1].destroyed, true); assert.equal(r.coordinator.snapshot().edge.status, 'ambiguous');
});

test('hide prevents recovery and explicit Show resets the bounded crash limit', async t => {
  const r = fixture(t); await r.coordinator.start();
  for (let index = 0; index < 3; index++) r.edges.at(-1).webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(r.edges.length, 3); assert.equal(r.coordinator.getEdgeWindow(), null);
  assert.equal(r.coordinator.snapshot().edge.status, 'failed');
  r.topology([laptop, edge]); assert.equal(r.edges.length, 3);
  r.coordinator.setEdgeVisible(true); assert.equal(r.edges.length, 4);
  r.coordinator.setEdgeVisible(false); assert.equal(r.edges.at(-1).destroyed, true);
  r.edges.at(-1).webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(r.edges.length, 4); assert.equal(r.coordinator.snapshot().edge.status, 'hidden');
  r.topology([laptop, edge]); assert.equal(r.edges.length, 4);
});

test('recovery budget expires after thirty seconds', async t => {
  const r = fixture(t); await r.coordinator.start();
  r.edges.at(-1).webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  r.edges.at(-1).webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  r.tick(30001); r.edges.at(-1).webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(r.edges.length, 4); assert.equal(r.coordinator.snapshot().edge.status, 'active');
});

test('load failures report the retained widget and reject stale or malformed reports', async t => {
  const r = fixture(t); await r.coordinator.start();
  r.coordinator.reportLoadResult({ revision: r.coordinator.getScene().revision, ok: true });
  r.coordinator.selectWidget('other');
  const revision = r.coordinator.getScene().revision;
  r.coordinator.reportLoadResult({ revision, ok: false, message: 'fetch failed' });
  assert.equal(r.coordinator.snapshot().edge.retainedWidgetId, 'clock');
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'failed');
  for (const report of [{ revision: revision - 1, ok: true }, { revision, ok: 'yes' }, { revision, ok: false, message: {} }]) {
    assert.throws(() => r.coordinator.reportLoadResult(report));
  }
  r.coordinator.reportLoadResult({ revision, ok: true });
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loaded');
  assert.equal(r.coordinator.snapshot().edge.retainedWidgetId, null);
});

test('load reports update controller status without rebroadcasting an unchanged Edge scene', async t => {
  const r = fixture(t); await r.coordinator.start();
  const edgeCount = r.edges[0].messages.length;
  const controllerCount = r.controllers[0].messages.length;
  r.coordinator.reportLoadResult({ revision: r.coordinator.getScene().revision, ok: true });
  assert.equal(r.edges[0].messages.length, edgeCount);
  assert.equal(r.controllers[0].messages.length, controllerCount + 1);
});

test('explicit automatic selection can choose a new unique target after disconnect', async t => {
  const r = fixture(t); await r.coordinator.start();
  r.topology([laptop, { ...edge, id: 5, label: 'Replacement XENEON Edge' }], 'display-removed');
  assert.equal(r.coordinator.snapshot().edge.status, 'disconnected');
  r.coordinator.selectDisplay('automatic');
  assert.equal(r.coordinator.getEdgeWindow().options.display.id, 5);
  assert.equal(r.coordinator.snapshot().state.displayPreference.mode, 'automatic');
});

test('startup creates no windows before server readiness and quit during startup closes that server', async t => {
  let release;
  const serverGate = new Promise(resolve => { release = resolve; });
  const r = fixture(t, { serverGate });
  const started = r.coordinator.start();
  assert.equal(r.controllers.length, 0); assert.equal(r.edges.length, 0);
  const quitting = r.coordinator.quit(); release();
  await started; await quitting;
  assert.equal(r.controllers.length, 0); assert.equal(r.edges.length, 0); assert.equal(r.server.closed, true);
});

test('public snapshots and broadcasts omit roots and isolate references', async t => {
  const r = fixture(t); await r.coordinator.start();
  const snapshot = r.coordinator.snapshot(); snapshot.state.scene.visible = false; snapshot.widgets[0].manifest.name = 'changed';
  r.coordinator.getScene().scene.pages[0].regions[0].settings.gain = 999;
  assert.equal(r.coordinator.snapshot().state.scene.visible, true);
  assert.equal(r.coordinator.snapshot().widgets[0].manifest.name, 'clock');
  assert.deepEqual(r.coordinator.getScene().scene.pages[0].regions[0].settings, {});
  assert.equal(JSON.stringify(r.coordinator.snapshot()).includes(r.temp), false);
});

test('imports require one-use confirmation and replacement reloads same-ID assets while preserving settings', async t => {
  const r = fixture(t); await r.coordinator.start(); r.coordinator.updateSetting('gain', 4);
  const incoming = writeWidget(r.temp, 'incoming', 'clock', '2');
  const pending = r.coordinator.beginImport(incoming);
  assert.equal(pending.status, 'confirmation-required'); assert.equal(pending.incoming.version, '2');
  const prior = r.coordinator.getScene();
  const installed = r.coordinator.confirmImport(pending.token);
  assert.equal(installed.status, 'replaced'); assert.equal(installed.entry.id, 'clock');
  assert.ok(r.coordinator.getScene().revision > prior.revision);
  assert.ok(r.coordinator.getScene().catalogRevision > prior.catalogRevision);
  assert.equal(r.coordinator.getScene().widget.manifest.version, '2');
  assert.deepEqual(r.coordinator.getScene().scene.pages[0].regions[0].settings, { gain: 4 });
  assert.equal(r.edges.length, 1); assert.throws(() => r.coordinator.confirmImport(pending.token));
  const next = r.coordinator.beginImport(incoming); assert.equal(r.coordinator.cancelImport(next.token).status, 'cancelled');
  assert.throws(() => r.coordinator.cancelImport(next.token));
  const fresh = writeWidget(r.temp, 'new', 'new'); assert.equal(r.coordinator.beginImport(fresh).status, 'installed');
  assert.ok(r.coordinator.snapshot().widgets.some(widget => widget.id === 'new'));
  const previous = r.coordinator.getScene(); r.coordinator.rescanWidgets();
  assert.ok(r.coordinator.getScene().revision > previous.revision); assert.ok(r.coordinator.getScene().catalogRevision > previous.catalogRevision);
});

test('quit closes windows, flushes state, closes server and removes topology listeners', async t => {
  const r = fixture(t); await r.coordinator.start(); r.coordinator.updateSetting('gain', 9);
  await r.coordinator.quit();
  assert.equal(r.controllers[0].destroyed, true); assert.equal(r.edges[0].destroyed, true); assert.equal(r.server.closed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.temp, 'state.json'))).widgetSettings.clock.gain, 9);
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(r.screen.listenerCount(event), 0);
  r.edges[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' }); assert.equal(r.edges.length, 1);
});

test('quit still closes server when state flush fails', async t => {
  const r = fixture(t); await r.coordinator.start();
  r.stateStore.flush = async () => { throw new Error('disk failed'); };
  await assert.rejects(r.coordinator.quit(), /disk failed/);
  assert.equal(r.server.closed, true); assert.equal(r.edges[0].destroyed, true);
});
