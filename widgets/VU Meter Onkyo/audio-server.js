/**
 * audio-server.js - VU Meter Audio Bridge for Raspberry Pi OS
 *
 * Captures the current PipeWire/PulseAudio default sink monitor with FFmpeg
 * and serves stereo peak levels at:
 *
 *   http://127.0.0.1:3748/levels
 *   http://127.0.0.1:3748/debug
 *
 * Optional override:
 *   ICUE_AUDIO_SOURCE=alsa_output.your_sink.monitor node audio-server.js
 */
'use strict';

const http = require('http');
const {
  DEFAULT_CHANNELS,
  DEFAULT_SAMPLE_RATE,
  startFfmpegPulseCapture
} = require('../../audio-capture');

const PORT = 3748;
const FRAME_SIZE = 2048;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_FRAME = FRAME_SIZE * DEFAULT_CHANNELS * BYTES_PER_SAMPLE;
const DECAY = 0.82;
const RESTART_MS = 3000;

let levelL = 0;
let levelR = 0;
let audioActive = false;
let restartTimer = null;
let captureSource = 'not started';
let captureReason = '';
let currentFfmpeg = null;
let shuttingDown = false;

function resetLevels() {
  levelL = 0;
  levelR = 0;
  audioActive = false;
}

function scheduleRestart(reason) {
  if (shuttingDown) return;
  if (restartTimer) return;
  resetLevels();
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

function processFrame(frame) {
  let peakL = 0;
  let peakR = 0;

  for (let i = 0; i < BYTES_PER_FRAME; i += 4) {
    const absL = Math.abs(frame.readInt16LE(i)) / 32767;
    const absR = Math.abs(frame.readInt16LE(i + 2)) / 32767;
    if (absL > peakL) peakL = absL;
    if (absR > peakR) peakR = absR;
  }

  levelL = peakL > levelL ? peakL : levelL * DECAY;
  levelR = peakR > levelR ? peakR : levelR * DECAY;

  if ((peakL > 0.001 || peakR > 0.001) && !audioActive) {
    console.log(`Audio detected: L=${peakL.toFixed(3)} R=${peakR.toFixed(3)}`);
    audioActive = true;
  }
}

function startAudioCapture() {
  console.log('Starting VU bridge FFmpeg capture...');

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

  if (req.url === '/levels' || req.url === '/') {
    json(res, {
      L: +levelL.toFixed(4),
      R: +levelR.toFixed(4)
    });
    return;
  }

  if (req.url === '/debug') {
    const on = levelL > 0.005 || levelR > 0.005;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body style="font:18px monospace;padding:24px;background:#111;color:#0f0">
<h2 style="color:#fff">VU Bridge (Raspberry Pi OS / FFmpeg)</h2>
<div style="font-size:36px;margin:16px 0">L=<b>${levelL.toFixed(4)}</b>&nbsp;R=<b>${levelR.toFixed(4)}</b></div>
<p style="font-size:22px;color:${on ? '#0f0' : '#f55'}">${on ? 'Audio detected' : 'No audio detected'}</p>
<p style="color:#aaa">Source: ${escapeHtml(captureSource)} (${escapeHtml(captureReason)})</p>
<script>setTimeout(()=>location.reload(),300)</script></body></html>`);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('VU Meter Bridge (Raspberry Pi OS / FFmpeg)');
  console.log(`Levels: http://127.0.0.1:${PORT}/levels`);
  console.log(`Debug:  http://127.0.0.1:${PORT}/debug`);
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
