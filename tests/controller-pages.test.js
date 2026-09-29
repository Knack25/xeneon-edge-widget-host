'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../controller');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.open = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type) { for (const listener of this.listeners[type] || []) listener({ preventDefault() {} }); }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
}
const widgetId = 'com.meloyellowjr.spectrumanalyzer';
function snapshot(pages = [{ id: 'one', name: 'One', regions: [{ widgetId, settings: { inputGain: 10 } }] }], activePageId = 'one') {
  return { revision: 1, widgets: [{ id: widgetId, iconUrl: '/icon.svg', manifest: { name: 'Analyzer' } }], displays: [], state: { displayPreference: { mode: 'automatic' }, scene: { visible: true, activePageId, navigationPosition: 'bottom-right', pages } }, edge: { status: 'active', widgetId, requestedPageId: activePageId, presentedPageId: activePageId, loadStatus: 'loaded' } };
}
function setup() {
  const elements = new Map(); const calls = []; let receive;
  const document = { activeElement: null, createElement: tag => new Element(tag), getElementById: id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); } };
  const bridge = { nativeControls: true, onState: fn => { receive = fn; return () => {}; }, getState: async () => snapshot(),
    selectWidget: async target => calls.push(['widget', target]), updateSetting: async target => calls.push(['setting', target]),
    createPage: async target => calls.push(['add', target]), renamePage: async target => calls.push(['rename', target]), movePage: async target => calls.push(['move', target]),
    deletePage: async target => calls.push(['delete', target]), selectPage: async target => calls.push(['select', target]), setNavigationPosition: async target => calls.push(['position', target]),
    selectDisplay: async () => {}, setEdgeVisible: async () => {}, rescanWidgets: async () => {}, importWidget: async () => {}, minimize() {}, toggleMaximize() {}, close() {} };
  return { controller: createController({ document, bridge, storage: { getItem: () => null } }), document, elements, calls, receive: value => receive(value) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const pages = () => [
  { id: 'one', name: '<img onerror=alert(1)>', regions: [{ widgetId, settings: { inputGain: 10 } }] },
  { id: 'two', name: 'Two', regions: [{ widgetId, settings: { inputGain: 90 } }] }
];
const setting = fixture => fixture.elements.get('settings').children.find(row => row.children[1]?.dataset.setting === 'inputGain').children[1];

test('same-widget page switch refreshes settings and stale queued input keeps its captured target', async () => {
  const f = setup(); await f.controller.start(); f.receive(snapshot(pages(), 'one'));
  const old = setting(f); f.receive(snapshot(pages(), 'two'));
  assert.notEqual(setting(f), old);
  assert.equal(setting(f).value, '90');
  old.value = '55'; old.dispatch('input'); setting(f).value = '95'; setting(f).dispatch('input'); await tick();
  assert.deepEqual(f.calls, [
    ['setting', { pageId: 'one', widgetId, name: 'inputGain', value: 55 }],
    ['setting', { pageId: 'two', widgetId, name: 'inputGain', value: 95 }]
  ]);
});

test('page list renders names as text and selection of failed page is retryable', async () => {
  const f = setup(); await f.controller.start();
  const data = snapshot(pages(), 'two'); data.edge.presentedPageId = 'one'; data.edge.loadStatus = 'failed';
  f.receive(data);
  const buttons = f.elements.get('page-list').children;
  assert.equal(buttons[0].textContent, '<img onerror=alert(1)>');
  assert.equal(buttons[1]['aria-pressed'], 'true');
  assert.match(f.elements.get('status').textContent, /Two/);
  assert.match(f.elements.get('status').textContent, /<img onerror=alert\(1\)>/);
  buttons[1].dispatch('click'); await tick();
  assert.deepEqual(f.calls, [['select', { pageId: 'two' }]]);
  assert.equal(f.elements.get('page-list').children.some(button => button.tagName === 'iframe'), false);
});

test('page boundary actions and limits disable invalid mutations', async () => {
  const f = setup(); await f.controller.start();
  assert.equal(f.elements.get('page-delete').disabled, true);
  assert.equal(f.elements.get('page-up').disabled, true);
  f.receive(snapshot(pages(), 'one'));
  assert.equal(f.elements.get('page-up').disabled, true);
  assert.equal(f.elements.get('page-down').disabled, false);
  f.receive(snapshot(pages(), 'two'));
  assert.equal(f.elements.get('page-up').disabled, false);
  assert.equal(f.elements.get('page-down').disabled, true);
  f.receive(snapshot(Array.from({ length: 12 }, (_, index) => ({ id: String(index), name: String(index), regions: [{ widgetId, settings: {} }] })), '0'));
  assert.equal(f.elements.get('page-add').disabled, true);
});

test('page forms validate names, capture page identity, and cancellation sends no delete', async () => {
  const f = setup(); await f.controller.start(); f.receive(snapshot(pages(), 'one'));
  const name = f.elements.get('page-name');
  name.value = ' '.repeat(3); f.elements.get('page-add').dispatch('click'); await tick();
  assert.deepEqual(f.calls, []);
  assert.match(f.elements.get('page-error').textContent, /1–80/);
  name.value = 'x'.repeat(81); f.elements.get('page-rename').dispatch('click'); await tick(); assert.deepEqual(f.calls, []);
  name.value = ' New '; f.elements.get('page-add').dispatch('click'); f.elements.get('page-rename').dispatch('click'); await tick();
  assert.deepEqual(f.calls, [['add', { name: 'New' }], ['rename', { pageId: 'one', name: 'New' }]]);
  f.elements.get('page-delete').dispatch('click'); f.elements.get('page-delete-cancel').dispatch('click'); await tick();
  assert.equal(f.calls.some(call => call[0] === 'delete'), false);
  assert.match(f.elements.get('page-delete-warning').textContent, /live widget state/i);
  f.elements.get('page-delete').dispatch('click'); f.elements.get('page-delete-confirm').dispatch('click'); await tick();
  assert.deepEqual(f.calls.at(-1), ['delete', { pageId: 'one' }]);
});

test('move controls and six navigation presets send live commands', async () => {
  const f = setup(); await f.controller.start(); f.receive(snapshot(pages(), 'two'));
  f.elements.get('page-up').dispatch('click'); await tick();
  assert.deepEqual(f.calls, [['move', { pageId: 'two', direction: 'up' }]]);
  const position = f.elements.get('navigation-position');
  assert.deepEqual(position.children.map(option => option.value), ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']);
  for (const option of position.children) { position.value = option.value; position.dispatch('change'); }
  await tick();
  assert.deepEqual(f.calls.slice(1), position.children.map(option => ['position', { position: option.value }]));
});
