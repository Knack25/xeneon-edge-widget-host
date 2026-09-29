'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPageNavigation } = require('../page-navigation');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = new Map(); this.listeners = new Map(); this.hidden = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
  click(event) { this.listeners.get('click')?.(event); }
}

function fixture() {
  const cluster = new Element('nav');
  const document = { getElementById: id => id === 'page-navigation' ? cluster : null, createElement: tag => new Element(tag) };
  const selected = [];
  const navigation = createPageNavigation({ document, onSelect: id => selected.push(id) });
  const pages = [{ id: 'stable-a', name: 'Drawing' }, { id: 'stable-b', name: 'Clock' }];
  const render = (overrides = {}) => navigation.render({ pages, requestedPageId: 'stable-a', presentedPageId: 'stable-a', position: 'bottom-right', ...overrides });
  return { cluster, navigation, selected, pages, render };
}

test('one page hides the cluster and two pages expose numbered named native buttons', () => {
  const f = fixture(); f.render({ pages: f.pages.slice(0, 1) });
  assert.equal(f.cluster.hidden, true);
  assert.equal(f.cluster.children.length, 0);
  f.render();
  assert.equal(f.cluster.hidden, false);
  assert.deepEqual(f.cluster.children.map(button => button.textContent), ['1', '2']);
  assert.deepEqual(f.cluster.children.map(button => button.getAttribute('aria-label')), ['Page 1: Drawing', 'Page 2: Clock']);
  assert.deepEqual(f.cluster.children.map(button => button.title), ['Drawing', 'Clock']);
  assert.ok(f.cluster.children.every(button => button.tagName === 'button' && button.type === 'button'));
});

test('selection emits stable IDs once and reorder changes numbering without changing identity', () => {
  const f = fixture(); f.render(); f.cluster.children[1].click();
  assert.deepEqual(f.selected, ['stable-b']);
  f.render({ pages: [f.pages[1], f.pages[0]] });
  assert.equal(f.cluster.children[0].textContent, '1');
  assert.equal(f.cluster.children[0].getAttribute('aria-label'), 'Page 1: Clock');
  f.cluster.children[0].click();
  assert.deepEqual(f.selected, ['stable-b', 'stable-b']);
});

test('presented page stays active while a different requested page indicates loading', () => {
  const f = fixture(); f.render({ requestedPageId: 'stable-b' });
  assert.equal(f.cluster.children[0].getAttribute('aria-current'), 'page');
  assert.equal(f.cluster.children[1].getAttribute('aria-current'), undefined);
  assert.equal(f.cluster.children[1].getAttribute('data-loading'), 'true');
  f.render({ requestedPageId: 'stable-b', presentedPageId: 'stable-b' });
  assert.equal(f.cluster.children[0].getAttribute('aria-current'), undefined);
  assert.equal(f.cluster.children[1].getAttribute('aria-current'), 'page');
  assert.equal(f.cluster.children[1].getAttribute('data-loading'), undefined);
});

test('all six placements update the cluster without changing selection or hiding on blur', () => {
  const f = fixture(); f.render(); const button = f.cluster.children[0];
  for (const position of ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']) {
    f.render({ position });
    assert.equal(f.cluster.dataset.position, position);
    assert.equal(f.cluster.hidden, false);
    assert.equal(f.cluster.children[0], button);
  }
  f.render({ requestedPageId: 'stable-b', presentedPageId: 'stable-b' });
  assert.equal(f.cluster.children[0], button);
  assert.equal(f.selected.length, 0);
  assert.deepEqual([...f.cluster.listeners.keys()], []);
});

test('destroy removes selection handlers and later renders do nothing', () => {
  const f = fixture(); f.render(); const oldButton = f.cluster.children[0];
  f.navigation.destroy(); oldButton.click(); f.render();
  assert.deepEqual(f.selected, []);
  assert.equal(f.cluster.children.length, 0);
});

test('isolated Edge navigation accepts trusted clicks only and follows confirmed presentation', async () => {
  const f = fixture();
  let receive, unsubscribe = false, pagehide;
  const snapshots = [];
  const state = { pages: f.pages, requestedPageId: 'stable-a', presentedPageId: null, position: 'bottom-right' };
  const bridge = {
    onState(fn) { receive = fn; return () => { unsubscribe = true; }; },
    getState: async () => state,
    selectPage: async target => { snapshots.push(target.pageId); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../edge-navigation.js'), 'utf8'), {
    icueNavigation: bridge, ICUEPageNavigation: { createPageNavigation },
    document: { getElementById: () => f.cluster, createElement: tag => new Element(tag) },
    addEventListener(name, fn) { assert.equal(name, 'pagehide'); pagehide = fn; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cluster.children[0].getAttribute('data-loading'), 'true');
  receive({ ...state, presentedPageId: 'stable-a' });
  assert.equal(f.cluster.children[0].getAttribute('aria-current'), 'page');
  f.cluster.children[1].click(); f.cluster.children[1].click({ isTrusted: false });
  assert.deepEqual(snapshots, []);
  f.cluster.children[1].click({ isTrusted: true });
  assert.deepEqual(snapshots, ['stable-b']);
  receive({ ...state, requestedPageId: 'stable-b', presentedPageId: 'stable-a', position: 'top-left' });
  assert.equal(f.cluster.dataset.position, 'top-left');
  assert.equal(f.cluster.children[0].getAttribute('aria-current'), 'page');
  assert.equal(f.cluster.children[1].getAttribute('data-loading'), 'true');
  receive({ ...state, requestedPageId: 'stable-b', presentedPageId: 'stable-b' });
  assert.equal(f.cluster.children[1].getAttribute('aria-current'), 'page');
  pagehide();
  assert.equal(unsubscribe, true);
  assert.equal(f.cluster.children.length, 0);
});
