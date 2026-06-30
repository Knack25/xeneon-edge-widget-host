'use strict';

const { execFileSync, spawn } = require('child_process');

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_CHANNELS = 2;
const DEFAULT_COMMAND_TIMEOUT_MS = 1500;

function commandOutput(command, args, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs
    }).trim();
  } catch {
    return '';
  }
}

function valueFromPactlInfo(info, label) {
  const prefix = `${label}:`;
  const line = String(info || '')
    .split(/\r?\n/)
    .find(row => row.trim().startsWith(prefix));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}

function listPulseSources() {
  const output = commandOutput('pactl', ['list', 'short', 'sources']);
  return output
    .split(/\r?\n/)
    .map(row => {
      const parts = row.split(/\t+/);
      return {
        id: parts[0] || '',
        name: parts[1] || '',
        driver: parts[2] || '',
        sample: parts[3] || '',
        state: parts[4] || '',
        row
      };
    })
    .filter(source => source.name);
}

function getDefaultSink() {
  const direct = commandOutput('pactl', ['get-default-sink']);
  if (direct) return direct;
  return valueFromPactlInfo(commandOutput('pactl', ['info']), 'Default Sink');
}

function getDefaultSource() {
  const direct = commandOutput('pactl', ['get-default-source']);
  if (direct) return direct;
  return valueFromPactlInfo(commandOutput('pactl', ['info']), 'Default Source');
}

function hasSource(sources, name) {
  return sources.some(source => source.name === name);
}

function selectPulseSource(options = {}) {
  const envSource = process.env.ICUE_AUDIO_SOURCE || process.env.PULSE_SOURCE || '';
  const override = options.source || envSource;
  const sources = listPulseSources();
  const defaultSink = getDefaultSink();
  const defaultSource = getDefaultSource();

  if (override) {
    return {
      name: override,
      reason: hasSource(sources, override) ? 'configured override' : 'configured override (not listed by pactl)',
      defaultSink,
      defaultSource,
      sources
    };
  }

  const defaultMonitor = defaultSink ? `${defaultSink}.monitor` : '';
  if (defaultMonitor && hasSource(sources, defaultMonitor)) {
    return {
      name: defaultMonitor,
      reason: 'default sink monitor',
      defaultSink,
      defaultSource,
      sources
    };
  }

  const firstMonitor = sources.find(source => source.name.endsWith('.monitor'));
  if (firstMonitor) {
    return {
      name: firstMonitor.name,
      reason: 'first available sink monitor',
      defaultSink,
      defaultSource,
      sources
    };
  }

  if (defaultSource) {
    return {
      name: defaultSource,
      reason: 'default source fallback',
      defaultSink,
      defaultSource,
      sources
    };
  }

  return {
    name: 'default',
    reason: 'ffmpeg default fallback',
    defaultSink,
    defaultSource,
    sources
  };
}

function buildFfmpegPulseArgs(sourceName, options = {}) {
  const sampleRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
  const channels = options.channels || DEFAULT_CHANNELS;
  const logLevel = options.logLevel || 'warning';

  return [
    '-hide_banner',
    '-loglevel', logLevel,
    '-nostdin',
    '-f', 'pulse',
    '-i', sourceName,
    '-acodec', 'pcm_s16le',
    '-ac', String(channels),
    '-ar', String(sampleRate),
    '-f', 's16le',
    'pipe:1'
  ];
}

function startFfmpegPulseCapture(options = {}) {
  const selected = selectPulseSource(options);
  const ffmpegPath = options.ffmpegPath || 'ffmpeg';
  const args = buildFfmpegPulseArgs(selected.name, options);
  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return { child, selected, args };
}

module.exports = {
  DEFAULT_CHANNELS,
  DEFAULT_SAMPLE_RATE,
  buildFfmpegPulseArgs,
  commandOutput,
  getDefaultSink,
  getDefaultSource,
  listPulseSources,
  selectPulseSource,
  startFfmpegPulseCapture
};
