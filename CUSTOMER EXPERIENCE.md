# Customer Experience

## What the App Does

Raspi iCUE Widget Runner Engine brings browser-style CORSAIR iCUE widgets to Raspberry Pi OS. It discovers compatible widgets stored on the device, presents them in a simple launcher, and runs the selected experience in an Electron window or Chromium app mode. An iCUE compatibility layer helps widgets operate outside the full desktop iCUE runtime, while optional local audio bridges enable experiences such as live VU meters and spectrum analyzers.

## Use Case Scenario

A customer may have a Raspberry Pi connected to a XENEON EDGE display as part of a desk, gaming room, streaming station, workshop, or home-entertainment setup. After starting the runner, the customer can browse the available widgets and select an experience such as an audio visualizer, clock face, air-quality display, or drawing surface. The Pi can then serve as a dedicated, always-available information or ambient display without requiring the primary PC screen to remain occupied.

The runner is also useful for prototyping. Designers and developers can place a compatible web widget in the local `widgets/` folder, launch it in the runner, and evaluate its appearance, interaction model, performance, and suitability for a small or touch-enabled display.

## Who It Is For

This project may be useful to:

- CORSAIR and iCUE enthusiasts interested in experimenting with new widget experiences.
- Raspberry Pi users who want a dedicated dashboard or ambient display.
- Gamers, streamers, creators, and PC builders who want system-adjacent visuals on a secondary screen.
- Widget designers and web developers who need a lightweight environment for testing concepts.
- Early adopters who are comfortable evaluating experimental software and providing feedback.

## Operating System Compatibility

Raspberry Pi OS is the currently supported and validated platform. Because the runner is built with Node.js, Electron or Chromium, and standard web technologies, it is also likely to work on Debian- or Ubuntu-based desktop Linux distributions and other Linux single-board computers that provide the required dependencies. These additional Linux environments are potential compatibility targets but are not currently validated or officially supported by this preview.

Audio-reactive widgets additionally require FFmpeg, PipeWire or PulseAudio, `pactl`, and access to a suitable output-monitor audio source. Compatibility may therefore vary by Linux distribution and hardware configuration.

## Customer Experience

The intended experience is exploratory, visual, and approachable. Customers should be able to launch the app, understand which widgets are available, preview a widget, and begin using it with minimal setup. Widget names, icons, metadata, status information, and saved settings help make the collection feel organized and persistent. Electron provides the primary desktop-like experience, while Chromium app mode offers a practical fallback.

Some capabilities depend on the Raspberry Pi configuration. Audio-reactive widgets require FFmpeg and a working PipeWire or PulseAudio monitor source, and widgets that retrieve live information may require internet access. Clear status indicators, fallback behavior, debug endpoints, and setup guidance are therefore important parts of the experience. Because this is preview software, customers should expect experiments, changing behavior, and features that may not become part of a future iCUE release.

## Technical Experience

The application uses Node.js, a local web server, and Electron or Chromium to host HTML-based widgets. It scans for widget folders containing an `index.html` file, reads optional manifest information, and loads each widget in an isolated frame. The runner injects iCUE-style globals and sensor-provider compatibility behavior so that supported widgets can run on Raspberry Pi OS without the official iCUE desktop runtime.

For audio-reactive widgets, local bridge services use FFmpeg to capture output-monitor audio and expose VU level or FFT spectrum data on loopback-only endpoints. Runner settings are retained in browser local storage, and developers can add permanent widgets to the bundled `widgets/` directory or temporarily load a widget for evaluation.

## Vision for CORSAIR Labs

This app is intended for publication in the CORSAIR Labs GitHub repository: a home for internal-use tools, early-access previews, experimental widgets, and prototypes that explore ideas beyond current official iCUE releases. These projects may preview concepts that could inform future iCUE features, unlock specialized workflows, or investigate platforms and operating systems that iCUE does not officially support today.

We envision CORSAIR Labs becoming an open workshop between CORSAIR creators and the community. A place where useful ideas can be shared earlier, tested in real environments, and improved through practical feedback. The repository can make experimentation more visible, give enthusiasts a safe and clearly labeled way to explore emerging concepts, and help teams learn which experiences deliver genuine customer value before decisions are made about broader product integration.

Projects in CORSAIR Labs should be treated as experimental previews rather than supported CORSAIR products. Availability in the repository does not promise inclusion in iCUE, official platform support, continued development, warranty coverage, or technical support. Users should review each project's requirements, license, and disclaimer before use.
