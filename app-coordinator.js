'use strict';
const defaultDisplayPolicy = require('./display-policy');

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const clone = value => JSON.parse(JSON.stringify(value));
const regionOf = state => state.scene.pages[0].regions[0];
const live = window => window && !window.isDestroyed();

function safeName(value) {
  return typeof value === 'string' && value.trim().length > 0 && !UNSAFE_KEYS.has(value.trim());
}

function publicWidget(entry) {
  const { id, folder, source, baseUrl, entryUrl, iconUrl, manifest } = entry;
  return clone({ id, folder, source, baseUrl, entryUrl, iconUrl, manifest });
}

function publicDisplay(display) {
  const { id, label, internal, scaleFactor, bounds, workArea } = display;
  return clone({ id, label: label || '', internal: Boolean(internal), scaleFactor, bounds, workArea });
}

// Factories load their renderer and own ready-to-show placement/presentation.
// No widget or setting command moves a native window.
function createAppCoordinator({ stateStore, widgetLibrary, screen,
  createControllerWindow, createEdgeWindow, startServer,
  displayPolicy = defaultDisplayPolicy, now = Date.now }) {
  let controllerWindow = null;
  let edgeWindow = null;
  let server = null;
  let startPromise = null;
  let quitPromise = null;
  let quitting = false;
  let widgets = [];
  let catalogRevision = 0;
  let targetDisplay = null;
  let selectedDisplayId = null;
  let automaticFingerprint = null;
  let recoveryAttempts = [];
  let recoveryFailed = false;
  let loadedWidgetId = null;
  let edgeState = { status: 'hidden', displayId: null, loadStatus: 'idle', error: null, retainedWidgetId: null };

  function assertRunning() {
    if (quitting) throw new Error('Application is quitting.');
  }

  function activeWidget() {
    const id = regionOf(stateStore.snapshot()).widgetId;
    return widgets.find(widget => widget.id === id) || null;
  }

  function getScene() {
    const state = stateStore.snapshot();
    return clone({ revision: state.revision, scene: state.scene, widget: activeWidget(), catalogRevision });
  }

  function snapshot() {
    const state = stateStore.snapshot();
    return clone({ revision: state.revision, state, widgets,
      displays: screen.getAllDisplays().map(publicDisplay),
      edge: { ...edgeState, widgetId: regionOf(state).widgetId } });
  }

  function broadcastController() {
    if (live(controllerWindow)) controllerWindow.webContents.send('app:state', snapshot());
  }

  function broadcast() {
    broadcastController();
    if (live(edgeWindow)) edgeWindow.webContents.send('edge:scene', getScene());
  }

  function prepareLoad() {
    edgeState.loadStatus = activeWidget() ? 'loading' : 'failed';
    edgeState.error = activeWidget() ? null : `Widget unavailable: ${regionOf(stateStore.snapshot()).widgetId}`;
    edgeState.retainedWidgetId = edgeState.loadStatus === 'failed' ? loadedWidgetId : null;
  }

  function synchronizeActiveSettings() {
    const state = stateStore.snapshot();
    const region = regionOf(state);
    if (!safeName(region.widgetId)) return;
    const settings = { ...state.widgetSettings[region.widgetId], ...region.settings };
    if (JSON.stringify(settings) === JSON.stringify(region.settings) &&
      JSON.stringify(settings) === JSON.stringify(state.widgetSettings[region.widgetId])) return;
    stateStore.update(draft => {
      regionOf(draft).settings = settings;
      draft.widgetSettings[region.widgetId] = settings;
    });
  }

  function resolveTarget() {
    const displays = screen.getAllDisplays();
    if (selectedDisplayId !== null) {
      const selected = displays.find(display => display.id === selectedDisplayId);
      if (selected) return { display: selected, reason: 'matched' };
      selectedDisplayId = null;
    }
    const preference = stateStore.snapshot().displayPreference;
    const effective = preference.mode === 'automatic' && automaticFingerprint ?
      { mode: 'manual', fingerprint: automaticFingerprint } : preference;
    const resolution = displayPolicy.resolveEdgeDisplay(displays, effective);
    if (preference.mode === 'automatic' && resolution.display && !automaticFingerprint) {
      // Session-scoped: unplugging the selected Edge must not adopt another Edge.
      automaticFingerprint = displayPolicy.fingerprintDisplay(resolution.display);
    }
    return resolution;
  }

  function destroyEdge() {
    const previous = edgeWindow;
    edgeWindow = null;
    targetDisplay = null;
    loadedWidgetId = null;
    edgeState.displayId = null;
    if (live(previous)) previous.destroy();
  }

  function recoverEdge(window, details) {
    if (quitting || window !== edgeWindow || !stateStore.snapshot().scene.visible) return;
    destroyEdge();
    recoveryAttempts = recoveryAttempts.filter(timestamp => now() - timestamp < 30000);
    if (recoveryAttempts.length >= 2) {
      recoveryFailed = true;
      edgeState.status = 'failed';
      edgeState.loadStatus = 'failed';
      edgeState.error = `Edge renderer failed repeatedly: ${details?.reason || 'unknown failure'}`;
      edgeState.retainedWidgetId = null;
      broadcast();
      return;
    }
    recoveryAttempts.push(now());
    reconcileEdge();
    broadcast();
  }

  function reconcileEdge() {
    if (quitting) return;
    if (!stateStore.snapshot().scene.visible) {
      destroyEdge();
      edgeState = { ...edgeState, status: 'hidden', loadStatus: 'idle', error: null, retainedWidgetId: null };
      return;
    }
    if (recoveryFailed) return;
    const { display, reason } = resolveTarget();
    if (!display) {
      destroyEdge();
      edgeState = { ...edgeState, status: reason === 'ambiguous' ? 'ambiguous' : 'disconnected',
        loadStatus: 'idle', error: null, retainedWidgetId: null };
      return;
    }
    if (live(edgeWindow) && targetDisplay.id === display.id &&
      JSON.stringify(targetDisplay.bounds) === JSON.stringify(display.bounds)) return;
    destroyEdge();
    targetDisplay = clone(display);
    edgeState.status = 'active';
    edgeState.displayId = display.id;
    prepareLoad();
    const window = createEdgeWindow({ display: clone(display), scene: getScene() });
    edgeWindow = window;
    window.webContents.on('render-process-gone', (_event, details) => recoverEdge(window, details));
    window.once('closed', () => {
      if (edgeWindow !== window) return;
      edgeWindow = null;
      targetDisplay = null;
      loadedWidgetId = null;
      edgeState = { ...edgeState, status: 'hidden', displayId: null, loadStatus: 'idle', retainedWidgetId: null };
      broadcast();
    });
  }

  function saveControllerBounds(window) {
    if (!live(window)) return;
    const bounds = window.getBounds();
    if (JSON.stringify(bounds) === JSON.stringify(stateStore.snapshot().controllerBounds)) return;
    stateStore.update(state => { state.controllerBounds = clone(bounds); });
  }

  function openController() {
    assertRunning();
    if (live(controllerWindow)) { controllerWindow.show(); controllerWindow.focus(); return; }
    const resolution = resolveTarget();
    const bounds = displayPolicy.safeControllerBounds(stateStore.snapshot().controllerBounds,
      screen.getAllDisplays(), resolution.display?.id, screen.getPrimaryDisplay());
    const window = createControllerWindow({ bounds: clone(bounds) });
    controllerWindow = window;
    window.on('close', () => { if (!quitting) saveControllerBounds(window); });
    window.once('closed', () => { if (controllerWindow === window) controllerWindow = null; broadcast(); });
  }

  function topologyChanged() {
    if (!quitting) {
      // Invalidate disconnected session IDs even while the Edge is hidden or failed.
      resolveTarget();
      reconcileEdge();
      broadcast();
    }
  }

  function start() {
    assertRunning();
    if (!startPromise) startPromise = (async () => {
      widgets = widgetLibrary.scan().map(publicWidget);
      synchronizeActiveSettings();
      server = await startServer();
      if (quitting) return snapshot();
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, topologyChanged);
      openController();
      reconcileEdge();
      broadcast();
      return snapshot();
    })();
    return startPromise;
  }

  function selectWidget(id) {
    assertRunning();
    if (!safeName(id) || !widgets.some(widget => widget.id === id)) throw new TypeError('Unknown widget ID.');
    stateStore.update(state => {
      const region = regionOf(state);
      if (safeName(region.widgetId)) state.widgetSettings[region.widgetId] = region.settings;
      region.widgetId = id;
      region.settings = clone(state.widgetSettings[id] || {});
      state.widgetSettings[id] = region.settings;
    });
    prepareLoad(); broadcast(); return snapshot();
  }

  function updateSetting(name, value) {
    assertRunning();
    if (!safeName(name)) throw new TypeError('Invalid setting name.');
    if (!(value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)))) throw new TypeError('Settings require a finite JSON primitive.');
    const id = regionOf(stateStore.snapshot()).widgetId;
    if (!safeName(id) || !activeWidget()) throw new Error('Active widget is unavailable.');
    stateStore.update(state => {
      const region = regionOf(state);
      region.settings[name] = value;
      state.widgetSettings[id] = region.settings;
    });
    broadcast(); return snapshot();
  }

  function selectDisplay(displayId) {
    assertRunning();
    const display = screen.getAllDisplays().find(item => item.id === displayId);
    if (displayId !== 'automatic' && (!Number.isSafeInteger(displayId) || !display)) throw new TypeError('Choose a connected display.');
    stateStore.update(state => {
      state.displayPreference = displayId === 'automatic' ? { mode: 'automatic', fingerprint: null } :
        { mode: 'manual', fingerprint: displayPolicy.fingerprintDisplay(display) };
    });
    selectedDisplayId = displayId === 'automatic' ? null : displayId;
    automaticFingerprint = null;
    reconcileEdge(); broadcast(); return snapshot();
  }

  function setEdgeVisible(visible) {
    assertRunning();
    if (typeof visible !== 'boolean') throw new TypeError('Visibility must be a boolean.');
    stateStore.update(state => { state.scene.visible = visible; });
    if (visible) { recoveryAttempts = []; recoveryFailed = false; }
    reconcileEdge(); broadcast(); return snapshot();
  }

  function reportLoadResult(report) {
    assertRunning();
    if (!report || !Number.isSafeInteger(report.revision) || report.revision !== stateStore.snapshot().revision ||
      typeof report.ok !== 'boolean' || (report.message !== undefined && typeof report.message !== 'string') || !live(edgeWindow)) {
      throw new TypeError('Invalid or stale Edge load report.');
    }
    if (report.ok && !activeWidget()) throw new Error('Active widget is unavailable.');
    if (report.ok) {
      loadedWidgetId = regionOf(stateStore.snapshot()).widgetId;
      edgeState = { ...edgeState, loadStatus: 'loaded', error: null, retainedWidgetId: null };
    } else {
      edgeState = { ...edgeState, loadStatus: 'failed', error: report.message || 'Widget failed to prepare.', retainedWidgetId: loadedWidgetId };
    }
    broadcastController(); return snapshot();
  }

  function rescanWidgets() {
    assertRunning();
    const catalog = widgetLibrary.scan().map(publicWidget);
    stateStore.update(() => {});
    widgets = catalog;
    catalogRevision++;
    prepareLoad(); broadcast(); return snapshot();
  }

  function importResult(result) {
    if (result.status === 'installed' || result.status === 'replaced') rescanWidgets();
    return result.entry ? { status: result.status, entry: publicWidget(result.entry) } : clone(result);
  }

  function beginImport(sourcePath) {
    assertRunning();
    if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath.includes('\0')) throw new TypeError('Import requires a folder path.');
    return importResult(widgetLibrary.beginImport(sourcePath));
  }

  function validateToken(token) {
    assertRunning();
    if (typeof token !== 'string' || !token.trim()) throw new TypeError('Import requires a replacement token.');
  }

  function confirmImport(token) { validateToken(token); return importResult(widgetLibrary.confirmReplacement(token)); }
  function cancelImport(token) { validateToken(token); return clone(widgetLibrary.cancelReplacement(token)); }

  function mergeLegacySettings(settings) {
    assertRunning();
    const merged = stateStore.mergeLegacySettings(settings);
    if (merged) { synchronizeActiveSettings(); broadcast(); }
    return merged;
  }

  async function activate() { assertRunning(); await start(); assertRunning(); openController(); broadcast(); return snapshot(); }

  function closeServer() {
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  function quit() {
    if (quitPromise) return quitPromise;
    quitting = true;
    quitPromise = (async () => {
      // A quit during async startup still owns the server startup has opened.
      if (startPromise) await startPromise.catch(() => {});
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, topologyChanged);
      saveControllerBounds(controllerWindow);
      destroyEdge();
      const window = controllerWindow;
      controllerWindow = null;
      if (live(window)) window.destroy();
      try { await stateStore.flush(); }
      finally { await closeServer(); }
    })();
    return quitPromise;
  }

  return { start, snapshot, getScene, selectWidget, updateSetting, selectDisplay, setEdgeVisible,
    reportLoadResult, rescanWidgets, beginImport, confirmImport, cancelImport, mergeLegacySettings, activate, quit,
    getControllerWindow: () => live(controllerWindow) ? controllerWindow : null,
    getEdgeWindow: () => live(edgeWindow) ? edgeWindow : null };
}

module.exports = { createAppCoordinator };
