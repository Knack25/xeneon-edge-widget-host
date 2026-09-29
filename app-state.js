const fs = require('node:fs');
const path = require('node:path');
const { MAX_PAGES, NAVIGATION_POSITIONS } = require('./page-model');

const STATE_VERSION = 2;
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
    if (Array.isArray(item) && item.length > 10000 - count) throw new TypeError('Settings exceed JSON limits');
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
    controllerBounds: null,
    displayPreference: { mode: 'automatic', fingerprint: null },
    scene: {
      visible: true,
      activePageId: 'page-1',
      navigationPosition: 'bottom-right',
      pages: [{ id: 'page-1', name: 'Page 1', regions: [{
        id: 'primary', widgetId: nonemptyString(defaultWidgetId, null), settings: {},
        bounds: { ...FULL_PAGE_BOUNDS }
      }], widgetSettings: {} }]
    }
  };
}

function validPage(page) {
  const validString = value => typeof value === 'string' && value.trim().length > 0;
  if (!isRecord(page) || !validString(page.id) || !validString(page.name) || page.name.trim().length > 80 ||
    !Array.isArray(page.regions) || page.regions.length !== 1 || !isRecord(page.regions[0])) return false;
  const region = page.regions[0];
  return validString(region.id) && (region.widgetId === null || validString(region.widgetId)) &&
    isRecord(region.settings) && isRecord(region.bounds) &&
    Object.keys(FULL_PAGE_BOUNDS).every(key => region.bounds[key] === FULL_PAGE_BOUNDS[key]);
}

function validScene(scene, version) {
  if (!isRecord(scene) || typeof scene.visible !== 'boolean' || !Array.isArray(scene.pages) ||
    scene.pages.length < 1 || scene.pages.length > (version === 1 ? 1 : MAX_PAGES) ||
    scene.pages.some(page => !validPage(page))) return false;
  const ids = scene.pages.map(page => page.id);
  if (new Set(ids).size !== ids.length) return false;
  if (version === 2 && (!NAVIGATION_POSITIONS.includes(scene.navigationPosition) ||
    scene.pages.some(page => !isRecord(page.widgetSettings)))) return false;
  return true;
}

function settingsAreLossless(scene, version) {
  function equalWithoutGetters(raw, normalized) {
    if (raw === null || typeof raw !== 'object') return Object.is(raw, normalized);
    if ((Array.isArray(raw) !== Array.isArray(normalized)) ||
      (!Array.isArray(raw) && (!isRecord(raw) || !isRecord(normalized))) ||
      Object.getOwnPropertySymbols(raw).length) return false;
    const keys = Object.keys(raw);
    if (keys.length !== Object.keys(normalized).length) return false;
    if (Array.isArray(raw) && raw.length !== normalized.length) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Object.hasOwn(normalized, key) ||
        !equalWithoutGetters(descriptor.value, normalized[key])) return false;
    }
    return true;
  }
  return scene.pages.every(page =>
    equalWithoutGetters(page.regions[0].settings, normalizeSettings(page.regions[0].settings)) &&
    (version === 1 || equalWithoutGetters(page.widgetSettings, normalizeWidgetSettings(page.widgetSettings))));
}

function normalizeState(raw, { defaultWidgetId } = {}) {
  const state = createDefaultState(defaultWidgetId);
  if (!isRecord(raw) || ![1, STATE_VERSION].includes(raw.version)) return state;
  if (Number.isSafeInteger(raw.revision) && raw.revision >= 0) state.revision = raw.revision;
  if (typeof raw.legacySettingsMigrated === 'boolean') state.legacySettingsMigrated = raw.legacySettingsMigrated;
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
  if (!validScene(raw.scene, raw.version)) return state;
  state.scene.navigationPosition = raw.version === 2 ? raw.scene.navigationPosition : 'bottom-right';
  state.scene.pages = raw.scene.pages.map(page => {
    const region = page.regions[0];
    const settings = normalizeSettings(region.settings);
    const widgetSettings = raw.version === 1 ? normalizeWidgetSettings(raw.widgetSettings) : normalizeWidgetSettings(page.widgetSettings);
    if (raw.version === 1 && region.widgetId && !UNSAFE_KEYS.has(region.widgetId)) {
      widgetSettings[region.widgetId] = { ...widgetSettings[region.widgetId], ...settings };
    }
    return { id: page.id, name: page.name.trim(), widgetSettings, regions: [{
      id: region.id, widgetId: region.widgetId, settings, bounds: { ...FULL_PAGE_BOUNDS }
    }] };
  });
  state.scene.activePageId = state.scene.pages.some(page => page.id === raw.scene.activePageId) ? raw.scene.activePageId : state.scene.pages[0].id;
  return state;
}

// Only startup recovery classifies the persisted schema. Extra metadata and
// formatting/key-order changes are benign; lost settings or invalid known
// fields warrant retaining the original file before the first rewrite.
function persistedRecoveryReason(raw, normalized) {
  if (!isRecord(raw) || ![1, STATE_VERSION].includes(raw.version)) return 'unsupported-state';
  const validBounds = value => isRecord(value) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0;
  const preference = raw.displayPreference;
  const fingerprint = preference?.fingerprint;
  const validFingerprint = value => isRecord(value) && typeof value.label === 'string' && ['physicalWidth', 'physicalHeight'].every(key => Number.isFinite(value[key]) && value[key] > 0);
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0 ||
    (raw.legacySettingsMigrated !== undefined && typeof raw.legacySettingsMigrated !== 'boolean') ||
    (raw.controllerBounds !== null && !validBounds(raw.controllerBounds)) ||
    !isRecord(preference) || !['automatic', 'manual'].includes(preference.mode) ||
    (fingerprint !== null && !validFingerprint(fingerprint)) || (preference.mode === 'manual' && !validFingerprint(fingerprint)) ||
    !validScene(raw.scene, raw.version)) return 'invalid-state';
  for (const [index, page] of raw.scene.pages.entries()) {
    const normalizedPage = normalized.scene.pages[index];
    if (JSON.stringify(page.regions[0].settings) !== JSON.stringify(normalizedPage.regions[0].settings) ||
      (raw.version === 2 && JSON.stringify(page.widgetSettings) !== JSON.stringify(normalizedPage.widgetSettings))) return 'lossy-state';
  }
  if (raw.version === 1 && raw.widgetSettings !== undefined &&
    JSON.stringify(raw.widgetSettings) !== JSON.stringify(normalizeWidgetSettings(raw.widgetSettings))) return 'lossy-state';
  if (!raw.scene.pages.some(page => page.id === raw.scene.activePageId)) return 'invalid-active-page';
  return null;
}

function createStateStore({ statePath, defaultWidgetId, writeDelayMs = 100 } = {}) {
  if (typeof statePath !== 'string' || !statePath) throw new TypeError('statePath is required');
  if (!Number.isFinite(writeDelayMs) || writeDelayMs < 0) throw new TypeError('writeDelayMs must be nonnegative');
  let state = createDefaultState(defaultWidgetId);
  let dirty = true;
  let timer = null;
  let recovery = null;
  let readOnly = false;
  let source;
  try {
    source = fs.readFileSync(statePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (source !== undefined) {
    let parsed;
    let reason = null;
    try {
      parsed = JSON.parse(source);
    } catch {
      reason = 'parse-error';
    }
    if (parsed !== undefined) {
      if (isRecord(parsed) && Number.isSafeInteger(parsed.version) && parsed.version > STATE_VERSION) {
        readOnly = true;
        dirty = false;
        recovery = { status: 'read-only', reason: 'unsupported-version' };
      } else {
        state = normalizeState(parsed, { defaultWidgetId });
        reason = persistedRecoveryReason(parsed, state);
        dirty = JSON.stringify(parsed) !== JSON.stringify(state);
      }
    }
    if (reason) {
      const timestamp = new Date().toISOString().replace(/[^0-9TZ]/g, '-');
      let suffix = 0;
      for (;;) {
        const backupPath = `${statePath}.corrupt-${timestamp}${suffix ? `-${suffix}` : ''}`;
        try { fs.copyFileSync(statePath, backupPath, fs.constants.COPYFILE_EXCL); break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; suffix++; }
      }
      recovery = { status: 'recovered', reason };
      dirty = true;
    }
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  async function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (readOnly) return;
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
    if (readOnly) throw new Error('Unsupported state version: read-only recovery');
    if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
    if (state.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('State revision is exhausted');
    const draft = snapshot();
    mutator(draft);
    draft.version = STATE_VERSION;
    draft.revision = state.revision + 1;
    if (!validScene(draft.scene, STATE_VERSION)) {
      const ids = Array.isArray(draft.scene?.pages) ? draft.scene.pages.map(page => page?.id) : [];
      if (new Set(ids).size !== ids.length) throw new TypeError('Duplicate page ID');
      throw new TypeError('Invalid scene');
    }
    if (!settingsAreLossless(draft.scene, STATE_VERSION)) throw new TypeError('Invalid page settings');
    if (!draft.scene.pages.some(page => page.id === draft.scene.activePageId)) throw new TypeError('Invalid active page ID');
    state = normalizeState(draft, { defaultWidgetId });
    dirty = true;
    scheduleWrite();
    return snapshot();
  }

  function mergeLegacySettings(settings) {
    if (readOnly) throw new Error('Unsupported state version: read-only recovery');
    if (state.legacySettingsMigrated) return false;
    update(draft => {
      const page = draft.scene.pages[0];
      const region = page.regions[0];
      const legacy = normalizeWidgetSettings(settings);
      for (const [widgetId, saved] of Object.entries(legacy)) {
        page.widgetSettings[widgetId] = { ...saved, ...page.widgetSettings[widgetId] };
      }
      region.settings = { ...page.widgetSettings[region.widgetId], ...region.settings };
      if (region.widgetId && !UNSAFE_KEYS.has(region.widgetId)) {
        page.widgetSettings[region.widgetId] = { ...region.settings };
      }
      draft.legacySettingsMigrated = true;
    });
    return true;
  }

  if (dirty) scheduleWrite();
  return { snapshot, update, mergeLegacySettings, flush, recoveryDiagnostic: () => recovery && { ...recovery } };
}

module.exports = { STATE_VERSION, createDefaultState, normalizeState, createStateStore };
