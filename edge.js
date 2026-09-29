(function (root) {
  'use strict';
  const runtimeApi = typeof module === 'object' && module.exports ? require('./widget-runtime') : root.ICUEWidgetRuntime;
  const sceneApi = typeof module === 'object' && module.exports ? require('./scene-runtime') : root.ICUESceneRuntime;
  function createEdge({ document, bridge, sceneRuntime, sceneRuntimeFactory = sceneApi.createSceneRuntime, fetchText }) {
    const fetchWidget = fetchText || (async url => { const response = await root.fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error(`Failed to fetch widget: ${response.status}`); return response.text(); });
    sceneRuntime ||= sceneRuntimeFactory({ document,
      createRuntime: ({ container, pageId, report }) => runtimeApi.createWidgetRuntime({ document, container, pageId, fetchText: fetchWidget, report }),
      report: result => bridge.reportLoadResult(result) });
    let last = null, unsubscribe, disposed = false;
    function receive(snapshot) {
      if (disposed || !snapshot || (last && snapshot.revision <= last.revision)) return;
      last = snapshot;
      // IPC broadcasts do not await listeners; the manager owns preparation and reports.
      void Promise.resolve().then(() => sceneRuntime.receive(snapshot)).catch(() => {});
    }
    async function start() { unsubscribe = bridge.onScene(receive); receive(await bridge.getScene()); }
    function dispose() { disposed = true; unsubscribe?.(); sceneRuntime.destroy(); }
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
