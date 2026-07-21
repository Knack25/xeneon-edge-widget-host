/**
 * spectrum-server 2.js - Spectrum Analyzer Audio Bridge for Raspberry Pi OS
 *
 * Captures the current PipeWire/PulseAudio default sink monitor with FFmpeg,
 * computes 64 frequency bins, and serves them at:
 *
 *   http://127.0.0.1:3749/fft
 *   http://127.0.0.1:3749/debug
 *
 * Optional override:
 *   ICUE_AUDIO_SOURCE=alsa_output.your_sink.monitor node "spectrum-server 2.js"
 */
'use strict';

const http = require('http');
const FFT = require('fft.js');
const {
  DEFAULT_CHANNELS,
  DEFAULT_SAMPLE_RATE,
  startFfmpegPulseCapture
} = require('../../audio-capture');

const PORT = 3749;
const NUM_BINS = 64;
const FFT_SIZE = 2048;
const MIN_FREQ = 20;
const MAX_FREQ = 18000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_FRAME = FFT_SIZE * DEFAULT_CHANNELS * BYTES_PER_SAMPLE;
const DECAY = 0.88;
const RESTART_MS = 3000;

const fft = new FFT(FFT_SIZE);
const fftInput = new Array(FFT_SIZE).fill(0);
const fftOutput = fft.createComplexArray();
const hannWindow = createHannWindow();

let bins = new Float32Array(NUM_BINS);
let peakVal = 0;
let audioActive = false;
let restartTimer = null;
let captureSource = 'not started';
let captureReason = '';
let currentFfmpeg = null;
let shuttingDown = false;

function createHannWindow() {
  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  }
  return win;
}

function resetBins() {
  bins.fill(0);
  peakVal = 0;
  audioActive = false;
}

function scheduleRestart(reason) {
  if (shuttingDown) return;
  if (restartTimer) return;
  resetBins();
  console.log(`Restarting audio capture in ${RESTART_MS / 1000}s (${reason})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startAudioCapture();
  }, RESTART_MS);
}

function logFfmpegMessage(data) {
  const msg = data.toString().trim();
  if (msg) console.error(`[ffmpeg] ${msg}`);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[ch]));
}

function computeFFT(samples) {
  for (let i = 0; i < FFT_SIZE; i++) {
    fftInput[i] = samples[i] * hannWindow[i];
  }

  fft.realTransform(fftOutput, fftInput);

  const nyquist = DEFAULT_SAMPLE_RATE / 2;
  let peak = 0;

  for (let b = 0; b < NUM_BINS; b++) {
    const fLo = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, b / NUM_BINS);
    const fHi = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, (b + 1) / NUM_BINS);
    const lo = Math.max(0, Math.floor((fLo / nyquist) * (FFT_SIZE / 2)));
    const hi = Math.max(lo, Math.min(FFT_SIZE / 2 - 1, Math.floor((fHi / nyquist) * (FFT_SIZE / 2))));

    let sum = 0;
    for (let i = lo; i <= hi; i++) {
      const real = fftOutput[i * 2] || 0;
      const imag = fftOutput[i * 2 + 1] || 0;
      sum += Math.sqrt(real * real + imag * imag) / (FFT_SIZE / 2);
    }

    const avg = sum / (hi - lo + 1);
    const db = avg > 1e-10 ? 20 * Math.log10(avg) : -90;
    const normalized = Math.max(0, Math.min(1, (db + 80) / 70));

    bins[b] = normalized > bins[b] ? normalized : bins[b] * DECAY;
    if (bins[b] > peak) peak = bins[b];
  }

  peakVal = peak;
  return peak > 0.002;
}

function processFrame(frame) {
  const samples = new Float32Array(FFT_SIZE);

  for (let i = 0; i < FFT_SIZE; i++) {
    const offset = i * 4;
    const sampleL = frame.readInt16LE(offset);
    const sampleR = frame.readInt16LE(offset + 2);
    samples[i] = ((sampleL + sampleR) / 2) / 32767;
  }

  const wasActive = audioActive;
  audioActive = computeFFT(samples);

  if (audioActive && !wasActive) {
    console.log(`Audio detected: peak=${peakVal.toFixed(4)}`);
  }
}

function startAudioCapture() {
  console.log('Starting Spectrum bridge FFmpeg capture...');

  const { child: ffmpeg, selected } = startFfmpegPulseCapture({
    sampleRate: DEFAULT_SAMPLE_RATE,
    channels: DEFAULT_CHANNELS
  });

  currentFfmpeg = ffmpeg;
  captureSource = selected.name;
  captureReason = selected.reason;
  console.log(`PipeWire/Pulse source: ${captureSource} (${captureReason})`);
  if (selected.defaultSink) console.log(`Default sink: ${selected.defaultSink}`);

  let buffer = Buffer.alloc(0);

  ffmpeg.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= BYTES_PER_FRAME) {
      const frame = buffer.subarray(0, BYTES_PER_FRAME);
      buffer = buffer.subarray(BYTES_PER_FRAME);
      processFrame(frame);
    }
  });

  ffmpeg.stderr.on('data', logFfmpegMessage);

  ffmpeg.on('error', err => {
    console.error(`Failed to start ffmpeg: ${err.message}`);
    scheduleRestart('ffmpeg spawn error');
  });

  ffmpeg.on('close', code => {
    if (currentFfmpeg === ffmpeg) currentFfmpeg = null;
    console.log(`FFmpeg process closed with code ${code}`);
    scheduleRestart('ffmpeg exited');
  });
}

function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/fft' || req.url === '/') {
    json(res, {
      bins: Array.from(bins).map(v => +v.toFixed(5)),
      peak: +peakVal.toFixed(5),
      bins_count: NUM_BINS
    });
    return;
  }

  if (req.url === '/debug') {
    const active = peakVal > 0.002;
    const barRows = Array.from(bins).map((value, index) => {
      const pct = Math.min(100, value * 800).toFixed(0);
      return `<div style="display:inline-block;margin:1px;vertical-align:bottom"><div style="width:8px;height:${pct}px;background:hsl(${Math.floor(index / NUM_BINS * 280)},100%,55%);min-height:1px"></div></div>`;
    }).join('');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body style="font:14px monospace;padding:20px;background:#111;color:#eee">
<h2 style="color:#fff">Spectrum Bridge (Raspberry Pi OS / FFmpeg)</h2>
<p style="color:${active ? '#0f0' : '#f55'};font-size:20px">${active ? `Audio active Peak=${peakVal.toFixed(4)}` : 'No audio detected'}</p>
<div style="display:flex;align-items:flex-end;height:120px;border-bottom:1px solid #333;margin:12px 0">${barRows}</div>
<p style="color:#aaa">Source: ${escapeHtml(captureSource)} (${escapeHtml(captureReason)})</p>
<p style="color:#888;font-size:12px">${NUM_BINS} log-spaced bins, 20Hz to 18kHz, FFT N=${FFT_SIZE}</p>
<script>setTimeout(()=>location.reload(),300)</script></body></html>`);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('Spectrum Analyzer Bridge (Raspberry Pi OS / FFmpeg)');
  console.log(`FFT:   http://127.0.0.1:${PORT}/fft`);
  console.log(`Debug: http://127.0.0.1:${PORT}/debug`);
  console.log('');
  startAudioCapture();
});

function shutdown() {
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (currentFfmpeg && !currentFfmpeg.killed) currentFfmpeg.kill('SIGTERM');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
