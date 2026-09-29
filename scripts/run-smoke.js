'use strict';

const { runOwnedChild } = require('./smoke-child');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ICUE_WIDGET_RUNNER_DIR;
env.ICUE_SMOKE_ARTIFACTS = path.resolve(env.ICUE_SMOKE_ARTIFACTS || path.join(__dirname, '../artifacts'));
function portOpen() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 8080 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Port 8080 probe timed out')); });
  });
}
async function run() {
  if (await portOpen()) throw new Error('Port 8080 is occupied; smoke will not stop another app or service.');
  const code = await runOwnedChild(require('electron'), [path.join(__dirname, '../tests/electron-smoke.js')], {
    spawnOptions: {
      cwd: path.join(__dirname, '..'), env, stdio: 'inherit', windowsHide: true
    }
  });
  if (code !== 0) throw new Error('Electron smoke failed (exit ' + code + ')');
  if (await portOpen()) throw new Error('Application quit left port 8080 listening.');
  const reportPath = path.join(env.ICUE_SMOKE_ARTIFACTS, 'smoke-result.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (!report.success) throw new Error('Electron did not produce a successful smoke report.');
  report.quit = { applicationExited: true, loopbackServerClosed: true, mechanism: 'app.quit through the Cmd-Q before-quit shutdown path' };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('Electron exited and 127.0.0.1:8080 is closed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
