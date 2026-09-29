# Multi-page macOS validation

Execution date: 2026-09-29. Branch: `feat/multi-page-navigation`.
This record distinguishes automated evidence from physical acceptance.

## Environment and automated evidence

macOS 27.0 (build 26A428), darwin arm64, Node.js 26.9.0,
npm 11.19.1 and Electron 41.5.0. The real display report identifies
the built-in Retina Display at (0, 0, 1440, 900), scale 2, and the
XENEON EDGE at (-501, 900, 2560, 720), scale 1.

`npm test`: PASS, 183/183 node:test cases, zero failures, cancellations
or skips. It ran with loopback permission for the web-server cases.
`node --check tests/electron-smoke.js`,
`node --check scripts/run-smoke.js` and `git diff --check`: PASS.

`npm run test:smoke`: PASS at 2026-09-29T18:29:02.184Z after the
whole-branch final fixes. The runner
checked that port 8080 was free before launching. It created one isolated
`artifacts/smoke-profile-*` userData directory, ran an exercise phase,
closed its Electron child/server, reopened the same isolated profile for a
restart phase, then closed that child/server. Port 8080 had no listener
afterward. The normal-profile app and data were not changed.

The [local smoke report](../../artifacts/smoke-result.json) and
`artifacts/controller-electron.png` /
`artifacts/edge-multi-page-electron.png` are ignored local artifacts.
The report's `success` is true. Its one renderer error is the deliberate
`smoke expected failure` widget used to verify failure retention; there
were no unexpected renderer errors.

The real Electron scenario observed:

- Production migration of an isolated version 1 profile to version 2,
  retaining its page ID, active setting and remembered inactive-widget setting.
- An Edge numbered-button mouse selection; two real Doodle canvases received
  different mouse strokes. The sampled pixels stayed distinct on
  A→B→A→B→A; B's stroke was sampled again after switching back to B,
  while native Electron frame tree IDs stayed [3, 4] and the Edge window
  remained fullscreen.
- Script running in a real widget frame found no callable parent page-selection
  bridge. Its `.click()` and dispatched synthetic click did not change the
  requested page. Native mouse input on the same button still selected it.
  Selection handlers and capability run in isolated world 1001; legacy widgets
  still share the host DOM origin, so this does not claim hostile-widget sandboxing.
- Both inactive frames retained the full display width and height with
  `inert` and `aria-hidden`; Tab did not focus the inactive page. An inactive
  timer counter reached 11 ticks during
  the observation window. This records execution, not an exact cadence
  guarantee or absence of throttling.
- All six saved navigation positions, including cluster bounds and placement,
  while the full-size widget frame and native Edge window ID stayed stable.
- Active-page deletion removed its frame and selected the previous page.
  A controlled first visit to a different, unvisited failing page kept
  Original presented while Failure was requested. The controller named both
  pages in its diagnostic; the Edge button for Original stayed current and
  the Failure button carried the requested marker. The prior Doodle frame
  remained interactive. Same-ID Doodle re-import refreshed the active
  instance and invalidated an inactive one until its next visit. The test
  supplies a fixed folder path to the production import flow; it does not
  exercise a human choice in the native directory picker.
- Controller close/reopen kept the same Edge window. Hide/Show recreated the
  Edge and restored the active page; Edge reload restored it again, including
  navigation that was then exercised with a native mouse click.
  Restart restored active page, page order, navigation position and a
  page-specific setting. `app.quit` closed both isolated Electron runs and
  the loopback server. Physical Command-Q was not pressed.

The latest isolated smoke (2026-09-29T19:03:43.807Z) runs the page-specific
Doodle storage fix. It verifies a blank second Doodle page, distinct drawings,
and both drawings restored independently after a full app restart. It does not
establish behavior for every imported Doodle variant or storage-write failure;
physical normal-profile retesting remains pending.

Focused regressions first reproduced pending B→A→B preparation failing to
promote, future-version controller close throwing before cleanup, and the missing
read-only controller diagnostic. They now pass. Future-version recovery also
verifies quit closes windows/server while preserving original state bytes.
Self-review added a failing reload regression before the isolated-navigation
reload fix. The real-frame selection bypass failed before its capability fix.

## Physical acceptance — pending

The two-window build's [earlier physical results](2026-09-22-two-window-macos.md)
are historical and do not accept multi-page behavior. Have the user confirm
the following on the normal-profile multi-page build, recording date, result
and deviations for each check:

| # | Check | Current result |
| --- | --- | --- |
| 1 | Single-tap Edge buttons switch pages; pointer returns to the laptop and controls remain usable | PASS — user confirmed 2026-09-29: one tap on an Edge page button switches pages and returns pointer to its previous laptop position |
| 2 | Two pages using Doodle retain different drawings and settings on switch-back | PASS — user confirmed 2026-09-29 that the second Doodle page starts blank, each page retains its own drawing and background color on switch-back, and both drawings/colors return to their respective pages after a normal-profile Command-Q/relaunch. Node tests and isolated Electron restart smoke also passed |
| 3 | All six button positions are reachable and unobtrusive on the physical Edge | PASS — user confirmed 2026-09-29 that all six controller-selectable positions work on the physical Edge |
| 4 | Drawing, supported scrolling and widget controls work without accidental navigation | PASS — user confirmed 2026-09-29 Doodle drawing, toolbar use and supported widget scrolling do not switch pages unexpectedly |
| 5 | Add, rename, reorder, select and delete pages; last-page guard and deletion warning are understandable | PARTIAL — user confirmed 2026-09-29 multiple page creation, page switching, distinct widgets per page, rename/reorder with live Edge button updates, and Cancel/Confirm deletion of a disposable page without disturbing others. Physical last-page guard not exercised to preserve user's pages; automated guard test passes |
| 6 | A failed/unavailable widget leaves prior content visible with a useful controller diagnostic | PENDING |
| 7 | Re-import a widget and confirm active/inactive page behavior | PASS — user confirmed 2026-09-29 re-import works and both Doodle pages retain their own drawings and background colors when switching afterward |
| 8 | Hide/Show Edge and verify page/setting restoration, with expected loss of runtime-only state | PASS — user confirmed 2026-09-29 Edge returns fullscreen to selected page with its background color and Doodle drawing intact. Doodle now persists the drawing per page; arbitrary widgets' runtime-only state is not guaranteed |
| 9 | Disconnect/reconnect Edge while the controller remains usable | PASS — user confirmed 2026-09-29 controller remains usable and selected page returns fullscreen on Edge with its Doodle drawing intact after display reconnect |
| 10 | Close the controller and reopen it from the Dock without disturbing Edge | PASS — user confirmed 2026-09-29 Edge keeps selected page after controller close; Dock activation reopens controller on laptop without changing Edge page |
| 11 | Native fullscreen still covers the Dock; controls remain tappable after focus restoration | PASS — user confirmed 2026-09-29 Dock remains behind fullscreen Edge and page buttons remain tappable after interacting with the laptop controller |
| 12 | Restart and verify page order, active page, placement and host settings | PASS — user confirmed 2026-09-29 active page, page order, button position, page-specific Doodle drawings and background colors restored after normal-profile relaunch |
| 13 | Command-Q closes both windows and port 8080 | PASS — user confirmed both windows closed for normal-profile restart on 2026-09-29; `lsof -nP -iTCP:8080 -sTCP:LISTEN` found no listener before relaunch |

Keep the existing touch-driver setup. Touch routing, driver cursor restoration
and native Dock coverage require direct observation; automated mouse input and
screenshots cannot prove them. No HID change is part of this feature.
