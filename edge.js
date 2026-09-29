(function (root) {
  'use strict';
  const runtimeApi = typeof module === 'object' && module.exports ? require('./widget-runtime') : root.ICUEWidgetRuntime;
  function createEdge({ document, bridge, runtime, fetchText }) {
    runtime ||= runtimeApi.createWidgetRuntime({ document, fetchText: fetchText || (async url => { const response = await root.fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error(`Failed to fetch widget: ${response.status}`); return response.text(); }), report: result => bridge.reportLoadResult(result) });
    let last = null, unsubscribe, disposed = false;
    function receive(snapshot) {
      if (disposed || !snapshot || (last && snapshot.revision <= last.revision)) return;
      const previous = last; last = snapshot;
      const region = snapshot.scene.pages[0].regions[0];
      const reload = !previous || previous.widget?.id !== snapshot.widget?.id || previous.catalogRevision !== snapshot.catalogRevision || !snapshot.widget;
      // Runtime owns current-revision reporting. Catch subscription operations
      // here, since IPC broadcasts do not await the listener's Promise.
      void Promise.resolve().then(() => reload
        ? runtime.load({ widget: snapshot.widget, settings: region.settings, revision: snapshot.revision })
        : runtime.updateSettings({ settings: region.settings, revision: snapshot.revision })).catch(() => {});
    }
    async function start() { unsubscribe = bridge.onScene(receive); receive(await bridge.getScene()); }
    function dispose() { disposed = true; unsubscribe?.(); runtime.destroy(); }
    return { start, dispose };
  }
  const api = { createEdge };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.ICUEEdge = api;
    if (root.document && root.icueEdge) {
      const edge = createEdge({ document: root.document, bridge: root.icueEdge });
      root.addEventListener('pagehide', () => edge.dispose(), { once: true });
      void edge.start().catch(() => {});
    }
  }
})(typeof globalThis === 'object' ? globalThis : this);
