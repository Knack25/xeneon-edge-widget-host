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
  assert.equal(state.version, 1);
  assert.equal(state.revision, 0);
  assert.equal(state.legacySettingsMigrated, false);
  assert.equal(state.controllerBounds, null);
  assert.deepEqual(state.displayPreference, { mode: 'automatic', fingerprint: null });
  assert.equal(state.scene.visible, true);
  assert.equal(state.scene.activePageId, 'page-1');
  assert.equal(state.scene.pages.length, 1);
  assert.deepEqual(state.scene.pages[0].regions, [{
    id: 'primary', widgetId: 'clock', settings: {},
    bounds: { x: 0, y: 0, width: 1, height: 1 }
  }]);
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
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).version, 1);
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

test('normalization preserves valid known fields and removes extra pages, regions and fields', () => {
  const raw = createDefaultState('clock');
  raw.revision = 4;
  raw.controllerBounds = { x: -10, y: 20, width: 500, height: 300, unknown: true };
  raw.displayPreference = { mode: 'manual', fingerprint: { label: 'EDGE', physicalWidth: 1920, physicalHeight: 1080, unknown: true } };
  raw.scene.visible = false;
  raw.scene.pages[0].id = 'custom';
  raw.scene.pages[0].name = 'Custom';
  raw.scene.pages[0].regions[0].widgetId = 'not-in-catalog';
  raw.scene.pages[0].regions[0].bounds.width = 0.2;
  raw.scene.pages[0].regions.push({ id: 'extra' });
  raw.scene.pages.push({ id: 'extra' });
  raw.unknown = true;
  const normalized = normalizeState(raw, { defaultWidgetId: 'clock' });
  assert.equal(normalized.revision, 4);
  assert.equal(normalized.unknown, undefined);
  assert.deepEqual(normalized.controllerBounds, { x: -10, y: 20, width: 500, height: 300 });
  assert.deepEqual(normalized.displayPreference, { mode: 'manual', fingerprint: { label: 'EDGE', physicalWidth: 1920, physicalHeight: 1080 } });
  assert.equal(normalized.scene.visible, false);
  assert.equal(normalized.scene.activePageId, 'custom');
  assert.equal(normalized.scene.pages.length, 1);
  assert.equal(normalized.scene.pages[0].regions.length, 1);
  assert.equal(normalized.scene.pages[0].regions[0].widgetId, 'not-in-catalog');
  assert.deepEqual(normalized.scene.pages[0].regions[0].bounds, { x: 0, y: 0, width: 1, height: 1 });
});

test('invalid schema fields and unsupported versions fall back to usable defaults', () => {
  for (const raw of [null, [], 3, { version: 99 }, { version: 1, revision: -1,
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
  assert.deepEqual(store.snapshot().widgetSettings, {});
  store.update(state => { state.widgetSettings = { other: { color: 'red' } }; });
  store.mergeLegacySettings({ clock: { inputGain: 140 }, other: { color: 'blue', speed: 2 }, invalid: null });
  await store.flush();
  const reloaded = createStateStore({ statePath, defaultWidgetId: 'clock' });
  const state = reloaded.snapshot();
  assert.deepEqual(state.widgetSettings, { clock: { inputGain: 140 }, other: { color: 'red', speed: 2 } });
  assert.deepEqual(state.scene.pages[0].regions[0].settings, { inputGain: 140 });
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
