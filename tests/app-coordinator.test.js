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
const { buildControllerViewModel } = require('../controller-view');
const { migrateLegacySettings } = require('../controller');
const { getDefaultWidgetSettings } = require('../widget-settings');

const laptop = { id: 1, label: 'Mac', internal: true, scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const edge = { id: 2, label: 'XENEON Edge', internal: false, scaleFactor: 1,
  bounds: { x: 1440, y: 0, width: 2560, height: 720 }, workArea: { x: 1440, y: 0, width: 2560, height: 720 } };
const target = (coordinator, widgetId) => ({ pageId: coordinator.snapshot().state.scene.activePageId, widgetId });
const setting = (coordinator, name, value) => coordinator.updateSetting({ ...target(coordinator, coordinator.snapshot().edge.widgetId), name, value });
const report = coordinator => {
  const scene = coordinator.getScene();
  const pageId = scene.scene.activePageId;
  return { pageId, widgetId: scene.scene.pages.find(page => page.id === pageId).regions[0].widgetId,
    generation: scene.pageGenerations[pageId], revision: scene.revision };
};

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
  if (options.persisted !== undefined) fs.writeFileSync(path.join(temp, 'state.json'), options.persisted);
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

test('activation waits for factory readiness and cannot show a replaced controller', async t => {
  const r = fixture(t); await r.coordinator.start();
  const old = r.controllers[0]; let ready;
  old.presentationReady = new Promise(resolve => { ready = resolve; });
  const activation = r.coordinator.activate(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(old.shown, undefined); old.close();
  await r.coordinator.activate(); const current = r.controllers[1];
  ready(true); await activation;
  assert.equal(old.shown, undefined); assert.equal(current.focused, true);
});

test('activation rechecks shutdown after factory readiness resolves', async t => {
  const r = fixture(t); await r.coordinator.start(); const win = r.controllers[0]; let ready;
  win.presentationReady = new Promise(resolve => { ready = resolve; });
  const activation = r.coordinator.activate(); await new Promise(resolve => setImmediate(resolve));
  const stopped = r.coordinator.quit(); ready(true);
  await assert.rejects(activation, /quitting/i); await stopped;
  assert.equal(win.shown, undefined); assert.equal(win.focused, false);
});

test('settings and widget switches preserve per-widget values without recreating Edge', async t => {
  const r = fixture(t); await r.coordinator.start();
  setting(r.coordinator, 'gain', 1); setting(r.coordinator, 'gain', 2);
  r.coordinator.selectWidget(target(r.coordinator, 'other')); setting(r.coordinator, 'color', 'red'); r.coordinator.selectWidget(target(r.coordinator, 'clock'));
  assert.equal(r.edges.length, 1);
  assert.deepEqual(r.coordinator.getScene().scene.pages[0].regions[0].settings, { gain: 2 });
  assert.deepEqual(r.coordinator.snapshot().state.scene.pages[0].widgetSettings, { clock: { gain: 2 }, other: { color: 'red' } });
  const messages = r.edges[0].messages.filter(item => item.channel === 'edge:scene');
  assert.ok(messages.some(item => item.value.scene.pages[0].regions[0].settings.gain === 1));
  assert.ok(messages.some(item => item.value.scene.pages[0].regions[0].settings.gain === 2));
  assert.ok(r.controllers[0].messages.some(item => item.channel === 'app:state'));
  await r.stateStore.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.temp, 'state.json'))).scene.pages[0].widgetSettings.clock.gain, 2);
});

test('page commands keep stable IDs, defaults and independent same-widget settings without native window changes', async t => {
  const r = fixture(t); await r.coordinator.start();
  const firstId = r.coordinator.snapshot().state.scene.activePageId;
  setting(r.coordinator, 'gain', 8);
  const win = r.edges[0];
  win.setBounds = () => { throw new Error('page edit moved Edge'); };
  win.setFullScreen = () => { throw new Error('page edit changed fullscreen'); };
  win.setSimpleFullScreen = win.setFullScreen;
  const added = r.coordinator.createPage({ name: '  Sketch  ' });
  const secondId = added.state.scene.activePageId;
  assert.notEqual(secondId, firstId);
  assert.equal(added.state.scene.pages[1].name, 'Sketch');
  assert.equal(added.state.scene.pages[1].regions[0].widgetId, 'clock');
  assert.deepEqual(added.state.scene.pages[1].regions[0].settings,
    getDefaultWidgetSettings(added.widgets.find(widget => widget.id === 'clock')));
  assert.equal(added.state.scene.pages[0].regions[0].settings.gain, 8);
  setting(r.coordinator, 'gain', 3);
  r.coordinator.renamePage({ pageId: secondId, name: '  Updated  ' });
  r.coordinator.movePage({ pageId: secondId, direction: 'up' });
  r.coordinator.setNavigationPosition({ position: 'top-left' });
  assert.deepEqual(r.coordinator.snapshot().state.scene.pages.map(page => page.id), [secondId, firstId]);
  assert.equal(r.coordinator.snapshot().state.scene.activePageId, secondId);
  assert.equal(r.coordinator.snapshot().state.scene.pages[0].name, 'Updated');
  assert.equal(r.coordinator.snapshot().state.scene.navigationPosition, 'top-left');
  assert.equal(r.coordinator.snapshot().state.scene.pages[0].regions[0].settings.gain, 3);
  assert.equal(r.coordinator.snapshot().state.scene.pages[1].regions[0].settings.gain, 8);
  assert.equal(r.edges.length, 1);
  r.coordinator.deletePage({ pageId: secondId });
  assert.equal(r.coordinator.snapshot().state.scene.activePageId, firstId);
});

test('page and setting commands reject stale targets and invalid bounds before mutation', async t => {
  const r = fixture(t); await r.coordinator.start();
  const firstId = r.coordinator.snapshot().state.scene.activePageId;
  const secondId = r.coordinator.createPage({ name: 'Second' }).state.scene.activePageId;
  const revision = r.coordinator.snapshot().revision;
  for (const action of [
    () => r.coordinator.updateSetting({ pageId: firstId, widgetId: 'clock', name: 'gain', value: 7 }),
    () => r.coordinator.updateSetting({ pageId: secondId, widgetId: 'other', name: 'gain', value: 7 }),
    () => r.coordinator.selectWidget({ pageId: firstId, widgetId: 'other' }),
    () => r.coordinator.selectWidget({ pageId: secondId, widgetId: 'missing' }),
    () => r.coordinator.renamePage({ pageId: 'missing', name: 'Bad' }),
    () => r.coordinator.movePage({ pageId: secondId, direction: 'sideways' }),
    () => r.coordinator.deletePage({ pageId: 'missing' }),
    () => r.coordinator.selectPage({ pageId: 'missing' }),
    () => r.coordinator.setNavigationPosition({ position: 'center' }),
    () => r.coordinator.createPage({ name: ' ' })
  ]) assert.throws(action);
  assert.equal(r.coordinator.snapshot().revision, revision);
  r.coordinator.selectPage({ pageId: firstId });
  assert.equal(r.coordinator.snapshot().state.scene.activePageId, firstId);
  assert.throws(() => r.coordinator.deletePage({ pageId: 'missing' }));
});

test('resolved page widgets and generations track replacement and catalog updates', async t => {
  const r = fixture(t); await r.coordinator.start();
  const firstId = r.coordinator.snapshot().state.scene.activePageId;
  const secondId = r.coordinator.createPage({ name: 'Second' }).state.scene.activePageId;
  let scene = r.coordinator.getScene();
  assert.equal(scene.pageWidgets[firstId].id, 'clock');
  assert.equal(scene.pageWidgets[secondId].id, 'clock');
  const firstGeneration = scene.pageGenerations[firstId];
  const secondGeneration = scene.pageGenerations[secondId];
  r.coordinator.selectWidget({ pageId: secondId, widgetId: 'other' });
  scene = r.coordinator.getScene();
  assert.equal(scene.pageGenerations[firstId], firstGeneration);
  assert.ok(scene.pageGenerations[secondId] > secondGeneration);
  assert.equal(scene.pageWidgets[secondId].id, 'other');
  const beforeOther = scene.pageGenerations[secondId];
  writeWidget(path.join(r.temp, 'widgets'), 'clock', 'clock', '2');
  r.coordinator.rescanWidgets();
  scene = r.coordinator.getScene();
  assert.ok(scene.pageGenerations[firstId] > firstGeneration);
  assert.equal(scene.pageGenerations[secondId], beforeOther);
});

test('an unchanged catalog scan preserves a pending page request', async t => {
  const r = fixture(t); await r.coordinator.start();
  const pending = { ...report(r.coordinator), ok: true };
  r.coordinator.rescanWidgets();
  assert.equal(r.coordinator.getScene().pageGenerations[pending.pageId], pending.generation);
  r.coordinator.reportLoadResult(pending);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loaded');
});

test('stale and inactive reports cannot promote the wrong page; failed active page retries with a new generation', async t => {
  const r = fixture(t); await r.coordinator.start();
  const firstReport = { ...report(r.coordinator), ok: true };
  r.coordinator.reportLoadResult(firstReport);
  const firstId = firstReport.pageId;
  const secondId = r.coordinator.createPage({ name: 'Second' }).state.scene.activePageId;
  const secondReport = { ...report(r.coordinator), ok: false, message: 'network error' };
  r.coordinator.reportLoadResult(secondReport);
  assert.equal(r.coordinator.snapshot().edge.requestedPageId, secondId);
  assert.equal(r.coordinator.snapshot().edge.presentedPageId, firstId);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'failed');
  r.coordinator.reportLoadResult(firstReport);
  assert.equal(r.coordinator.snapshot().edge.presentedPageId, firstId);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'failed');
  r.coordinator.selectPage({ pageId: secondId });
  const retry = report(r.coordinator);
  assert.ok(retry.generation > secondReport.generation);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loading');
  r.coordinator.reportLoadResult({ ...secondReport, ok: true });
  assert.equal(r.coordinator.snapshot().edge.presentedPageId, firstId);
  assert.equal(r.coordinator.snapshot().edge.pageLoads[secondId].status, 'loading');
  r.coordinator.reportLoadResult({ ...retry, ok: true });
  assert.equal(r.coordinator.snapshot().edge.presentedPageId, secondId);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loaded');
  r.coordinator.deletePage({ pageId: firstId });
  r.coordinator.reportLoadResult(firstReport);
  assert.equal(r.coordinator.snapshot().edge.presentedPageId, secondId);
});

test('a late report from an earlier request cannot mark a newly requested visit loaded', async t => {
  const r = fixture(t); await r.coordinator.start();
  const firstId = r.coordinator.snapshot().state.scene.activePageId;
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: true });
  const secondId = r.coordinator.createPage({ name: 'Second' }).state.scene.activePageId;
  const earlier = { ...report(r.coordinator), ok: true };
  r.coordinator.selectPage({ pageId: firstId });
  r.coordinator.selectPage({ pageId: secondId });
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loading');
  r.coordinator.reportLoadResult(earlier);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loading');
  assert.equal(r.coordinator.snapshot().edge.pageLoads[secondId].status, 'loading');
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: true });
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loaded');
});

test('returning to a cached page waits for Edge confirmation before changing presented status', async t => {
  const r = fixture(t); await r.coordinator.start();
  const firstId = r.coordinator.snapshot().state.scene.activePageId;
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: true });
  const secondId = r.coordinator.createPage({ name: 'Second' }).state.scene.activePageId;
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: true });
  r.coordinator.selectPage({ pageId: firstId });
  const controllerState = r.controllers[0].messages.at(-1).value;
  assert.equal(controllerState.edge.requestedPageId, firstId);
  assert.equal(controllerState.edge.presentedPageId, secondId);
  assert.equal(controllerState.edge.loadStatus, 'loading');
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: true });
  assert.equal(r.coordinator.snapshot().edge.presentedPageId, firstId);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loaded');
});

test('same-metadata managed widget replacement invalidates every page using its assets', async t => {
  const r = fixture(t); await r.coordinator.start();
  const first = writeWidget(r.temp, 'first-copy', 'copy');
  assert.equal(r.coordinator.beginImport(first).status, 'installed');
  const firstId = r.coordinator.snapshot().state.scene.activePageId;
  r.coordinator.selectWidget({ pageId: firstId, widgetId: 'copy' });
  const secondId = r.coordinator.createPage({ name: 'Second' }).state.scene.activePageId;
  const previous = r.coordinator.getScene().pageGenerations;
  const staleReport = { ...report(r.coordinator), ok: true };
  const replacement = writeWidget(r.temp, 'replacement-copy', 'copy');
  fs.writeFileSync(path.join(replacement, 'index.html'), '<html>replacement assets</html>');
  const pending = r.coordinator.beginImport(replacement);
  assert.equal(pending.status, 'confirmation-required');
  assert.equal(r.coordinator.confirmImport(pending.token).status, 'replaced');
  const next = r.coordinator.getScene();
  assert.ok(next.pageGenerations[firstId] > previous[firstId]);
  assert.ok(next.pageGenerations[secondId] > previous[secondId]);
  r.coordinator.reportLoadResult(staleReport);
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loading');
});

test('migration merges inactive settings once and startup synchronizes the active cache', async t => {
  const r = fixture(t, { prepare: store => store.update(state => { state.scene.pages[0].regions[0].settings = { gain: 7 }; }) });
  await r.coordinator.start();
  assert.deepEqual(r.coordinator.snapshot().state.scene.pages[0].widgetSettings.clock, { gain: 7 });
  assert.equal(await r.coordinator.mergeLegacySettings({ clock: { gain: 3, color: 'blue' }, other: { speed: 5 } }), true);
  assert.equal(await r.coordinator.mergeLegacySettings({ clock: { gain: 9 } }), false);
  r.coordinator.selectWidget(target(r.coordinator, 'other')); assert.deepEqual(r.coordinator.getScene().scene.pages[0].regions[0].settings, { speed: 5 });
  r.coordinator.selectWidget(target(r.coordinator, 'clock')); assert.deepEqual(r.coordinator.getScene().scene.pages[0].regions[0].settings, { gain: 7, color: 'blue' });
});

test('recovered persisted bytes produce a visible controller notice through the real coordinator', async t => {
  for (const bytes of ['{bad']) {
    const r = fixture(t, { persisted: bytes }); await r.coordinator.start();
    assert.match(buildControllerViewModel(r.coordinator.snapshot()).edge.message, /State recovered from invalid persisted data/);
    assert.doesNotMatch(JSON.stringify(r.coordinator.snapshot().recovery), /app-coordinator-|state.json/);
    const backup = fs.readdirSync(r.temp).find(name => name.startsWith('state.json.corrupt-'));
    assert.equal(fs.readFileSync(path.join(r.temp, backup), 'utf8'), bytes);
  }
});

test('unsupported future state opens read-only without overwriting its bytes', async t => {
  const bytes = '{"version":99,"widgetSettings":{"clock":{"gain":145}}}';
  const r = fixture(t, { persisted: bytes }); await r.coordinator.start();
  assert.equal(r.coordinator.snapshot().recovery.status, 'read-only');
  assert.equal(fs.readFileSync(path.join(r.temp, 'state.json'), 'utf8'), bytes);
});

test('migration keeps localStorage on durable write failure and retries the already merged state before acknowledgement', async t => {
  const r = fixture(t); await r.coordinator.start(); setting(r.coordinator, 'gain', 7); await r.stateStore.flush();
  const bytes = '{"clock":{"gain":3,"color":"blue"},"other":{"speed":5,"nested":{"list":[1,true,null]}}}';
  const storage = { value: bytes, getItem() { return this.value; }, removeItem() { this.value = null; } };
  const bridge = { submitLegacySettings: data => r.coordinator.mergeLegacySettings(data) };
  // An actual non-writable destination for the atomic rename, with the durable original retained.
  const statePath = path.join(r.temp, 'state.json'); const original = fs.readFileSync(statePath);
  fs.renameSync(statePath, `${statePath}.saved`); fs.mkdirSync(statePath);
  await assert.rejects(migrateLegacySettings(storage, bridge));
  assert.equal(storage.value, bytes); assert.equal(r.stateStore.snapshot().legacySettingsMigrated, true);
  fs.rmdirSync(statePath); fs.writeFileSync(statePath, original);
  await migrateLegacySettings(storage, bridge); assert.equal(storage.value, null);
  const reloaded = createStateStore({ statePath, defaultWidgetId: 'clock' });
  assert.equal(reloaded.snapshot().legacySettingsMigrated, true);
  assert.deepEqual(reloaded.snapshot().scene.pages[0].widgetSettings, { clock: { gain: 7, color: 'blue' }, other: { speed: 5, nested: { list: [1, true, null] } } });
  await reloaded.flush();
});

test('hidden manual targets remain selected independently of the Edge window and still require unique saved matches', async t => {
  const duplicate = { ...edge, id: 3 };
  const r = fixture(t, { displays: [laptop, edge, duplicate] }); await r.coordinator.start();
  r.coordinator.selectDisplay(2); r.coordinator.setEdgeVisible(false);
  assert.equal(r.coordinator.snapshot().edge.displayId, null);
  assert.equal(buildControllerViewModel(r.coordinator.snapshot()).displayValue, 2);
  r.coordinator.selectDisplay(3); assert.equal(buildControllerViewModel(r.coordinator.snapshot()).displayValue, 3);
  r.topology([laptop, edge], 'display-removed'); assert.equal(buildControllerViewModel(r.coordinator.snapshot()).displayValue, 2);
  r.topology([laptop, edge, duplicate]); assert.equal(buildControllerViewModel(r.coordinator.snapshot()).displayValue, '');
  assert.equal(r.edges.length, 1); r.coordinator.selectDisplay(3); r.coordinator.setEdgeVisible(true);
  assert.equal(r.coordinator.snapshot().edge.displayId, 3);
});

test('invalid commands fail closed without changing revision', async t => {
  const r = fixture(t); await r.coordinator.start(); const revision = r.coordinator.snapshot().revision;
  for (const id of ['missing', '', '__proto__', 1]) assert.throws(() => r.coordinator.selectWidget(target(r.coordinator, id)));
  for (const name of ['', ' ', '__proto__', 'constructor', 'prototype', 1]) assert.throws(() => r.coordinator.updateSetting({ ...target(r.coordinator, 'clock'), name, value: 1 }));
  for (const value of [NaN, Infinity, undefined, {}, [], () => 1, 1n]) assert.throws(() => setting(r.coordinator, 'gain', value));
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
  r.coordinator.selectDisplay(2); assert.equal(r.edges.length, 1);
  assert.equal(r.coordinator.snapshot().edge.displayId, 2);
  assert.equal(r.coordinator.snapshot().state.displayPreference.mode, 'manual');
  assert.equal(JSON.stringify(r.coordinator.snapshot().state.displayPreference).includes('"id"'), false);
  r.topology([laptop, edge, { ...edge, id: 3 }], 'display-metrics-changed');
  assert.equal(r.coordinator.snapshot().edge.displayId, 2);
  assert.equal(r.edges.length, 1);
  r.coordinator.selectDisplay(3);
  assert.equal(r.coordinator.snapshot().edge.displayId, 3);
});

test('manual selection loses its session ID on disconnect and reconnect requires a unique fingerprint', async t => {
  const r = fixture(t, { displays: [laptop, edge, { ...edge, id: 3 }] }); await r.coordinator.start();
  r.coordinator.selectDisplay(2);
  assert.equal(r.coordinator.snapshot().edge.displayId, 2);
  r.coordinator.setEdgeVisible(false);
  r.topology([laptop], 'display-removed');
  r.topology([laptop, edge, { ...edge, id: 44 }]);
  r.coordinator.setEdgeVisible(true);
  assert.equal(r.coordinator.snapshot().edge.status, 'ambiguous');
  assert.equal(r.coordinator.getEdgeWindow(), null);
  r.topology([laptop, { ...edge, id: 44 }], 'display-removed');
  assert.equal(r.coordinator.snapshot().edge.displayId, 44);
});

test('saved manual preference cannot resolve identical display fingerprints after startup', async t => {
  const r = fixture(t, { displays: [laptop, edge, { ...edge, id: 3 }], prepare: store => store.update(state => {
    state.displayPreference = { mode: 'manual', fingerprint: { label: 'XENEON Edge', physicalWidth: 720, physicalHeight: 2560 } };
  }) });
  await r.coordinator.start();
  assert.equal(r.coordinator.snapshot().edge.status, 'ambiguous');
  assert.equal(r.edges.length, 0);
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
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: true });
  r.coordinator.selectWidget(target(r.coordinator, 'other'));
  const revision = r.coordinator.getScene().revision;
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: false, message: 'fetch failed' });
  assert.equal(r.coordinator.snapshot().edge.retainedWidgetId, 'clock');
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'failed');
  for (const bad of [{ ...report(r.coordinator), revision: revision - 1, ok: true }, { ...report(r.coordinator), ok: 'yes' }, { ...report(r.coordinator), ok: false, message: {} }]) {
    if (bad.revision === revision - 1) assert.equal(r.coordinator.reportLoadResult(bad).edge.loadStatus, 'failed');
    else assert.throws(() => r.coordinator.reportLoadResult(bad));
  }
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: true });
  assert.equal(r.coordinator.snapshot().edge.loadStatus, 'loaded');
  assert.equal(r.coordinator.snapshot().edge.retainedWidgetId, null);
});

test('load reports update controller status without rebroadcasting an unchanged Edge scene', async t => {
  const r = fixture(t); await r.coordinator.start();
  const edgeCount = r.edges[0].messages.length;
  const controllerCount = r.controllers[0].messages.length;
  r.coordinator.reportLoadResult({ ...report(r.coordinator), ok: true });
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

test('pending activation cannot create a controller once quit starts', async t => {
  let release;
  const serverGate = new Promise(resolve => { release = resolve; });
  const r = fixture(t, { serverGate });
  const activation = r.coordinator.activate();
  const rejected = assert.rejects(activation, /quitting/);
  const quitting = r.coordinator.quit();
  release(); await rejected; await quitting;
  assert.equal(r.controllers.length, 0); assert.equal(r.edges.length, 0);
  assert.equal(r.coordinator.snapshot().state.controllerBounds, null);
  assert.equal(r.server.closed, true);
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
  const r = fixture(t); await r.coordinator.start(); setting(r.coordinator, 'gain', 4);
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
  const r = fixture(t); await r.coordinator.start(); setting(r.coordinator, 'gain', 9);
  await r.coordinator.quit();
  assert.equal(r.controllers[0].destroyed, true); assert.equal(r.edges[0].destroyed, true); assert.equal(r.server.closed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.temp, 'state.json'))).scene.pages[0].widgetSettings.clock.gain, 9);
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(r.screen.listenerCount(event), 0);
  r.edges[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' }); assert.equal(r.edges.length, 1);
});

test('quit still closes server when state flush fails', async t => {
  const r = fixture(t); await r.coordinator.start();
  r.stateStore.flush = async () => { throw new Error('disk failed'); };
  await assert.rejects(r.coordinator.quit(), /disk failed/);
  assert.equal(r.server.closed, true); assert.equal(r.edges[0].destroyed, true);
});
