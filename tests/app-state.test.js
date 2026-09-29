const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState, normalizeState, createStateStore } = require('../app-state');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-state-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, statePath: path.join(temp, 'state.json') };
}

test('default state contains one page and one full-size region', () => {
  const state = createDefaultState('clock');
  assert.equal(state.version, 2);
  assert.equal(state.revision, 0);
  assert.equal(state.legacySettingsMigrated, false);
  assert.equal(state.controllerBounds, null);
  assert.deepEqual(state.displayPreference, { mode: 'automatic', fingerprint: null });
  assert.equal(state.scene.visible, true);
  assert.equal(state.scene.activePageId, 'page-1');
  assert.equal(state.scene.navigationPosition, 'bottom-right');
  assert.equal(state.scene.pages.length, 1);
  assert.deepEqual(state.scene.pages[0].widgetSettings, {});
  assert.deepEqual(state.scene.pages[0].regions, [{
    id: 'primary', widgetId: 'clock', settings: {},
    bounds: { x: 0, y: 0, width: 1, height: 1 }
  }]);
});

test('persisted invalid or lossy state preserves exact bytes and exposes a transient recovery diagnostic', async t => {
  const { temp } = fixture(t);
  const malformed = createDefaultState('clock'); malformed.scene.pages = [];
  const lossy = createDefaultState('clock'); lossy.scene.pages[0].widgetSettings.clock = JSON.parse('{"color":"blue","constructor":7}');
  for (const [index, raw] of [malformed, lossy, '{broken'].entries()) {
    const statePath = path.join(temp, `state-${index}.json`);
    const bytes = Buffer.from(typeof raw === 'string' ? raw : `  ${JSON.stringify(raw)}\n\n`);
    fs.writeFileSync(statePath, bytes);
    const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 10000 });
    assert.equal(store.recoveryDiagnostic()?.status, 'recovered');
    assert.doesNotMatch(JSON.stringify(store.recoveryDiagnostic()), /state-|app-state-/);
    const backup = fs.readdirSync(temp).find(name => name.startsWith(`state-${index}.json.corrupt-`));
    assert.ok(backup); assert.deepEqual(fs.readFileSync(path.join(temp, backup)), bytes);
    await store.flush();
    assert.equal(JSON.parse(fs.readFileSync(statePath)).recovery, undefined);
    const reloaded = createStateStore({ statePath, defaultWidgetId: 'clock' });
    assert.equal(reloaded.recoveryDiagnostic(), null); await reloaded.flush();
  }
});

test('benign persisted canonicalization and ordinary updates do not create recovery backups', async t => {
  const { temp, statePath } = fixture(t);
  const raw = createDefaultState('clock'); raw.unknown = 'ignored'; raw.controllerBounds = { x: 1, y: 2, width: 500, height: 300, extra: true };
  fs.writeFileSync(statePath, JSON.stringify(raw));
  const store = createStateStore({ statePath, defaultWidgetId: 'clock' });
  assert.equal(store.recoveryDiagnostic(), null);
  store.update(state => { state.scene.visible = false; }); await store.flush();
  assert.deepEqual(fs.readdirSync(temp), ['state.json']);
});

test('same-timestamp recovery never overwrites an earlier backup', async t => {
  const { temp, statePath } = fixture(t);
  t.mock.method(Date.prototype, 'toISOString', () => '2026-09-29T00:00:00.000Z');
  for (const bytes of ['{first', '{second']) {
    fs.writeFileSync(statePath, bytes);
    const store = createStateStore({ statePath, defaultWidgetId: 'clock' }); await store.flush();
  }
  const originals = fs.readdirSync(temp).filter(name => name.startsWith('state.json.corrupt-')).map(name => fs.readFileSync(path.join(temp, name), 'utf8')).sort();
  assert.deepEqual(originals, ['{first', '{second']);
});

test('a failed recovery backup aborts initialization and leaves the original persisted bytes untouched', async t => {
  const { temp, statePath } = fixture(t); const bytes = Buffer.from('{broken');
  fs.writeFileSync(statePath, bytes);
  t.mock.method(fs, 'copyFileSync', () => { throw Object.assign(Error('backup storage full'), { code: 'ENOSPC' }); });
  assert.throws(() => createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 0 }), /backup storage full/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(fs.readFileSync(statePath), bytes); assert.deepEqual(fs.readdirSync(temp), ['state.json']);
});

test('oversized settings arrays are rejected before allocating or reading their indices', () => {
  let reads = 0;
  const values = new Proxy(new Array(10001), { getOwnPropertyDescriptor(target, key) { if (/^\d+$/.test(key)) reads++; return Reflect.getOwnPropertyDescriptor(target, key); } });
  const raw = createDefaultState('clock'); raw.scene.pages[0].regions[0].settings = { values };
  assert.deepEqual(normalizeState(raw).scene.pages[0].regions[0].settings, {});
  assert.equal(reads, 0);
});

test('corrupt state is backed up and replaced by persisted defaults', async (t) => {
  const { temp, statePath } = fixture(t);
  fs.writeFileSync(statePath, '{broken');
  const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 0 });
  assert.equal(store.snapshot().scene.pages[0].regions[0].widgetId, 'clock');
  const backup = fs.readdirSync(temp).find(name => name.startsWith('state.json.corrupt-'));
  assert.match(backup, /^state\.json\.corrupt-[0-9TZ-]+$/);
  assert.equal(fs.readFileSync(path.join(temp, backup), 'utf8'), '{broken');
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).version, 2);
});

test('legacy settings merge once into the matching region and survive reload', async (t) => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 0 });
  assert.equal(store.mergeLegacySettings({ clock: { inputGain: 140 }, other: { value: 2 } }), true);
  assert.equal(store.mergeLegacySettings({ clock: { inputGain: 90 } }), false);
  assert.equal(store.snapshot().scene.pages[0].regions[0].settings.inputGain, 140);
  await store.flush();
  const reloaded = createStateStore({ statePath, defaultWidgetId: 'clock' });
  assert.equal(reloaded.mergeLegacySettings({ clock: { inputGain: 70 } }), false);
});

test('normalization preserves valid known fields and all valid pages', () => {
  const raw = createDefaultState('clock');
  raw.revision = 4;
  raw.controllerBounds = { x: -10, y: 20, width: 500, height: 300, unknown: true };
  raw.displayPreference = { mode: 'manual', fingerprint: { label: 'EDGE', physicalWidth: 1920, physicalHeight: 1080, unknown: true } };
  raw.scene.visible = false;
  raw.scene.pages[0].id = 'custom';
  raw.scene.pages[0].name = 'Custom';
  raw.scene.activePageId = 'custom';
  raw.scene.pages[0].regions[0].widgetId = 'not-in-catalog';
  raw.scene.pages.push({ id: 'second', name: 'Second', widgetSettings: {}, regions: [{ id: 'primary', widgetId: 'clock', settings: {}, bounds: { x: 0, y: 0, width: 1, height: 1 } }] });
  raw.unknown = true;
  const normalized = normalizeState(raw, { defaultWidgetId: 'clock' });
  assert.equal(normalized.revision, 4);
  assert.equal(normalized.unknown, undefined);
  assert.deepEqual(normalized.controllerBounds, { x: -10, y: 20, width: 500, height: 300 });
  assert.deepEqual(normalized.displayPreference, { mode: 'manual', fingerprint: { label: 'EDGE', physicalWidth: 1920, physicalHeight: 1080 } });
  assert.equal(normalized.scene.visible, false);
  assert.equal(normalized.scene.activePageId, 'custom');
  assert.equal(normalized.scene.pages.length, 2);
  assert.equal(normalized.scene.pages[0].regions.length, 1);
  assert.equal(normalized.scene.pages[0].regions[0].widgetId, 'not-in-catalog');
  assert.deepEqual(normalized.scene.pages[0].regions[0].bounds, { x: 0, y: 0, width: 1, height: 1 });
});

test('invalid schema fields and unsupported versions fall back to usable defaults in pure normalization', () => {
  for (const raw of [null, [], 3, { version: 99 }, { version: 2, revision: -1,
    controllerBounds: { x: 0, y: 0, width: -1, height: 2 },
    displayPreference: { mode: 'invalid', fingerprint: { label: 'EDGE', physicalWidth: Infinity } },
    scene: { visible: 'false', pages: [] }
  }]) {
    const state = normalizeState(raw, { defaultWidgetId: 'clock' });
    assert.equal(state.revision, 0);
    assert.equal(state.scene.visible, true);
    assert.equal(state.scene.pages[0].regions[0].widgetId, 'clock');
    assert.equal(state.controllerBounds, null);
    assert.deepEqual(state.displayPreference, { mode: 'automatic', fingerprint: null });
  }
});

test('settings retain nested JSON values without sharing input references or prototype keys', () => {
  const raw = createDefaultState('clock');
  raw.scene.pages[0].regions[0].settings = JSON.parse('{"nested":{"values":[1,true,null,"ok"]},"__proto__":{"polluted":true},"constructor":42}');
  const normalized = normalizeState(raw, { defaultWidgetId: 'clock' });
  raw.scene.pages[0].regions[0].settings.nested.values[0] = 99;
  assert.deepEqual(normalized.scene.pages[0].regions[0].settings, { nested: { values: [1, true, null, 'ok'] } });
  assert.equal({}.polluted, undefined);
});

test('non-JSON settings fall back to an empty object', () => {
  const cycle = {};
  cycle.self = cycle;
  for (const settings of [null, [], 'oops', { bad: undefined }, { bad: NaN }, { bad: () => 1 }, { bad: 1n }, cycle, new Date()]) {
    const raw = createDefaultState('clock');
    raw.scene.pages[0].regions[0].settings = settings;
    assert.deepEqual(normalizeState(raw, { defaultWidgetId: 'clock' }).scene.pages[0].regions[0].settings, {});
  }
});

test('updates increment revision and isolate snapshots and retained mutator references', async (t) => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 10000 });
  let draft;
  const result = store.update(state => {
    draft = state;
    state.scene.visible = false;
    state.revision = 100;
    state.scene.pages[0].regions[0].settings = { inputGain: 123 };
  });
  assert.equal(result.revision, 1);
  result.scene.visible = true;
  draft.scene.pages[0].regions[0].settings.inputGain = 2;
  assert.equal(store.snapshot().scene.visible, false);
  assert.equal(store.snapshot().scene.pages[0].regions[0].settings.inputGain, 123);
  store.update(state => { state.scene.visible = true; });
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).revision, 2);
  assert.equal(fs.existsSync(`${statePath}.tmp`), false);
  const reloaded = createStateStore({ statePath, defaultWidgetId: 'other' });
  assert.equal(reloaded.snapshot().scene.pages[0].regions[0].settings.inputGain, 123);
});

test('a throwing mutator leaves state and revision untouched', async (t) => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock' });
  assert.throws(() => store.update(state => { state.scene.visible = false; throw new Error('abort'); }), /abort/);
  assert.equal(store.snapshot().revision, 0);
  assert.equal(store.snapshot().scene.visible, true);
  await store.flush();
});

test('debounced writes persist the last update without an explicit flush', async (t) => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 10 });
  store.update(state => { state.scene.visible = false; });
  store.update(state => { state.scene.pages[0].name = 'Updated'; });
  await new Promise(resolve => setTimeout(resolve, 50));
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.scene.visible, false);
  assert.equal(persisted.scene.pages[0].name, 'Updated');
});

test('legacy migration preserves existing per-region settings on conflicts', async (t) => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock' });
  store.update(state => { state.scene.pages[0].regions[0].settings = { inputGain: 120 }; });
  store.mergeLegacySettings({ clock: { inputGain: 70, color: 'blue' } });
  assert.deepEqual(store.snapshot().scene.pages[0].regions[0].settings, { inputGain: 120, color: 'blue' });
  await store.flush();
});

test('legacy migration persists settings for inactive widgets and keeps current values', async (t) => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock' });
  assert.deepEqual(store.snapshot().scene.pages[0].widgetSettings, {});
  store.update(state => { state.scene.pages[0].widgetSettings = { other: { color: 'red' } }; });
  store.mergeLegacySettings({ clock: { inputGain: 140 }, other: { color: 'blue', speed: 2 }, invalid: null });
  await store.flush();
  const reloaded = createStateStore({ statePath, defaultWidgetId: 'clock' });
  const state = reloaded.snapshot();
  assert.deepEqual(state.scene.pages[0].widgetSettings, { clock: { inputGain: 140 }, other: { color: 'red', speed: 2 } });
  assert.deepEqual(state.scene.pages[0].regions[0].settings, { inputGain: 140 });
});

test('version-1 migration preserves preferences, current settings and inactive remembered settings', async t => {
  const { statePath } = fixture(t);
  const raw = {
    version: 1, revision: 7, legacySettingsMigrated: true,
    widgetSettings: { clock: { backgroundColor: '#445566', other: 1 }, inactive: { value: 2 } },
    controllerBounds: { x: 9, y: 10, width: 640, height: 480 },
    displayPreference: { mode: 'manual', fingerprint: { label: 'EDGE', physicalWidth: 1920, physicalHeight: 1080 } },
    scene: { visible: false, activePageId: 'custom', pages: [{ id: 'custom', name: 'Desk', regions: [{ id: 'primary', widgetId: 'clock', settings: { backgroundColor: '#112233' }, bounds: { x: 0, y: 0, width: 1, height: 1 } }] }] }
  };
  fs.writeFileSync(statePath, JSON.stringify(raw));
  const store = createStateStore({ statePath, defaultWidgetId: 'fallback' });
  const state = store.snapshot();
  assert.equal(store.recoveryDiagnostic(), null);
  assert.equal(state.version, 2);
  assert.equal(state.revision, 7);
  assert.equal(state.legacySettingsMigrated, true);
  assert.deepEqual(state.controllerBounds, raw.controllerBounds);
  assert.deepEqual(state.displayPreference, raw.displayPreference);
  assert.equal(state.scene.visible, false);
  assert.equal(state.scene.navigationPosition, 'bottom-right');
  assert.equal(state.scene.activePageId, 'custom');
  assert.equal(state.scene.pages[0].name, 'Desk');
  assert.deepEqual(state.scene.pages[0].regions[0].settings, { backgroundColor: '#112233' });
  assert.deepEqual(state.scene.pages[0].widgetSettings, { clock: { backgroundColor: '#112233', other: 1 }, inactive: { value: 2 } });
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).version, 2);
});

test('version-2 pages and all navigation presets round-trip without cross-page settings changes', async t => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock' });
  store.update(state => {
    state.scene.pages[0].regions[0].settings = { backgroundColor: '#112233' };
    state.scene.pages[0].widgetSettings.clock = { backgroundColor: '#112233' };
    state.scene.pages.push({ id: 'second', name: 'Second', widgetSettings: { clock: { backgroundColor: '#445566' } }, regions: [{ id: 'primary', widgetId: 'clock', settings: { backgroundColor: '#445566' }, bounds: { x: 0, y: 0, width: 1, height: 1 } }] });
    state.scene.activePageId = 'second';
  });
  for (const position of ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']) {
    store.update(state => { state.scene.navigationPosition = position; });
    await store.flush();
    const reloaded = createStateStore({ statePath, defaultWidgetId: 'other' });
    const scene = reloaded.snapshot().scene;
    assert.equal(scene.navigationPosition, position);
    assert.equal(scene.activePageId, 'second');
    assert.deepEqual(scene.pages.map(page => page.widgetSettings.clock), [{ backgroundColor: '#112233' }, { backgroundColor: '#445566' }]);
  }
});

test('invalid active ID recovers to first page with a diagnostic', async t => {
  const { statePath } = fixture(t);
  const raw = createDefaultState('clock'); raw.scene.activePageId = 'missing';
  fs.writeFileSync(statePath, JSON.stringify(raw));
  const store = createStateStore({ statePath, defaultWidgetId: 'clock' });
  assert.equal(store.snapshot().scene.activePageId, 'page-1');
  assert.equal(store.recoveryDiagnostic()?.reason, 'invalid-active-page');
  await store.flush();
});

test('invalid page mutations reject without changing revision or persisted bytes', async t => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock' });
  await store.flush();
  const bytes = fs.readFileSync(statePath);
  assert.throws(() => store.update(state => { state.scene.pages.push({ ...state.scene.pages[0] }); }), /duplicate/i);
  assert.equal(store.snapshot().revision, 0);
  await store.flush();
  assert.deepEqual(fs.readFileSync(statePath), bytes);
});

test('settings accessors are rejected without invocation during mutation', t => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock' });
  let reads = 0;
  assert.throws(() => store.update(state => {
    state.scene.pages[0].regions[0].settings = { get color() { reads++; return 'red'; } };
  }), /settings/i);
  assert.equal(reads, 0);
  assert.equal(store.snapshot().revision, 0);
});

test('future-version bytes remain unchanged and attempted mutation is blocked visibly', async t => {
  const { temp, statePath } = fixture(t);
  const bytes = Buffer.from('  {"version":99,"future":{"data":true}}\n');
  fs.writeFileSync(statePath, bytes);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 0 });
  assert.equal(store.recoveryDiagnostic()?.status, 'read-only');
  assert.throws(() => store.update(state => { state.scene.visible = false; }), /unsupported|read.only/i);
  assert.throws(() => store.mergeLegacySettings({ clock: { value: 1 } }), /unsupported|read.only/i);
  await store.flush();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(fs.readFileSync(statePath), bytes);
  assert.deepEqual(fs.readdirSync(temp), ['state.json']);
});

test('flush rejects a write failure and retries the latest state without damaging prior state', async (t) => {
  const { statePath } = fixture(t);
  const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 10000 });
  await store.flush();
  store.update(state => { state.scene.visible = false; });
  fs.mkdirSync(`${statePath}.tmp`);
  await assert.rejects(store.flush());
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).scene.visible, true);
  fs.rmdirSync(`${statePath}.tmp`);
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).scene.visible, false);
});
