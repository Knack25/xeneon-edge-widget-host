# Two-Window Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent laptop controller and an independent fullscreen XENEON Edge window so widgets and settings can change live without leaving Edge fullscreen.

**Architecture:** An Electron main-process coordinator owns versioned state, widget imports, display resolution, and both BrowserWindows. A controller-only renderer sends validated commands through a narrow preload API; an Edge-only renderer runs the sole live widget instance and swaps staged content in place.

**Tech Stack:** CommonJS Node.js 22+, Electron 41.5.0, browser HTML/CSS/JavaScript, `node:test`, loopback HTTP server.

**Spec:** `docs/superpowers/specs/2026-09-22-two-window-controller-design.md`

## Global Constraints

- Keep Electron at the locked 41.5.0 dependency; add no runtime dependencies.
- Preserve the MIT license, disclaimer, upstream history, and widget author credits.
- Keep the server on `127.0.0.1:8080` and fail if that port is occupied.
- Use CommonJS and the existing `node:test` test runner.
- The controller never executes a live widget; the Edge owns the only live instance.
- Phase one permits exactly one page with one full-page region.
- The Edge has no app overlay and no Escape exit behavior.
- macOS Edge presentation uses simple fullscreen, accepts first mouse, and stays above the Dock only while visible.
- Do not guess when a saved or automatic display match is missing or ambiguous.
- Use Conventional Commits for every checkpoint.

## Review Focus

- Duplicate or renamed displays must produce an explicit ambiguous/unavailable state, never presentation on a guessed screen; Task 2 tests this.
- Closing the controller, closing the Edge, and quitting the app are different operations and must not accidentally stop the server or remaining window; Task 4 tests all three.
- Rapid widget selections may finish loading out of order; only the latest scene revision may become visible; Task 7 tests stale-load suppression.
- Imports may contain symlinks, malformed manifests, conflicting IDs, or fail midway through replacement; Task 3 tests rejection and rollback.
- Persisted state may be truncated or contain off-screen controller bounds and stale display IDs; Tasks 1 and 2 test backup, defaults, and safe placement.

---

### Task 1: Versioned application state store

**Files:**
- Create: `app-state.js`
- Create: `tests/app-state.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Node `fs`, `path`, and a caller-supplied default widget ID.
- Produces: `createDefaultState(defaultWidgetId)`, `normalizeState(raw, options)`, and `createStateStore(options)` with `snapshot()`, `update(mutator)`, `mergeLegacySettings(settings)`, and `flush()`.

- [ ] **Step 1: Add state-store tests and include them in `npm test`**

```js
test('default state contains one page and one full-size region', () => {
  const state = createDefaultState('clock');
  assert.equal(state.version, 1);
  assert.equal(state.scene.pages.length, 1);
  assert.deepEqual(state.scene.pages[0].regions[0], {
    id: 'primary', widgetId: 'clock', settings: {},
    bounds: { x: 0, y: 0, width: 1, height: 1 }
  });
});

test('corrupt state is backed up and replaced by defaults', async () => {
  fs.writeFileSync(statePath, '{broken');
  const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 0 });
  assert.equal(store.snapshot().scene.pages[0].regions[0].widgetId, 'clock');
  assert.equal(fs.readdirSync(temp).some(name => name.startsWith('state.json.corrupt-')), true);
  await store.flush();
});

test('legacy settings merge once into the matching region', async () => {
  const store = createStateStore({ statePath, defaultWidgetId: 'clock', writeDelayMs: 0 });
  assert.equal(store.mergeLegacySettings({ clock: { inputGain: 140 } }), true);
  assert.equal(store.mergeLegacySettings({ clock: { inputGain: 90 } }), false);
  assert.equal(store.snapshot().scene.pages[0].regions[0].settings.inputGain, 140);
});
```

Set the test script to run `tests/app-state.test.js` before existing suites.

- [ ] **Step 2: Run the new test to verify it fails**

Run: `node --test tests/app-state.test.js`

Expected: FAIL with `Cannot find module '../app-state'`.

- [ ] **Step 3: Implement schema normalization, debounced updates, and atomic writes**

```js
const STATE_VERSION = 1;

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
      pages: [{ id: 'page-1', name: 'Page 1', regions: [{
        id: 'primary', widgetId: defaultWidgetId, settings: {},
        bounds: { x: 0, y: 0, width: 1, height: 1 }
      }] }]
    }
  };
}
```

`normalizeState` must copy only known fields, require one page/one region,
normalize bounds back to the full-page constant, and fall back to defaults for
invalid values. `createStateStore.update` clones the snapshot, applies the
mutator, increments `revision`, normalizes, and schedules a write. `flush`
writes `<statePath>.tmp`, `fsync`s and closes it, then renames it to `statePath`.
On parse failure, rename the source to
`state.json.corrupt-<ISO timestamp with punctuation replaced by hyphens>`.

- [ ] **Step 4: Run state and existing tests**

Run: `node --test tests/app-state.test.js && npm test`

Expected: all state tests pass, followed by the existing 10 passing tests.

- [ ] **Step 5: Commit**

```bash
git add app-state.js tests/app-state.test.js package.json
git commit -m "feat: add versioned application state store"
```

---

### Task 2: Stable display targeting and controller placement

**Files:**
- Create: `display-policy.js`
- Create: `tests/display-policy.test.js`
- Modify: `presentation.js`
- Modify: `tests/presentation.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Electron display records and persisted `displayPreference`.
- Produces: `fingerprintDisplay(display)`, `resolveEdgeDisplay(displays, preference)`, `safeControllerBounds(savedBounds, displays, edgeDisplayId, primaryDisplay)`, `enterEdgePresentation(win, bounds, platform)`, and `leaveEdgePresentation(win, platform)`.

- [ ] **Step 1: Write display-policy regression tests**

```js
test('saved fingerprint restores only one matching display', () => {
  const preference = { mode: 'manual', fingerprint: fingerprintDisplay(edge) };
  assert.equal(resolveEdgeDisplay([laptop, edge], preference).display.id, edge.id);
  assert.equal(resolveEdgeDisplay([laptop, edge, { ...edge, id: 3 }], preference).reason, 'ambiguous');
});

test('session display ID is not part of persisted fingerprint', () => {
  assert.deepEqual(fingerprintDisplay({ ...edge, id: 999 }), fingerprintDisplay(edge));
});

test('controller bounds on Edge or off-screen fall back to primary work area', () => {
  const result = safeControllerBounds(edge.bounds, [laptop, edge], edge.id, laptop);
  assert.ok(result.x >= laptop.workArea.x && result.y >= laptop.workArea.y);
});
```

Also change the presentation test to assert that `enterEdgePresentation` calls
`setBounds`, `setSimpleFullScreen(true)`, and
`setAlwaysOnTop(true, 'pop-up-menu')`, while `leaveEdgePresentation` reverses
the level and fullscreen state without adding Escape listeners.

- [ ] **Step 2: Run tests to verify missing policy exports fail**

Run: `node --test tests/display-policy.test.js tests/presentation.test.js`

Expected: FAIL with missing `display-policy` module or exports.

- [ ] **Step 3: Implement deterministic display policy**

```js
function fingerprintDisplay(display) {
  const physical = [display.bounds.width, display.bounds.height]
    .map(value => Math.round(value * display.scaleFactor)).sort((a, b) => a - b);
  return { label: display.label || '', physicalWidth: physical[0], physicalHeight: physical[1] };
}

function resolveEdgeDisplay(displays, preference) {
  const candidates = preference.mode === 'manual'
    ? displays.filter(display => isFingerprintMatch(display, preference.fingerprint))
    : automaticCandidates(displays);
  if (candidates.length === 1) return { display: candidates[0], reason: 'matched' };
  return { display: null, reason: candidates.length ? 'ambiguous' : 'unavailable' };
}
```

Keep the existing name-first, physical-size-second automatic detection.
`safeControllerBounds` must require meaningful intersection with a non-Edge
display work area; otherwise return a centered 1100 × 720 rectangle constrained
to the primary work area.

- [ ] **Step 4: Run display and full unit suites**

Run: `node --test tests/display-policy.test.js tests/presentation.test.js && npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add display-policy.js presentation.js tests/display-policy.test.js tests/presentation.test.js package.json
git commit -m "feat: add stable Edge display policy"
```

---

### Task 3: Durable managed widget library

**Files:**
- Create: `widget-library.js`
- Create: `tests/widget-library.test.js`
- Create: `tests/web-server.test.js`
- Modify: `web-server.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: bundled widget root, managed widget root, import source paths.
- Produces: `createWidgetLibrary(options)` with `scan()`, `beginImport(sourcePath)`, `confirmReplacement(token)`, and `cancelReplacement(token)`; `createServer({ root, widgetLibrary, ... })` serves catalog entries through their declared `baseUrl`.

- [ ] **Step 1: Add catalog, import, and server traversal tests**

```js
test('new import becomes a durable managed catalog entry', () => {
  writeWidget(source, { id: 'sample.widget', name: 'Sample', version: '1.0.0' });
  const result = library.beginImport(source);
  assert.equal(result.status, 'installed');
  assert.equal(library.scan().find(item => item.id === 'sample.widget').source, 'managed');
});

test('same ID returns a one-use confirmation token and preserves settings externally', () => {
  writeWidget(sourceV1, { id: 'sample.widget', version: '1.0.0' });
  library.beginImport(sourceV1);
  writeWidget(sourceV2, { id: 'sample.widget', version: '2.0.0' });
  const pending = library.beginImport(sourceV2);
  assert.equal(pending.status, 'confirmation-required');
  assert.equal(library.confirmReplacement(pending.token).status, 'replaced');
  assert.throws(() => library.confirmReplacement(pending.token), /expired/i);
});

test('symlink import is rejected and failed replacement rolls back', () => {
  fs.symlinkSync(outsideFile, path.join(source, 'escape'));
  assert.throws(() => library.beginImport(source), /symbolic link/i);
  assert.equal(readInstalledVersion(managedRoot, 'sample.widget'), '1.0.0');
});

test('manifest ID cannot choose a managed filesystem path', () => {
  writeWidget(source, { id: '../../escape', version: '1.0.0' });
  library.beginImport(source);
  assert.equal(fs.existsSync(path.join(temp, 'escape')), false);
  assert.equal(library.scan().some(item => item.id === '../../escape'), true);
});

test('managed route cannot traverse its configured root', async () => {
  assert.equal((await request('/managed-widgets/%2e%2e/secret')).statusCode, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/widget-library.test.js tests/web-server.test.js`

Expected: FAIL because the managed library and injectable server routes do not exist.

- [ ] **Step 3: Implement catalog normalization and transactional imports**

```js
function normalizeCatalogEntry(rootType, folder, root, manifest) {
  const id = String(manifest.id || folder).trim();
  if (!id) throw new Error('Widget ID is required.');
  const prefix = rootType === 'managed' ? '/managed-widgets' : '/widgets';
  return {
    id, folder, source: rootType,
    entryUrl: `${prefix}/${encodeURIComponent(folder)}/index.html`,
    iconUrl: manifest.preview_icon ? `${prefix}/${encodeURIComponent(folder)}/${manifest.preview_icon}` : '',
    manifest
  };
}
```

Walk imports with `lstatSync`; reject every symbolic link. Require a regular
`index.html`. Copy into `<managedRoot>/.staging-<random>`. For replacement,
store a random one-use token mapped to the staging path and metadata. On
confirmation rename installed to `.backup-<random>`, rename staging to the
final folder, remove backup, and restore backup if promotion fails. Clear the
token on confirm or cancel. Managed folder names are
`sha256(widgetId).slice(0, 24)` and never use manifest text as a path segment.

- [ ] **Step 4: Make the server consume catalog `baseUrl` roots safely**

`createServer` receives the widget library. `/api/widgets` returns
`widgetLibrary.scan()`. `/managed-widgets/...` resolves only below
`managedRoot`; bundled `/widgets/...` remains below the repository root. Decode
once, reject NUL bytes, then reject any `path.relative` result beginning with
`..` or absolute.

- [ ] **Step 5: Run library, server, and full tests**

Run: `node --test tests/widget-library.test.js tests/web-server.test.js && npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add widget-library.js web-server.js tests/widget-library.test.js tests/web-server.test.js package.json
git commit -m "feat: add durable managed widget library"
```

---

### Task 4: Main-process application coordinator

**Files:**
- Create: `app-coordinator.js`
- Create: `tests/app-coordinator.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: state store, widget library, display policy, controller/Edge window factories, Electron `screen`, and server lifecycle.
- Produces: `createAppCoordinator(dependencies)` with `start()`, `snapshot()`, `selectWidget(id)`, `updateSetting(name, value)`, `selectDisplay(displayId)`, `setEdgeVisible(visible)`, `beginImport(sourcePath)`, `confirmImport(token)`, `cancelImport(token)`, `activate()`, and `quit()`.

- [ ] **Step 1: Write coordinator lifecycle and command tests with fake windows**

```js
test('closing controller leaves Edge and server alive; activate recreates controller', async () => {
  const runtime = fixture();
  await runtime.coordinator.start();
  runtime.controller.closeFromUser();
  assert.equal(runtime.edge.destroyed, false);
  assert.equal(runtime.server.closed, false);
  await runtime.coordinator.activate();
  assert.equal(runtime.controllerFactory.calls, 2);
});

test('quit disables recovery and closes both windows and server', async () => {
  const runtime = fixture();
  await runtime.coordinator.start();
  await runtime.coordinator.quit();
  assert.equal(runtime.controller.destroyed, true);
  assert.equal(runtime.edge.destroyed, true);
  assert.equal(runtime.server.closed, true);
  assert.equal(runtime.stateStore.flushed, true);
});

test('disconnect waits and uniquely matching reconnect restores Edge', async () => {
  const runtime = fixture();
  await runtime.coordinator.start();
  runtime.removeDisplay(edge.id);
  assert.equal(runtime.coordinator.snapshot().edge.status, 'disconnected');
  runtime.addDisplay({ ...edge, id: 44 });
  assert.equal(runtime.edgeFactory.calls, 2);
});
```

Add tests for rapid setting updates, unknown widget IDs, ambiguous display
selection, Edge renderer repeated failure with bounded retries, and previous
widget retention status after a load-failure report.

- [ ] **Step 2: Run coordinator tests to verify failure**

Run: `node --test tests/app-coordinator.test.js`

Expected: FAIL with missing `app-coordinator`.

- [ ] **Step 3: Implement coordinator transitions and snapshots**

```js
function createAppCoordinator(deps) {
  let controllerWindow = null;
  let edgeWindow = null;
  let quitting = false;
  let edgeStatus = 'hidden';

  function snapshot() {
    return Object.freeze({
      revision: deps.stateStore.snapshot().revision,
      state: structuredClone(deps.stateStore.snapshot()),
      widgets: deps.widgetLibrary.scan(),
      displays: deps.screen.getAllDisplays().map(publicDisplay),
      edge: { status: edgeStatus }
    });
  }
  // Return the public methods listed in Interfaces and keep BrowserWindow
  // references private to this closure.
}
```

Every mutating method validates input before calling `stateStore.update`.
Broadcast controller snapshots and Edge scene snapshots separately. Destroying
an Edge after explicit hide, disconnect, or quit must not enter crash recovery.
Unexpected `render-process-gone` gets at most two recreation attempts in 30
seconds; the third leaves Edge hidden and reports `failed`.

- [ ] **Step 4: Run coordinator and full tests**

Run: `node --test tests/app-coordinator.test.js && npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app-coordinator.js tests/app-coordinator.test.js package.json
git commit -m "feat: coordinate controller and Edge lifecycles"
```

---

### Task 5: Secure IPC, window factories, and production bootstrap

**Files:**
- Create: `ipc-contract.js`
- Create: `window-factories.js`
- Create: `preload-controller.js`
- Create: `preload-edge.js`
- Create: `tests/ipc-contract.test.js`
- Modify: `main.js`
- Modify: `tests/main.test.js`

**Interfaces:**
- Consumes: coordinator public methods from Task 4.
- Produces: `registerIpc({ ipcMain, coordinator, getControllerWindow, getEdgeWindow, dialog })`, `createControllerWindow(options)`, and `createEdgeWindow(options)`; renderer globals `window.icueController` and `window.icueEdge`.

- [ ] **Step 1: Add sender-authorization and two-window startup tests**

```js
test('mutating IPC accepts only controller main frame', async () => {
  const { handlers, controllerEvent, edgeEvent } = fixture();
  await handlers.get('scene:select-widget')(controllerEvent, 'clock');
  await assert.rejects(handlers.get('scene:select-widget')(edgeEvent, 'clock'), /controller/i);
});

test('Edge reports require current Edge main frame and revision', async () => {
  await assert.rejects(handlers.get('edge:load-result')(controllerEvent, { revision: 2, ok: true }), /Edge/i);
  await handlers.get('edge:load-result')(edgeEvent, { revision: 2, ok: true });
});

test('startup creates separate controller and Edge windows', async () => {
  const runtime = await boot();
  assert.equal(runtime.windows.length, 2);
  assert.match(runtime.windows.find(win => win.role === 'controller').url, /controller\.html/);
  assert.match(runtime.windows.find(win => win.role === 'edge').url, /edge\.html/);
});
```

- [ ] **Step 2: Run IPC and main tests to verify failure**

Run: `node --test tests/ipc-contract.test.js tests/main.test.js`

Expected: FAIL because the contracts and second window do not exist.

- [ ] **Step 3: Implement narrow preloads and IPC registration**

```js
contextBridge.exposeInMainWorld('icueController', {
  nativeControls: process.platform === 'darwin',
  getState: () => ipcRenderer.invoke('app:get-state'),
  onState: callback => ipcRenderer.on('app:state', (_event, value) => callback(value)),
  selectWidget: id => ipcRenderer.invoke('scene:select-widget', id),
  updateSetting: (name, value) => ipcRenderer.invoke('scene:update-setting', name, value),
  selectDisplay: id => ipcRenderer.invoke('display:select', id),
  setEdgeVisible: visible => ipcRenderer.invoke('edge:set-visible', visible),
  importWidget: () => ipcRenderer.invoke('widgets:import'),
  confirmImport: token => ipcRenderer.invoke('widgets:confirm-import', token),
  cancelImport: token => ipcRenderer.invoke('widgets:cancel-import', token),
  submitLegacySettings: settings => ipcRenderer.invoke('settings:migrate-legacy', settings),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close')
});
```

The Edge preload exposes only `getScene`, `onScene`, and `reportLoadResult`.
Registration compares `event.sender`, `event.senderFrame`, and the current
window `webContents`/`mainFrame` before dispatching.
The import handler calls `dialog.showOpenDialog(controllerWindow,
{ properties: ['openDirectory'] })`, then passes the single chosen path to
`coordinator.beginImport(sourcePath)`; cancellation returns `{ status:
'cancelled' }` without mutating the catalog.

- [ ] **Step 4: Implement window factories and replace `main.js` bootstrap**

Controller options include native macOS framing, macOS-only
`acceptFirstMouse: true`, and the existing frameless controls on Windows.
Edge options include `frame: false`, `fullscreenable: false`,
`acceptFirstMouse: true`, `show: false`, and the Edge preload. After load,
apply target bounds, simple fullscreen, and `pop-up-menu` level before showing.
`main.js` creates state/library/server/coordinator once, registers IPC once,
starts after `app.whenReady`, delegates `activate`, and calls coordinator quit
from `before-quit` with a reentrancy guard.

- [ ] **Step 5: Run IPC, main, and complete unit suites**

Run: `node --test tests/ipc-contract.test.js tests/main.test.js && npm test`

Expected: all tests pass with exactly two startup windows when Edge is available.

- [ ] **Step 6: Commit**

```bash
git add ipc-contract.js window-factories.js preload-controller.js preload-edge.js main.js tests/ipc-contract.test.js tests/main.test.js
git commit -m "feat: bootstrap secure two-window Electron host"
```

---

### Task 6: Laptop controller interface

**Files:**
- Create: `controller.html`
- Create: `controller.css`
- Create: `controller.js`
- Create: `controller-view.js`
- Create: `widget-settings.js`
- Create: `tests/controller-view.test.js`
- Modify: `app-config.js`

**Interfaces:**
- Consumes: `window.icueController` from Task 5 and coordinator snapshot shape from Task 4.
- Produces: `buildControllerViewModel(snapshot)`, `getSettingDefinitions(widget)`, `getDefaultWidgetSettings(widget)`, and a controller DOM with widget selection, settings, display, visibility, status, and import confirmation actions.

- [ ] **Step 1: Test safe view models and status mapping**

```js
test('view model uses manifest text without producing HTML', () => {
  const model = buildControllerViewModel(snapshotWithWidget({ name: '<img onerror=alert(1)>' }));
  assert.equal(model.widgets[0].name, '<img onerror=alert(1)>');
  assert.equal(Object.hasOwn(model.widgets[0], 'html'), false);
});

test('edge status distinguishes hidden, disconnected, ambiguous, and failed', () => {
  assert.equal(buildControllerViewModel(snapshotWithStatus('disconnected')).edge.message, 'Edge disconnected');
  assert.equal(buildControllerViewModel(snapshotWithStatus('ambiguous')).edge.actionDisabled, true);
});
```

- [ ] **Step 2: Run view tests to verify failure**

Run: `node --test tests/controller-view.test.js`

Expected: FAIL because `controller-view.js` does not exist.

- [ ] **Step 3: Implement the static controller layout**

Create a two-column responsive layout. Build widget cards with `createElement`
and `textContent`, never manifest-driven `innerHTML`. Show manifest thumbnails,
active state, search, metadata, settings, display picker, status, Show/Hide
Edge, Rescan, and Import widget folder. Do not include an iframe or load widget
entry URLs in the controller.

`widget-settings.js` owns the existing VU, Spectrum, AQI, and Doodle defaults
and the controller-visible definitions for range, checkbox, color, and text
controls. Both the controller and Task 7 runtime import this module so default
values and setting names cannot drift.

```js
function renderWidgetCard(widget, active) {
  const button = document.createElement('button');
  button.className = `widget-card${active ? ' active' : ''}`;
  button.dataset.widgetId = widget.id;
  const name = document.createElement('strong');
  name.textContent = widget.name;
  button.append(name);
  return button;
}
```

- [ ] **Step 4: Wire live commands, confirmation, and legacy migration**

On startup read `localStorage.getItem('icueWidgetRunner.widgetSettings.v1')`,
parse it inside `try/catch`, call `submitLegacySettings`, and remove the key only
after success. Range inputs call `updateSetting` on every `input` event. Import
results with `confirmation-required` open a native `<dialog>` showing installed
and incoming name/version; confirm and cancel invoke their matching token APIs.

- [ ] **Step 5: Run controller and full tests**

Run: `node --test tests/controller-view.test.js && npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add controller.html controller.css controller.js controller-view.js widget-settings.js tests/controller-view.test.js app-config.js
git commit -m "feat: add laptop widget controller"
```

---

### Task 7: Dedicated Edge renderer and staged widget runtime

**Files:**
- Create: `edge.html`
- Create: `edge.css`
- Create: `edge.js`
- Create: `widget-runtime.js`
- Create: `tests/widget-runtime.test.js`
- Modify: `runner-v2.js`

**Interfaces:**
- Consumes: `window.icueEdge`, catalog widget records, scene revision, region settings, `widget-settings.js`, and the existing widget compatibility shim behavior.
- Produces: `createWidgetRuntime({ document, fetchText, report })` with `load({ widget, settings, revision })`, `updateSettings({ settings, revision })`, and `destroy()`.

- [ ] **Step 1: Add shell, staging, and stale-load tests**

```js
test('successful staged load promotes one live frame', async () => {
  const runtime = createWidgetRuntime(fixture());
  await runtime.load({ widget: clock, settings: {}, revision: 1 });
  assert.equal(document.querySelectorAll('iframe[data-live="true"]').length, 1);
});

test('failed preparation keeps the previous live frame', async () => {
  await runtime.load({ widget: clock, settings: {}, revision: 1 });
  fetchText.rejectNext(new Error('missing'));
  await assert.rejects(runtime.load({ widget: doodle, settings: {}, revision: 2 }));
  assert.equal(liveFrame().dataset.widgetId, clock.id);
});

test('older load finishing last cannot replace the latest revision', async () => {
  const oldLoad = runtime.load({ widget: clock, settings: {}, revision: 2 });
  const newLoad = runtime.load({ widget: doodle, settings: {}, revision: 3 });
  await newLoad;
  await oldLoad;
  assert.equal(liveFrame().dataset.widgetId, doodle.id);
});
```

Add assertions that settings update the live frame shim and that the Edge HTML
contains no toolbar, exit button, controller status, or Escape listener.

- [ ] **Step 2: Run runtime tests to verify failure**

Run: `node --test tests/widget-runtime.test.js`

Expected: FAIL because the runtime module does not exist.

- [ ] **Step 3: Extract the compatibility runtime and implement staged swaps**

Move `normalizeManifest`, shell/shim construction, widget-kind defaults, and
settings application out of `runner-v2.js`. A load creates a hidden staging
iframe, assigns `srcdoc`, waits for its `load`, checks that its revision is still
current, marks it live, then removes the old frame. Failed or stale loads remove
only the staging frame.

```js
async function load({ widget, settings, revision }) {
  currentRevision = Math.max(currentRevision, revision);
  const frame = createStagingFrame(widget.id, revision);
  frame.srcdoc = buildWidgetShell(widget, await fetchText(widget.entryUrl), settings);
  await waitForFrameLoad(frame);
  if (revision !== currentRevision) { frame.remove(); return { stale: true }; }
  promote(frame);
  report({ revision, ok: true });
  return { stale: false };
}
```

- [ ] **Step 4: Wire `edge.js` to scene snapshots**

Request the initial scene, resolve its widget record, and call runtime load.
For a snapshot with the same widget ID call `updateSettings`; for a changed ID
call `load`. Report `{ revision, ok: false, message }` on preparation failure.
Render only `<main id="scene"><div id="primary-region"></div></main>`.

- [ ] **Step 5: Run runtime and full tests**

Run: `node --test tests/widget-runtime.test.js && npm test`

Expected: all tests pass and the existing shim assertions remain represented in
the new runtime tests.

- [ ] **Step 6: Commit**

```bash
git add edge.html edge.css edge.js widget-runtime.js runner-v2.js tests/widget-runtime.test.js
git commit -m "feat: add dedicated Edge widget runtime"
```

---

### Task 8: Real Electron two-window smoke coverage and legacy cleanup

**Files:**
- Modify: `tests/electron-smoke.js`
- Modify: `scripts/run-smoke.js`
- Modify: `package.json`
- Delete: `index.html`
- Delete: `preload.js`
- Delete: `presentation-ui.js`
- Delete: `runner-v2.js`

**Interfaces:**
- Consumes: the complete production app from Tasks 1-7.
- Produces: smoke artifacts and assertions for the shipped two-window workflow.

- [ ] **Step 1: Rewrite smoke expectations for explicit window roles**

```js
const windows = await until(() => {
  const all = BrowserWindow.getAllWindows();
  return all.length === 2 ? all : false;
}, 'controller and Edge windows');
const controller = windows.find(win => /controller\.html/.test(win.webContents.getURL()));
const edge = windows.find(win => /edge\.html/.test(win.webContents.getURL()));
assert.ok(controller);
assert.ok(edge);
```

Use the controller preload API to select Doodle and change a setting. Record the
Edge BrowserWindow ID before the command and assert the same ID remains,
fullscreen remains active, and the live frame changes. Close controller, assert
Edge animation continues, emit app activation, and assert one controller is
recreated. Assert Edge DOM lacks `exitPresentation` and send Escape to confirm
it does not hide the Edge.

- [ ] **Step 2: Run the smoke test to expose remaining integration failures**

Run: `npm run test:smoke`

Expected: FAIL until all old single-window URLs and selectors have been removed.

- [ ] **Step 3: Remove legacy single-window files and references**

Delete the old files only after `controller.html` and `edge.html` cover their
responsibilities. Remove `runner-v2.js` after Task 7 has moved every needed shim
and runtime function. Update server root behavior so `/` redirects or serves
`controller.html`, while production factories use explicit URLs.

- [ ] **Step 4: Run all automated verification**

Run: `npm test && npm run test:smoke`

Expected: all unit tests pass; the real Electron smoke report records two-window
startup, live swap, settings update, controller reopen, persistent Edge window,
and zero renderer errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: verify two-window Electron workflow"
```

---

### Task 9: Documentation and physical acceptance

**Files:**
- Modify: `README-MACOS.md`
- Modify: `README.md`
- Modify: `HANDOFF.md`
- Create: `docs/validation/2026-09-22-two-window-macos.md`

**Interfaces:**
- Consumes: final behavior and evidence from Tasks 1-8.
- Produces: accurate setup, operation, limitations, and hardware-validation records.

- [ ] **Step 1: Update user documentation**

Document controller versus Edge roles, Show/Hide behavior, controller close and
Dock reopen, automatic restore, durable imports and replacement confirmation,
state/import locations under Electron `userData`, and Command-Q shutdown. State
explicitly that phase one has one page/one widget and that page navigation and
multi-widget editing are subsequent features.

- [ ] **Step 2: Run the complete automated suite from a clean app state**

Run: `npm test && npm run test:smoke`

Expected: all tests pass and smoke artifacts identify `darwin arm64` when run on
the target Mac.

- [ ] **Step 3: Perform physical acceptance with the user**

Verify, in order:

1. Controller opens on the laptop and Edge remains fullscreen.
2. Select Clock, Doodle, and one imported widget without leaving fullscreen.
3. Change a visible setting and observe the live Edge update.
4. Confirm tap, scroll, Doodle hold-drag, pointer return, and Dock coverage.
5. Close controller, confirm Edge continues, then reopen from Dock.
6. Hide and show Edge only from the controller.
7. Unplug/reconnect Edge and confirm unique-match restoration.
8. Restart app and confirm saved widget/display/settings restoration.
9. Re-import the same widget ID, cancel once, then confirm once.
10. Command-Q and confirm controller, Edge, and server all exit.

Record each result as pass/fail with the actual macOS, architecture, Electron
version, display label/bounds, and any deviation. Do not include local hardware
identifiers beyond the display information needed for reproducibility.

- [ ] **Step 4: Commit documentation and evidence**

```bash
git add README-MACOS.md README.md HANDOFF.md docs/validation/2026-09-22-two-window-macos.md
git commit -m "docs: record two-window Mac validation"
```

- [ ] **Step 5: Final branch verification**

Run: `git status --short --branch && npm test`

Expected: clean `feat/two-window-controller` worktree and all tests passing.
