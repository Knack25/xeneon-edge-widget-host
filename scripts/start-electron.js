'use strict';

const path = require('path');
const { spawn } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const runnerDir = path.resolve(process.argv[2] || appRoot);
const electronPath = require('electron');
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;
env.ICUE_WIDGET_RUNNER_DIR = runnerDir;

const child = spawn(electronPath, ['.'], {
  cwd: appRoot,
  env,
  stdio: 'inherit',
  windowsHide: false
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code || 0);
});

child.on('error', error => {
  console.error(error);
  process.exit(1);
});
