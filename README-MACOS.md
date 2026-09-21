# XENEON Edge Widget Host — display targeting and fullscreen

This is a minimal macOS adaptation of the Corsair Labs Raspberry Pi runner.
It opens the existing **Robex Tourbillon 1.0.4** clock in Electron through the
upstream widget discovery, iframe loader and iCUE compatibility shim. The
bundled clock is unchanged. No iCUE installation, cloud account, audio bridge
or network connection is needed after dependencies have been installed.

**Phase 1 status (user verified):** On the user's Mac, the runner launches,
the Robex clock animates, the Edge works as an extended display with accurate
touch, and the window closes/reopens successfully. Exact Mac model, architecture
and OS version were not recorded.

**This update:** automatic Edge targeting and widget-only fullscreen are
implemented. Automated checks and real Electron fullscreen/exit tests pass on
Windows x64. The new targeting/fullscreen behavior still needs testing on the
user's Mac and Edge; this development environment has neither attached.

## Run on Apple Silicon

1. Install an ARM64 build of Node.js 22 LTS or newer, including npm, from
   [Node.js](https://nodejs.org/en/download). Use a native Terminal session.
2. Copy/extract this project onto the Mac. Do not copy Windows `node_modules`.
3. In Terminal, enter the project directory containing `package.json`:

   ```sh
   cd /path/to/xeneon-edge-widget-host
   node -p 'process.platform + " " + process.arch'
   # Expected: darwin arm64. If x64, use native ARM64 Node before installing.
   npm ci
   npm test
   npm run test:smoke
   npm start
   ```

`npm ci` uses the existing upstream lockfile (Electron 41.5.0). That Electron
version requires macOS 12 or later. Its installer chooses the native binary
for the Node platform and architecture. This app has no compile/bundle step:
`npm ci` installs the runtime; `npm start` launches it. No DMG, signing,
notarization or installer is included in Phase 1.

Expected result: the Robex clock opens fullscreen on a uniquely detected Edge.
Otherwise, the launcher opens with five widgets and a display picker. Exit
fullscreen to choose another widget. The source manifest
still says `windows`; this is preserved upstream metadata, not a runtime gate.
Select other bundled widgets from the sidebar if desired; their dependencies
and compatibility differ.

Use **npm start**, not `run-all.sh`: the latter remains the upstream Linux
launcher. No Homebrew, FFmpeg, PulseAudio or Chromium installation is required
for the clock proof of concept. `npm run web` is an optional browser mode and
does not prove Electron or macOS operation.

## Verification and evidence

- `npm test`: four startup/lifecycle regressions. Tests cover closing and
  reopening a Mac window, repeated activation, server ownership, startup URL,
  native frame selection, occupied-port failure, and Windows close behavior.
  Five additional tests cover display selection, scaled coordinates, ambiguous
  matches, manual selection, Escape, unplug recovery, native Mac fullscreen
  conflicts and listener cleanup.
- `npm run test:smoke`: launches the real production `main.js` with an isolated
  test profile. Verifies widget selection, shim initialization, visible SVG,
  date, moving second hand and unavailable Node `require` inside the widget;
  fails on renderer errors. Also verifies fullscreen layout, widget preservation,
  Escape with the iframe focused, and the exit button. On macOS it also closes
  and reopens the window.
- Evidence is written to `artifacts/clock-electron.png` and
  `artifacts/smoke-result.json`, including actual OS, architecture and Electron
  version. Test profiles stay under ignored `artifacts/smoke-profile-*`.
  `artifacts/clock-fullscreen.png` captures the fullscreen result.
  Quit the normal app before the smoke test; both use port 8080.

The supplied screenshot/result are from **Windows**, not a Mac. On the Mac,
rerun the smoke test and check `platform: darwin`, `arch: arm64`, and
`macReopenVerified: true`. Also manually verify native close, Dock reopen,
Command-Q and fullscreen. The smoke test opens and then closes its own window.

## Display targeting and touch

1. Connect the Edge before starting; macOS must recognize it as an extended display.
2. `npm start` automatically targets a unique external display whose label contains
   XENEON and EDGE. If none is named, it looks for one external display whose
   logical size × scale factor is 2560 × 720 (either orientation). This resolution
   match is a heuristic, not hardware identification. Multiple matches leave the
   launcher open instead of guessing.
3. If detection fails, choose the Edge in **Widget display**, select a widget,
   and click **Show widget fullscreen**. The picker includes connected displays
   with logical dimensions and session IDs. It updates when displays connect or
   disconnect. A display connected after launch requires pressing this button.
4. Fullscreen hides the sidebar and toolbar while keeping the existing widget
   running. Press **Escape**, even with widget focus, or tap the 44-pixel-high
   **Exit fullscreen** button in the upper-right corner to restore the launcher.
5. If the active target disconnects, fullscreen exits and the launcher moves to
   the primary display. Reconnect and use the picker/button to resume.

macOS uses Electron's simple fullscreen mode to stay on the chosen display
without opening a new Space. Use the launcher's fullscreen button for this mode;
the native green button continues to control macOS's separate fullscreen mode.
If already in that native mode, exit it before pressing Show widget fullscreen;
the app displays a reminder rather than attempting a move macOS would ignore.
Window placement uses Electron's logical bounds, including negative coordinates.
The exit button intentionally remains over the widget so a touch-only user can
get back. No display preference or last widget is saved; reopening starts with
the Robex clock and redetects the Edge. Login launch remains deferred.

Mac acceptance checks for this update: start with the Edge connected, confirm the
clock is on that display with no sidebar, exit by touch and by Escape, choose
Doodle pad and re-enter, unplug/reconnect, and close/reopen. Verify placement and
touch coordinates after fullscreen changes. Existing Phase 1 touch accuracy was
user-confirmed, but fullscreen touch behavior and multitouch are not yet verified.
No HID driver, calibration or touch translation is added.

## Linux assumptions found

| Location | Assumption | Phase 1 treatment |
| --- | --- | --- |
| `run-all.sh` | Linux Electron path `dist/electron`; apt, xdg-open, Linux browser executable names; starts audio by default | Retained for Pi; bypassed using the portable npm launcher |
| `audio-capture.js` and audio widget bridges | pactl, PulseAudio/PipeWire monitor sources, FFmpeg `-f pulse` | Retained, not launched; macOS audio capture deferred |
| `main.js` | Server started for each window; existing port reused without ownership verification | Start server once per app; fail clearly if 8080 is occupied |
| `main.js`, `preload.js`, `runner-v2.js` | Frameless custom controls on all platforms | Native Mac frame/fullscreen; hide duplicate custom controls on Mac |
| Initial widget selection | First sorted widget is AQI and needs network | Select existing offline clock through upstream `?widget=` support |
| `README.md` | Pi package installation and launch instructions | Preserved; this document supplies Mac steps |
| Widget manifests / sensor shim | Source-platform labels; simulated sensor values | Preserved; not actual macOS system telemetry |

The Node launcher already resolves Electron's executable via `require('electron')`.
The web server binds to `127.0.0.1`; its static paths are platform-neutral.
There are no native Node addons to port for this proof of concept. The renderer,
widget assets and compatibility layer remain upstream except for hiding duplicate
window controls on Mac.

## Known limitations and troubleshooting

- **Port 8080 occupied:** quit any previous runner/web server before retrying.
  Startup now exits nonzero rather than silently connecting to another service.
- **Wrong architecture:** confirm Node reports `darwin arm64`; reinstall with
  `npm ci` on the Mac. Never reuse the Windows dependency folder.
- **Blank or non-animated clock:** run the smoke test from a terminal and retain
  its output. Verify `widgets/Robex Tourbillon-1.0.4` exists in the copied project.
- **Audio widgets:** no macOS system-audio bridge is implemented. Simulated
  sensor values or fallback animation are not real readings.
- **Dependency audit:** upstream's locked Electron 41.5.0 and its `extract-zip`
  dependency produced two high-severity findings on 2026-09-21. See `npm audit`
  for details (GHSA-9f4c-93c8-jc8g, GHSA-r4w5-6pfg-jxp5,
  GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3). Versions remain unchanged to keep
  this port minimal; a patched runtime must be assessed before distribution.
- The upstream widget host is a trusted-local-widget prototype. Its iframe
  compatibility model is not a hardened boundary for untrusted widget packages.
  Import/package validation and production security work are outside this phase.

## Provenance and license

Upstream: [Corsair-Labs/iCUE-widget-runner-RaspberryPi](https://github.com/Corsair-Labs/iCUE-widget-runner-RaspberryPi)

Starting commit: `1c3318533aa201f3d7a1b4b3526b8a2e2ca69630` (master, copied 2026-09-21).
The working repository retains upstream Git history and an upstream remote. This adaptation
does not imply Corsair support or endorsement. Original `LICENSE` (MIT,
Copyright © 2025 Corsair Memory, Inc.), `DISCLAIMER NOTICE`, README,
widget author credits and assets are preserved. No new widget assets are added.

Relevant Electron references: [installation](https://www.electronjs.org/docs/latest/tutorial/installation),
[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window),
[screen coordinates](https://www.electronjs.org/docs/latest/api/screen).
