'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function entryExists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function manifestAt(root) {
  const file = path.join(root, 'manifest.json');
  if (!fs.existsSync(file)) return {};
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid widget manifest: ${error.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid widget manifest: expected an object.');
  if (manifest.id !== undefined && (typeof manifest.id !== 'string' || !manifest.id.trim())) throw new Error('Invalid widget manifest ID.');
  return manifest;
}
function normalize(source, folder, manifest) {
  const id = manifest.id === undefined ? folder : manifest.id.trim();
  const baseUrl = `${source === 'managed' ? '/managed-widgets' : '/widgets'}/${encodeURIComponent(folder)}`;
  const icon = manifest.preview_icon;
  const safeIcon = typeof icon === 'string' && !icon.includes('\\') && !icon.includes('\0') && !icon.startsWith('/') && !icon.split('/').some(part => part === '..' || part === '.');
  return { id, folder, source, baseUrl, entryUrl: `${baseUrl}/index.html`, iconUrl: safeIcon && icon ? `${baseUrl}/${icon.split('/').map(encodeURIComponent).join('/')}` : '', manifest };
}
function walk(root, relative = '', files = []) {
  const target = path.join(root, relative);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('Widget import contains a symbolic link.');
  if (stat.isDirectory()) {
    files.push({ relative, directory: true });
    for (const name of fs.readdirSync(target)) walk(root, path.join(relative, name), files);
  } else if (stat.isFile()) files.push({ relative, directory: false });
  else throw new Error('Widget import contains a non-regular file.');
  return files;
}
function createWidgetLibrary({ bundledRoot, managedRoot }) {
  if (!bundledRoot || !managedRoot) throw new Error('Bundled and managed roots are required.');
  fs.mkdirSync(managedRoot, { recursive: true });
  const roots = { bundled: fs.existsSync(bundledRoot) ? fs.realpathSync(bundledRoot) : path.resolve(bundledRoot), managed: fs.realpathSync(managedRoot) };
  const pending = new Map();
  const randomPath = prefix => path.join(roots.managed, `${prefix}${crypto.randomUUID()}`);
  function scanSource(source) {
    if (!fs.existsSync(roots[source])) return [];
    return fs.readdirSync(roots[source], { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const root = path.join(roots[source], entry.name);
      const index = path.join(root, 'index.html');
      if (!fs.existsSync(index) || !fs.lstatSync(index).isFile()) return [];
      return [normalize(source, entry.name, manifestAt(root))];
    });
  }
  function scan() {
    const catalog = new Map();
    for (const item of [...scanSource('bundled'), ...scanSource('managed')]) {
      const previous = catalog.get(item.id);
      if (previous && previous.source === item.source) throw new Error(`Duplicate widget ID: ${item.id}`);
      catalog.set(item.id, item);
    }
    return [...catalog.values()];
  }
  function promote(record) {
    const target = path.join(roots.managed, record.folder);
    let backup;
    if (entryExists(target)) {
      // Only a catalogued same-ID managed directory can be replaced.
      const current = scanSource('managed').find(item => item.folder === record.folder);
      if (!current || current.id !== record.entry.id || !record.replaceManaged) throw new Error('Managed widget path collision.');
      backup = randomPath('.backup-');
      fs.renameSync(target, backup);
    }
    try { fs.renameSync(record.staging, target); }
    catch (error) {
      if (backup) fs.renameSync(backup, target);
      throw error;
    }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
  }
  function beginImport(sourcePath) {
    const source = path.resolve(sourcePath);
    const files = walk(source);
    if (!files[0].directory || !files.some(file => file.relative === 'index.html' && !file.directory)) throw new Error('Widget requires a regular index.html.');
    const manifest = manifestAt(source);
    const id = manifest.id === undefined ? path.basename(source) : manifest.id.trim();
    const folder = crypto.createHash('sha256').update(id).digest('hex').slice(0, 24);
    const installed = scan().find(item => item.id === id);
    const target = path.join(roots.managed, folder);
    if ((installed?.source === 'managed' && installed.folder !== folder) || (entryExists(target) && (!installed || installed.source !== 'managed' || installed.folder !== folder))) throw new Error('Managed widget path collision.');
    const staging = randomPath('.staging-');
    const entry = normalize('managed', folder, { ...manifest, id });
    try {
      fs.mkdirSync(staging);
      for (const file of files.slice(1)) {
        const from = path.join(source, file.relative);
        const to = path.join(staging, file.relative);
        const stat = fs.lstatSync(from);
        if (stat.isSymbolicLink()) throw new Error('Widget import contains a symbolic link.');
        if (file.directory && stat.isDirectory()) fs.mkdirSync(to);
        else if (!file.directory && stat.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        else throw new Error('Widget changed during import.');
      }
      // Persist the normalized stable ID, including the original-folder fallback.
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(entry.manifest, null, 2));
      const record = { staging, folder, entry, replaceManaged: installed?.source === 'managed' };
      if (installed) {
        const token = crypto.randomUUID();
        pending.set(token, record);
        return { status: 'confirmation-required', token, installed: { id, name: installed.manifest.name || id, version: installed.manifest.version || '' }, incoming: { id, name: manifest.name || id, version: manifest.version || '' } };
      }
      promote(record);
      return { status: 'installed', entry };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  function consume(token) {
    const record = pending.get(token);
    if (!record) throw new Error('Replacement token expired or invalid.');
    pending.delete(token);
    return record;
  }
  function confirmReplacement(token) {
    const record = consume(token);
    try { promote(record); return { status: 'replaced', entry: record.entry }; }
    finally { fs.rmSync(record.staging, { recursive: true, force: true }); }
  }
  function cancelReplacement(token) {
    const record = consume(token);
    fs.rmSync(record.staging, { recursive: true, force: true });
    return { status: 'cancelled' };
  }
  // Main-process/server-only interface. Never serialize these filesystem roots.
  function getServingRoots() { return [{ baseUrl: '/widgets', root: roots.bundled }, { baseUrl: '/managed-widgets', root: roots.managed }]; }
  return { scan, beginImport, confirmReplacement, cancelReplacement, getServingRoots };
}
module.exports = { createWidgetLibrary };
