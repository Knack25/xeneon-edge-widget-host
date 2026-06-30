# Spectrum Analyzer - Raspberry Pi Runner

Real-time audio spectrum widget driven by the local Raspberry Pi audio bridge.

## How It Works

`spectrum-server 2.js` captures the current PipeWire/PulseAudio monitor source
through FFmpeg, runs FFT analysis with `fft.js`, and serves normalized spectrum
bins at:

```text
http://127.0.0.1:3749/fft
```

If the bridge is not running, the widget uses its simulated fallback.

## Run

Start the full runner from the repo root:

```bash
./icue-widget-runner-raspi/run-all.sh both
```

Start only this bridge from the widget folder:

```bash
node "spectrum-server 2.js"
```

Debug endpoint:

```text
http://127.0.0.1:3749/debug
```

## Notes

- Uses FFmpeg plus PipeWire/PulseAudio on Raspberry Pi OS.
- Uses port `3749`.
- Requires the root npm dependencies from `package.json`.
