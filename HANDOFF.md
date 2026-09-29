# Two-window Mac handoff

Updated 2026-09-29. Tasks 1–8 implementation baseline: `265ddd3`.
Implementation lives in isolated `feat/two-window-implementation`; the original
`feat/two-window-controller` retains the approved spec and plan. No merge or push
is authorized by this checkpoint.

The static controller opens on the primary Mac display; Edge owns the sole live
widget. Selection/settings preserve Edge fullscreen. Controller close keeps Edge
and server running; Dock activation recreates/focuses the controller. Hide/Show
destroys/recreates only Edge, preserving its scene. Command-Q closes both windows,
flushes state and closes `127.0.0.1:8080`. Edge has no app overlay or Escape exit.
See [README-MACOS.md](README-MACOS.md) for operation, durable imports, display
fingerprints and actual userData path semantics.

Phase one has one page/one full-page widget. Page creation and Edge-initiated
navigation come next, with gesture/button testing against scrolling and drawing.
Simultaneous multi-widget layout/editing follows on a later branch.

## Evidence and next acceptance

Current automated tests and real Mac/Edge smoke are recorded in
[validation](docs/validation/2026-09-22-two-window-macos.md). Task 8's final baseline
passed 111 node:test cases and real smoke on darwin arm64 / Electron 41.5.0,
targeting the actual XENEON EDGE. The final-review fix wave passed 124/124 tests
and refreshed real smoke at 2026-09-29T15:45:55.893Z with zero renderer errors.
The record contains Task 9 and final-fix verification dates and logs.

Smoke proves native windows/runtime selection, live settings, animation after
controller close, activation recreation, Hide/Show and app.quit/server cleanup.
It does not accept physical touch, visual Dock occlusion, Dock clicking, physical
Command-Q, unplug/reconnect, restart restoration or native import UI. All ten
physical checks are PENDING until user confirmation on this build. Prior
single-window confirmations are historical context only. Preserve the existing
touch-driver setup; do not infer a driver reinstall from an app window issue.

Continue by inspecting `git status` and preserving local work. Use the validation
checklist in order with the user, record actual pass/fail and deviations, and
diagnose reproducible failures before targeted changes. Do not alter or relaunch
a user's running app/profile for tests. Smoke uses an isolated profile and refuses
an occupied port.

## Setup and code map

On Apple Silicon use native ARM64 Node.js 22 or newer, `npm ci`, then `npm start`.
No build/package step or iCUE installation is required. Keep Electron 41.5.0 and
macOS 12 or later. `run-all.sh` and audio helpers retain Linux/Pi assumptions;
browser-only mode does not provide native controller IPC.

- `main.js`, `app-coordinator.js`, `window-factories.js`: server/two-window
  lifecycle, native presentation, state/command coordination and recovery.
- `display-policy.js`, `presentation.js`: display fingerprints, safe controller
  bounds and shared native presentation helpers.
- `app-state.js`: state, per-widget settings, one-time legacy migration with a
  durable acknowledgement, atomic persistence and invalid-state backup/recovery.
- `widget-library.js`, `web-server.js`: bundled/managed catalog, staged imports,
  confirmed same-ID overrides and canonical server routes.
- `controller.html`, `controller.js`, `controller-view.js`, `preload-controller.js`:
  static library/settings UI and narrow controller bridge.
- `edge.html`, `edge.js`, `widget-runtime.js`, `preload-edge.js`: sole live widget,
  staged preparation, settings and restricted load reporting.
- `tests/`, `scripts/run-smoke.js`, `scripts/smoke-child.js`: node:test boundaries
  and real Electron smoke with bounded owned-child shutdown.

## Constraints and provenance

Keep CommonJS, node:test, existing runtime dependencies and locked Electron.
Use Conventional Commits. Preserve MIT LICENSE, DISCLAIMER NOTICE, all widget
author credits and upstream history. Public repository:
[Knack25/xeneon-edge-widget-host](https://github.com/Knack25/xeneon-edge-widget-host),
based on Corsair-Labs/iCUE-widget-runner-RaspberryPi commit
`1c3318533aa201f3d7a1b4b3526b8a2e2ca69630`.

No packaging/signing/notarization/login launch, `.icuewidget` archive importer,
macOS audio, real telemetry or integrations are implemented. Folder validation
exists, but arbitrary widget scripts are not a hardened trust boundary. Historical
audit findings need reassessment before distribution. No paid software is required
for the offline clock or this workflow.
