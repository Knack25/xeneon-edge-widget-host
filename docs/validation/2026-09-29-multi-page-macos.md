# Multi-page macOS validation

Execution date: 2026-09-29. Branch: `feat/multi-page-navigation`.
This record distinguishes automated evidence from physical acceptance.

## Environment and automated evidence

macOS 27.0 (build 26A428), darwin arm64, Node.js 26.9.0,
npm 11.19.1 and Electron 41.5.0. The real display report identifies
the built-in Retina Display at (0, 0, 1440, 900), scale 2, and the
XENEON EDGE at (-501, 900, 2560, 720), scale 1.

`npm test`: PASS, 178/178 node:test cases, zero failures, cancellations
or skips. It ran with loopback permission for the web-server cases.
`node --check tests/electron-smoke.js`,
`node --check scripts/run-smoke.js` and `git diff --check`: PASS.

`npm run test:smoke`: PASS at 2026-09-29T18:15:00.091Z after the
Task 6 evidence review. The runner
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
  Edge and restored the active page; Edge reload restored it again.
  Restart restored active page, page order, navigation position and a
  page-specific setting. `app.quit` closed both isolated Electron runs and
  the loopback server. Physical Command-Q was not pressed.

The smoke observes canvas state within one running Edge window. Doodle uses
same-origin widget storage, so this does not establish independent persisted
documents across pages or preserve drawings through Hide/Show, reconnect,
renderer crash or restart.

## Physical acceptance — pending

The two-window build's [earlier physical results](2026-09-22-two-window-macos.md)
are historical and do not accept multi-page behavior. Have the user confirm
the following on the normal-profile multi-page build, recording date, result
and deviations for each check:

| # | Check | Current result |
| --- | --- | --- |
| 1 | Single-tap Edge buttons switch pages; pointer returns to the laptop and controls remain usable | PENDING |
| 2 | Two pages using Doodle retain different drawings and settings on switch-back | PENDING |
| 3 | All six button positions are reachable and unobtrusive on the physical Edge | PENDING |
| 4 | Drawing, supported scrolling and widget controls work without accidental navigation | PENDING |
| 5 | Add, rename, reorder, select and delete pages; last-page guard and deletion warning are understandable | PENDING |
| 6 | A failed/unavailable widget leaves prior content visible with a useful controller diagnostic | PENDING |
| 7 | Re-import a widget and confirm active/inactive page behavior | PENDING |
| 8 | Hide/Show Edge and verify page/setting restoration, with expected loss of runtime-only state | PENDING |
| 9 | Disconnect/reconnect Edge while the controller remains usable | PENDING |
| 10 | Close the controller and reopen it from the Dock without disturbing Edge | PENDING |
| 11 | Native fullscreen still covers the Dock; controls remain tappable after focus restoration | PENDING |
| 12 | Restart and verify page order, active page, placement and host settings | PENDING |
| 13 | Command-Q closes both windows and port 8080 | PENDING |

Keep the existing touch-driver setup. Touch routing, driver cursor restoration
and native Dock coverage require direct observation; automated mouse input and
screenshots cannot prove them. No HID change is part of this feature.
