(function (root) {
  'use strict';
  const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
  const array = value => Array.isArray(value) ? value : [];
  function buildControllerViewModel(snapshot) {
    const state = snapshot.state || {};
    const scene = state.scene || {};
    const sourcePages = array(scene.pages);
    const activePageId = scene.activePageId || sourcePages[0]?.id || null;
    const activePage = sourcePages.find(page => page.id === activePageId) || sourcePages[0] || {};
    const region = activePage.regions?.[0] || {};
    const pages = sourcePages.map((page, index) => ({ id: page.id, name: text(page.name, `Page ${index + 1}`), active: page.id === activePageId, number: index + 1 }));
    const activeWidgetId = region.widgetId ?? snapshot.edge?.widgetId ?? null;
    const widgets = (snapshot.widgets || []).map(widget => {
      const raw = widget.manifest || {};
      const manifest = { ...raw, os: array(raw.os).filter(item => typeof item?.platform === 'string'), supported_devices: array(raw.supported_devices).filter(item => typeof item?.type === 'string'), required_plugins: array(raw.required_plugins).filter(item => typeof item === 'string') };
      return { id: widget.id, name: text(manifest.name, widget.id), author: text(manifest.author, 'Unknown'), version: text(manifest.version, 'Unknown'), description: text(manifest.description), source: text(widget.source), iconUrl: text(widget.iconUrl), manifest, active: widget.id === activeWidgetId };
    });
    const edge = snapshot.edge || {};
    const messages = { active: 'Edge active', hidden: 'Edge hidden', disconnected: 'Edge disconnected', ambiguous: 'Display selection ambiguous', failed: 'Edge failed' };
    let message = messages[edge.status] || 'Waiting for Edge';
    if (edge.loadStatus === 'loading') message += ' · Loading widget';
    if (edge.loadStatus === 'failed') message += ` · Widget failed to prepare${edge.retainedWidgetId ? '; previous widget retained' : ''}`;
    if (edge.error) message += ` · ${edge.error}`;
    if (edge.presentedPageId && edge.presentedPageId !== activePageId) {
      const requested = pages.find(page => page.id === activePageId)?.name || 'requested page';
      const presented = pages.find(page => page.id === edge.presentedPageId)?.name || 'previous page';
      message += ` · Requested ${requested}; showing ${presented}`;
    }
    if (snapshot.recovery?.status === 'recovered') message += ' · State recovered from invalid persisted data; original configuration preserved';
    return { revision: snapshot.revision, widgets, pages, activePageId, navigationPosition: scene.navigationPosition || 'bottom-right', canAddPage: pages.length < 12, canDeletePage: pages.length > 1, presentedPageId: edge.presentedPageId || null, activeWidgetId, activeWidget: widgets.find(widget => widget.active) || null, settings: region.settings || {}, displays: snapshot.displays || [], displayValue: state.displayPreference?.mode === 'automatic' ? 'automatic' : (snapshot.selectedTargetDisplayId ?? ''), visible: state.scene?.visible === true, edge: { ...edge, message, actionDisabled: edge.status === 'ambiguous' || edge.status === 'disconnected' } };
  }
  const api = { buildControllerViewModel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ICUEControllerView = api;
})(typeof globalThis === 'object' ? globalThis : this);
