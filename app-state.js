const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;
const FULL_PAGE_BOUNDS = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonemptyString(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

// Settings are widget-owned JSON data. Reject values JSON would silently lose
// or coerce, and omit prototype-related keys at every nesting level.
function normalizeSettings(value) {
  if (!isRecord(value)) return {};
  const ancestors = new Set();
  let count = 0;
  function copy(item, depth) {
    if (++count > 10000 || depth > 64) throw new TypeError('Settings exceed JSON limits');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!Array.isArray(item) && !isRecord(item)) throw new TypeError('Settings must contain JSON values');
    if (ancestors.has(item)) throw new TypeError('Settings must not contain cycles');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Settings must use string keys');
    ancestors.add(item);
    const result = Array.isArray(item) ? [] : {};
    const keys = Array.isArray(item) ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(item);
    for (const key of keys) {
      if (UNSAFE_KEYS.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Settings must not contain accessors or sparse arrays');
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  try {
    return copy(value, 0);
  } catch {
    return {};
  }
}

function normalizeWidgetSettings(value) {
  const result = {};
  if (!isRecord(value)) return result;
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key) || !key.trim()) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !isRecord(descriptor.value)) continue;
    result[key] = normalizeSettings(descriptor.value);
  }
  return result;
}

function createDefaultState(defaultWidgetId) {
  return {
    version: STATE_VERSION,
    revision: 0,
    legacySettingsMigrated: false,
    widgetSettings: {},
    controllerBounds: null,
    displayPreference: { mode: 'automatic', fingerprint: null },
    scene: {
      visible: true,
      activePageId: 'page-1',
      pages: [{ id: 'page-1', name: 'Page 1', regions: [{
        id: 'primary', widgetId: nonemptyString(defaultWidgetId, null), settings: {},
        bounds: { ...FULL_PAGE_BOUNDS }
      }] }]
    }
  };
}

function normalizeState(raw, { defaultWidgetId } = {}) {
  const state = createDefaultState(defaultWidgetId);
  if (!isRecord(raw) || raw.version !== STATE_VERSION) return state;
  if (Number.isSafeInteger(raw.revision) && raw.revision >= 0) state.revision = raw.revision;
  if (typeof raw.legacySettingsMigrated === 'boolean') state.legacySettingsMigrated = raw.legacySettingsMigrated;
  state.widgetSettings = normalizeWidgetSettings(raw.widgetSettings);
  const bounds = raw.controllerBounds;
  if (isRecord(bounds) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0) {
    state.controllerBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }
  const preference = raw.displayPreference;
  if (isRecord(preference)) {
    if (preference.mode === 'automatic' || preference.mode === 'manual') state.displayPreference.mode = preference.mode;
    const fingerprint = preference.fingerprint;
    if (isRecord(fingerprint) && typeof fingerprint.label === 'string' && Number.isFinite(fingerprint.physicalWidth) && fingerprint.physicalWidth > 0 && Number.isFinite(fingerprint.physicalHeight) && fingerprint.physicalHeight > 0) {
      state.displayPreference.fingerprint = { label: fingerprint.label, physicalWidth: fingerprint.physicalWidth, physicalHeight: fingerprint.physicalHeight };
    }
  }
  if (!isRecord(raw.scene)) return state;
  if (typeof raw.scene.visible === 'boolean') state.scene.visible = raw.scene.visible;
  const page = Array.isArray(raw.scene.pages) ? raw.scene.pages[0] : null;
  if (!isRecord(page)) return state;
  const normalizedPage = state.scene.pages[0];
  normalizedPage.id = nonemptyString(page.id, normalizedPage.id);
  normalizedPage.name = nonemptyString(page.name, normalizedPage.name);
  state.scene.activePageId = normalizedPage.id;
  const region = Array.isArray(page.regions) ? page.regions[0] : null;
  if (isRecord(region)) {
    const normalizedRegion = normalizedPage.regions[0];
    normalizedRegion.id = nonemptyString(region.id, normalizedRegion.id);
    normalizedRegion.widgetId = nonemptyString(region.widgetId, normalizedRegion.widgetId);
    normalizedRegion.settings = normalizeSettings(region.settings);
  }
  return state;
}

function createStateStore({ statePath, defaultWidgetId, writeDelayMs = 100 } = {}) {
  if (typeof statePath !== 'string' || !statePath) throw new TypeError('statePath is required');
  if (!Number.isFinite(writeDelayMs) || writeDelayMs < 0) throw new TypeError('writeDelayMs must be nonnegative');
  let state = createDefaultState(defaultWidgetId);
  let dirty = true;
  let timer = null;
  let source;
  try {
    source = fs.readFileSync(statePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (source !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      const timestamp = new Date().toISOString().replace(/[^0-9TZ]/g, '-');
      fs.renameSync(statePath, `${statePath}.corrupt-${timestamp}`);
    }
    if (parsed !== undefined) {
      state = normalizeState(parsed, { defaultWidgetId });
      dirty = JSON.stringify(parsed) !== JSON.stringify(state);
    }
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  async function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.tmp`;
    const descriptor = fs.openSync(temporaryPath, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, statePath);
    dirty = false;
  }

  function scheduleWrite() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      // Keep the state dirty on failure so an explicit flush can retry and
      // report the error to the application during shutdown.
      flush().catch(() => {});
    }, writeDelayMs);
    timer.unref();
  }

  function update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
    if (state.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('State revision is exhausted');
    const draft = snapshot();
    mutator(draft);
    draft.version = STATE_VERSION;
    draft.revision = state.revision + 1;
    state = normalizeState(draft, { defaultWidgetId });
    dirty = true;
    scheduleWrite();
    return snapshot();
  }

  function mergeLegacySettings(settings) {
    if (state.legacySettingsMigrated) return false;
    update(draft => {
      const region = draft.scene.pages[0].regions[0];
      const legacy = normalizeWidgetSettings(settings);
      for (const [widgetId, saved] of Object.entries(legacy)) {
        draft.widgetSettings[widgetId] = { ...saved, ...draft.widgetSettings[widgetId] };
      }
      region.settings = { ...draft.widgetSettings[region.widgetId], ...region.settings };
      if (region.widgetId && !UNSAFE_KEYS.has(region.widgetId)) {
        draft.widgetSettings[region.widgetId] = { ...region.settings };
      }
      draft.legacySettingsMigrated = true;
    });
    return true;
  }

  if (dirty) scheduleWrite();
  return { snapshot, update, mergeLegacySettings, flush };
}

module.exports = { STATE_VERSION, createDefaultState, normalizeState, createStateStore };
