# Multi-page Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add independently configured pages and touch-friendly Edge navigation while retaining visited widget instances.

**Architecture:** The coordinator owns persistent page configuration and requested selection. An Edge scene manager retains one runtime per visited page and promotes only the current requested page after readiness. Controller and Edge navigation share validated page-selection commands without changing native windows.

**Tech Stack:** CommonJS/browser UMD JavaScript, Electron 41.5.0, node:test, existing dependencies only.

**Spec:** `docs/superpowers/specs/2026-09-29-multi-page-design.md`, approved 2026-09-29 including the 12-page limit and widget-owned storage caveat.

## Global Constraints

- At most 12 pages; at least one page; names of 1–80 trimmed characters.
- One full-size region per page; stable unique page IDs.
- Six navigation presets: top-left, top-center, top-right, bottom-left, bottom-center, bottom-right; default bottom-right.
- At least 44 CSS-pixel navigation touch targets; navigation hidden for one page.
- Independent host-managed settings; no promise of isolated widget-owned storage.
- Retain visited inactive runtimes; lazy first load; no swipe/wheel interception.
- Preserve native fullscreen, driver, controller close/reopen and display handling.
- Use `feat/multi-page-navigation`, Conventional Commits; no merge/push without authorization.
- Do not interrupt the running normal-profile app for automated smoke.

## Review Focus

- Rapid Edge/controller switches and late callbacks must not present an obsolete page (Tasks 2, 3).
- Same widget on two pages and delayed setting events must not cross-contaminate settings (Tasks 1, 2, 5).
- Re-import, page deletion and disconnected display must not resurrect stale frames (Tasks 3, 6).
- Corrupt or future-version state must not be silently overwritten (Task 1).
- Background widgets must retain canvas size and remain unreachable to touch/keyboard input (Tasks 3, 4, 6).

## File ownership and dependency order

`app-state.js` owns persistence/migration; new `page-model.js` owns pure scene mutations.
`app-coordinator.js` owns commands, catalog resolution and presentation status;
`ipc-contract.js` and preloads own authorization/exposure. `widget-runtime.js` remains
the single-widget loader; new `scene-runtime.js` owns retained pages. New
`page-navigation.js` owns Edge navigation DOM; `edge.js` connects both. Controller
files own page editing UI. Corresponding node tests and real smoke verify boundaries.

Execute Tasks 1–6 in order. For every task: run its tests red before implementation,
run them green afterward, then run the full `npm test` suite before its commit.
Add new test filenames to the explicit package.json test command in their task.

### Task 1: Versioned page model and migration

**Files:** Create `page-model.js`, `tests/page-model.test.js`; modify `app-state.js`, `tests/app-state.test.js`, `package.json`.

**Interfaces:** Export `MAX_PAGES = 12`, `NAVIGATION_POSITIONS`, `activePage(scene)`,
`createPage(scene, { id, name, widgetId })`, `renamePage(scene, { pageId, name })`,
`movePage(scene, { pageId, direction })`, `deletePage(scene, { pageId })`,
`selectPage(scene, { pageId })`, `setNavigationPosition(scene, { position })`.
Mutations operate on a draft scene and throw on invalid inputs; coordinator generates
IDs via `crypto.randomUUID()`. Page adds `widgetSettings: { [widgetId]: settings }`;
scene adds `navigationPosition`. Existing state-store public methods remain stable.

- [ ] Write tests: version-1 migration keeps all profile preferences and active settings; page cache receives inactive remembered settings; independent pages can hold literal Clock settings `{backgroundColor:'#112233'}` and `{backgroundColor:'#445566'}` without changing each other. Existing migration acknowledgements survive.
- [ ] Write invariants tests: add page 12 succeeds, 13 throws; last-page deletion throws; deleting active middle page selects previous ID; rename preserves ID; reorder preserves active ID; blank/81-character names and duplicate IDs fail; all six presets round-trip; invalid active ID recovers with diagnostic. Unknown future-version file bytes remain unchanged after attempted startup mutation, with writes blocked and a visible recovery diagnostic.
- [ ] Run `node --test tests/page-model.test.js tests/app-state.test.js`; expect failures for missing exports/version-2 behavior.
- [ ] Implement version-2 normalization/validation and explicit v1 migration. Preserve atomic writes and invalid-state backups; unsupported future versions enter read-only recovery rather than overwriting. Remove global settings coupling; route legacy settings merge into the migrated first page cache without erasing explicit settings.
- [ ] Run targeted tests and `npm test`; require zero failures. Commit `feat: add persistent independent page model`.

### Task 2: Coordinator commands and narrow IPC

**Files:** Modify `app-coordinator.js`, `ipc-contract.js`, `preload-controller.js`, `preload-edge.js`, `tests/app-coordinator.test.js`, `tests/ipc-contract.test.js`, `tests/main.test.js`.

**Interfaces:** Coordinator adds `createPage({name})`, `renamePage({pageId,name})`,
`movePage({pageId,direction})` (`up`/`down`), `deletePage({pageId})`,
`selectPage({pageId})`, `setNavigationPosition({position})`.
Change `selectWidget` to `selectWidget({pageId,widgetId})` and `updateSetting` to
`updateSetting({pageId,widgetId,name,value})`; reject non-active/stale targets.
Controller preload exposes these object signatures. Edge preload adds only
`selectPage({pageId})`, authenticated through `edge:select-page`.
Controller channels use `pages:create`, `pages:rename`, `pages:move`, `pages:delete`,
`pages:select`, `pages:set-navigation-position`.

Scene snapshot adds resolved `pageWidgets: {[pageId]: widget|null}` and
`pageGenerations: {[pageId]: integer}`. Increment a page generation on widget
replacement, affected catalog replacement or reload after lifecycle recovery.
Load reports use `{pageId,widgetId,generation,revision,ok,message}`. Controller
presentation status distinguishes `requestedPageId`, `presentedPageId` and error.

- [ ] Write tests for page-scoped widget caches, explicit stale-target rejection, active-ID rather than array-index access, Add using current widget defaults, bounded commands and unknown IDs. Verify create/name/order/settings/placement never invoke native fullscreen or move APIs.
- [ ] Write report tests: inactive page success cannot change presented status; deleted page/old generation reports are ignored; late previous-request success is ignored; request to failed active page retries with a fresh generation. Controller main frame may edit pages; Edge may only select; iframe/stale-window senders are rejected.
- [ ] Run `node --test tests/app-coordinator.test.js tests/ipc-contract.test.js tests/main.test.js`; observe expected red failures.
- [ ] Implement using Task 1 draft mutations; resolve catalog entries for every page. Keep existing import/display/lifecycle behavior. Reports for current requested page alone may advance presented status; hidden-page failure is retained per page for diagnostics. Broadcast active selection and status atomically after state mutation.
- [ ] Update existing command callers/test fixtures to explicit target objects. Run targeted tests and `npm test`; commit `feat: coordinate page commands and edge selection`.

### Task 3: Retained scene runtime

**Files:** Create `scene-runtime.js`, `tests/scene-runtime.test.js`; modify `widget-runtime.js`, `edge.js`, `edge.html`, `edge.css`, `tests/widget-runtime.test.js`, `package.json`.

**Interfaces:** `createWidgetRuntime` accepts optional explicit `container` (defaults
to existing primary-region for compatibility). Its `load` returns
`{stale:boolean,ok:boolean,message?:string}` at preparation completion without
weakening current error reporting. New `createSceneRuntime({document,createRuntime,
report,onPresentation})` exposes `receive(snapshot) -> Promise<void>` and `destroy()`.
`createRuntime` receives `{container,report}`; `onPresentation({pageId})` fires only
after successful visible promotion. Edge delegates snapshots to this manager.

- [ ] Write controlled-navigation tests: A→B→A reuses A's exact frame/runtime; first visit alone creates B; rename/reorder/position do not recreate either; same-widget page settings reach only their runtime. Container size remains full-size while inactive.
- [ ] Write race tests: B pending then C succeeds then B resolves leaves C visible; B failure leaves A visible; selecting B again retries; deleting pending B prevents promotion and destroys it once. A widget re-import invalidates matching inactive runtimes for lazy reload while leaving unrelated pages untouched. Destroy cancels all outstanding operations and releases all frames.
- [ ] Run `node --test tests/scene-runtime.test.js tests/widget-runtime.test.js`; require expected red failures.
- [ ] Implement map entries `{pageId,widgetId,generation,runtime,container,ready}`. Keep background containers offscreen with full dimensions, inert and aria-hidden. Promote only the latest request token after successful load; leave former presented page visible on failure. Apply settings updates to retained pages without switching them. Dispose on deletion; invalidate on generation/catalog change; keep bounds fixed during page switches.
- [ ] Update Edge subscriptions and script order, keeping subscribe-before-query and stale-snapshot protection. Run targeted tests and `npm test`; commit `feat: retain visited edge page runtimes`.

### Task 4: Touch-safe Edge page controls

**Files:** Create `page-navigation.js`, `tests/page-navigation.test.js`; modify `edge.html`, `edge.css`, `edge.js`, `package.json`.

**Interfaces:** `createPageNavigation({document,onSelect})` exposes
`render({pages,requestedPageId,presentedPageId,position})` and `destroy()`.
`onSelect(pageId)` calls Task 2 Edge bridge. Render uses presented ID for active
styling and requested ID only for loading indication. Numbering follows page order.

- [ ] Write DOM-behavior tests: one-page cluster absent/hidden; two pages have numbered buttons and name-based labels; button activation emits exactly its stable ID; reorder changes labels not IDs; all six presets change cluster position without runtime calls. Blur does not hide navigation. Tab/Enter/Space are native button behavior; no wheel/swipe listener is installed.
- [ ] Run `node --test tests/page-navigation.test.js`; observe red failures.
- [ ] Implement inset, wrapping cluster with minimum 44px targets. Only cluster hit areas intercept input; transparent surrounding layer uses pointer-events:none, cluster restores pointer-events:auto. Use native buttons and aria-current for active state. Hide cluster for one page and dispose event handlers on teardown.
- [ ] Connect scene presentation callback to navigation and authenticated selection; failures are reported through controller status. Run targeted tests and `npm test`; commit `feat: add configurable edge page buttons`.

### Task 5: Controller page editor

**Files:** Modify `controller.html`, `controller.css`, `controller.js`, `controller-view.js`, `tests/controller-view.test.js`; create `tests/controller-pages.test.js`; modify `package.json`.

**Interfaces:** View model adds `pages`, `activePageId`, `navigationPosition`,
`canAddPage`, `canDeletePage`, `presentedPageId`. Controller uses Task 2 preload
object commands; selection from either window is reflected from snapshots only.

- [ ] Write tests: page selection refreshes settings even for the same widget ID; queued input events carry captured page/widget targets and cannot affect the new active page; Add disabled at 12; deletion disabled at one; boundary move buttons disabled; rename 80-char validation; confirmation cancellation sends no delete command. Six preset options restore current setting and submit live changes.
- [ ] Write tests that selecting a failed page remains retryable and requested/presented mismatch is clearly shown. Names entered as markup render as text. Controller thumbnails stay static and never create widget iframes.
- [ ] Run `node --test tests/controller-view.test.js tests/controller-pages.test.js`; observe red failures.
- [ ] Implement page list and Add/Rename forms with explicit validation, Move up/down, confirmed Delete, and navigation position selector. Confirm text warns that deleting discards live widget state. Rebuild or retarget setting handlers on page identity changes, not solely widget ID. Preserve current import and window controls.
- [ ] Run targeted tests and `npm test`; commit `feat: edit pages and navigation position in controller`.

### Task 6: Integration, hardware acceptance and handoff

**Files:** Modify `tests/electron-smoke.js`, `README-MACOS.md`, `HANDOFF.md`; create `docs/validation/2026-09-29-multi-page-macos.md`.

**Interfaces:** Use production commands from Task 2 and real scene manager from Task 3. Smoke assertions must query actual widget frame/window state, not test-only production methods.

- [ ] Add a failing real-Electron scenario: migrate an isolated v1 profile, create two Doodle pages, send real canvas mouse events inside each frame, sample their canvas pixels and prove distinct strokes survive A→B→A with identical frame IDs and full dimensions. Observe an inactive-frame timer/state counter, explicitly recording throttling rather than asserting exact cadence. Check inactive frames cannot receive Tab focus.
- [ ] Cover all six navigation presets, native Edge/window ID stability, controller close/reopen, reload/re-import invalidation, deleted-page cleanup, restart restoring active page/settings/order/placement, and quit closing the server. Verify unavailable widget/loading failure leaves the prior page visible with controller diagnostic.
- [ ] Before smoke, inspect port 8080 ownership. If normal app is running, defer smoke until user authorizes closing it; never kill unknown processes. Run `npm test` and `npm run test:smoke` on an available port with the existing isolated-profile runner; record counts, versions, timestamps and failures.
- [ ] Run physical checklist with user: single tap navigation/pointer return; independent same-widget settings and Doodle switch-back drawings; six placements; unaffected drawing/scrolling; page CRUD; re-import; Hide/Show; reconnect; controller close/Dock reopen; native Dock coverage; restart; Command-Q. Record only confirmed results, leaving untested cases pending.
- [ ] Update documentation with approved storage caveat, 12-page resource limit, lazy retention and lifecycle limits. Mark spec implementation status accurately; update HANDOFF from completed two-window acceptance to current multi-page evidence. Run `git diff --check` and full suite before commit `docs: record multi-page validation and operation`.
- [ ] Obtain whole-branch independent review; resolve findings with regression tests, rerun affected verification, and report final evidence. Do not merge/push or claim hardware acceptance until authorized/confirmed.

## Execution handoff

The user previously chose cost-conscious subagent development. Preserve that method
unless they ask to change it: one bounded implementer per task plus independent
review gates, without parallel edits to shared coordinator/state/runtime files.
Use a capable mid-tier implementer and reserve the strongest reviewer for the final
whole-branch review. Read the execution skill before dispatching; implementation
must wait for the user's review of this written plan.
