# iCUE Widget Runner — Raspberry Pi OS

This runner folder is configured for the Raspberry Pi build of the widget runner. The current target system is **Raspberry Pi OS based on Debian 13 "trixie"**, running on **aarch64**, with **PipeWire** providing PulseAudio compatibility.

The key difference from the Windows build: the VU Meter and Spectrum Analyzer no longer use the old Windows WASAPI/C# audio bridge. They now use **Node.js + FFmpeg** to capture the PipeWire/PulseAudio monitor source for the current default audio output.

---

## Prerequisites

Install these once on the Raspberry Pi:

```bash
sudo apt update
sudo apt install -y nodejs npm ffmpeg pipewire pipewire-pulse wireplumber pulseaudio-utils chromium
```

### What each piece does

| Dependency              | Role                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| Node.js & npm           | Run the web server, Electron launcher, and audio bridges            |
| npm dependencies        | Install Electron and `fft.js` (see `npm install` below)             |
| FFmpeg                  | Capture raw audio from the PulseAudio compatibility layer           |
| PipeWire / pipewire-pulse / WirePlumber | Provide the desktop audio server                               |
| pulseaudio-utils        | Provides `pactl`, used to find the correct monitor source           |
| Chromium                | Optional fallback if Electron is not installed or cannot start      |

### Install Node dependencies

```bash
cd ~/PROJECTS/RASPI/Raspi_iCue_Widget_Runner_Engine/icue-widget-runner-raspi
npm install
```

This installs:

- **electron** — used by the normal app window
- **fft.js** — used by the Spectrum Analyzer bridge

### Make the launcher executable

```bash
chmod +x run-all.sh
```

---

## Quick verification

Check the basics:

```bash
node --version
npm --version
ffmpeg -hide_banner -devices
pactl info
pactl list short sources
```

FFmpeg must list the `pulse` input device. `pactl info` should report something like:

```
Server Name: PulseAudio (on PipeWire ...)
```

The source list should include one or more entries ending in `.monitor`. Those monitor sources are what the audio bridges use to capture system playback.

On this Raspberry Pi, the current default output monitor was detected as:

```
alsa_output.usb-Cosair_Corsair_VOID_ELITE_Surround_USB_Adapter_00000000-00.analog-stereo.monitor
```

Your source name may change if you switch from USB headset to HDMI or another audio output.

---

## Daily startup

From the app folder:

```bash
./run-all.sh both
```

The default mode is `both`, so this is also valid:

```bash
./run-all.sh
```

Normal startup does three things:

1. Starts the **VU Meter bridge** on port **3748**
2. Starts the **Spectrum Analyzer bridge** on port **3749**
3. Opens the widget runner UI in **Electron**

If Electron is not installed under `../node_modules`, the launcher falls back to browser app mode and opens Chromium at `http://127.0.0.1:8080/`.

---

## Launcher modes

| Command                      | Description                                                    |
| ---------------------------- | -------------------------------------------------------------- |
| `./run-all.sh both`          | Start VU bridge, Spectrum bridge, and Electron UI              |
| `./run-all.sh vu`            | Start only the VU bridge and Electron UI                       |
| `./run-all.sh spectrum`      | Start only the Spectrum bridge and Electron UI                 |
| `./run-all.sh web`           | Start only the Electron UI                                     |
| `./run-all.sh browser`       | Start the web UI in Chromium browser app mode                  |
| `./run-all.sh demo`          | Start the dummy levels server and Electron UI                  |
| `./run-all.sh help`          | Show launcher help                                             |

> **Note:** Do not run demo mode at the same time as the real VU bridge. The dummy `levels-server.js` also uses port 3748.

---

## Audio bridge changes made for Raspberry Pi OS

The following changes were made so the VU Meter and Spectrum Analyzer work on this Raspberry Pi OS install:

- Added `icue-widget-runner-raspi/audio-capture.js`
- Converted the VU Meter bridge from Windows WASAPI/C# to FFmpeg + PulseAudio
- Converted the Spectrum Analyzer bridge from Windows WASAPI/C# to FFmpeg + PulseAudio + `fft.js`
- Removed the broken leftover C# block from the Spectrum Analyzer JavaScript bridge
- Added `fft.js` to `package.json` and `package-lock.json`
- Added **Linux** to the VU Meter and Spectrum Analyzer widget manifests
- Added `run-all.sh` for Raspberry Pi / Linux startup
- Removed the old Windows batch launcher from the Raspberry Pi repo

### Audio source detection order

The shared audio helper finds the correct source in this order:

1. `ICUE_AUDIO_SOURCE` — if set
2. `PULSE_SOURCE` — if set
3. The **current default sink monitor** — usually `<default sink>.monitor`
4. The **first available `.monitor`** source
5. The **default source** as a fallback
6. **FFmpeg's `default` source** as a last fallback

This matters because the default Pulse/PipeWire source is often the **microphone**, but the widgets need the output monitor to visualize music, video, games, or other system playback.

---

## Audio bridge endpoints

### VU Meter

| Detail           | Value                                                       |
| ---------------- | ----------------------------------------------------------- |
| Script           | `widgets/VU Meter Onkyo/audio-server.js`            |
| JSON endpoint    | `http://127.0.0.1:3748/levels`                              |
| Debug page       | `http://127.0.0.1:3748/debug`                               |

Expected JSON:

```json
{ "L": 0.1234, "R": 0.1234 }
```

### Spectrum Analyzer

| Detail           | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| Script           | `widgets/SpectrumAnalyzer/spectrum-server 2.js`         |
| JSON endpoint    | `http://127.0.0.1:3749/fft`                                      |
| Debug page       | `http://127.0.0.1:3749/debug`                                     |

Expected JSON:

```json
{ "bins": [0, 0, ...], "peak": 0, "bins_count": 64 }
```

If music is not playing, zeros are normal. Play audio through the Raspberry Pi's selected output and refresh the debug page to confirm movement.

---

## Selecting a different audio output

If you change from USB audio to HDMI, Bluetooth, or another output, the bridge usually follows the new default sink automatically after restart.

To see available sources:

```bash
pactl list short sources
```

Look for the source ending in `.monitor` for the output you want. Then force it:

```bash
ICUE_AUDIO_SOURCE=alsa_output.your_output.monitor ./run-all.sh both
```

Example:

```bash
ICUE_AUDIO_SOURCE=alsa_output.platform-107c701400.hdmi.hdmi-stereo.monitor ./run-all.sh both
```

---

## Manual bridge testing

### VU Meter

```bash
cd "widgets/VU Meter Onkyo"
node audio-server.js
```

In another terminal:

```bash
curl http://127.0.0.1:3748/levels
```

### Spectrum Analyzer

```bash
cd "widgets/SpectrumAnalyzer"
node "spectrum-server 2.js"
```

In another terminal:

```bash
curl http://127.0.0.1:3749/fft
```

Use **Ctrl+C** to stop a manually started bridge.

---

## RustDesk note

RustDesk is optional, but useful for managing the Raspberry Pi from Windows. If the Windows RustDesk client shows the wrong Raspberry Pi monitor, enable the monitor toolbar in RustDesk:

```
Settings → Display → Other default options → Show monitors toolbar
```

Then reconnect and use the monitor buttons in the RustDesk session toolbar. If RustDesk still chooses the wrong display, set the desired Raspberry Pi display as **primary** in the Raspberry Pi screen/display settings, or temporarily disable the unwanted display, then reconnect.

---

## Troubleshooting

### No audio movement, but the widget UI opens

- Confirm the bridge debug pages open:
  - `http://127.0.0.1:3748/debug`
  - `http://127.0.0.1:3749/debug`
- Play audio through the Raspberry Pi's selected output
- Run `pactl list short sources` and confirm a `.monitor` source exists
- Restart the launcher after changing audio outputs
- Force a source with `ICUE_AUDIO_SOURCE` if auto-detection picked the wrong one

### FFmpeg cannot capture pulse

- Confirm FFmpeg lists the `pulse` device: `ffmpeg -hide_banner -devices`
- Confirm PipeWire/PulseAudio compatibility is running: `pactl info`
- Reboot after installing `pipewire-pulse` or changing audio services

### Electron does not open

- Run `npm install` from the repo root
- Confirm `node_modules/electron/dist/electron` exists
- Use browser mode as a fallback: `./run-all.sh browser`

### Port already in use

| Port | Service             |
| ---- | ------------------- |
| 3748 | VU Meter / demo     |
| 3749 | Spectrum Analyzer   |

- Stop duplicate `node` processes or reboot the Raspberry Pi

---

## Packaging note

This repo now keeps only the Raspberry Pi runner. The old Windows runner folders and Windows PowerShell packaging flow were removed from this repo to avoid mixing OS-specific builds.

---

## Notes

- No Python install is required
- No Windows C# compiler or .NET Framework is required on Raspberry Pi OS
- The Node web server auto-detects widgets using `/api/widgets`
- The Electron app starts the web server itself when launched by `run-all.sh`
- Set `showWindowControls` in `app-config.js` to show or hide the Electron window buttons
- No `widgets/index.json` file is needed
- Drag-and-drop widget folders are temporary for the current browser session
