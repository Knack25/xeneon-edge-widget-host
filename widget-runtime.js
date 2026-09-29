(function (root) {
  'use strict';
  const settingsApi = typeof module === 'object' && module.exports ? require('./widget-settings') : root.ICUEWidgetSettings;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const jsonForScript = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  function normalizeManifest(manifest, folder = 'Unknown Widget') {
    const value = manifest && typeof manifest === 'object' ? manifest : {};
    return { id: value.id || folder.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: value.name || folder, description: value.description || 'No description provided.', version: value.version || 'unknown', author: value.author || 'unknown', preview_icon: value.preview_icon || '', os: Array.isArray(value.os) ? value.os : [], interactive: !!value.interactive, required_plugins: Array.isArray(value.required_plugins) ? value.required_plugins : [], supported_devices: Array.isArray(value.supported_devices) ? value.supported_devices : [] };
  }
  function propertiesFor(widget, settings) {
    const manifest = normalizeManifest(widget.manifest, widget.folder);
    return { ...settingsApi.getDefaultWidgetSettings(widget), ...settings, widgetId: widget.id || manifest.id, widgetName: manifest.name, uniqueId: widget.id || widget.uid || manifest.id };
  }
  function buildShimScript(widget, settings = {}) {
    return `(() => {
      const props = ${jsonForScript(propertiesFor(widget, settings))};
      Object.assign(window, props);
      window.iCUE = Object.assign({ iCUELanguage: 'en', ipRegistryApiKey: '' }, window.iCUE || {});
      window.tr = window.tr || (value => Promise.resolve(String(value)));
      window.iCUE_initialized = true;
      window.pluginSensorsdataprovider_initialized = true;
      window.icueEvents = window.icueEvents || {};
      window.pluginSensorsdataproviderEvents = window.pluginSensorsdataproviderEvents || {};
      const makeSignal = () => {
        const handlers = [];
        return { connect(fn) { if (typeof fn === 'function') handlers.push(fn); }, emit(...args) { for (const fn of handlers) { try { Promise.resolve(fn(...args)).catch(error => console.error(error)); } catch (error) { console.error(error); } } } };
      };
      const asyncResponse = makeSignal();
      const sensorValueChanged = makeSignal();
      const Sensorsdataprovider = {
        asyncResponse, sensorValueChanged,
        getDefaultSensorIdBlock(kind) { return kind === 'load' ? 'left' : 'right'; },
        getSensorValue(requestId, sensorId) { setTimeout(() => asyncResponse.emit(requestId, sensorId === 'right' ? 57 : 42), 0); },
        getSensorUnits(requestId) { setTimeout(() => asyncResponse.emit(requestId, '%'), 0); }
      };
      window.plugins = Object.assign({}, window.plugins || {}, { Sensorsdataprovider });
      const recordFailure = message => {
        window.__ICUEWidgetRuntimeFailure = String(message || 'Widget script failed.');
        if (typeof window.__ICUEWidgetRuntimeNotify === 'function') window.__ICUEWidgetRuntimeNotify(window.__ICUEWidgetRuntimeFailure);
      };
      window.addEventListener('error', event => recordFailure(event.message || 'Widget asset failed to load.'), true);
      window.addEventListener('unhandledrejection', event => recordFailure(event.reason && event.reason.message || event.reason || 'Widget promise failed.'));
    })();`;
  }
  function buildWidgetShell(widget, indexText, settings = {}, baseURI = root.location?.href) {
    if (typeof indexText !== 'string') throw new TypeError('Widget entry must be HTML text.');
    const entryUrl = new URL(widget.entryUrl, baseURI);
    const baseUrl = widget.baseUrl ? new URL(widget.baseUrl, entryUrl) : new URL('.', entryUrl);
    if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
    const baseHref = baseUrl.href;
    const injection = `<base href="${escapeHtml(baseHref)}">\n<script>${buildShimScript(widget, settings)}<\/script>`;
    if (/<head(\s[^>]*)?>/i.test(indexText)) return indexText.replace(/<head(\s[^>]*)?>/i, match => `${match}\n${injection}`);
    return `<!doctype html><html><head>${injection}</head><body>${indexText}</body></html>`;
  }
  function createWidgetRuntime({ document, fetchText, container, report = () => {}, frameLoadTimeoutMs = 15000 }) {
    const region = container || document.getElementById('primary-region');
    let current = null, live = null, destroyed = false;
    const stale = Object.freeze({ stale: true });
    function isCurrent(operation) { return !destroyed && current === operation; }
    async function send(operation, ok, message) {
      if (!isCurrent(operation)) return;
      // IPC rejects reports made obsolete by a later main-process revision.
      // Report transport failure must never become a renderer rejection loop.
      try { await report({ revision: operation.revision, ok, ...(message ? { message } : {}) }); } catch (_) { /* best effort */ }
    }
    function cancel(operation) {
      if (!operation) return;
      operation.cancel();
      clearTimeout(operation.deadlineTimer);
      operation.stopWaiting?.();
      if (operation.frame && operation.frame !== live) operation.frame.remove();
    }
    async function applySettings(operation) {
      const revision = operation.revision;
      const target = operation.frame.contentWindow;
      try {
        if (target.__ICUEWidgetRuntimeFailure) throw new Error(target.__ICUEWidgetRuntimeFailure);
        const properties = propertiesFor(operation.widget, operation.settings);
        for (const name of operation.appliedNames || []) if (!Object.hasOwn(properties, name)) delete target[name];
        Object.assign(target, properties);
        operation.appliedNames = Object.keys(properties);
        if (typeof target.icueEvents?.onDataUpdated === 'function') await Promise.race([Promise.resolve(target.icueEvents.onDataUpdated()), operation.cancellation, ...(operation.status === 'loading' ? [operation.deadline] : [])]);
        if (!isCurrent(operation) || revision !== operation.revision) return stale;
        if (target.__ICUEWidgetRuntimeFailure) throw new Error(target.__ICUEWidgetRuntimeFailure);
      } catch (error) {
        if (!isCurrent(operation) || (revision !== operation.revision && !operation.timedOut)) return stale;
        throw error;
      }
    }
    function waitForFrame(operation, shell) {
      const frame = operation.frame;
      return new Promise((resolve, reject) => {
        const cleanup = () => { frame.removeEventListener('load', loaded); frame.removeEventListener('error', failed); operation.stopWaiting = null; };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Widget frame failed to load.')); };
        operation.stopWaiting = () => { cleanup(); resolve(stale); };
        frame.addEventListener('load', loaded); frame.addEventListener('error', failed);
        try { frame.srcdoc = shell; region.append(frame); } catch (error) { cleanup(); reject(error); }
      });
    }
    async function load({ widget, settings = {}, revision }) {
      if (destroyed || (current && revision < current.revision)) return stale;
      cancel(current);
      let cancelLoad;
      const cancellation = new Promise(resolve => { cancelLoad = () => resolve(stale); });
      const operation = { widget, settings: { ...settings }, revision, frame: null, status: 'loading', cancel: cancelLoad, cancellation };
      current = operation;
      operation.deadline = new Promise((_, reject) => {
        operation.deadlineTimer = setTimeout(() => { operation.timedOut = true; reject(new Error('Widget preparation timed out.')); }, frameLoadTimeoutMs);
      });
      try {
        if (!widget) throw new Error('Selected widget is missing from the catalog.');
        const frame = document.createElement('iframe'); operation.frame = frame;
        frame.dataset.widgetId = widget.id || widget.manifest?.id; frame.dataset.live = 'false';
        frame.setAttribute('title', widget.manifest?.name || 'Widget'); frame.setAttribute('aria-hidden', 'true'); frame.style.visibility = 'hidden';
        const html = await Promise.race([Promise.resolve().then(() => fetchText(widget.entryUrl)), cancellation, operation.deadline]);
        if (!isCurrent(operation) || html === stale) { frame.remove(); return stale; }
        const shell = buildWidgetShell(widget, html, operation.settings, document.baseURI);
        operation.appliedNames = Object.keys(propertiesFor(widget, operation.settings));
        await Promise.race([waitForFrame(operation, shell), cancellation, operation.deadline]);
        if (!isCurrent(operation)) { frame.remove(); return stale; }
        while (await applySettings(operation) === stale) {
          if (!isCurrent(operation)) { frame.remove(); return stale; }
        }
        if (!isCurrent(operation)) { frame.remove(); return stale; }
        clearTimeout(operation.deadlineTimer);
        frame.contentWindow.__ICUEWidgetRuntimeNotify = message => {
          if (!isCurrent(operation)) return;
          operation.status = 'failed'; operation.error = message;
          void send(operation, false, message);
        };
        const previous = live; live = frame;
        frame.dataset.live = 'true'; frame.setAttribute('aria-hidden', 'false'); frame.style.visibility = 'visible';
        if (previous) { previous.contentWindow.__ICUEWidgetRuntimeNotify = null; previous.remove(); }
        operation.status = 'loaded'; await send(operation, true);
        return isCurrent(operation) ? { stale: false, ok: true } : stale;
      } catch (error) {
        clearTimeout(operation.deadlineTimer);
        operation.stopWaiting?.();
        if (operation.frame && operation.frame !== live) operation.frame.remove();
        if (!isCurrent(operation)) return stale;
        operation.status = 'failed'; operation.error = error.message || String(error);
        await send(operation, false, operation.error);
        return { stale: false, ok: false, message: operation.error };
      }
    }
    async function updateSettings({ settings = {}, revision }) {
      if (destroyed || !current || revision < current.revision) return stale;
      const operation = current; operation.revision = revision; operation.settings = { ...settings };
      if (operation.status === 'loading') return { pending: true };
      // A failed replacement must not send its settings into retained content.
      // The owned live frame can retry a transient settings callback failure.
      if (operation.status === 'failed' && (!live || operation.frame !== live)) { await send(operation, false, operation.error); return { failed: true }; }
      try { if (await applySettings(operation) === stale) return stale; operation.status = 'loaded'; operation.error = null; await send(operation, true); return { stale: false }; }
      catch (error) { operation.status = 'failed'; operation.error = error.message || String(error); await send(operation, false, operation.error); throw error; }
    }
    function destroy() {
      destroyed = true; cancel(current);
      if (live) { live.contentWindow.__ICUEWidgetRuntimeNotify = null; live.remove(); }
      current = null; live = null;
    }
    return { load, updateSettings, destroy };
  }
  const api = { createWidgetRuntime, normalizeManifest, buildShimScript, buildWidgetShell };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ICUEWidgetRuntime = api;
})(typeof globalThis === 'object' ? globalThis : this);
