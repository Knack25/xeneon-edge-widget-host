'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOwnedChild } = require('../scripts/smoke-child');

test('watchdog forcibly stops only its spawned child when SIGTERM is ignored', { timeout: 2000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-watchdog-'));
  const marker = path.join(directory, 'ignored');
  const pidPath = path.join(directory, 'pid');
  t.after(() => {
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const script = "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => fs.writeFileSync(process.argv[2], 'ignored')); setInterval(() => {}, 1000);";
  const began = Date.now();
  await assert.rejects(runOwnedChild(process.execPath, ['-e', script, pidPath, marker],
    { timeoutMs: 300, killGraceMs: 100, spawnOptions: { stdio: 'ignore' } }), /exceeded 300 milliseconds/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ignored');
  assert.ok(Date.now() - began < 3000, 'watchdog failure must settle promptly');
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  // SIGKILL delivery precedes reaping; give the exclusively owned child time to exit.
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('owned child survived forced watchdog termination');
});

test('a timed-out child exiting zero after SIGTERM still fails', async () => {
  const script = "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);";
  await assert.rejects(runOwnedChild(process.execPath, ['-e', script],
    { timeoutMs: 300, killGraceMs: 100, spawnOptions: { stdio: 'ignore' } }), /exceeded 300 milliseconds/);
});

test('normal completion and spawn errors settle without a later watchdog signal', async () => {
  assert.equal(await runOwnedChild(process.execPath, ['-e', 'process.exit(7)'],
    { timeoutMs: 1000, killGraceMs: 100, spawnOptions: { stdio: 'ignore' } }), 7);
  await assert.rejects(runOwnedChild('/nonexistent-smoke-test-command', [],
    { timeoutMs: 1000, killGraceMs: 100, spawnOptions: { stdio: 'ignore' } }), { code: 'ENOENT' });
});
