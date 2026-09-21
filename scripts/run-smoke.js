'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ICUE_WIDGET_RUNNER_DIR;
const child = spawn(require('electron'), [path.join(__dirname, '../tests/electron-smoke.js')], {
  cwd: path.join(__dirname, '..'), env, stdio: 'inherit', windowsHide: true
});
const timeout = setTimeout(() => {
  console.error('Electron smoke test exceeded 45 seconds');
  child.kill();
}, 45000);
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timeout); process.exitCode = code === 0 ? 0 : 1; });
