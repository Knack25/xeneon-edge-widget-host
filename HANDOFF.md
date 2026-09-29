# Multi-page Mac handoff

Updated 2026-09-29. Working branch: `feat/multi-page-navigation`.
The approved design is in [multi-page-design.md](docs/superpowers/specs/2026-09-29-multi-page-design.md).
This branch has not been merged or pushed.

The controller creates, names, reorders, selects and deletes pages. Each page
contains one full-size widget and its own host-managed settings. Numbered Edge
buttons select pages in one of six saved positions. Page IDs survive rename and
reorder. The Edge loads pages on first visit and retains visited frames until
deletion, replacement or Edge destruction. A failed first visit keeps the
previous page visible and reports the requested page in the controller.
Pending preparation follows the latest request when revisiting a still-loading
page. Edge selection runs in isolated world 1001 with trusted native button input;
the main-world bridge has no page-selection method. Legacy widget DOM/storage
access remains unchanged; this is not a hostile-widget sandbox.

Version 2 state stores page order, active page ID, navigation position, page
settings, visibility, display preference and controller bounds. A version 1
profile migrates its single page and remembered widget settings. State writes
remain atomic with backup/recovery behavior for invalid data. The limit is
12 pages, with names of 1–80 trimmed characters. Widget-authored localStorage
and cookies remain shared by same-origin pages for arbitrary widgets. Doodle is
the narrow exception: the host gives bundled and managed Doodle versions a
page-scoped storage identity. One legacy shared drawing is copied to the first
Doodle page opened; other Doodle pages start blank. Separate Doodle drawings
were confirmed on the physical Edge through switching, re-import, Hide/Show,
display reconnect and normal-profile restart. Storage-write failure remains a
documented limitation; other widgets are not isolated.
Unsupported future state versions show a read-only controller diagnostic and
preserve the original file; controller close and quit still complete normally.

## Evidence and acceptance

See [multi-page validation](docs/validation/2026-09-29-multi-page-macos.md)
for the current Node suite, real Electron smoke and physical checklist.
The smoke ran only after a fresh check found port 8080 free; it used an isolated
profile and left the normal-profile app untouched. It passed both exercise and
restart phases. Do not close, relaunch or disturb the normal-profile app for
future testing without the user's direction. Automated smoke does not establish
physical multi-page acceptance.

The [two-window validation](docs/validation/2026-09-22-two-window-macos.md)
records the earlier build. The multi-page build has now passed direct tap,
pointer-return, drawing/scrolling, six-position, Dock, reconnect, restart,
Hide/Show and re-import checks. The last-page deletion guard was left to
automated tests to preserve user pages. A deliberately unavailable-widget page
was verified in isolated Electron smoke, not the user's normal profile. The
branch remains local, unmerged and unpushed.

## Next steps

After changes, rerun `npm test`, and run `npm run test:smoke` only when port
8080 is available. Inspect `artifacts/smoke-result.json` plus screenshots;
diagnose failures and rerun affected checks. The current physical record is
up-to-date except the intentionally unexercised unavailable-widget and
last-page-guard cases.

Keep the normal-profile state and existing MacXeneonEdgeTouchDriver setup.
The smoke runner creates its own `artifacts/smoke-profile-*` userData, refuses
an occupied port and shuts down only its owned Electron children. The physical
test is needed for single taps, pointer return, drawing/scrolling, actual
button placement and native Dock coverage. Automated mouse events cannot
substitute for those observations.

## Operation and code map

Use native ARM64 Node.js 22 or newer on macOS 12 or later. Run `npm ci`,
`npm test`, then `npm start`. Electron is locked at 41.5.0. See
[README-MACOS.md](README-MACOS.md) for display matching, imports, actual
userData path semantics, lifecycle and limitations.

- `app-state.js`, `page-model.js`, `app-coordinator.js`: migration, page
  invariants, state, commands and page load status.
- `controller.html`, `controller.js`, `controller-view.js`,
  `preload-controller.js`: controller page controls and diagnostics.
- `edge.html`, `edge.js`, `edge-navigation.js`, `page-navigation.js`, `scene-runtime.js`,
  `widget-runtime.js`: Edge buttons, lazy retained runtimes and staged loads.
- `ipc-contract.js`, `preload-edge.js`, `window-factories.js`: sender
  boundaries and native presentation.
- `tests/`, `scripts/run-smoke.js`: Node coverage and isolated real Electron
  smoke. The smoke uses the production server, windows and widget frames.

Keep CommonJS, node:test and Conventional Commits. Preserve the MIT license,
DISCLAIMER NOTICE, widget author credits and upstream history. Packaging,
signing, macOS audio, telemetry, gesture navigation and multi-widget layouts
remain outside this branch's scope.
