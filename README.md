# XENEON Edge Widget Host

Experimental macOS adaptation of [Corsair Labs' Raspberry Pi widget runner](https://github.com/Corsair-Labs/iCUE-widget-runner-RaspberryPi).
Runs existing iCUE-style widgets in Electron with a static Mac controller and a
separate fullscreen Edge window containing the sole live widget. Select widgets
and change settings in the controller while Edge remains fullscreen.

**[Mac setup and verification guide](README-MACOS.md)** — start here.

**Continuing development in a new chat? Read [HANDOFF.md](HANDOFF.md)** for
current status, confirmed results, and the next Apple Silicon hardware checks.

```sh
git clone https://github.com/Knack25/xeneon-edge-widget-host.git
cd xeneon-edge-widget-host
npm ci
npm start
```

Use native ARM64 Node.js on Apple Silicon. Run `npm test` for regression tests and
`npm run test:smoke` for a real Electron check. The original runtime, animated clock,
accurate touch and close/reopen were verified by the user on an earlier Mac build.
Current two-window automated validation includes real darwin arm64 / Electron
41.5.0 smoke on the attached Edge. All ten physical acceptance checks are pending
user confirmation in the [validation record](docs/validation/2026-09-22-two-window-macos.md).

Close the controller to leave Edge running; click the Dock icon to reopen it.
Use controller Hide Edge/Show Edge controls and Command-Q to quit the whole app.
Edge has no app overlay or Escape exit. State and durable folder imports live
under Electron `app.getPath('userData')`; same-ID replacement requires confirmation
and can override bundled entries without changing bundled source files.
The Mac guide explains saved settings/bounds and safe display restoration.

Phase one supports one page/one full-page widget. Page navigation on Edge comes
next, followed later by simultaneous multi-widget layouts and editing.

Upstream MIT license, disclaimer, widget credits and Git history are retained.
This is not an official or supported Corsair product. Known dependency advisories
and prototype limitations are documented in the Mac guide.

## Raspberry Pi setup and upstream context

The Linux setup and audio bridge instructions below retain upstream context.
The shared Electron UI now uses controller/Edge roles described above; former
launcher live previews and temporary dropped-folder imports have been retired.
Chromium/browser mode remains in the upstream launch script as historical context;
it cannot operate the current controller, which requires Electron's native bridge.

# Raspi iCUE Widget Runner Engine

Raspberry Pi OS runner for browser-style CORSAIR iCUE widgets. The app hosts
widgets from the local `widgets/` folder, injects a small iCUE compatibility
shim, and displays the selected widget in Electron. The original Chromium app
mode does not support the current controller.

The application is self-contained in the repository root.

## What the App Does

Raspi iCUE Widget Runner Engine brings browser-style CORSAIR iCUE widgets to Raspberry Pi OS. The current Electron app discovers compatible widgets, presents them in a static controller, and runs the selected experience in the separate Edge window. An iCUE compatibility layer helps widgets operate outside the full desktop iCUE runtime, while optional local audio bridges enable experiences such as live VU meters and spectrum analyzers.

## Use Case Scenario

A customer may have a Raspberry Pi connected to a XENEON EDGE display as part of a desk, gaming room, streaming station, workshop, or home-entertainment setup. After starting the runner, the customer can browse the available widgets and select an experience such as an audio visualizer, clock face, air-quality display, or drawing surface. The Pi can then serve as a dedicated, always-available information or ambient display without requiring the primary PC screen to remain occupied.

The runner is also useful for prototyping. Designers and developers can place a compatible web widget in the local `widgets/` folder, launch it in the runner, and evaluate its appearance, interaction model, performance, and suitability for a small or touch-enabled display.

- **VU Stereo Meter:** Its full-frame canvas effects may stutter at high display
  resolutions on older Pis; use a simpler theme, smaller window, or `vu` mode.
- **Spectrum Analyzer:** Real-time FFmpeg capture, FFT processing, glow, and
  reflections are more demanding; reduce bars/effects or use a cooled Pi 5.

## Disclaimer and License

This is experimental software, not a supported CORSAIR product. Review the
[DISCLAIMER NOTICE](DISCLAIMER%20NOTICE) and [LICENSE](LICENSE) before using,
modifying, or redistributing it. The project uses the standard MIT License,
which permits both commercial and non-commercial use, modification,
distribution, sublicensing, and sale as long as its copyright and permission
notices are retained. The license applies to the software, not to CORSAIR or
iCUE trademarks or any claim of endorsement. The software is provided as-is,
without warranty or support.

### Prerequisites

On Raspberry Pi OS, install:

```bash
sudo apt update
sudo apt install -y nodejs npm ffmpeg pipewire pipewire-pulse wireplumber pulseaudio-utils chromium
```

Clone the repository and install its Node.js dependencies:

```bash
git clone git@github.com:jlcorsair/Raspi_iCue_Widget_Runner_Engine.git
cd Raspi_iCue_Widget_Runner_Engine
npm install
chmod +x run-all.sh
```

Run `npm install` in every fresh clone (and after replacing the project
directory); system packages installed with `apt` do not provide this project's
local Electron and `fft.js` dependencies.

The launcher is a Bash script for Linux/Raspberry Pi OS. The `.sh` extension
does not make it a Windows script. It must have Unix (LF) line endings; this
repository enforces them through `.gitattributes`.

### Quick Verification

Check that the required tools are available:

```bash
node --version
npm --version
ffmpeg -hide_banner -devices
pactl info
pactl list short sources
```

The audio bridges rely on a monitor source such as `.monitor` from the selected output device. If needed, force a source explicitly:

```bash
ICUE_AUDIO_SOURCE=alsa_output.your_output.monitor ./run-all.sh both
```

Required pieces:

- Node.js and npm run the web server, Electron launcher, and bridge scripts.
- Electron opens the normal app window.
- FFmpeg captures audio from PulseAudio compatibility on PipeWire.
- `pactl` from `pulseaudio-utils` is used to find output monitor sources.
- `fft.js` is used by the Spectrum Analyzer bridge.
- Chromium is used when Electron is missing or cannot start.

### Daily Startup

From the cloned repository root (the directory containing `package.json` and
`run-all.sh`):

```bash
./run-all.sh both
```

With no argument, the launcher also defaults to `both`, so `./run-all.sh` is
equivalent. Use `./run-all.sh help` to list the available modes.

NPM scripts:

```bash
npm start     # Start Electron; Electron starts the local web server.
npm run web   # Start only the local web server at http://127.0.0.1:8080/
```

The launcher supports:

```text
./run-all.sh both       Start VU bridge, Spectrum bridge, and Electron UI.
./run-all.sh vu         Start only the VU bridge and Electron UI.
./run-all.sh spectrum   Start only the Spectrum bridge and Electron UI.
./run-all.sh web        Start only the Electron UI.
./run-all.sh browser    Historical Chromium mode; current controller unavailable.
./run-all.sh demo       Start the dummy VU levels server and Electron UI.
./run-all.sh help       Show launcher help.
```

### Manual Bridge Testing

If you want to test the bridges directly:

```bash
cd widgets/VU\ Meter\ Onkyo\ -\ Manny
node audio-server.js
```

In another terminal:

```bash
curl http://127.0.0.1:3748/levels
```

For the spectrum bridge:

```bash
cd "widgets/SpectrumAnalyzer-v1.0.1 1"
node "spectrum-server 2.js"
```

```bash
curl http://127.0.0.1:3749/fft
```

## What It Does

- Runs a local widget web app at `http://127.0.0.1:8080/`.
- Scans `widgets/` for widget folders containing
  `index.html` and optional `manifest.json`.
- Shows discovered widgets in the controller with manifest metadata, static
  thumbnails, settings and status; Edge owns the live iframe.
- Imports widget folders durably through the controller's native picker, with
  explicit confirmation for same-ID replacements.
- Injects iCUE-style globals and a Sensors data provider shim so widgets can run
  outside the full iCUE desktop runtime.
- Runs in Electron; the retained upstream Chromium/browser mode cannot provide
  the native bridge required by the current controller.
- Provides Raspberry Pi audio bridges for live VU meter and spectrum widgets
  using FFmpeg plus PipeWire/PulseAudio monitor sources.

## Main Components

```text
Raspi_iCue_Widget_Runner_Engine/
  main.js                  Electron main process. Starts the local web server.
  app-coordinator.js       Shared state and independent window lifecycle.
  controller.html/js       Static widget library, settings and display controls.
  edge.html/js             Dedicated fullscreen widget surface.
  preload-controller.js    Narrow controller command bridge.
  preload-edge.js          Scene subscription and load reporting bridge.
  widget-runtime.js        Widget iframe loading, shim injection and settings.
  app-state.js             Versioned userData state persistence.
  widget-library.js        Bundled discovery and managed folder imports.
  web-server.js            Static server plus /api/widgets discovery endpoint.
  app-config.js            Small UI config, including window-control visibility.
  audio-capture.js         Shared FFmpeg/PulseAudio capture helper.
  levels-server.js         Demo VU level server on port 3748.
  run-all.sh               Raspberry Pi launcher for UI and audio bridges.
  scripts/start-electron.js
  widgets/
```

## Bundled Widgets

| Widget            | Functionality                                                                          | Runtime notes                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| VU Stereo Meter   | Analog stereo VU meters with multiple amplifier styles.                                | Uses the local VU bridge at`http://127.0.0.1:3748/levels`; falls back to simulated/sensor motion if unavailable.        |
| Spectrum Analyzer | Real-time 64-bin audio spectrum visualizer with themes.                                | Uses the spectrum bridge at`http://127.0.0.1:3749/fft`; runner exposes input gain, sensitivity, and smoothing controls. |
| Robex Tourbillon  | Animated luxury watch face with date/month elements.                                   | Browser-hosted visual widget.                                                                                             |
| Doodle pad        | Touch-style freeform drawing widget with brush, eraser, colors, and persistent canvas. | Browser-hosted interactive widget using local storage.                                                                    |
| AQI               | Air quality display.                                                                   | Uses Open-Meteo APIs and needs network access for live data.                                                              |

The runner lists every widget folder it can load. Original widget manifests may
still show their source-platform metadata, but the local runner hosts them in the
Raspberry Pi browser/Electron environment.


## Audio Capture

The Raspberry Pi audio path uses `audio-capture.js` to select a PulseAudio source
and stream raw stereo PCM from FFmpeg. The source selection order is:

1. `ICUE_AUDIO_SOURCE`, if set.
2. `PULSE_SOURCE`, if set.
3. The current default sink monitor, usually `<default sink>.monitor`.
4. The first available `.monitor` source.
5. The default source.
6. FFmpeg's `default` source.

To force a specific monitor source:

```bash
ICUE_AUDIO_SOURCE=alsa_output.your_output.monitor ./run-all.sh both
```

Useful checks:

```bash
pactl info
pactl list short sources
ffmpeg -hide_banner -devices
```

The bridges expose these local endpoints:

```text
VU Meter:
  http://127.0.0.1:3748/levels
  http://127.0.0.1:3748/debug

Spectrum Analyzer:
  http://127.0.0.1:3749/fft
  http://127.0.0.1:3749/debug
```

`levels-server.js` is a demo server that also uses port `3748`, so do not run it
at the same time as the real VU bridge.

## Widget Loading

`web-server.js` serves static files and exposes `GET /api/widgets`. In the Electron
app, that API returns the combined bundled and managed catalog, with manifest
data and icon paths when available. Confirmed same-ID imports take precedence as
managed overrides. Standalone `npm run web` retains bundled-only discovery and
cannot operate the current controller without Electron's native bridge.

`widget-runtime.js`, consumed only by Edge, then:

- Normalizes widget manifest fields.
- Builds an iframe shell for each widget.
- Injects iCUE compatibility globals before the widget code runs.
- Adds default properties for bundled widgets.
- Applies coordinator-owned settings persisted under Electron userData.
- Tracks bridge reachability for the VU and Spectrum widgets.

Use the controller's Import widget folder action for durable managed imports.
Same-ID imports require replacement confirmation; confirmed bundled-ID imports
become managed overrides. Imported files live below
`path.join(app.getPath('userData'), 'imports')`, with versioned app state in
`path.join(app.getPath('userData'), 'state.json')`. The exact userData app folder
depends on runtime app identity and path overrides; do not assume a folder name.

## Configuration

`app-config.js` currently exposes:

```js
window.ICUE_RUNNER_CONFIG = {
  showWindowControls: true
};
```

Set `showWindowControls` to `false` to hide the custom minimize, maximize, and
close buttons in the controller where custom controls are used. macOS uses native
controller controls. The Edge has no app window-control overlay.

## Troubleshooting

- If `./run-all.sh` reports `cannot execute: required file not found`, check the
  script format:

  ```bash
  file run-all.sh
  head -n 1 run-all.sh
  ```

  The first line must be `#!/bin/bash`, and `file` must not report `CRLF line
  terminators`. If an older checkout has CRLF endings, repair it and retry:

  ```bash
  sed -i 's/\r$//' run-all.sh
  chmod +x run-all.sh
  npm install
  ./run-all.sh both
  ```

- Run the launcher from the repository root. Confirm the correct directory with
  `test -f package.json && test -f run-all.sh && echo "repository root OK"`.
- If the UI opens but audio widgets do not move, open the `/debug` bridge pages
  and confirm audio is playing through the Raspberry Pi's selected output.
- If no `.monitor` source is listed, confirm PipeWire/PulseAudio compatibility
  is running with `pactl info`.
- If Electron does not open, run `npm install` from the repository root and
  inspect the launch error. The retained `./run-all.sh browser` mode is historical
  upstream behavior and does not replace the current Electron controller.
- If a port is already in use, stop duplicate Node processes or restart the Pi.
  The main ports are `8080`, `3748`, and `3749`.

The sections above include the Raspberry Pi setup, manual bridge testing, audio
source selection, and endpoint notes.
