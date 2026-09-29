# XENEON Edge Widget Host on macOS

This experimental adaptation of Corsair Labs' Raspberry Pi runner has two
windows: a controller on the Mac display and a dedicated fullscreen Edge display.
The controller has static thumbnails, metadata, settings, imports and display
controls. Only the Edge executes a live widget. Widget selection and setting
changes update the Edge without moving its window or leaving fullscreen.

Phase one has exactly one page with one full-page widget. Page creation and
Edge-side navigation (gestures or unobtrusive buttons) come next; simultaneous
multi-widget layouts and editing follow later.

## Run on Apple Silicon

Use native ARM64 Node.js 22 or newer with npm, on macOS 12 or later. In the
directory containing `package.json`:

```sh
node -p 'process.platform + " " + process.arch'
# Expected on Apple Silicon: darwin arm64
npm ci
npm start
```

Do not copy Windows `node_modules` to the Mac. `npm ci` installs the locked
Electron 41.5.0 runtime; no compile/bundle step is required. No DMG, signing,
notarization or login launcher is included. Use `npm start`; `run-all.sh` is the
retained Linux/Pi audio launcher. The offline bundled Robex Tourbillon 1.0.4 clock
needs no iCUE installation, cloud account, audio bridge, paid software or network
connection after dependencies are installed. Other widgets have different needs.
Source-platform labels such as `windows` in manifests are upstream metadata,
rather than a macOS runtime gate.

## Using the controller and Edge

Connect the Edge as an extended display before launch. The controller opens on
the primary display, or restores safe saved bounds on a connected non-Edge
display. The Edge restores the saved widget and settings when its target resolves.
The offline Robex clock is the default on first launch or when persisted selection
data is missing/invalid. If a valid saved widget ID is absent from the catalog,
the controller reports that it is unavailable; choose another widget explicitly.

Choose a widget in the controller list, then use its Settings controls. The Edge
keeps its native window and fullscreen placement during selection. If a widget
fails to prepare, the previous working content remains visible and the controller
reports the error. Settings reach the active widget live.

Closing the controller leaves the Edge and application-owned loopback server
running. Clicking the Dock icon recreates or focuses the controller. **Hide Edge**
destroys only the presentation window and preserves the scene; **Show Edge**
recreates it on the selected target. **Command-Q** quits both windows, flushes
saved state and closes the server. Hiding Edge and closing the controller still
leaves the macOS app available from Dock.

The Edge has no app toolbar, sidebar, status overlay or exit button. Escape does
not exit fullscreen. Use the controller for app controls. macOS presentation uses
simple fullscreen without a new Space, accepts first mouse input, and uses the
`pop-up-menu` window level while visible to cover the Dock. Physical first-touch
delivery and Dock coverage still need acceptance on this two-window build.

## Display selection and restoration

**Target display** offers Automatic XENEON Edge and connected displays. Automatic
selection first looks for one external display whose label contains XENEON and
EDGE (in either order). With no named candidate, it looks for a unique 2560 × 720
physical-size estimate from logical bounds × scale factor in either orientation.
Resolution matching is a heuristic, not hardware identity. Missing or ambiguous
matches keep the controller available and do not guess.

After automatic resolution, the app retains that display's label/size fingerprint
for the current session so an unplug does not silently adopt a different Edge.
Disconnecting the target closes only Edge; reconnecting a unique matching display
restores presentation if the saved scene is visible. Automatic mode is saved as
automatic and performs fresh detection after an app restart.

A manual choice saves a fingerprint of the label and physical-size estimate.
Display IDs are session-scoped: explicit selection can distinguish identical
connected displays in the current session, but after restart or disconnection
the saved fingerprint must match uniquely. With duplicate fingerprints, choose
the intended connected display explicitly again. Selecting Automatic again starts
fresh automatic resolution. Hidden scenes stay hidden until Show.

## Saved state and durable imports

The actual paths are `path.join(app.getPath('userData'), 'state.json')` and
`path.join(app.getPath('userData'), 'imports')`. Electron normally places userData
under macOS Application Support, but its exact app folder depends on app identity,
launch context and path overrides. Use the runtime's `app.getPath('userData')`
value when locating data; do not assume an app folder name. Smoke overrides it
with an isolated profile.

Versioned state saves the active widget, per-widget settings, scene visibility,
display preference and controller bounds. Bounds restore only when sufficiently
visible on a connected non-Edge display; otherwise the controller centers on a
safe display. Writes are debounced and atomically renamed, with a quit flush.
Malformed JSON is preserved as a dated `state.json.corrupt-*` backup; unsupported
or invalid fields normalize to safe defaults. Legacy local-storage settings merge
once.

Use **Import widget folder** and choose a folder with a regular `index.html`.
An optional valid `manifest.json` supplies its ID; otherwise the original folder
name becomes the stable ID. Files copy into the managed imports library with a
normalized ID, so imports survive restart without retaining the source folder.
Symbolic links and non-regular files are rejected. This replaces temporary
dropped folders; `.icuewidget` archives are not supported.

Importing an existing ID asks **Replace installed widget?**, showing installed
and incoming metadata. Cancel preserves the installed entry. Confirm uses a
one-use token and staged replacement with backup/rename rollback if promotion
fails; settings for the ID are preserved. A confirmed bundled-ID import becomes
a managed override with catalog precedence; bundled source files remain intact.
Validation does not make arbitrary widget scripts safe: use trusted local widgets.

## Verification and physical acceptance

Run these with the normal app quit because both use `127.0.0.1:8080`:

```sh
npm test
npm run test:smoke
```

The runner refuses an occupied port and does not stop another service. Smoke
uses production windows, server and runtime with fresh isolated
`artifacts/smoke-profile-*` userData. On this Mac it requires a unique actual
Edge, without substituting a simulated monitor. It checks Clock animation, live
Doodle selection/settings, static controller, one live widget, fullscreen,
ignored Escape, controller recreation, Hide/Show, renderer errors, and app.quit
with closed port 8080. That shutdown path is used by Command-Q; smoke does not
physically press the shortcut.

Evidence: `artifacts/smoke-result.json`, `controller-electron.png`,
`edge-clock-electron.png`, and `edge-doodle-electron.png`. Automated Mac/Edge smoke
is PASS on darwin arm64 / Electron 41.5.0. See the
[validation record](docs/validation/2026-09-22-two-window-macos.md) for actual
2026-09-29 environment, test counts and all ten pending hardware checks. Its
filename follows the approved plan date, not the execution date.

Earlier builds had user-confirmed clock animation and later first-click/Dock
retests, but those confirmations do not accept this two-window build. Prior
coordinate probes found Edge touches routed to the built-in display rather than
Edge. App code cannot reroute events it never receives. The user's existing
MacXeneonEdgeTouchDriver setup and Accessibility/cursor-return issues remain
separate from window management; this feature installs no HID driver/calibration.
Preserve the working setup and physically retest tap, scroll, Doodle hold-drag,
pointer return and Dock coverage. No driver reinstall or paid touch software is
required by this host.

## Limitations and troubleshooting

- Port 8080 occupied: quit the previous runner/web server before retrying.
  Startup fails rather than connecting to an unrelated service.
- Wrong architecture: use native ARM64 Node and install dependencies on the Mac.
- Blank clock: retain smoke output and verify the bundled Robex directory exists.
- macOS system audio, real sensor telemetry and integrations remain deferred.
  Upstream Linux bridges need PulseAudio/PipeWire and FFmpeg; simulated sensors
  and fallback animation are not real readings. Spectrum bridge availability is
  separate from touch/window acceptance.
- The locked dependency tree reported two high-severity audit findings on
  2026-09-21 (GHSA-9f4c-93c8-jc8g, GHSA-r4w5-6pfg-jxp5,
  GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3). This is historical evidence, not a
  fresh audit; assess patched dependencies before broader distribution.

## Provenance and license

Upstream: [Corsair-Labs/iCUE-widget-runner-RaspberryPi](https://github.com/Corsair-Labs/iCUE-widget-runner-RaspberryPi),
starting commit `1c3318533aa201f3d7a1b4b3526b8a2e2ca69630` (copied 2026-09-21).
Upstream Git history, MIT `LICENSE` (Copyright © 2025 Corsair Memory, Inc.),
`DISCLAIMER NOTICE`, widget author credits and assets remain preserved.
This adaptation is experimental and does not imply Corsair support or endorsement.
