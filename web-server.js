'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const WIDGETS = path.join(ROOT, 'widgets');
const HOST = '127.0.0.1';
const PORT = 8080;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function sendJson(res, value) {
  send(res, 200, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8'
  });
}

function safeJsonLoad(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function toWebPath(...parts) {
  return parts.map(part => String(part).replace(/\\/g, '/')).join('/');
}

function handleWidgetsApi(res, widgetsRoot = WIDGETS) {
  const entries = [];
  if (fs.existsSync(widgetsRoot)) {
    const folders = fs.readdirSync(widgetsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const folder of folders) {
      const folderPath = path.join(widgetsRoot, folder);
      const indexPath = path.join(folderPath, 'index.html');
      if (!fs.existsSync(indexPath)) continue;

      const manifest = safeJsonLoad(path.join(folderPath, 'manifest.json'));
      const icon = manifest.preview_icon || '';
      entries.push({
        folder,
        path: toWebPath('widgets', folder),
        entryUrl: toWebPath('widgets', folder, 'index.html'),
        manifest,
        iconUrl: icon ? toWebPath('widgets', folder, icon) : ''
      });
    }
  }
  sendJson(res, entries);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function serveStatic(req, res, pathname, routes, managedRoute) {
  const route = routes.find(item => pathname === item.baseUrl || pathname.startsWith(`${item.baseUrl}/`)) || routes[routes.length - 1];
  const relative = pathname.slice(route.baseUrl.length).replace(/^\/+/, '') || 'index.html';
  let filePath = path.resolve(route.root, relative);
  if (!inside(route.root, filePath)) return send(res, 400, 'Bad request');
  try {
    filePath = fs.realpathSync(filePath);
    if (!inside(route.root, filePath)) return send(res, 400, 'Bad request');
    if (managedRoute && route !== managedRoute && inside(managedRoute.root, filePath)) return send(res, 404, 'Not found');
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = fs.realpathSync(path.join(filePath, 'index.html'));
    if (!inside(route.root, filePath)) return send(res, 400, 'Bad request');
    if (managedRoute && route !== managedRoute && inside(managedRoute.root, filePath)) return send(res, 404, 'Not found');
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  fs.readFile(filePath, (err, body) => {
    if (err) {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, body, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'
    });
  });
}

function createServer(options = {}) {
  const root = fs.realpathSync(options.root || ROOT);
  const library = options.widgetLibrary;
  const routes = library ? library.getServingRoots().map(route => ({ ...route, root: fs.existsSync(route.root) ? fs.realpathSync(route.root) : path.resolve(route.root) })) : [{ baseUrl: '/widgets', root: fs.existsSync(path.join(root, 'widgets')) ? fs.realpathSync(path.join(root, 'widgets')) : path.join(root, 'widgets') }];
  const managedRoute = library && routes.find(route => route.baseUrl === '/managed-widgets');
  routes.push({ baseUrl: '', root });
  return http.createServer((req, res) => {
    let pathname;
    try {
      // Inspect the raw path before URL normalization can erase dot segments.
      pathname = decodeURIComponent(req.url.split('?')[0]);
      if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(segment => segment === '..' || segment === '.')) throw new Error('Invalid path');
    } catch { send(res, 400, 'Bad request'); return; }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (pathname === '/api/widgets') {
      try {
        if (library) sendJson(res, library.scan());
        else handleWidgetsApi(res, path.join(root, 'widgets'));
      } catch { send(res, 500, 'Widget catalog unavailable'); }
      return;
    }

    if (library && (pathname === '/managed-widgets' || pathname.startsWith('/managed-widgets/'))) {
      try {
        const published = library.scan().some(entry => {
          const baseUrl = decodeURIComponent(entry.baseUrl);
          return entry.source === 'managed' && (pathname === baseUrl || pathname.startsWith(`${baseUrl}/`));
        });
        if (!published) return send(res, 404, 'Not found');
      } catch { return send(res, 500, 'Widget catalog unavailable'); }
    }

    serveStatic(req, res, pathname, routes, managedRoute);
  });
}

function startServer(options = {}) {
  const host = options.host || HOST;
  const port = options.port || PORT;
  const server = createServer(options);

  if (typeof options.onError === 'function') {
    server.on('error', options.onError);
  }
  if (typeof options.onListening === 'function') {
    server.once('listening', options.onListening);
  }

  server.listen(port, host, () => {
    if (!options.silent) {
      console.log(`Serving http://${host}:${port}/`);
    }
  });

  return server;
}

if (require.main === module) {
  const server = startServer();

  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { HOST, PORT, createServer, startServer };
