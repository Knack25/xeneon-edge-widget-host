# XENEON Edge Widget Host on macOS

This experimental adaptation of Corsair Labs' Raspberry Pi runner has two
windows: a controller on the Mac display and a dedicated fullscreen Edge display.
The controller has static thumbnails, metadata, settings, imports and display
controls. Only the Edge executes live widgets. Widget selection and setting
changes update the Edge without moving its window or leaving fullscreen.

Each page has one full-page widget. Use the controller to create, rename, reorder,
select or delete pages and to choose one of six positions for the numbered Edge
page buttons. The buttons appear only with multiple pages. The selected page and
button position restore after restart. Simultaneous multi-widget layouts and
gesture navigation remain future work.

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
Preparation has a 15-second deadline covering fetch, frame navigation and initial
asynchronous settings application; a timeout retains the previous widget.

**Add page** creates and selects a new page using the current widget's default
settings. Each page has independent host-managed settings, even when two pages
use the same widget. Rename and reorder preserve page identity. Deleting a page
discards its live widget state and selects the previous page; the final page
cannot be deleted. Pages are limited to 12, with names of 1–80 trimmed
characters. The controller shows which page was requested if preparation fails
while another page remains visible; select the failed page again to retry.

The Edge loads a page on its first visit and retains visited widget frames while
the Edge window exists. Switching back can preserve in-memory state such as a
Doodle drawing without recreating the frame. Inactive frames stay full-size but
cannot receive pointer or keyboard input. They can still use CPU, timers or
audio, and timer cadence may be throttled. Hide/Show, display disconnect, renderer
crash and quit can destroy those frames. Widget-owned persistence then determines
what survives. Bundled and managed Doodle versions are given page-scoped storage
identities: each page saves its own drawing across app restarts. The first Doodle
page opened after upgrading receives the one historical shared drawing; other
new Doodle pages start blank. This cannot reconstruct drawings already
overwritten in the old shared key. Other widgets using same-origin localStorage
or cookies may still share storage across pages; this host does not isolate them.

Closing the controller leaves the Edge and application-owned loopback server
running. Clicking the Dock icon recreates or focuses the controller. **Hide Edge**
destroys only the presentation window and preserves the scene; **Show Edge**
recreates it on the selected target. **Command-Q** quits both windows, flushes
saved state and closes the server. Hiding Edge and closing the controller still
leaves the macOS app available from Dock.

The Edge has only its numbered page buttons: no app toolbar, sidebar, status
overlay or exit button. Escape does not exit fullscreen. Use the controller for
configuration and window controls. macOS presentation uses
simple fullscreen without a new Space, accepts first mouse input, and uses the
`pop-up-menu` window level while visible to cover the Dock. Physical first-touch
delivery and Dock coverage still need acceptance on this multi-page build.

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

Version 2 state saves ordered pages, the active page ID, navigation position,
per-page widget settings, scene visibility, display preference and controller
bounds. Version 1 profiles migrate their single page and remembered widget
settings. Bounds restore only when sufficiently
visible on a connected non-Edge display; otherwise the controller centers on a
safe display. Writes are debounced and atomically renamed, with a quit flush.
Malformed JSON, invalid known schema fields, and settings
that normalization would lose are preserved byte-for-byte in a unique dated
`state.json.corrupt-*` backup before safe normalized state is written. The
controller reports recovery for that launch. Formatting changes and ignored
extra metadata do not trigger recovery. Backup failure leaves the original file
untouched and stops initialization.

An unsupported future state version opens in read-only recovery. The original
`state.json` stays byte-for-byte unchanged, edits are rejected, and the controller
shows an unsupported-version notice. Closing the controller and quitting still
work; controller bounds are not persisted in this mode. Use a compatible newer
runner to resume editing that configuration.

Legacy local-storage settings merge once. Their migration acknowledgement waits
for a successful state-file flush before localStorage is removed. A failed write
retains the legacy entry, and retry flushes the already merged settings. Ordinary
settings changes remain debounced.

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
Page-selection capability and button handlers run in an isolated Electron world,
outside the widget-accessible main-world bridge. Only trusted native button input
can select an Edge page; script calls and synthetic clicks cannot. Widgets retain
their legacy same-origin DOM/storage access, so this is a narrow command boundary,
not a full sandbox against hostile widgets or host DOM tampering.

## Verification and physical acceptance

Run these with the normal app quit because smoke uses `127.0.0.1:8080`:

```sh
npm test
npm run test:smoke
```

The runner refuses an occupied port and does not stop another service. Smoke
uses production windows, server and runtime with fresh isolated
`artifacts/smoke-profile-*` userData. It requires a unique actual Edge. The
multi-page scenario starts from a version 1 profile, draws into two live Doodle
frames using Electron mouse events, checks switch-back pixels and native frame
IDs, records inactive timer activity, checks keyboard exclusion and all six
button positions, then relaunches the same isolated profile to check persisted
page/order/setting/position and both Doodle drawings. It also checks a controlled failed widget, deletion,
re-import invalidation, controller recreation, Hide/Show and Edge reload. Its
app.quit path is shared with Command-Q; it does not physically press the shortcut.
The current multi-page smoke passed after port 8080 became free; see the
[validation record](docs/validation/2026-09-29-multi-page-macos.md).

The completed two-window baseline evidence is in the
[earlier validation record](docs/validation/2026-09-22-two-window-macos.md).
Its physical confirmations do not accept multi-page behavior.

The earlier two-window build had user-confirmed touch, pointer and Dock checks,
but those confirmations do not accept this multi-page build. Prior coordinate
probes found Edge touches routed to the built-in display rather than
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
