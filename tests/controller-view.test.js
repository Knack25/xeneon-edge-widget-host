'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { buildControllerViewModel } = require('../controller-view');
const { getSettingDefinitions, getDefaultWidgetSettings } = require('../widget-settings');
const { createController, migrateLegacySettings } = require('../controller');
function snapshot(status = 'active', id = 'com.meloyellowjr.spectrumanalyzer') {
  return { revision: 1, widgets: [{ id, source: 'bundled', iconUrl: '/widgets/icon.svg', manifest: { id, name: '<img onerror=alert(1)>', author: 'Artist', version: '1' } }], displays: [{ id: 8, label: 'Edge', bounds: { width: 2560, height: 720 } }], state: { displayPreference: { mode: 'automatic' }, scene: { visible: true, activePageId: 'first', navigationPosition: 'bottom-right', pages: [{ id: 'first', name: 'First', regions: [{ widgetId: id, settings: {} }] }] } }, edge: { status, displayId: 8, widgetId: id, loadStatus: 'loaded', error: null, retainedWidgetId: null, requestedPageId: 'first', presentedPageId: 'first' } };
}
test('view model preserves manifest text and never substitutes a missing active widget', () => {
  const data = snapshot();
  const model = buildControllerViewModel(data);
  assert.equal(model.widgets[0].name, '<img onerror=alert(1)>');
  assert.equal(Object.hasOwn(model.widgets[0], 'html'), false);
  data.state.scene.pages[0].regions[0].widgetId = 'missing'; data.edge.widgetId = 'missing';
  assert.equal(buildControllerViewModel(data).activeWidget, null);
  assert.equal(buildControllerViewModel(data).activeWidgetId, 'missing');
});
test('view model selects settings by active page ID and exposes page limits and presented page', () => {
  const data = snapshot();
  const first = data.state.scene.pages[0];
  Object.assign(first, { id: 'first', name: 'First', regions: [{ widgetId: 'shared', settings: { gain: 10 } }] });
  data.state.scene.pages.push({ id: 'second', name: 'Second', regions: [{ widgetId: 'shared', settings: { gain: 90 } }] });
  data.state.scene.activePageId = 'second'; data.state.scene.navigationPosition = 'top-center';
  data.edge.presentedPageId = 'first'; data.edge.requestedPageId = 'second'; data.edge.loadStatus = 'failed';
  data.widgets[0].id = 'shared';
  const model = buildControllerViewModel(data);
  assert.equal(model.activePageId, 'second');
  assert.deepEqual(model.settings, { gain: 90 });
  assert.equal(model.navigationPosition, 'top-center');
  assert.equal(model.presentedPageId, 'first');
  assert.equal(model.pages[1].active, true);
  assert.match(model.edge.message, /Second/);
  assert.match(model.edge.message, /First/);
  assert.equal(model.canDeletePage, true);
  data.state.scene.pages = Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, name: `Page ${index}`, regions: [{ widgetId: 'shared', settings: {} }] }));
  assert.equal(buildControllerViewModel(data).canAddPage, false);
});
test('failed requested page with no presented page is explicit in controller status', () => {
  const data = snapshot();
  data.state.scene.pages[0].name = 'Retry sketch';
  data.edge.presentedPageId = null;
  data.edge.loadStatus = 'failed';
  const message = buildControllerViewModel(data).edge.message;
  assert.match(message, /Requested Retry sketch/);
  assert.match(message, /no page (is )?(currently )?shown/i);
});
test('edge topology and load failure are both visible including retained content', () => {
  assert.equal(buildControllerViewModel(snapshot('disconnected')).edge.message, 'Edge disconnected');
  assert.equal(buildControllerViewModel(snapshot('ambiguous')).edge.actionDisabled, true);
  assert.equal(buildControllerViewModel(snapshot('hidden')).edge.message, 'Edge hidden');
  const data = snapshot(); data.edge.loadStatus = 'failed'; data.edge.error = 'Fetch failed'; data.edge.retainedWidgetId = 'previous';
  assert.match(buildControllerViewModel(data).edge.message, /Fetch failed/);
  assert.match(buildControllerViewModel(data).edge.message, /previous/i);
  data.edge.status = 'hidden';
  assert.match(buildControllerViewModel(data).edge.message, /Fetch failed/);
});
test('shared settings preserve shim defaults and expose Clock and Doodle controls', () => {
  assert.equal(getDefaultWidgetSettings({ id: 'com.meloyellowjr.vumeter' }).needleDamping, 95);
  assert.equal(getDefaultWidgetSettings({ id: 'com.meloyellowjr.spectrumanalyzer' }).smoothing, 75);
  assert.equal(getDefaultWidgetSettings({ id: 'com.corsair.airquality' }).weatherLocation, 5368361);
  assert.equal(getDefaultWidgetSettings({ id: 'com.corsair.widget.doodle-pad' }).backgroundColor, '#4b4b4b');
  assert.equal(getDefaultWidgetSettings({ id: 'com.shocksim.robextourbillon' }).showSeconds, true);
  assert.ok(getSettingDefinitions({ id: 'com.shocksim.robextourbillon' }).some(def => def.name === 'showSeconds' && def.type === 'checkbox'));
  assert.ok(getSettingDefinitions({ id: 'com.corsair.widget.doodle-pad' }).some(def => def.name === 'color1' && def.type === 'color'));
  const defaults = getDefaultWidgetSettings({ id: 'x' }); defaults.textColor = 'changed';
  assert.equal(getDefaultWidgetSettings({ id: 'x' }).textColor, '#ffffff');
});
test('shared modules expose browser APIs with require unavailable', () => {
  const context = vm.createContext({});
  for (const file of ['controller-view.js', 'widget-settings.js']) vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
  assert.equal(typeof context.ICUEControllerView.buildControllerViewModel, 'function');
  assert.equal(typeof context.ICUEWidgetSettings.getDefaultWidgetSettings, 'function');
});
test('legacy storage is removed only after successful IPC and failure remains retryable', async () => {
  const storage = { value: '{"w":{"gain":4}}', getItem() { return this.value; }, removeItem() { this.value = null; } };
  await assert.rejects(migrateLegacySettings(storage, { submitLegacySettings: async () => { throw Error('IPC failed'); } }), /IPC failed/);
  assert.ok(storage.value);
  await migrateLegacySettings(storage, { submitLegacySettings: async data => { assert.deepEqual(data, { w: { gain: 4 } }); return false; } });
  assert.equal(storage.value, null);
  storage.value = '{bad';
  await assert.rejects(migrateLegacySettings(storage, { submitLegacySettings: async () => assert.fail('must not invoke') }));
  assert.equal(storage.value, '{bad');
});
// Native DOM and IPC are the only boundaries substituted; real renderer handlers run.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.open = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); }
  dispatch(event) { for (const fn of this.listeners[event] || []) fn({ preventDefault() {} }); }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
}
function setup(overrides = {}) {
  const elements = new Map();
  const document = { activeElement: null, createElement: tag => new Element(tag), getElementById: id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); } };
  const calls = [];
  let receive;
  const bridge = { nativeControls: true, getState: async () => snapshot(), onState: fn => { receive = fn; return () => {}; }, updateSetting: async (...args) => { calls.push(['setting', ...args]); }, selectWidget: async () => {}, selectDisplay: async id => calls.push(['display', id]), setEdgeVisible: async () => {}, rescanWidgets: async () => {}, importWidget: async () => ({ status: 'confirmation-required', token: 'token', installed: { name: '<b>old</b>', version: '1' }, incoming: { name: 'new', version: '2' } }), cancelImport: async token => calls.push(['cancel', token]), confirmImport: async token => calls.push(['confirm', token]), ...overrides };
  const controller = createController({ document, bridge, storage: { getItem: () => null } });
  return { controller, document, elements, calls, receive: data => receive(data) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('range sends every input and snapshots preserve focused settings nodes and search', async () => {
  const fixture = setup(); await fixture.controller.start();
  const settings = fixture.elements.get('settings');
  const range = settings.children.find(row => row.children[1]?.dataset.setting === 'inputGain').children[1];
  fixture.document.activeElement = range; range.value = '120'; range.dispatch('input'); range.value = '125'; range.dispatch('input');
  fixture.elements.get('search').value = 'spect';
  const data = snapshot(); data.state.scene.pages[0].regions[0].settings.inputGain = 120; fixture.receive(data);
  assert.equal(settings.children.find(row => row.children[1]?.dataset.setting === 'inputGain').children[1], range);
  assert.equal(range.value, '125');
  assert.equal(fixture.elements.get('search').value, 'spect');
  assert.deepEqual(fixture.calls, [['setting', { pageId: 'first', widgetId: 'com.meloyellowjr.spectrumanalyzer', name: 'inputGain', value: 120 }], ['setting', { pageId: 'first', widgetId: 'com.meloyellowjr.spectrumanalyzer', name: 'inputGain', value: 125 }]]);
});
test('display IDs stay numeric and ambiguity disables Show without disabling picker', async () => {
  const fixture = setup(); await fixture.controller.start(); fixture.receive(snapshot('ambiguous'));
  assert.equal(fixture.elements.get('visibility').disabled, true);
  const picker = fixture.elements.get('display'); assert.equal(picker.disabled, false);
  picker.value = '8'; picker.dispatch('change'); picker.value = 'automatic'; picker.dispatch('change'); await settle();
  assert.deepEqual(fixture.calls, [['display', 8], ['display', 'automatic']]);
});
test('replacement metadata is text and native cancel or close disposes the token once', async () => {
  const fixture = setup(); await fixture.controller.start();
  fixture.elements.get('import').dispatch('click'); await settle();
  assert.equal(fixture.elements.get('replacement').open, true);
  assert.match(fixture.elements.get('replacement-detail').textContent, /<b>old<\/b>/);
  fixture.elements.get('replacement').dispatch('cancel'); await settle();
  assert.deepEqual(fixture.calls, [['cancel', 'token']]);
  fixture.elements.get('import').dispatch('click'); await settle(); fixture.elements.get('replacement').close(); await settle();
  assert.deepEqual(fixture.calls, [['cancel', 'token'], ['cancel', 'token']]);
});
test('command failures are visible and leave the controller usable', async () => {
  const fixture = setup({ rescanWidgets: async () => { throw Error('Scan failed'); } }); await fixture.controller.start();
  fixture.elements.get('rescan').dispatch('click'); await settle();
  assert.match(fixture.elements.get('error').textContent, /Scan failed/);
  assert.equal(fixture.elements.get('import').disabled, false);
});
test('a rescan removing the selected widget disables its settings without changing selection', async () => {
  const fixture = setup(); await fixture.controller.start();
  const data = snapshot(); data.widgets = []; fixture.receive(data);
  assert.match(fixture.elements.get('settings').children[0].textContent, /unavailable/);
  assert.match(fixture.elements.get('widget-title').textContent, /com.meloyellowjr.spectrumanalyzer/);
  fixture.receive(snapshot());
  assert.ok(fixture.elements.get('settings').children.some(row => row.children[1]?.dataset.setting === 'inputGain'));
});
test('confirm replacement consumes token once and does not also cancel it', async () => {
  const fixture = setup(); await fixture.controller.start();
  fixture.elements.get('import').dispatch('click'); await settle();
  fixture.elements.get('replacement-confirm').dispatch('click'); await settle();
  fixture.elements.get('replacement-confirm').dispatch('click'); await settle();
  assert.deepEqual(fixture.calls, [['confirm', 'token']]);
  assert.equal(fixture.elements.get('replacement').open, false);
});
test('optional malformed manifest metadata cannot break the controller', async () => {
  const fixture = setup(); await fixture.controller.start();
  const data = snapshot(); Object.assign(data.widgets[0].manifest, { os: [null, 'bad', { platform: 'mac' }], supported_devices: 'bad', required_plugins: { bad: true } });
  assert.doesNotThrow(() => fixture.receive(data));
  assert.equal(fixture.elements.get('rescan').disabled, false);
});

test('interactive metadata displays Yes only for the boolean true', async () => {
  const f = setup(); await f.controller.start();
  for (const [value, expected] of [['false', 'No'], [1, 'No'], [false, 'No'], [true, 'Yes']]) {
    const data = snapshot(); data.widgets[0].manifest.interactive = value; f.receive(data);
    assert.equal(f.elements.get('metadata').children.find(row => row.children[0].textContent === 'Interactive: ').children[1].textContent, expected);
  }
});

test('controller visibly reports recovered state independently of Edge status without a filesystem path', async () => {
  const f = setup(); await f.controller.start();
  const data = snapshot('hidden'); data.recovery = { status: 'recovered', reason: 'invalid-state' }; f.receive(data);
  assert.match(f.elements.get('status').textContent, /State recovered from invalid persisted data/);
  assert.match(f.elements.get('status').textContent, /Edge hidden/);
});

test('hidden controller picker shows the connected selected target even without an Edge window', async () => {
  const f = setup(); await f.controller.start();
  const data = snapshot('hidden'); data.state.scene.visible = false; data.state.displayPreference.mode = 'manual'; data.edge.displayId = null; data.selectedTargetDisplayId = 8;
  f.receive(data); assert.equal(f.elements.get('display').value, '8');
  assert.ok(f.elements.get('display').children.every(option => !/unavailable/.test(option.textContent)));
  data.selectedTargetDisplayId = null; f.receive(data); assert.equal(f.elements.get('display').value, '');
  assert.ok(f.elements.get('display').children.some(option => /unavailable/.test(option.textContent)));
});
