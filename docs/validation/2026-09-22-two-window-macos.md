# Two-window macOS validation

Plan date and fixed filename: 2026-09-22. Execution date: 2026-09-29.
Task 8 implementation baseline: `265ddd3`, isolated `feat/two-window-implementation`.
Software verification is recorded below; physical acceptance remains incomplete.

## Environment and evidence

Actual host: macOS 27.0, build 26A428 (`sw_vers`, 2026-09-29), darwin arm64,
Electron 41.5.0. No hardware serial numbers or other local hardware identifiers
are recorded. Electron logical display information:

| Display | Bounds (x, y, width, height) | Scale | Role |
| --- | --- | --- | --- |
| Built-in Retina Display | (0, 0, 1440, 900) | 2 | Internal / primary controller display |
| XENEON EDGE | (-501, 900, 2560, 720) | 1 | External / uniquely detected automatic Edge target |

Task 8's baseline smoke timestamp: 2026-09-29T15:17:58.844Z; PASS.
Task 9 refreshed smoke timestamp: 2026-09-29T15:26:39.410Z; PASS.
Task 9 `npm test`: 111/111 passed, zero failures/cancellations/skips. `npm run test:smoke`:
PASS, zero renderer errors, application exit and closed port 8080. The commands
ran after documentation changes with a fresh isolated smoke profile. Initial
sandbox unit execution passed 109 cases and denied two loopback server binds
with EPERM; the complete authorized loopback rerun passed all 111. Native smoke
ran once with loopback/native permission. No production changes were needed.

Exact local command logs: `artifacts/task-9-unit.log`
and `artifacts/task-9-smoke.log`. The smoke
report records controller 1 / Edge 2 at startup, controller 3 reopening while
Edge 2 stays alive, and Edge 4 after Hide/Show. Clock animation after controller
destruction changed from rotate(247.92deg) to rotate(248.52deg) in the retained
frame. Doodle background became rgb(18, 52, 86) in the same live widget frame.

Final-review fix wave (source baseline `51ad89e`): `npm test` passed 124/124,
zero failures/cancellations/skips. One refreshed real Electron smoke passed at
2026-09-29T15:45:55.893Z on darwin arm64 / Electron 41.5.0 with zero renderer errors,
application exit and closed port 8080. Both commands ran once after fix self-review
with authorized loopback/native access and a fresh isolated smoke profile.
Local logs are `artifacts/final-fix-unit.log`
and `artifacts/final-fix-smoke.log`, preserved outside temporary review scratch.
The refreshed smoke retained Edge 2 during controller recreation as controller 3;
Clock animation changed from rotate(346.884deg) to rotate(347.484deg). Doodle
background reached rgb(18, 52, 86) in the same widget frame; Hide/Show created Edge 4.
The added regressions cover exact invalid-state backup bytes and visible transient
recovery status, unique backup names and backup failure, durable legacy migration
failure/retry/reload, oversized settings arrays, strict interactive metadata,
the complete preparation deadline, and connected manual selection while hidden.

The smoke launches production Electron windows and a production loopback server
using a new ignored `artifacts/smoke-profile-*` userData directory. It never uses
the real userData profile or import dialogs and refuses an occupied port.
Evidence files are ignored, local outputs: `artifacts/smoke-result.json`,
`artifacts/controller-electron.png`, `artifacts/edge-clock-electron.png`, and
`artifacts/edge-doodle-electron.png`.

Automated scope: static controller with zero live widget frames; sole initialized
and animated Clock on real Edge; controller-driven Doodle selection preserving
Edge window/fullscreen; live background setting applied to the same widget frame;
no app overlay; ignored Escape; continued Clock animation after controller
destruction; one controller recreated through activation; controller Hide/Show;
zero renderer errors; app.quit/before-quit exit and closed `127.0.0.1:8080`.
The quit path is used by Command-Q, but no physical keyboard shortcut is tested.
Screenshots show renderer content and cannot establish native Dock occlusion.

## Physical acceptance — user confirmation required

All results are PENDING for this build. Automated tests and earlier single-window
user confirmations do not replace these checks. Record pass/fail, actual date,
macOS/architecture/Electron/display bounds and deviations when the user retests.

| # | Ordered check | Result | Deviation / evidence |
| --- | --- | --- | --- |
| 1 | Controller opens on laptop while Edge remains fullscreen | PENDING user confirmation | Automated window creation is covered; physical observation pending |
| 2 | Select Clock, Doodle and one imported widget without leaving fullscreen | PENDING user confirmation | Clock/Doodle smoke covered; imported-widget UI acceptance pending |
| 3 | Change a visible setting and observe the live Edge update | PENDING user confirmation | Doodle background smoke covered; user observation pending |
| 4 | Tap, scroll, Doodle hold-drag, pointer return and Dock coverage | PENDING user confirmation | No physical touch or native Dock occlusion proof |
| 5 | Close controller, confirm Edge continues, reopen from Dock | PENDING user confirmation | Automated destruction/activation covered; Dock click pending |
| 6 | Hide/show Edge only from controller | PENDING user confirmation | Automated buttons covered; physical acceptance pending |
| 7 | Unplug/reconnect Edge and confirm unique-match restoration | PENDING user confirmation | Boundary coverage does not replace cable test |
| 8 | Restart app and confirm saved widget/display/settings restoration | PENDING user confirmation | Isolated smoke does not exercise real-profile restart |
| 9 | Re-import same widget ID, cancel once then confirm once | PENDING user confirmation | Import boundary tests covered; native import UI pending |
| 10 | Command-Q exits controller, Edge and server | PENDING user confirmation | app.quit/server cleanup covered; physical shortcut pending |

## Operating notes for acceptance

Retain the existing MacXeneonEdgeTouchDriver setup. Input routing, cursor return,
Accessibility permissions and widget gesture delivery are separate from display
placement. This feature does not require driver reinstall or paid touch software.
Do not report touch success from a fullscreen/window test alone.

Disconnect closes only Edge; visible presentation restores only to a unique
fingerprint match. Automatic fingerprint retention lasts for the current session;
automatic mode redetects on restart. Manual session IDs can distinguish duplicate
connected displays, but persisted fingerprints cannot: after restart/disconnect,
ambiguous matches require an explicit connected-display choice. Hidden scenes
stay hidden. Do not silently substitute another display.

Imports copy to `path.join(app.getPath('userData'), 'imports')`; state is
`path.join(app.getPath('userData'), 'state.json')`. Resolve userData from the actual
runtime rather than guessing the macOS app folder. Use trusted widgets and an
explicit same-ID replacement decision; bundled-ID replacements are managed
overrides, and failed promotion rolls back the prior managed directory.

Recovery backs up unsupported, invalid or materially lossy persisted state before
rewriting it and shows a controller notice for that launch. Benign canonicalization
does not trigger recovery. Legacy localStorage is retained until the destination
flush succeeds, including retries after an in-memory merge. Ordinary setting writes
remain debounced. Widget preparation has one 15-second deadline through fetch,
navigation and initial asynchronous settings; timeout retains prior working content.

Current scope is one page/one full-page widget. Page creation and Edge navigation
follow first, then multi-widget layouts/editing. No merge or push is part of this
validation checkpoint.
