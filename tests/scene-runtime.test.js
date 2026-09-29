'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSceneRuntime } = require('../scene-runtime');

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const containers = [];
  const host = { children: [], append(node) { node.parent = this; this.children.push(node); } };
  const document = { getElementById(id) { assert.equal(id, 'primary-region'); return host; }, createElement(tag) {
    assert.equal(tag, 'div');
    const attributes = new Map();
    const node = { style: {}, dataset: {}, children: [], setAttribute(key, value) { attributes.set(key, value); }, removeAttribute(key) { attributes.delete(key); }, getAttribute(key) { return attributes.get(key); }, remove() { this.parent.children = this.parent.children.filter(child => child !== this); this.removed = true; } };
    containers.push(node); return node;
  } };
  const runtimes = [], reports = [], presentations = [];
  const manager = createSceneRuntime({ document, report: value => reports.push(value), onPresentation: value => presentations.push(value), createRuntime({ container, report }) {
    const runtime = { container, reports: report, loads: [], updates: [], destroyed: 0, load(input) {
      const gate = deferred(); this.loads.push({ input, gate });
      return gate.promise.then(result => { if (result.stale) return result; if (result.ok) report({ revision: input.revision, ok: true }); else report({ revision: input.revision, ok: false, message: result.message }); return result; });
    }, updateSettings(input) { this.updates.push(input); report({ revision: input.revision, ok: true }); return Promise.resolve({ stale: false }); }, destroy() { this.destroyed++; container.remove(); } };
    runtimes.push(runtime); return runtime;
  } });
  return { manager, host, containers, runtimes, reports, presentations };
}

const widgets = { A: { id: 'doodle', entryUrl: '/doodle.html' }, B: { id: 'doodle', entryUrl: '/doodle.html' }, C: { id: 'clock', entryUrl: '/clock.html' } };
function snapshot(revision, activePageId, pages = ['A', 'B', 'C'], extras = {}) {
  const generations = extras.generations || {};
  const settings = extras.settings || {};
  const pageWidgets = extras.widgets || widgets;
  return { revision, catalogRevision: extras.catalogRevision || 1, pageWidgets,
    pageGenerations: Object.fromEntries(pages.map(id => [id, generations[id] || 1])),
    scene: { activePageId, navigationPosition: extras.position || 'bottom-right', pages: pages.map(id => ({ id, name: extras.names?.[id] || id, regions: [{ id: 'primary', widgetId: pageWidgets[id]?.id || 'missing', settings: settings[id] || {}, bounds: { x: 0, y: 0, width: 1, height: 1 } }] })) } };
}
function finish(runtime, result = { stale: false, ok: true }) { runtime.loads.at(-1).gate.resolve(result); }

test('visiting A to B to A retains exact runtimes and full-size offscreen containers', async () => {
  const f = fixture(); const first = f.manager.receive(snapshot(1, 'A')); assert.equal(f.runtimes.length, 1); finish(f.runtimes[0]); await first;
  const a = f.runtimes[0], aContainer = a.container;
  const second = f.manager.receive(snapshot(2, 'B')); assert.equal(f.runtimes.length, 2); assert.equal(aContainer.getAttribute('aria-hidden'), 'false');
  finish(f.runtimes[1]); await second;
  assert.equal(aContainer.getAttribute('aria-hidden'), 'true'); assert.equal(aContainer.inert, true);
  assert.equal(aContainer.style.width, '100%'); assert.equal(aContainer.style.height, '100%'); assert.equal(aContainer.style.display, undefined);
  await f.manager.receive(snapshot(3, 'A'));
  assert.equal(f.runtimes.length, 2); assert.equal(a.loads.length, 1); assert.equal(aContainer.getAttribute('aria-hidden'), 'false');
  assert.equal(f.runtimes[1].container.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(f.presentations, [{ pageId: 'A' }, { pageId: 'B' }, { pageId: 'A' }]);
  assert.deepEqual(f.reports.at(-1), { pageId: 'A', widgetId: 'doodle', generation: 1, revision: 3, ok: true });
});

test('rename, reorder and navigation placement preserve runtimes; settings target only matching page', async () => {
  const f = fixture(); let pending = f.manager.receive(snapshot(1, 'A')); finish(f.runtimes[0]); await pending;
  pending = f.manager.receive(snapshot(2, 'B')); finish(f.runtimes[1]); await pending;
  await f.manager.receive(snapshot(3, 'A', ['B', 'A', 'C'], { position: 'top-left', names: { A: 'Drawing', B: 'Other drawing' } }));
  await f.manager.receive(snapshot(4, 'A', ['B', 'A', 'C'], { settings: { B: { color: 'blue' } } }));
  assert.equal(f.runtimes.length, 2); assert.equal(f.runtimes[0].loads.length, 1); assert.equal(f.runtimes[1].loads.length, 1);
  assert.deepEqual(f.runtimes[0].updates, []); assert.deepEqual(f.runtimes[1].updates, [{ revision: 4, settings: { color: 'blue' } }]);
});

test('late B success cannot replace C after a rapid switch', async () => {
  const f = fixture(); let pending = f.manager.receive(snapshot(1, 'A')); finish(f.runtimes[0]); await pending;
  const b = f.manager.receive(snapshot(2, 'B')); const c = f.manager.receive(snapshot(3, 'C'));
  finish(f.runtimes[2]); await c; finish(f.runtimes[1]); await b;
  assert.equal(f.runtimes[2].container.getAttribute('aria-hidden'), 'false');
  assert.equal(f.runtimes[1].container.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(f.presentations, [{ pageId: 'A' }, { pageId: 'C' }]);
  assert.ok(f.reports.every(value => !(value.pageId === 'B' && value.ok)));
});

test('failed B keeps A visible and a later selection retries B', async () => {
  const f = fixture(); let pending = f.manager.receive(snapshot(1, 'A')); finish(f.runtimes[0]); await pending;
  pending = f.manager.receive(snapshot(2, 'B')); finish(f.runtimes[1], { stale: false, ok: false, message: 'missing asset' }); await pending;
  assert.equal(f.runtimes[0].container.getAttribute('aria-hidden'), 'false');
  assert.deepEqual(f.reports.at(-1), { pageId: 'B', widgetId: 'doodle', generation: 1, revision: 2, ok: false, message: 'missing asset' });
  await f.manager.receive(snapshot(3, 'B', ['A', 'B', 'C'], { names: { B: 'Renamed' } }));
  assert.equal(f.runtimes[1].loads.length, 1);
  await f.manager.receive(snapshot(4, 'A'));
  pending = f.manager.receive(snapshot(5, 'B')); finish(f.runtimes[1]); await pending;
  assert.equal(f.runtimes[1].loads.length, 2); assert.equal(f.runtimes[1].container.getAttribute('aria-hidden'), 'false');
  assert.deepEqual(f.reports.at(-1), { pageId: 'B', widgetId: 'doodle', generation: 1, revision: 5, ok: true });
});

test('a failed active settings update cannot be followed by a false success report', async () => {
  const f = fixture(); const initial = f.manager.receive(snapshot(1, 'A')); finish(f.runtimes[0]); await initial;
  f.runtimes[0].updateSettings = input => { f.runtimes[0].updates.push(input); f.runtimes[0].reports({ revision: input.revision, ok: false, message: 'settings failed' }); return Promise.reject(Error('settings failed')); };
  await f.manager.receive(snapshot(2, 'A', ['A', 'B', 'C'], { settings: { A: { color: 'green' } } }));
  assert.deepEqual(f.reports.filter(value => value.revision === 2), [{ pageId: 'A', widgetId: 'doodle', generation: 1, revision: 2, ok: false, message: 'settings failed' }]);
});

test('reimport of the presented page stages replacement inside its existing runtime', async () => {
  const f = fixture(); const initial = f.manager.receive(snapshot(1, 'A')); finish(f.runtimes[0]); await initial;
  const container = f.runtimes[0].container;
  const reload = f.manager.receive(snapshot(2, 'A', ['A', 'B', 'C'], { generations: { A: 2 } }));
  assert.equal(container.getAttribute('aria-hidden'), 'false'); assert.equal(f.runtimes.length, 1); assert.equal(f.runtimes[0].loads.length, 2);
  finish(f.runtimes[0]); await reload;
  assert.equal(f.runtimes[0].container, container); assert.equal(f.runtimes[0].destroyed, 0);
  assert.deepEqual(f.reports.at(-1), { pageId: 'A', widgetId: 'doodle', generation: 2, revision: 2, ok: true });
});

test('a superseded active reimport cannot promote or start another load', async () => {
  const f = fixture(); const initial = f.manager.receive(snapshot(1, 'A')); finish(f.runtimes[0]); await initial;
  const older = f.manager.receive(snapshot(2, 'A', ['A', 'B', 'C'], { generations: { A: 2 } }));
  const newer = f.manager.receive(snapshot(3, 'A', ['A', 'B', 'C'], { generations: { A: 3 } }));
  f.runtimes[0].loads[1].gate.resolve({ stale: true }); await older;
  const same = f.manager.receive(snapshot(4, 'A', ['A', 'B', 'C'], { generations: { A: 3 } }));
  assert.equal(f.runtimes[0].loads.length, 3);
  f.runtimes[0].loads[2].gate.resolve({ stale: false, ok: true }); await Promise.all([newer, same]);
  assert.deepEqual(f.reports.at(-1), { pageId: 'A', widgetId: 'doodle', generation: 3, revision: 3, ok: true });
});

test('deleting pending B disposes it once and prevents promotion', async () => {
  const f = fixture(); let pending = f.manager.receive(snapshot(1, 'A')); finish(f.runtimes[0]); await pending;
  const b = f.manager.receive(snapshot(2, 'B'));
  await f.manager.receive(snapshot(3, 'A', ['A', 'C']));
  assert.equal(f.runtimes[1].destroyed, 1); finish(f.runtimes[1]); await b;
  assert.equal(f.runtimes[1].destroyed, 1); assert.equal(f.runtimes[1].container.removed, true);
  assert.deepEqual(f.presentations, [{ pageId: 'A' }]);
});

test('reimport invalidates matching inactive pages lazily and leaves other widgets intact', async () => {
  const f = fixture(); for (const [revision, id] of [[1, 'A'], [2, 'B'], [3, 'C']]) { const pending = f.manager.receive(snapshot(revision, id)); finish(f.runtimes.at(-1)); await pending; }
  const oldA = f.runtimes[0], oldB = f.runtimes[1], oldC = f.runtimes[2];
  await f.manager.receive(snapshot(4, 'C', ['A', 'B', 'C'], { generations: { A: 2, B: 2 } }));
  assert.equal(oldA.destroyed, 1); assert.equal(oldB.destroyed, 1); assert.equal(oldC.destroyed, 0);
  const pending = f.manager.receive(snapshot(5, 'A', ['A', 'B', 'C'], { generations: { A: 2, B: 2 } }));
  assert.equal(f.runtimes.length, 4); finish(f.runtimes[3]); await pending;
  assert.equal(oldC.destroyed, 0); assert.equal(f.runtimes[3].container.getAttribute('aria-hidden'), 'false');
});

test('destroy cancels outstanding loads and removes every retained container', async () => {
  const f = fixture(); let pending = f.manager.receive(snapshot(1, 'A')); finish(f.runtimes[0]); await pending;
  const b = f.manager.receive(snapshot(2, 'B')); f.manager.destroy(); finish(f.runtimes[1]); await b;
  assert.deepEqual(f.runtimes.map(runtime => runtime.destroyed), [1, 1]);
  assert.equal(f.host.children.length, 0); assert.deepEqual(f.presentations, [{ pageId: 'A' }]);
  await f.manager.receive(snapshot(3, 'C')); assert.equal(f.runtimes.length, 2);
});
