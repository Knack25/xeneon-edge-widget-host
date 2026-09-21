# Continue on an Apple Silicon Mac

Handoff updated 2026-09-21. Implementation baseline: `eea16a8` on `main`.

## Objective and scope

Prove a minimal standalone macOS host for existing iCUE-style widgets on the
XENEON Edge. Keep Corsair's Electron renderer, widget loader and compatibility
shim. Do not redesign the runtime or begin integrations until the current Mac
display/fullscreen behavior is verified.

The user is moving this conversation from Windows to the desktop app on an
Apple Silicon Mac. Start by inspecting the local checkout and available tools;
do not assume the previous Windows workspace, dependencies or authentication
are present. The code is already published; do not recreate the project.

## What is done

- Repository: https://github.com/Knack25/xeneon-edge-widget-host (public).
- Based on Corsair-Labs/iCUE-widget-runner-RaspberryPi, upstream commit
  `1c3318533aa201f3d7a1b4b3526b8a2e2ca69630`. Upstream history is retained.
- Default widget: unchanged bundled Robex Tourbillon 1.0.4, selected through
  the upstream URL query mechanism. It needs no audio bridge or network data.
- Native Mac window controls, application-owned local server, working
  close/reopen lifecycle, clear failure when port 8080 is occupied.
- Automatic Edge targeting at window startup by a unique external display
  name containing XENEON and EDGE; fallback to a unique 2560 × 720 physical
  size estimate (logical bounds × scale factor, either orientation).
- Manual display picker when detection is absent or ambiguous.
- Widget-only fullscreen; Escape works with widget focus, and a visible
  touch-accessible Exit fullscreen button returns to the launcher.
- Target unplug exits presentation and moves the launcher to the primary
  display. Reconnection requires selecting/starting fullscreen again.
- Mac uses simple fullscreen to avoid creating another Space. Entering from
  native green-button fullscreen is rejected with instructions to exit it first.

## Evidence: keep these distinctions

**User-confirmed on a Mac, original Phase 1 build:** runner launches, Robex
clock renders and animates, Edge is an extended display, touch is accurate,
and closing/reopening works. Exact Mac model, architecture and OS version
were not recorded for those checks. The destination for continuation is
explicitly Apple Silicon.

**Agent-verified on Windows x64, latest implementation:** nine regression
tests pass; real Electron 41.5.0 smoke test passes for clock/shim initialization,
animation, full-viewport widget layout, preservation of the running widget,
Escape with iframe focus, and the exit button. No renderer errors were recorded.
Independent review found a native Mac fullscreen conflict; the guard and a
regression test were added before publishing.

**Still unverified:** latest automatic targeting, simple fullscreen, touch
after fullscreen transitions, and unplug/reconnect behavior on physical Mac
and Edge hardware. Mocked Mac branches and Windows screenshots do not prove
those behaviors. Do not repeat all Phase 1 work or claim new hardware checks
passed based solely on the user's earlier confirmations.

## First actions on the Mac

If a checkout is already present, inspect `git status` and preserve local work
before updating it. Otherwise:

```sh
git clone https://github.com/Knack25/xeneon-edge-widget-host.git
cd xeneon-edge-widget-host
node -p 'process.platform + " " + process.arch'
sw_vers
npm ci
npm test
npm run test:smoke
npm start
```

Expect `darwin arm64` from Node. Install native ARM64 Node.js 22 or newer if
needed. Do not transfer Windows `node_modules`. There is no app build step;
`npm ci` installs Electron and `npm start` runs the source. Use macOS 12 or
later for the locked Electron version. Do not use the Linux `run-all.sh`.
Quit a normal runner before the smoke test: both use loopback port 8080.

The smoke test writes `artifacts/smoke-result.json`, `clock-electron.png` and
`clock-fullscreen.png`. Check the actual platform/architecture and
`macReopenVerified` result. These artifacts and test profiles are Git-ignored.
The test enters fullscreen on its first listed display and then exits; that
automated check is not itself a physical Edge targeting test.

## Hardware acceptance checklist

1. Record Mac model, macOS version and Node architecture. Connect the Edge as
   an extended display before launching.
2. Start the app. Confirm the clock opens on the Edge, with sidebar/toolbar
   hidden. If not, inspect the reported display name, bounds and scale factor;
   try the manual picker before changing detection heuristics.
3. Tap Exit fullscreen, choose another widget (Doodle pad is useful), and
   press Show widget fullscreen. Verify the selected widget is retained.
4. Check touch at corners and continuous drawing in fullscreen. Check Escape
   while the widget has focus, then the touch exit button again.
5. Unplug the target: confirm a usable launcher returns on the primary
   display. Reconnect and re-enter through the picker/button.
6. Close/reopen and quit/relaunch. Reopening deliberately redetects the Edge
   and starts the default clock; last-widget/display persistence is not built.
7. Test the native green-button fullscreen case: the app must explain that
   native fullscreen needs to be exited before display-targeted presentation.

Record outcomes and actual failures in README-MACOS.md or a dated validation
note. Diagnose reproducible failures and keep fixes small, with relevant tests.
If desktop tools are unavailable, guide the user through hardware checks and
clearly label their reports instead of claiming to have observed the screen.

## Code map

- `main.js`: Electron window/server lifecycle, initial automatic presentation,
  and presentation IPC restricted to the launcher main frame.
- `presentation.js`: detection, display placement, fullscreen state, Escape,
  unplug handling and listener cleanup.
- `presentation-ui.js`, `index.html`: display picker, layout and exit control.
- `preload.js`: narrow Electron bridge; no Node integration in the renderer.
- `runner-v2.js`: upstream loading/shim, only duplicate Mac controls changed.
- `tests/main.test.js`: four startup/lifecycle tests with substituted boundaries.
- `tests/presentation.test.js`: five display/presentation regression tests.
- `tests/electron-smoke.js`, `scripts/run-smoke.js`: real Electron verification.
- `README-MACOS.md`: setup, behavior, limitations and provenance.

## Constraints and known limitations

- Preserve LICENSE, DISCLAIMER NOTICE and all upstream/widget author credits.
- Use Conventional Commits for new commits, e.g. `fix: ...`, `feat: ...`,
  `docs: ...`. Keep upstream historical commits intact.
- Resolution matching is a fallback heuristic, not a device identity guarantee.
- No saved display preference, last-widget persistence, login launch, DMG,
  signing, notarization, multi-widget layout or `.icuewidget` importer yet.
- Mac system audio, real sensor telemetry and third-party integrations are
  deferred. Upstream audio helpers use Linux PulseAudio/PipeWire and FFmpeg.
- The trusted-local-widget prototype is not hardened for arbitrary imports.
- The retained Electron 41.5.0/extract-zip dependency tree reported two
  high-severity audit findings. Details are in README-MACOS.md. Versions were
  intentionally retained for the port; assess patched dependencies before
  broader distribution rather than silently treating this as production-ready.

The immediate next task is **Mac verification of existing targeting/fullscreen
code**, followed by fixes only if evidence requires them. Discuss the next
feature scope after that verification is complete.
