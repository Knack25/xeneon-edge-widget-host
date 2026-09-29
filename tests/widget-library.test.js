'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWidgetLibrary } = require('../widget-library');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundledRoot = path.join(root, 'bundled');
  const managedRoot = path.join(root, 'managed');
  fs.mkdirSync(bundledRoot);
  return { root, bundledRoot, managedRoot, library: createWidgetLibrary({ bundledRoot, managedRoot }) };
}
function widget(root, folder, manifest) {
  const source = path.join(root, folder);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'index.html'), 'widget');
  if (manifest !== undefined) fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  return source;
}
test('new import is durable with safe normalized URLs and an opaque folder', t => {
  const f = fixture(t);
  f.library.beginImport(widget(f.root, 'source', { id: '../../escape', preview_icon: 'a b.png' }));
  const item = createWidgetLibrary(f).scan()[0];
  assert.equal(item.id, '../../escape');
  assert.match(item.folder, /^[a-f0-9]{24}$/);
  assert.equal(item.source, 'managed');
  assert.equal(item.entryUrl, `${item.baseUrl}/index.html`);
  assert.equal(item.iconUrl, `${item.baseUrl}/a%20b.png`);
  assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
});
test('absent manifest ID uses the original folder consistently after restart', t => {
  const f = fixture(t);
  assert.equal(f.library.beginImport(widget(f.root, 'Original')).status, 'installed');
  assert.equal(createWidgetLibrary(f).scan()[0].id, 'Original');
});
test('replacement is explicit, token is one-use, and cancellation cleans staging', t => {
  const f = fixture(t);
  f.library.beginImport(widget(f.root, 'one', { id: 'sample', version: '1' }));
  const pending = f.library.beginImport(widget(f.root, 'two', { id: 'sample', version: '2' }));
  assert.equal(pending.status, 'confirmation-required');
  assert.equal(pending.installed.version, '1');
  assert.equal(pending.incoming.version, '2');
  assert.equal(f.library.scan()[0].manifest.version, '1');
  assert.equal(f.library.confirmReplacement(pending.token).status, 'replaced');
  assert.throws(() => f.library.confirmReplacement(pending.token), /expired/i);
  const cancel = f.library.beginImport(widget(f.root, 'three', { id: 'sample', version: '3' }));
  f.library.cancelReplacement(cancel.token);
  assert.throws(() => f.library.confirmReplacement(cancel.token), /expired/i);
  assert.equal(fs.readdirSync(f.managedRoot).some(n => n.startsWith('.staging-')), false);
});
test('bundled replacement creates a managed override without touching bundled source', t => {
  const f = fixture(t);
  widget(f.bundledRoot, 'stock', { id: 'sample', version: '1' });
  const pending = f.library.beginImport(widget(f.root, 'incoming', { id: 'sample', version: '2' }));
  assert.equal(pending.status, 'confirmation-required');
  f.library.confirmReplacement(pending.token);
  assert.equal(f.library.scan().length, 1);
  assert.equal(f.library.scan()[0].source, 'managed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bundledRoot, 'stock/manifest.json'))).version, '1');
});
test('rejects malformed manifests, missing regular index and every symlink', t => {
  const f = fixture(t);
  const source = widget(f.root, 'source', { id: 'sample' });
  fs.writeFileSync(path.join(source, 'manifest.json'), '{');
  assert.throws(() => f.library.beginImport(source), /manifest/i);
  fs.writeFileSync(path.join(source, 'manifest.json'), '[]');
  assert.throws(() => f.library.beginImport(source), /manifest/i);
  fs.unlinkSync(path.join(source, 'manifest.json'));
  fs.symlinkSync(f.bundledRoot, path.join(source, 'link'));
  assert.throws(() => f.library.beginImport(source), /symbolic link/i);
  fs.unlinkSync(path.join(source, 'link'));
  fs.unlinkSync(path.join(source, 'index.html'));
  fs.mkdirSync(path.join(source, 'index.html'));
  assert.throws(() => f.library.beginImport(source), /index.html/i);
});
test('failed promotion restores old files and consumes token', t => {
  const f = fixture(t);
  f.library.beginImport(widget(f.root, 'one', { id: 'sample', version: '1' }));
  const pending = f.library.beginImport(widget(f.root, 'two', { id: 'sample', version: '2' }));
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (path.basename(from).startsWith('.staging-')) throw new Error('promotion failure'); return rename(from, to); };
  try { assert.throws(() => f.library.confirmReplacement(pending.token), /promotion failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(f.library.scan()[0].manifest.version, '1');
  assert.throws(() => f.library.confirmReplacement(pending.token), /expired/i);
  assert.equal(fs.readdirSync(f.managedRoot).some(n => n.startsWith('.staging-')), false);
});
test('an unrelated managed target collision is preserved', t => {
  const f = fixture(t);
  const crypto = require('node:crypto');
  const folder = crypto.createHash('sha256').update('sample').digest('hex').slice(0, 24);
  fs.mkdirSync(f.managedRoot, { recursive: true });
  fs.writeFileSync(path.join(f.managedRoot, folder), 'user data');
  assert.throws(() => f.library.beginImport(widget(f.root, 'source', { id: 'sample' })), /collision/i);
  assert.equal(fs.readFileSync(path.join(f.managedRoot, folder), 'utf8'), 'user data');
});
test('dangling symlink target collision is preserved', t => {
  const f = fixture(t);
  const folder = require('node:crypto').createHash('sha256').update('sample').digest('hex').slice(0, 24);
  fs.symlinkSync(path.join(f.root, 'absent'), path.join(f.managedRoot, folder));
  assert.throws(() => f.library.beginImport(widget(f.root, 'source', { id: 'sample' })), /collision/i);
  assert.equal(fs.lstatSync(path.join(f.managedRoot, folder)).isSymbolicLink(), true);
});
test('same-ID directory outside the managed naming convention is preserved', t => {
  const f = fixture(t);
  widget(f.managedRoot, 'user-folder', { id: 'sample' });
  assert.throws(() => f.library.beginImport(widget(f.root, 'source', { id: 'sample' })), /collision/i);
  assert.equal(f.library.scan().length, 1);
  assert.equal(fs.existsSync(path.join(f.managedRoot, 'user-folder/index.html')), true);
});
