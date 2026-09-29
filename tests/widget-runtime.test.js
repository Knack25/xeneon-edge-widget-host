'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createWidgetRuntime, buildWidgetShell, buildShimScript } = require('../widget-runtime');
const { createEdge } = require('../edge');
const clock = { id: 'com.shocksim.robextourbillon', baseUrl: '/widgets/clock', entryUrl: '/widgets/clock/index.html', manifest: { id: 'com.shocksim.robextourbillon', name: 'Clock' } };
const doodle = { id: 'com.corsair.widget.doodle-pad', baseUrl: '/managed-widgets/doodle', entryUrl: '/managed-widgets/doodle/index.html', manifest: { id: 'com.corsair.widget.doodle-pad', name: 'Doodle' } };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
test('Doodle toolbar survives focus restoration but hides when the document becomes hidden', () => {
  const html = fs.readFileSync(require.resolve('../widgets/Doodle Pad-1/index.html'), 'utf8');
  const elements = new Map(['toolbar', 'toolbarHandle'].map(id => {
    const classes = new Set();
    return [id, { classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } }];
  }));
  const windowEvents = new Map();
  const documentEvents = new Map();
  const document = { hidden: false, getElementById: id => elements.get(id), addEventListener: (name, fn) => documentEvents.set(name, fn) };
  const context = vm.createContext({ document, window: { addEventListener: (name, fn) => windowEvents.set(name, fn) }, clearTimeout, flushPendingSave() {} });
  const toolbarCode = html.slice(html.indexOf('    function showToolbar()'), html.indexOf('    // --- Color buttons ---'));
  const lifecycleStart = html.search(/    \/\/ --- (?:Hide panel on focus loss|Document lifecycle) ---/);
  assert.notEqual(lifecycleStart, -1);
  const lifecycleCode = html.slice(lifecycleStart, html.indexOf('    // --- Init ---'));
  vm.runInContext('let toolbarTimeout = null; let toolbarVisible = true;\n' + toolbarCode + lifecycleCode + '\nshowToolbar();', context);
  windowEvents.get('blur')?.({ type: 'blur' });
  assert.equal(elements.get('toolbar').classList.contains('visible'), true);
  assert.equal(elements.get('toolbarHandle').classList.contains('hidden'), true);
  document.hidden = true;
  documentEvents.get('visibilitychange')();
  assert.equal(elements.get('toolbar').classList.contains('visible'), false);
  assert.equal(elements.get('toolbarHandle').classList.contains('hidden'), false);
});
// Substitute native frame navigation only. Runtime controls srcdoc, staging,
// settings, frame ownership and listener disposal; tests decide navigation order.
function fixture(options = {}) {
  const frames = []; const reports = [];
  const region = { children: [], append(frame) { this.children.push(frame); frame.parent = this; } };
  const document = { baseURI: 'http://127.0.0.1:8080/edge.html', getElementById: () => region, createElement(tag) {
    assert.equal(tag, 'iframe');
    const events = new Map();
    const frame = { dataset: {}, style: {}, contentWindow: {}, setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { (events.get(name) || events.set(name, new Set()).get(name)).add(fn); }, removeEventListener(name, fn) { events.get(name)?.delete(fn); }, dispatch(name) { for (const fn of [...(events.get(name) || [])]) fn(); }, remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.removed = true; }, finish(failure) {
      const match = this.srcdoc.match(/<script>([\s\S]*?)<\/script>/);
      const listeners = {};
      this.contentWindow = { addEventListener(name, fn) { listeners[name] = fn; }, console, setTimeout, Promise };
      this.contentWindow.window = this.contentWindow;
      vm.runInNewContext(match[1], this.contentWindow);
      if (failure) listeners.error({ message: failure });
      this.dispatch('load');
      this.failScript = message => listeners.error({ message });
    }, listenerCount() { return [...events.values()].reduce((n, set) => n + set.size, 0); } };
    frames.push(frame); return frame;
  } };
  const runtime = createWidgetRuntime({ document, fetchText: async () => '<html><head></head><body>Widget</body></html>', report: value => reports.push(value), ...options });
  return { runtime, frames, region, reports, document, live: () => region.children.find(frame => frame.dataset.live === 'true'), async load(widget = clock, revision = 1, settings = {}) { const result = runtime.load({ widget, revision, settings }); await settle(); frames.at(-1).finish(); return result; } };
}
test('Doodle frame receives its stable page ID without changing other widget identities', async () => {
  const a = fixture({ pageId: 'page-a' });
  await a.load(doodle);
  assert.equal(a.live().contentWindow.icuePageId, 'page-a');
  assert.equal(a.live().contentWindow.uniqueId, doodle.id);
  const b = fixture({ pageId: 'page-b' });
  await b.load(doodle);
  assert.equal(b.live().contentWindow.icuePageId, 'page-b');
  const other = fixture({ pageId: 'page-c' });
  await other.load(clock);
  assert.equal(other.live().contentWindow.icuePageId, undefined);
  assert.equal(other.live().contentWindow.uniqueId, clock.id);
});

test('Edge forwards scene page identity through its real widget runtime factory', async () => {
  const f = fixture();
  let runtime;
  const edge = createEdge({ document: f.document,
    bridge: { onScene: () => () => {}, getScene: async () => null },
    sceneRuntimeFactory: ({ createRuntime }) => {
      runtime = createRuntime({ container: f.region, pageId: 'edge-page', report: () => {} });
      return { receive() {}, destroy() { runtime.destroy(); } };
    }, fetchText: async () => '<html><head></head><body>Doodle</body></html>' });
  await edge.start();
  const loading = runtime.load({ widget: doodle, settings: {}, revision: 1 });
  await settle(); f.frames.at(-1).finish(); await loading;
  assert.equal(f.frames.at(-1).contentWindow.icuePageId, 'edge-page');
  edge.dispose();
});

test('Doodle migrates the legacy drawing once and restores separate page canvases', () => {
  const html = fs.readFileSync(require.resolve('../widgets/Doodle Pad-1/index.html'), 'utf8');
  const code = html.slice(html.indexOf('    // --- Persistence ---'), html.indexOf('    // --- Toolbar ---'));
  const entries = new Map([[doodle.id, JSON.stringify({ canvasData: 'legacy-drawing', canvasWidth: 20, canvasHeight: 20 })]]);
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  function page(pageId) {
    const drawn = [];
    const context = { window: null, addEventListener() {}, localStorage: storage, Image: class { set src(value) { this.source = value; this.onload(); } },
      canvas: { width: 20, height: 20 }, ctx: { clearRect() {}, drawImage(image) { drawn.push(image.source); } },
      normalizeHistoryStack: () => [], updateUndoRedoButtons() {}, normalizeToolState: () => ({ currentColorIndex: 0, currentBrushSize: 2, isEraser: false, toolbarVisible: true }),
      applyToolSelectionUI() {}, console, setTimeout, clearTimeout };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(buildShimScript(doodle, {}, pageId), context);
    vm.runInContext(code, context);
    return { context, read: () => vm.runInContext('readStoredState()', context),
      write: data => { context.dataToSave = data; return vm.runInContext('writeStoredState(dataToSave)', context); },
      load: () => vm.runInContext('loadFromStorage()', context), drawn };
  }
  const first = page('page-a');
  first.load();
  assert.deepEqual(first.drawn, ['legacy-drawing']);
  assert.equal(first.read().canvasData, 'legacy-drawing');
  assert.equal(entries.get(doodle.id + ':legacy-page'), 'page-a');
  assert.equal(JSON.parse(entries.get(doodle.id + ':page:page-a')).canvasData, 'legacy-drawing');
  const second = page('page-b');
  second.load();
  assert.deepEqual(second.drawn, []);
  assert.equal(second.write({ canvasData: 'second-drawing' }), true);
  assert.equal(first.write({ canvasData: 'first-drawing' }), true);
  const reopenedFirst = page('page-a'); reopenedFirst.load();
  const reopenedSecond = page('page-b'); reopenedSecond.load();
  assert.deepEqual(reopenedFirst.drawn, ['first-drawing']);
  assert.deepEqual(reopenedSecond.drawn, ['second-drawing']);
  assert.equal(JSON.parse(entries.get(doodle.id)).canvasData, 'legacy-drawing');
});

test('Doodle retains legacy bytes when a migration storage write fails and retries for the claimant', () => {
  const html = fs.readFileSync(require.resolve('../widgets/Doodle Pad-1/index.html'), 'utf8');
  const code = html.slice(html.indexOf('    // --- Persistence ---'), html.indexOf('    // --- Toolbar ---'));
  const original = JSON.stringify({ canvasData: 'legacy-drawing' });
  const entries = new Map([[doodle.id, original]]);
  let blockedKey = doodle.id + ':page:page-a';
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { if (key === blockedKey) throw Error('quota'); entries.set(key, value); } };
  function read(pageId) {
    const context = { window: null, addEventListener() {}, localStorage: storage, console };
    context.window = context; vm.createContext(context);
    vm.runInContext(buildShimScript(doodle, {}, pageId), context);
    vm.runInContext(code, context);
    return vm.runInContext('readStoredState()', context);
  }
  assert.equal(read('page-a').canvasData, 'legacy-drawing');
  assert.equal(entries.get(doodle.id), original);
  assert.equal(entries.get(doodle.id + ':legacy-page'), 'page-a');
  assert.equal(read('page-b'), null);
  blockedKey = null;
  assert.equal(read('page-a').canvasData, 'legacy-drawing');
  assert.equal(entries.get(doodle.id + ':page:page-a'), original);
});

test('Doodle keeps the shared drawing readable when the ownership marker cannot be saved', () => {
  const html = fs.readFileSync(require.resolve('../widgets/Doodle Pad-1/index.html'), 'utf8');
  const code = html.slice(html.indexOf('    // --- Persistence ---'), html.indexOf('    // --- Toolbar ---'));
  const original = JSON.stringify({ canvasData: 'legacy-drawing' });
  const entries = new Map([[doodle.id, original]]);
  const context = { window: null, addEventListener() {}, console,
    localStorage: { getItem: key => entries.get(key) ?? null, setItem: (key, value) => {
      if (key === doodle.id + ':legacy-page') throw Error('quota'); entries.set(key, value);
    } } };
  context.window = context; vm.createContext(context);
  vm.runInContext(buildShimScript(doodle, {}, 'page-a'), context);
  vm.runInContext(code, context);
  assert.equal(vm.runInContext('readStoredState()', context).canvasData, 'legacy-drawing');
  assert.equal(entries.get(doodle.id), original);
  assert.equal(entries.has(doodle.id + ':page:page-a'), false);
});
test('successful staging promotes one frame and settings notify its initialized shim', async () => {
  const f = fixture(); assert.deepEqual(await f.load(), { stale: false, ok: true }); const frame = f.live(); let updates = 0;
  frame.contentWindow.icueEvents.onDataUpdated = () => updates++;
  await f.runtime.updateSettings({ revision: 2, settings: { showSeconds: false, widgetId: 'spoofed' } });
  assert.equal(frame.contentWindow.showSeconds, false); assert.equal(updates, 1);
  assert.equal(frame.contentWindow.widgetId, clock.id); assert.equal(frame.contentWindow.uniqueId, clock.id);
  assert.deepEqual(f.reports.at(-1), { revision: 2, ok: true });
  await f.load(doodle, 3); assert.equal(f.region.children.length, 1); assert.ok(frame.removed); assert.equal(f.live().dataset.widgetId, doodle.id);
});
test('explicit runtime container owns its frames without touching the primary region', async () => {
  const child = { children: [], append(frame) { this.children.push(frame); frame.parent = this; } };
  const f = fixture({ container: child });
  assert.deepEqual(await f.load(), { stale: false, ok: true });
  assert.equal(f.region.children.length, 0); assert.equal(child.children.length, 1);
  f.runtime.destroy(); assert.equal(child.children.length, 0);
});
test('fetch and shell failure retain the previous live frame and report current failure', async () => {
  let fail = false; const f = fixture({ fetchText: async () => { if (fail) throw Error('missing'); return '<head></head>'; } });
  await f.load(); const previous = f.live(); fail = true;
  assert.deepEqual(await f.runtime.load({ widget: doodle, revision: 2, settings: {} }), { stale: false, ok: false, message: 'missing' });
  assert.equal(f.live(), previous); assert.equal(f.region.children.length, 1); assert.deepEqual(f.reports.at(-1), { revision: 2, ok: false, message: 'missing' });
  fail = false;
  assert.equal((await f.runtime.load({ widget: { ...doodle, baseUrl: 'http://[' }, revision: 3, settings: {} })).ok, false);
  assert.equal(f.live(), previous);
});
test('preparation failure resolves with a structured result and preserves failure reporting', async () => {
  const f = fixture({ fetchText: async () => { throw Error('missing asset'); } });
  assert.deepEqual(await f.runtime.load({ widget: doodle, revision: 8, settings: {} }),
    { stale: false, ok: false, message: 'missing asset' });
  assert.deepEqual(f.reports.at(-1), { revision: 8, ok: false, message: 'missing asset' });
});
test('obsolete fetch and frame navigation never promote or report success', async () => {
  const slow = deferred(); const f = fixture({ fetchText: url => url === clock.entryUrl ? slow.promise : Promise.resolve('<head></head>') });
  const older = f.runtime.load({ widget: clock, revision: 1, settings: {} });
  const newer = f.runtime.load({ widget: doodle, revision: 2, settings: {} }); await settle(); f.frames.at(-1).finish(); await newer;
  slow.resolve('<head></head>'); assert.deepEqual(await older, { stale: true }); await settle();
  assert.equal(f.live().dataset.widgetId, doodle.id); assert.deepEqual(f.reports, [{ revision: 2, ok: true }]); assert.ok(f.frames[0].removed);
  const staged = f.runtime.load({ widget: doodle, revision: 3, settings: {} }); await settle(); const abandoned = f.frames.at(-1);
  const final = f.runtime.load({ widget: doodle, revision: 4, settings: {} }); await settle(); f.frames.at(-1).finish(); await final; abandoned.dispatch('load');
  assert.deepEqual(await staged, { stale: true }); assert.ok(abandoned.removed); assert.equal(abandoned.listenerCount(), 0);
});
test('settings during fetch and frame wait reach the promoted widget at latest revision', async () => {
  const pending = deferred(); const f = fixture({ fetchText: () => pending.promise });
  const load = f.runtime.load({ widget: clock, revision: 1, settings: {} });
  await f.runtime.updateSettings({ revision: 2, settings: { showSeconds: false } }); pending.resolve('<head></head>'); await settle();
  await f.runtime.updateSettings({ revision: 3, settings: { showSeconds: true, transparency: 29 } });
  f.frames[0].finish(); await load; assert.equal(f.live().contentWindow.transparency, 29); assert.equal(f.live().contentWindow.showSeconds, true);
  assert.deepEqual(f.reports, [{ revision: 3, ok: true }]);
});

test('preparation deadline includes stalled fetch and initial async settings and reports latest pending revision', async t => {
  const blocked = deferred(); let blockFetch = false;
  const f = fixture({ frameLoadTimeoutMs: 30, fetchText: () => blockFetch ? blocked.promise : Promise.resolve('<head></head>') });
  t.after(() => f.runtime.destroy());
  await f.load(); const previous = f.live(); blockFetch = true;
  const watchdog = () => new Promise((_, reject) => setTimeout(() => reject(Error('preparation failed to enforce its deadline')), 150));
  assert.deepEqual(await Promise.race([f.runtime.load({ widget: doodle, revision: 2 }), watchdog()]), { stale: false, ok: false, message: 'Widget preparation timed out.' });
  assert.equal(f.live(), previous); blocked.resolve('<head></head>'); blockFetch = false;
  const loading = f.runtime.load({ widget: doodle, revision: 3, settings: { transparency: 22 } });
  const failure = Promise.race([loading, watchdog()]); await settle(); const staged = f.frames.at(-1); staged.finish();
  staged.contentWindow.icueEvents.onDataUpdated = () => new Promise(() => {});
  await settle(); await f.runtime.updateSettings({ revision: 4, settings: { transparency: 33 } });
  assert.deepEqual(await failure, { stale: false, ok: false, message: 'Widget preparation timed out.' });
  assert.equal(f.live(), previous); assert.equal(f.region.children.length, 1); assert.equal(staged.listenerCount(), 0);
  assert.equal(f.reports.at(-1).revision, 4); assert.equal(f.reports.at(-1).ok, false);
  await f.runtime.updateSettings({ revision: 5, settings: { transparency: 44 } });
  assert.equal(f.reports.at(-1).revision, 5); assert.equal(previous.contentWindow.transparency, 80); f.runtime.destroy();
});

test('initial settings can advance to the latest revision and cancelled preparation cannot report a stale deadline or failure', async () => {
  const f = fixture({ frameLoadTimeoutMs: 60 }); await f.load(); const pending = deferred();
  const loading = f.runtime.load({ widget: doodle, revision: 2, settings: { transparency: 22 } }); await settle(); const staged = f.frames.at(-1); staged.finish();
  let calls = 0; staged.contentWindow.icueEvents.onDataUpdated = () => ++calls === 1 ? pending.promise : Promise.resolve();
  await settle(); await f.runtime.updateSettings({ revision: 3, settings: { transparency: 33 } }); pending.reject(Error('obsolete initial callback'));
  await loading; assert.equal(f.live(), staged); assert.equal(staged.contentWindow.transparency, 33); assert.deepEqual(f.reports.at(-1), { revision: 3, ok: true });
  const staleCallback = deferred(); const abandoned = f.runtime.load({ widget: clock, revision: 4 }); await settle(); const old = f.frames.at(-1); old.finish();
  old.contentWindow.icueEvents.onDataUpdated = () => staleCallback.promise; await settle();
  await f.load(doodle, 5); assert.deepEqual(await abandoned, { stale: true }); staleCallback.reject(Error('cancelled callback'));
  await new Promise(resolve => setTimeout(resolve, 70)); assert.ok(old.removed); assert.equal(old.listenerCount(), 0);
  assert.ok(f.reports.every(report => report.revision !== 4)); assert.deepEqual(f.reports.at(-1), { revision: 5, ok: true }); f.runtime.destroy();
});
test('frame failure, timeout and destroy dispose staged frames without losing live content', async () => {
  const f = fixture({ frameLoadTimeoutMs: 15 }); await f.load(); const previous = f.live();
  const failed = f.runtime.load({ widget: doodle, revision: 2, settings: {} }); await settle(); f.frames.at(-1).dispatch('error'); assert.equal((await failed).ok, false); assert.equal(f.live(), previous);
  assert.deepEqual(await f.runtime.load({ widget: doodle, revision: 3, settings: {} }), { stale: false, ok: false, message: 'Widget preparation timed out.' }); assert.equal(f.region.children.length, 1);
  const pending = f.runtime.load({ widget: doodle, revision: 4, settings: {} }); await settle(); f.runtime.destroy(); assert.deepEqual(await pending, { stale: true }); assert.equal(f.region.children.length, 0);
  assert.ok(f.frames.every(frame => frame.listenerCount() === 0));
});
test('observable script failures block promotion and later errors report current revision', async () => {
  const f = fixture(); await f.load(); const previous = f.live();
  const bad = f.runtime.load({ widget: doodle, revision: 2, settings: {} }); await settle(); f.frames.at(-1).finish('broken script'); assert.deepEqual(await bad, { stale: false, ok: false, message: 'broken script' });
  assert.equal(f.live(), previous); assert.equal(f.reports.at(-1).ok, false);
  await f.load(clock, 3); await f.runtime.updateSettings({ revision: 4, settings: {} }); f.live().failScript('later failure'); await settle();
  assert.deepEqual(f.reports.at(-1), { revision: 4, ok: false, message: 'later failure' });
});
test('settings callback and report rejections are contained and do not report false success', async () => {
  const seen = []; const f = fixture({ report: async value => { seen.push(value); throw Error('stale IPC'); } }); await f.load();
  f.live().contentWindow.icueEvents.onDataUpdated = () => { throw Error('bad update'); };
  await assert.rejects(f.runtime.updateSettings({ revision: 2, settings: {} }), /bad update/);
  await settle(); assert.deepEqual(seen.at(-1), { revision: 2, ok: false, message: 'bad update' });
});
test('asynchronous settings errors are contained and obsolete settings failures cannot overwrite newer success', async () => {
  const f = fixture(); await f.load(); const result = deferred();
  f.live().contentWindow.icueEvents.onDataUpdated = () => result.promise;
  const older = f.runtime.updateSettings({ revision: 2, settings: { transparency: 22 } });
  f.live().contentWindow.icueEvents.onDataUpdated = () => Promise.resolve();
  await f.runtime.updateSettings({ revision: 3, settings: { transparency: 33 } });
  result.reject(Error('obsolete settings failure')); await older;
  assert.equal(f.live().contentWindow.transparency, 33); assert.equal(f.reports.at(-1).revision, 3); assert.ok(f.reports.every(report => report.ok));
  f.live().contentWindow.icueEvents.onDataUpdated = () => Promise.reject(Error('async update failed'));
  await assert.rejects(f.runtime.updateSettings({ revision: 4, settings: {} }), /async update failed/);
  assert.deepEqual(f.reports.at(-1), { revision: 4, ok: false, message: 'async update failed' });
});
test('later settings recover a live widget after a transient callback throw or rejection', async () => {
  for (const fail of [() => { throw Error('transient update'); }, () => Promise.reject(Error('transient update'))]) {
    const f = fixture(); await f.load(); const live = f.live();
    live.contentWindow.icueEvents.onDataUpdated = fail;
    await assert.rejects(f.runtime.updateSettings({ revision: 2, settings: { transparency: 22 } }), /transient update/);
    let updatedValue;
    live.contentWindow.icueEvents.onDataUpdated = () => { updatedValue = live.contentWindow.transparency; return Promise.resolve(); };
    await f.runtime.updateSettings({ revision: 3, settings: { transparency: 33 } });
    assert.equal(f.live(), live); assert.equal(f.frames.length, 1); assert.equal(updatedValue, 33);
    assert.deepEqual(f.reports.at(-1), { revision: 3, ok: true });
    await f.runtime.updateSettings({ revision: 4, settings: { transparency: 44 } });
    assert.equal(updatedValue, 44); assert.deepEqual(f.reports.at(-1), { revision: 4, ok: true });
    f.runtime.destroy();
  }
});
test('settings after failed replacement still withhold requested properties from retained content', async () => {
  let fail = false; const f = fixture({ fetchText: async () => { if (fail) throw Error('replacement failed'); return '<head></head>'; } });
  await f.load(); const previous = f.live(); fail = true;
  assert.deepEqual(await f.runtime.load({ widget: doodle, revision: 2, settings: { transparency: 22 } }), { stale: false, ok: false, message: 'replacement failed' });
  await f.runtime.updateSettings({ revision: 3, settings: { transparency: 33 } });
  assert.equal(f.live(), previous); assert.equal(previous.contentWindow.transparency, 80);
  assert.deepEqual(f.reports.at(-1), { revision: 3, ok: false, message: 'replacement failed' });
  const missing = fixture(); assert.deepEqual(await missing.runtime.load({ widget: null, revision: 1 }), { stale: false, ok: false, message: 'Selected widget is missing from the catalog.' });
  assert.deepEqual(await missing.runtime.updateSettings({ revision: 2, settings: {} }), { failed: true });
  assert.deepEqual(missing.reports.at(-1), { revision: 2, ok: false, message: 'Selected widget is missing from the catalog.' });
});
test('old failures and destroyed fetches dispose without reporting obsolete status', async () => {
  const slow = deferred(); const f = fixture({ fetchText: url => url === clock.entryUrl ? slow.promise : Promise.resolve('<head></head>') });
  const older = f.runtime.load({ widget: clock, revision: 1, settings: {} }); await f.load(doodle, 2);
  slow.reject(Error('old fetch failure')); await older; await settle(); assert.deepEqual(f.reports, [{ revision: 2, ok: true }]);
  const pending = deferred(); const other = fixture({ fetchText: () => pending.promise }); const loading = other.runtime.load({ widget: clock, revision: 1 });
  other.runtime.destroy(); assert.deepEqual(await loading, { stale: true }); pending.reject(Error('after destruction')); await settle(); assert.deepEqual(other.reports, []); assert.ok(other.frames[0].removed);
});
test('shell keeps relative assets under catalog base and initializes legacy sensors and translation', async () => {
  const shell = buildWidgetShell(doodle, '<HEAD><link href="style.css"></HEAD><script src="app.js"></script>', { color1: '</script>' }, 'http://127.0.0.1:8080/edge.html');
  assert.match(shell, /<base href="http:\/\/127.0.0.1:8080\/managed-widgets\/doodle\/">/); assert.match(shell, /src="app.js"/);
  assert.equal(new URL('app.js', shell.match(/<base href="([^"]+)"/)[1]).href, 'http://127.0.0.1:8080/managed-widgets/doodle/app.js');
  const window = { addEventListener() {} }; window.window = window;
  vm.runInNewContext(buildShimScript(doodle, { color1: '</script>' }), { window, setTimeout, console, Promise });
  assert.equal(window.iCUE_initialized, true); assert.equal(window.pluginSensorsdataprovider_initialized, true); assert.equal(window.color1, '</script>'); assert.equal(window.backgroundColor, '#4b4b4b'); assert.equal(await window.tr(42), '42');
  const values = []; const sensor = window.plugins.Sensorsdataprovider; sensor.asyncResponse.connect((...args) => values.push(args)); sensor.getSensorValue('value', 'right'); sensor.getSensorUnits('unit'); await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(values, [['value', 57], ['unit', '%']]); assert.equal(sensor.getDefaultSensorIdBlock('load'), 'left');
});
function snapshot(revision, widget = clock, catalogRevision = 0, settings = {}) { return { revision, widget, catalogRevision,
  pageWidgets: { A: widget }, pageGenerations: { A: catalogRevision + 1 },
  scene: { activePageId: 'A', pages: [{ id: 'A', regions: [{ widgetId: widget?.id || 'missing', settings }] }] } }; }
test('Edge subscribes before querying and only forwards the freshest scene to its manager', async () => {
  let receive, unsubscribed = false; const initial = deferred(); const snapshots = [];
  const sceneRuntime = { receive(value) { snapshots.push(value); return Promise.resolve(); }, destroy() { this.destroyed = true; } };
  const edge = createEdge({ sceneRuntime, bridge: { onScene(fn) { receive = fn; return () => { unsubscribed = true; }; }, getScene: () => initial.promise } });
  const start = edge.start(); receive(snapshot(2, clock, 0, { transparency: 22 })); await settle();
  initial.resolve(snapshot(1)); await start;
  receive(snapshot(3, clock, 0, { transparency: 33 })); await settle();
  assert.deepEqual(snapshots.map(value => value.revision), [2, 3]);
  edge.dispose(); assert.equal(unsubscribed, true); assert.equal(sceneRuntime.destroyed, true);
  receive(snapshot(4)); await settle(); assert.equal(snapshots.length, 2);
});
test('missing widget remains a scene-manager concern and Edge has no controller overlay', async () => {
  const snapshots = []; const edge = createEdge({ sceneRuntime: { receive(value) { snapshots.push(value); }, destroy() {} },
    bridge: { getScene: async () => snapshot(1, null), onScene() { return () => {}; } } });
  await edge.start(); await settle(); assert.equal(snapshots[0].pageWidgets.A, null);
  const html = fs.readFileSync(require.resolve('../edge.html'), 'utf8'); assert.doesNotMatch(html, /<button|toolbar|id="status"|Escape/); edge.dispose();
});
test('runtime and Edge load in browser without CommonJS or an Escape listener', () => {
  const events = []; const context = vm.createContext({ addEventListener: name => events.push(name) });
  for (const file of ['widget-settings.js', 'widget-runtime.js', 'scene-runtime.js', 'edge.js']) vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
  assert.equal(typeof context.ICUEWidgetRuntime.createWidgetRuntime, 'function'); assert.equal(typeof context.ICUESceneRuntime.createSceneRuntime, 'function');
  assert.equal(typeof context.ICUEEdge.createEdge, 'function'); assert.deepEqual(events, []);
});
