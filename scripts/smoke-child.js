'use strict';
const { spawn } = require('node:child_process');

function runOwnedChild(command, args, { timeoutMs = 90000, killGraceMs = 2000, spawnOptions = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, spawnOptions);
    let timeout, killTimer, timeoutError, settled = false;
    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(code);
    }
    child.once('error', error => finish(timeoutError || error));
    child.once('exit', code => finish(timeoutError, code));
    timeout = setTimeout(() => {
      timeoutError = new Error('Electron smoke test exceeded ' + timeoutMs + ' milliseconds');
      // Signals target only the ChildProcess created above, never a port owner
      // or a PID discovered elsewhere. Graceful exit still counts as timeout.
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(timeoutError);
      }, killGraceMs);
      child.kill('SIGTERM');
    }, timeoutMs);
  });
}
module.exports = { runOwnedChild };
