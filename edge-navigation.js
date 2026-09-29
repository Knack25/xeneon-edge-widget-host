// Loaded by the main process in world 1001, never in the widget/main world.
(function () {
  'use strict';
  const bridge = globalThis.icueNavigation;
  const navigation = globalThis.ICUEPageNavigation.createPageNavigation({
    document, trustedInputOnly: true,
    onSelect: pageId => { void bridge.selectPage({ pageId }).catch(() => {}); }
  });
  let subscribed = false;
  const unsubscribe = bridge.onState(value => { subscribed = true; navigation.render(value); });
  void bridge.getState().then(value => { if (!subscribed && value) navigation.render(value); });
  addEventListener('pagehide', () => { unsubscribe(); navigation.destroy(); }, { once: true });
})();
