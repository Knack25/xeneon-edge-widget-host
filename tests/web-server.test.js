'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../web-server');
const { createWidgetLibrary } = require('../widget-library');

test('server serves declared library roots, protects paths, and keeps catalog private', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-server-'));
  const bundledRoot = path.join(root, 'external-bundled');
  const managedRoot = path.join(root, 'external-managed');
  fs.mkdirSync(path.join(bundledRoot, 'stock'), { recursive: true });
  fs.writeFileSync(path.join(bundledRoot, 'stock/index.html'), 'stock');
  fs.writeFileSync(path.join(root, 'index.html'), 'launcher');
  fs.writeFileSync(path.join(root, 'controller.html'), 'controller');
  fs.writeFileSync(path.join(root, 'secret'), 'secret');
  const source = path.join(root, 'incoming');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.html'), 'imported');
  const library = createWidgetLibrary({ bundledRoot, managedRoot });
  library.beginImport(source);
  const server = createServer({ root, widgetLibrary: library });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const request = url => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: url }, res => {
      let body = ''; res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal((await request('/')).body, 'controller');
  assert.equal((await request('/widgets/stock/index.html')).body, 'stock');
  assert.equal((await request(library.scan().find(e => e.source === 'managed').entryUrl)).body, 'imported');
  const api = await request('/api/widgets');
  assert.equal(api.status, 200);
  assert.equal(api.body.includes(root), false);
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ id: 'incoming', version: '2' }));
  const pending = library.beginImport(source);
  const staging = fs.readdirSync(managedRoot).find(name => name.startsWith('.staging-'));
  assert.equal((await request(`/managed-widgets/${staging}/index.html`)).status, 404);
  fs.symlinkSync(path.join(managedRoot, staging), path.join(root, 'pending-alias'));
  fs.mkdirSync(path.join(root, 'pending-index-alias'));
  fs.symlinkSync(path.join(managedRoot, staging, 'index.html'), path.join(root, 'pending-index-alias/index.html'));
  const installed = library.scan().find(entry => entry.source === 'managed');
  for (const alias of [
    `/external-managed/${staging}/index.html`,
    '/pending-alias/index.html',
    '/pending-index-alias/',
    `/external-managed/${installed.folder}/index.html`
  ]) {
    assert.equal((await request(alias)).status, 404, alias);
  }
  assert.equal((await request(installed.entryUrl)).body, 'imported');
  library.cancelReplacement(pending.token);
  for (const url of ['/managed-widgets/%2e%2e/secret', '/widgets/../secret', '/%2e%2e/secret', '/widgets/%00', '/widgets/%zz', '/widgets/%2e%2e%5csecret']) {
    assert.equal((await request(url)).status, 400, url);
  }
  fs.symlinkSync(path.join(root, 'secret'), path.join(bundledRoot, 'stock/escape'));
  assert.equal((await request('/widgets/stock/escape')).status, 400);
  fs.mkdirSync(path.join(bundledRoot, 'stock/nested'));
  fs.symlinkSync(path.join(root, 'secret'), path.join(bundledRoot, 'stock/nested/index.html'));
  assert.equal((await request('/widgets/stock/nested/')).status, 400);
});
test('server without injected library preserves legacy startup and catalog shape', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const entries = await new Promise(resolve => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/widgets' }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(JSON.parse(body))); }));
  assert.ok(entries.length > 0);
  assert.ok(entries[0].path.startsWith('widgets/'));
});
