(function (root) {
  'use strict';

  function createSceneRuntime({ document, createRuntime, report = () => {}, onPresentation = () => {} }) {
    const host = document.getElementById('primary-region');
    const entries = new Map();
    let requestedPageId = null, presentedPageId = null, requestToken = 0, destroyed = false;

    function setVisible(entry, visible) {
      entry.container.style.left = visible ? '0' : '-200vw';
      entry.container.style.pointerEvents = visible ? 'auto' : 'none';
      entry.container.inert = !visible;
      if (visible) entry.container.removeAttribute('inert');
      else entry.container.setAttribute('inert', '');
      entry.container.setAttribute('aria-hidden', String(!visible));
    }

    function dispose(entry) {
      if (entries.get(entry.pageId) !== entry) return;
      entries.delete(entry.pageId);
      entry.runtime.destroy();
      entry.container.remove();
    }

    function send(entry, result) {
      if (destroyed || entries.get(entry.pageId) !== entry) return Promise.resolve();
      const message = result.message ? { message: result.message } : {};
      const payload = { pageId: entry.pageId, widgetId: entry.widgetId,
        generation: entry.generation, revision: result.revision, ok: result.ok, ...message };
      return Promise.resolve().then(() => report(payload)).then(() => {
        if (result.ok && entries.get(entry.pageId) === entry) entry.lastReportedRevision = result.revision;
      }).catch(() => {});
    }

    async function updateSettings(entry, settings, revision) {
      const operation = { revision, failureReported: false, message: null };
      entry.settingsUpdate = operation;
      try {
        const result = await entry.runtime.updateSettings({ settings, revision });
        if (entry.settingsUpdate !== operation || destroyed || entries.get(entry.pageId) !== entry) return;
        entry.settingsUpdate = null;
        if (operation.failureReported || result?.failed) {
          entry.ready = false;
          entry.failed = true;
          await send(entry, { revision: entry.revision, ok: false, message: operation.message || 'Widget settings failed.' });
          return;
        }
        if (result?.stale || result?.pending || !entry.ready) return;
        if (requestedPageId === entry.pageId) await promote(entry, requestToken, entry.revision);
        else await send(entry, { revision: entry.revision, ok: true });
      } catch (error) {
        if (entry.settingsUpdate !== operation || destroyed || entries.get(entry.pageId) !== entry) return;
        entry.settingsUpdate = null;
        entry.ready = false;
        entry.failed = true;
        await send(entry, { revision: entry.revision, ok: false, message: operation.message || error.message || String(error) });
      }
    }

    function makeEntry(page, widget, generation, revision) {
      const container = document.createElement('div');
      container.className = 'page-scene';
      container.dataset.pageId = page.id;
      container.style.position = 'absolute';
      container.style.top = '0';
      container.style.width = '100%';
      container.style.height = '100%';
      setVisible({ container }, false);
      host.append(container);
      const entry = { pageId: page.id, widgetId: page.regions[0].widgetId, widget,
        signature: JSON.stringify(widget), generation, runtime: null, container,
        ready: false, failed: false, loading: null, loadSerial: 0,
        settingsKey: JSON.stringify(page.regions[0].settings), revision,
        failureReported: false, settingsUpdate: null };
      entry.runtime = createRuntime({ container, report: result => {
        if (destroyed || entries.get(entry.pageId) !== entry) return;
        if (entry.loading && result.ok) return; // Success is reported only after visible promotion.
        if (!result.ok) {
          entry.ready = false;
          entry.failed = true;
          if (entry.loading) entry.failureReported = true;
          if (entry.settingsUpdate) {
            if (result.revision === entry.settingsUpdate.revision) {
              entry.settingsUpdate.failureReported = true;
              entry.settingsUpdate.message = result.message;
            }
            return;
          }
        } else if (!entry.loading) {
          entry.ready = true;
          entry.failed = false;
        }
        if (entry.settingsUpdate) return;
        void send(entry, { ...result, revision: entry.revision });
      } });
      entries.set(page.id, entry);
      return entry;
    }

    async function promote(entry, token, revision, shouldReport = true) {
      if (destroyed || entries.get(entry.pageId) !== entry ||
        requestedPageId !== entry.pageId || token !== requestToken || !entry.ready) return;
      const changed = presentedPageId !== entry.pageId;
      if (changed) {
        const previous = entries.get(presentedPageId);
        if (previous) setVisible(previous, false);
        setVisible(entry, true);
        presentedPageId = entry.pageId;
        onPresentation({ pageId: entry.pageId });
        if (previous?.invalidated) dispose(previous);
      }
      if (shouldReport) await send(entry, { revision, ok: true });
    }

    async function prepare(entry, widget, settings, revision, token) {
      const serial = ++entry.loadSerial;
      entry.ready = false;
      entry.failed = false;
      entry.failureReported = false;
      let loading;
      try { loading = Promise.resolve(entry.runtime.load({ widget, settings, revision })); }
      catch (error) { loading = Promise.reject(error); }
      entry.loading = loading;
      let result;
      try { result = await loading; }
      catch (error) {
        if (serial !== entry.loadSerial || destroyed || entries.get(entry.pageId) !== entry) return;
        entry.loading = null;
        entry.failed = true;
        if (!entry.failureReported) await send(entry, { revision: entry.revision, ok: false, message: error.message || String(error) });
        return;
      }
      if (serial !== entry.loadSerial) return;
      entry.loading = null;
      if (destroyed || entries.get(entry.pageId) !== entry || result?.stale) return;
      if (!result?.ok) {
        entry.failed = true;
        if (!entry.failureReported) await send(entry, { revision: entry.revision, ok: false, message: result?.message || 'Widget failed to prepare.' });
        return;
      }
      entry.ready = true;
      if (requestedPageId === entry.pageId && token === requestToken) await promote(entry, token, entry.revision);
    }

    async function receive(snapshot) {
      if (destroyed || !snapshot?.scene) return;
      const { pages, activePageId } = snapshot.scene;
      const requestedChanged = requestedPageId !== activePageId;
      if (requestedChanged) { requestedPageId = activePageId; requestToken++; }
      const token = requestToken;
      const ids = new Set(pages.map(page => page.id));
      for (const entry of [...entries.values()]) if (!ids.has(entry.pageId)) {
        if (presentedPageId === entry.pageId) presentedPageId = null;
        dispose(entry);
      }
      const work = [];
      let activeSettingsChanged = false;
      for (const page of pages) {
        const widget = snapshot.pageWidgets?.[page.id] ?? null;
        const generation = snapshot.pageGenerations?.[page.id];
        const settings = page.regions[0].settings;
        const signature = JSON.stringify(widget);
        let entry = entries.get(page.id);
        if (entry && (entry.generation !== generation || entry.widgetId !== page.regions[0].widgetId || entry.signature !== signature)) {
          if (page.id === presentedPageId) {
            entry.invalidated = true;
            if (page.id === activePageId) {
              entry.invalidated = false;
              entry.widgetId = page.regions[0].widgetId;
              entry.widget = widget;
              entry.signature = signature;
              entry.generation = generation;
              entry.settingsKey = JSON.stringify(settings);
              entry.revision = snapshot.revision;
              work.push(prepare(entry, widget, settings, snapshot.revision, token));
            }
            continue;
          }
          dispose(entry); entry = null;
        }
        if (page.id !== activePageId && !entry) continue;
        if (!entry) {
          entry = makeEntry(page, widget, generation, snapshot.revision);
          work.push(prepare(entry, widget, settings, snapshot.revision, token));
          continue;
        }
        if (page.id === activePageId) entry.revision = snapshot.revision;
        const settingsKey = JSON.stringify(settings);
        if (page.id === activePageId && !entry.ready && !entry.loading && (!entry.failed || requestedChanged)) {
          entry.settingsKey = settingsKey;
          entry.revision = snapshot.revision;
          work.push(prepare(entry, widget, settings, snapshot.revision, token));
          continue;
        }
        if (entry.settingsKey !== settingsKey) {
          if (page.id === activePageId) activeSettingsChanged = true;
          entry.settingsKey = settingsKey;
          entry.revision = snapshot.revision;
          work.push(updateSettings(entry, settings, snapshot.revision));
        }
      }
      const selected = entries.get(activePageId);
      if (selected?.ready && !selected.settingsUpdate && requestedChanged) await promote(selected, token, snapshot.revision, !activeSettingsChanged);
      else if (selected?.ready && !selected.settingsUpdate && !activeSettingsChanged && selected.lastReportedRevision !== snapshot.revision) {
        await send(selected, { revision: snapshot.revision, ok: true });
      }
      await Promise.all(work);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true; requestToken++;
      for (const entry of [...entries.values()]) dispose(entry);
      presentedPageId = null; requestedPageId = null;
    }

    return { receive, destroy };
  }

  const api = { createSceneRuntime };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ICUESceneRuntime = api;
})(typeof globalThis === 'object' ? globalThis : this);
