'use strict';
const defaultDisplayPolicy = require('./display-policy');
const { randomUUID } = require('node:crypto');
const pageModel = require('./page-model');
const { getDefaultWidgetSettings } = require('./widget-settings');

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const clone = value => JSON.parse(JSON.stringify(value));
const pageOf = state => pageModel.activePage(state.scene);
const regionOf = state => pageOf(state).regions[0];
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
// Optional window.presentationReady resolves true after the initial show, or
// false on failed loading/destruction. Activation awaits it before show/focus.
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
  const pageGenerations = new Map();
  const pageLoads = new Map();
  let currentRequestRevision = 0;
  let edgeState = { status: 'hidden', displayId: null, loadStatus: 'idle', error: null,
    retainedWidgetId: null, requestedPageId: null, presentedPageId: null };

  function syncPages() {
    const pages = stateStore.snapshot().scene.pages;
    const ids = new Set(pages.map(page => page.id));
    for (const page of pages) if (!pageGenerations.has(page.id)) pageGenerations.set(page.id, 1);
    for (const id of pageGenerations.keys()) if (!ids.has(id)) { pageGenerations.delete(id); pageLoads.delete(id); }
  }

  function bumpGeneration(pageId) {
    syncPages();
    pageGenerations.set(pageId, pageGenerations.get(pageId) + 1);
    pageLoads.delete(pageId);
  }

  function pageWidget(page) {
    return widgets.find(widget => widget.id === page.regions[0].widgetId) || null;
  }

  function pageLoadSnapshot() {
    return Object.fromEntries([...pageLoads].map(([id, value]) => [id, { ...value }]));
  }

  function assertRunning() {
    if (quitting) throw new Error('Application is quitting.');
  }

  function activeWidget() {
    return pageWidget(pageOf(stateStore.snapshot()));
  }

  function getScene() {
    const state = stateStore.snapshot();
    syncPages();
    return clone({ revision: state.revision, scene: state.scene, widget: activeWidget(), catalogRevision,
      pageWidgets: Object.fromEntries(state.scene.pages.map(page => [page.id, pageWidget(page)])),
      pageGenerations: Object.fromEntries(pageGenerations) });
  }

  function snapshot() {
    const state = stateStore.snapshot();
    return clone({ revision: state.revision, state, widgets,
      recovery: stateStore.recoveryDiagnostic?.() || null,
      selectedTargetDisplayId: resolveTarget().display?.id ?? null,
      displays: screen.getAllDisplays().map(publicDisplay),
      edge: { ...edgeState, widgetId: regionOf(state).widgetId, pageLoads: pageLoadSnapshot() } });
  }

  function broadcastController() {
    if (live(controllerWindow)) controllerWindow.webContents.send('app:state', snapshot());
  }

  function broadcast() {
    broadcastController();
    if (live(edgeWindow)) edgeWindow.webContents.send('edge:scene', getScene());
  }

  function prepareLoad() {
    const state = stateStore.snapshot();
    const id = state.scene.activePageId;
    const widget = activeWidget();
    edgeState.requestedPageId = id;
    currentRequestRevision = state.revision;
    if (!widget) {
      edgeState.loadStatus = 'failed';
      edgeState.error = `Widget unavailable: ${regionOf(state).widgetId}`;
      pageLoads.set(id, { status: 'failed', error: edgeState.error });
    } else {
      edgeState.loadStatus = 'loading';
      edgeState.error = null;
      pageLoads.set(id, { status: 'loading', error: null, generation: pageGenerations.get(id) });
    }
    edgeState.retainedWidgetId = edgeState.loadStatus === 'failed' ? loadedWidgetId : null;
  }

  function synchronizeActiveSettings() {
    if (stateStore.recoveryDiagnostic?.()?.status === 'read-only') return;
    const state = stateStore.snapshot();
    const page = pageOf(state);
    const region = page.regions[0];
    if (!safeName(region.widgetId)) return;
    const settings = { ...page.widgetSettings[region.widgetId], ...region.settings };
    if (JSON.stringify(settings) === JSON.stringify(region.settings) &&
      JSON.stringify(settings) === JSON.stringify(page.widgetSettings[region.widgetId])) return;
    stateStore.update(draft => {
      regionOf(draft).settings = settings;
      pageOf(draft).widgetSettings[region.widgetId] = settings;
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
    edgeState.presentedPageId = null;
    pageLoads.clear();
    syncPages();
    for (const id of pageGenerations.keys()) bumpGeneration(id);
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
      edgeState = { ...edgeState, status: 'hidden', displayId: null, loadStatus: 'idle', retainedWidgetId: null,
        presentedPageId: null };
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
    if (live(controllerWindow)) return controllerWindow;
    const resolution = resolveTarget();
    const bounds = displayPolicy.safeControllerBounds(stateStore.snapshot().controllerBounds,
      screen.getAllDisplays(), resolution.display?.id, screen.getPrimaryDisplay());
    const window = createControllerWindow({ bounds: clone(bounds) });
    controllerWindow = window;
    window.on('close', () => { if (!quitting) saveControllerBounds(window); });
    window.once('closed', () => { if (controllerWindow === window) controllerWindow = null; broadcast(); });
    return window;
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

  function activeTarget(pageId) {
    const state = stateStore.snapshot();
    if (typeof pageId !== 'string' || pageId !== state.scene.activePageId) throw new Error('Stale or inactive page target.');
    return pageOf(state);
  }

  function selectWidget({ pageId, widgetId } = {}) {
    assertRunning();
    activeTarget(pageId);
    if (!safeName(widgetId) || !widgets.some(widget => widget.id === widgetId)) throw new TypeError('Unknown widget ID.');
    const oldId = regionOf(stateStore.snapshot()).widgetId;
    stateStore.update(state => {
      const page = pageOf(state);
      const region = page.regions[0];
      if (safeName(region.widgetId)) page.widgetSettings[region.widgetId] = clone(region.settings);
      region.widgetId = widgetId;
      region.settings = clone(page.widgetSettings[widgetId] || {});
      page.widgetSettings[widgetId] = clone(region.settings);
    });
    if (oldId !== widgetId) bumpGeneration(pageId);
    prepareLoad(); broadcast(); return snapshot();
  }

  function updateSetting({ pageId, widgetId, name, value } = {}) {
    assertRunning();
    const page = activeTarget(pageId);
    if (widgetId !== page.regions[0].widgetId) throw new Error('Stale widget target.');
    if (!safeName(name)) throw new TypeError('Invalid setting name.');
    if (!(value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)))) throw new TypeError('Settings require a finite JSON primitive.');
    if (!safeName(widgetId) || !activeWidget()) throw new Error('Active widget is unavailable.');
    stateStore.update(state => {
      const region = regionOf(state);
      region.settings[name] = value;
      pageOf(state).widgetSettings[widgetId] = clone(region.settings);
    });
    broadcast(); return snapshot();
  }

  function createPage({ name } = {}) {
    assertRunning();
    const widget = activeWidget();
    const widgetId = widget?.id || null;
    const defaults = widget ? getDefaultWidgetSettings(widget) : {};
    let pageId;
    stateStore.update(state => {
      do { pageId = `page-${randomUUID()}`; } while (state.scene.pages.some(page => page.id === pageId));
      const page = pageModel.createPage(state.scene, { id: pageId, name, widgetId });
      page.regions[0].settings = clone(defaults);
      if (widgetId) page.widgetSettings[widgetId] = clone(defaults);
      state.scene.activePageId = pageId;
    });
    syncPages(); prepareLoad(); broadcast(); return snapshot();
  }

  function renamePage(args) {
    assertRunning();
    stateStore.update(state => { pageModel.renamePage(state.scene, args); });
    broadcast(); return snapshot();
  }

  function movePage({ pageId, direction } = {}) {
    assertRunning();
    const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : null;
    if (offset === null) throw new TypeError('Direction must be up or down.');
    stateStore.update(state => { pageModel.movePage(state.scene, { pageId, direction: offset }); });
    broadcast(); return snapshot();
  }

  function deletePage(args) {
    assertRunning();
    const previous = stateStore.snapshot().scene.activePageId;
    stateStore.update(state => { pageModel.deletePage(state.scene, args); });
    syncPages();
    if (previous !== stateStore.snapshot().scene.activePageId) prepareLoad();
    if (edgeState.presentedPageId === args?.pageId) {
      edgeState.presentedPageId = null;
      loadedWidgetId = null;
      edgeState.retainedWidgetId = null;
    }
    broadcast(); return snapshot();
  }

  function selectPage(args) {
    assertRunning();
    const previous = stateStore.snapshot().scene.activePageId;
    const wasFailed = edgeState.loadStatus === 'failed';
    stateStore.update(state => { pageModel.selectPage(state.scene, args); });
    const current = stateStore.snapshot().scene.activePageId;
    if (current === previous && wasFailed) bumpGeneration(current);
    prepareLoad(); broadcast(); return snapshot();
  }

  function setNavigationPosition(args) {
    assertRunning();
    stateStore.update(state => { pageModel.setNavigationPosition(state.scene, args); });
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
    if (!report || typeof report.pageId !== 'string' || typeof report.widgetId !== 'string' ||
      !Number.isSafeInteger(report.generation) || report.generation < 1 ||
      !Number.isSafeInteger(report.revision) || report.revision < 0 ||
      typeof report.ok !== 'boolean' || (report.message !== undefined && typeof report.message !== 'string') || !live(edgeWindow)) {
      throw new TypeError('Invalid Edge load report.');
    }
    const state = stateStore.snapshot();
    const page = state.scene.pages.find(item => item.id === report.pageId);
    if (!page || page.regions[0].widgetId !== report.widgetId ||
      pageGenerations.get(report.pageId) !== report.generation || report.revision > state.revision) return snapshot();
    if (report.pageId === state.scene.activePageId && report.revision < currentRequestRevision) return snapshot();
    const error = report.ok ? null : report.message || 'Widget failed to prepare.';
    pageLoads.set(report.pageId, { status: report.ok ? 'loaded' : 'failed', error, generation: report.generation });
    if (report.pageId === state.scene.activePageId && report.revision >= currentRequestRevision) {
      if (report.ok) {
        loadedWidgetId = report.widgetId;
        edgeState = { ...edgeState, loadStatus: 'loaded', error: null, retainedWidgetId: null,
          presentedPageId: report.pageId };
      } else {
        edgeState = { ...edgeState, loadStatus: 'failed', error,
          retainedWidgetId: loadedWidgetId };
      }
    }
    broadcastController(); return snapshot();
  }

  function scanWidgets(replacedWidgetId = null) {
    assertRunning();
    const catalog = widgetLibrary.scan().map(publicWidget);
    const before = new Map(widgets.map(widget => [widget.id, JSON.stringify(widget)]));
    const after = new Map(catalog.map(widget => [widget.id, JSON.stringify(widget)]));
    stateStore.update(() => {});
    widgets = catalog;
    catalogRevision++;
    let activeAffected = false;
    for (const page of stateStore.snapshot().scene.pages) {
      const id = page.regions[0].widgetId;
      if (id === replacedWidgetId || before.get(id) !== after.get(id)) {
        bumpGeneration(page.id);
        if (page.id === stateStore.snapshot().scene.activePageId) activeAffected = true;
      }
    }
    if (activeAffected) prepareLoad();
    broadcast(); return snapshot();
  }

  function rescanWidgets() { return scanWidgets(); }

  function importResult(result) {
    if (result.status === 'installed') scanWidgets();
    if (result.status === 'replaced') scanWidgets(result.entry.id);
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

  async function mergeLegacySettings(settings) {
    assertRunning();
    const merged = stateStore.mergeLegacySettings(settings);
    if (merged) { synchronizeActiveSettings(); broadcast(); }
    // A failed previous write may already have set the in-memory marker. The
    // renderer may remove its durable source only after this retry also flushes.
    await stateStore.flush();
    return merged;
  }

  async function activate() {
    assertRunning();
    await start();
    assertRunning();
    const window = openController();
    const ready = window.presentationReady ? await window.presentationReady : true;
    assertRunning();
    if (ready !== false && window === controllerWindow && live(window)) {
      window.show();
      window.focus();
    }
    broadcast();
    return snapshot();
  }

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

  return { start, snapshot, getScene, createPage, renamePage, movePage, deletePage, selectPage,
    setNavigationPosition, selectWidget, updateSetting, selectDisplay, setEdgeVisible,
    reportLoadResult, rescanWidgets, beginImport, confirmImport, cancelImport, mergeLegacySettings, activate, quit,
    getControllerWindow: () => live(controllerWindow) ? controllerWindow : null,
    getEdgeWindow: () => live(edgeWindow) ? edgeWindow : null };
}

module.exports = { createAppCoordinator };
