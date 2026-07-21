# VU Stereo Meter - Raspberry Pi Runner

Analog VU stereo meters driven by the local Raspberry Pi audio bridge.

## How It Works

`audio-server.js` captures the current PipeWire/PulseAudio monitor source through
the shared `audio-capture.js` helper and serves stereo peak levels at:

```text
http://127.0.0.1:3748/levels
```

If the bridge is not running, the widget falls back to simulated motion.

## Run

Start the full runner from the repo root:

```bash
./icue-widget-runner-raspi/run-all.sh both
```

Start only this bridge from the widget folder:

```bash
node audio-server.js
```

Debug endpoint:

```text
http://127.0.0.1:3748/debug
```

## Notes

- Uses FFmpeg plus PipeWire/PulseAudio on Raspberry Pi OS.
- Uses port `3748`.
- Do not run `levels-server.js` at the same time; it also uses port `3748`.
