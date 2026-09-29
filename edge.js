(function (root) {
  'use strict';
  const runtimeApi = typeof module === 'object' && module.exports ? require('./widget-runtime') : root.ICUEWidgetRuntime;
  const sceneApi = typeof module === 'object' && module.exports ? require('./scene-runtime') : root.ICUESceneRuntime;
  const navigationApi = typeof module === 'object' && module.exports ? require('./page-navigation') : root.ICUEPageNavigation;
  function createEdge({ document, bridge, sceneRuntime, sceneRuntimeFactory = sceneApi.createSceneRuntime, fetchText }) {
    const fetchWidget = fetchText || (async url => { const response = await root.fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error(`Failed to fetch widget: ${response.status}`); return response.text(); });
    let presentedPageId = null;
    const navigation = document?.getElementById?.('page-navigation') ? navigationApi.createPageNavigation({ document,
      onSelect: pageId => { void Promise.resolve(bridge.selectPage({ pageId })).catch(() => {}); } }) : null;
    function renderNavigation() {
      if (!navigation || !last?.scene) return;
      const scene = last.scene;
      if (!scene.pages.some(page => page.id === presentedPageId)) presentedPageId = null;
      navigation.render({ pages: scene.pages, requestedPageId: scene.activePageId,
        presentedPageId, position: scene.navigationPosition || 'bottom-right' });
    }
    sceneRuntime ||= sceneRuntimeFactory({ document,
      createRuntime: ({ container, report }) => runtimeApi.createWidgetRuntime({ document, container, fetchText: fetchWidget, report }),
      report: result => bridge.reportLoadResult(result),
      onPresentation: ({ pageId }) => { presentedPageId = pageId; renderNavigation(); } });
    let last = null, unsubscribe, disposed = false;
    function receive(snapshot) {
      if (disposed || !snapshot || (last && snapshot.revision <= last.revision)) return;
      last = snapshot;
      renderNavigation();
      // IPC broadcasts do not await listeners; the manager owns preparation and reports.
      void Promise.resolve().then(() => sceneRuntime.receive(snapshot)).catch(() => {});
    }
    async function start() { unsubscribe = bridge.onScene(receive); receive(await bridge.getScene()); }
    function dispose() { disposed = true; unsubscribe?.(); navigation?.destroy(); sceneRuntime.destroy(); }
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
