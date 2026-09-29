(function (root) {
  'use strict';
  const viewApi = typeof module === 'object' && module.exports ? require('./controller-view') : root.ICUEControllerView;
  const settingsApi = typeof module === 'object' && module.exports ? require('./widget-settings') : root.ICUEWidgetSettings;
  const LEGACY_KEY = 'icueWidgetRunner.widgetSettings.v1';
  async function migrateLegacySettings(storage, bridge) {
    const raw = storage.getItem(LEGACY_KEY);
    if (raw === null) return;
    const data = JSON.parse(raw);
    await bridge.submitLegacySettings(data);
    storage.removeItem(LEGACY_KEY);
  }
  function createController({ document, bridge, storage, config = {} }) {
    const el = id => document.getElementById(id);
    let model = null;
    let settingsId;
    let settingsAvailable;
    const controls = new Map();
    let pendingToken = null;
    let importBusy = false;
    let unsubscribe;
    function error(err) { el('error').textContent = err?.message || String(err); el('error').hidden = false; }
    async function command(action) {
      try { return await action(); } catch (err) { error(err); return null; }
    }
    function node(tag, text, className) {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      if (className) element.className = className;
      return element;
    }
    function renderLibrary() {
      const query = el('search').value.trim().toLowerCase();
      const cards = model.widgets.filter(widget => `${widget.name} ${widget.author}`.toLowerCase().includes(query)).map(widget => {
        const card = node('button', undefined, `widget-card${widget.active ? ' active' : ''}`);
        card.dataset.widgetId = widget.id;
        card.setAttribute('aria-pressed', String(widget.active));
        // Only local catalog thumbnails are used. No widget entry page is loaded.
        if (widget.iconUrl.startsWith('/') && !widget.iconUrl.startsWith('//')) {
          const image = node('img'); image.src = widget.iconUrl; image.alt = ''; image.loading = 'lazy';
          image.addEventListener('error', () => { image.hidden = true; }); card.append(image);
        }
        const caption = node('div'); caption.append(node('strong', widget.name), node('small', `${widget.version} · ${widget.author}${widget.active ? ' · Active' : ''}`)); card.append(caption);
        card.addEventListener('click', () => command(() => bridge.selectWidget(widget.id)));
        return card;
      });
      el('widget-list').replaceChildren(...(cards.length ? cards : [node('p', query ? 'No matching widgets.' : 'No widgets found. Import a widget folder to begin.')]));
    }
    function renderSettings() {
      const widget = model.activeWidget;
      if (settingsId !== model.activeWidgetId || settingsAvailable !== Boolean(widget)) {
        settingsId = model.activeWidgetId; settingsAvailable = Boolean(widget); controls.clear();
        const rows = widget ? settingsApi.getSettingDefinitions(widget).map(def => {
          const label = node('label', undefined, 'setting-row');
          const input = node('input'); input.type = def.type; input.dataset.setting = def.name;
          if (def.type === 'range') { input.min = def.min; input.max = def.max; input.step = def.step; }
          const output = node('output'); label.append(node('span', def.label), input, output);
          input.addEventListener('input', () => {
            const value = def.type === 'checkbox' ? input.checked : def.type === 'range' ? Number(input.value) : input.value;
            output.textContent = def.type === 'range' ? String(value) : '';
            command(() => bridge.updateSetting(def.name, value));
          });
          controls.set(def.name, { input, output, def });
          return label;
        }) : [];
        el('settings').replaceChildren(...(rows.length ? rows : [node('p', widget ? 'No controller settings are available for this widget.' : 'The selected widget is unavailable. Select an installed widget.')]));
      }
      const values = { ...settingsApi.getDefaultWidgetSettings(widget), ...model.settings };
      for (const [name, { input, output, def }] of controls) {
        // IPC snapshots must not reset a slider mid-drag or move a text caret.
        if (document.activeElement === input) continue;
        if (def.type === 'checkbox') input.checked = values[name] === true;
        else input.value = String(values[name] ?? '');
        output.textContent = def.type === 'range' ? String(values[name]) : '';
      }
    }
    function renderDisplays() {
      if (document.activeElement === el('display')) return;
      const options = [node('option', 'Automatic XENEON Edge')]; options[0].value = 'automatic';
      if (model.displayValue === '') { const unavailable = node('option', 'Saved display unavailable — choose a display'); unavailable.value = ''; unavailable.disabled = true; options.push(unavailable); }
      for (const display of model.displays) { const option = node('option', `${display.label || 'Display'} · ${display.bounds.width} × ${display.bounds.height}${display.internal ? ' · Built-in' : ''}`); option.value = String(display.id); options.push(option); }
      el('display').replaceChildren(...options); el('display').value = String(model.displayValue);
    }
    function render(snapshot) {
      model = viewApi.buildControllerViewModel(snapshot);
      el('status').textContent = model.edge.message;
      const hide = model.visible && model.edge.status !== 'failed';
      el('visibility').textContent = hide ? 'Hide Edge' : 'Show Edge';
      el('visibility').disabled = model.edge.actionDisabled;
      renderDisplays(); renderLibrary();
      const widget = model.activeWidget;
      el('widget-title').textContent = widget ? widget.name : model.activeWidgetId ? `Unavailable widget: ${model.activeWidgetId}` : 'Select a widget';
      const metadata = [];
      if (widget) for (const [label, value] of [['Author', widget.author], ['Version', widget.version], ['Description', widget.description], ['Source', widget.source], ['OS', (widget.manifest.os || []).map(os => os.platform).join(', ') || 'Unspecified'], ['Supported devices', (widget.manifest.supported_devices || []).map(device => device.type).join(', ') || 'Unspecified'], ['Interactive', widget.manifest.interactive ? 'Yes' : 'No'], ['Required plugins', (widget.manifest.required_plugins || []).join(', ') || 'None']]) {
        const row = node('div', undefined, 'metadata-row'); row.append(node('span', `${label}: `), node('strong', value)); metadata.push(row);
      }
      el('metadata').replaceChildren(...metadata); renderSettings();
    }
    async function disposeToken(confirm) {
      if (!pendingToken) return;
      const token = pendingToken; pendingToken = null;
      el('replacement').close();
      await command(() => confirm ? bridge.confirmImport(token) : bridge.cancelImport(token));
    }
    el('search').addEventListener('input', () => { if (model) renderLibrary(); });
    el('display').addEventListener('change', () => { const value = el('display').value; if (value) command(() => bridge.selectDisplay(value === 'automatic' ? value : Number(value))); });
    el('visibility').addEventListener('click', () => { if (model) command(() => bridge.setEdgeVisible(!(model.visible && model.edge.status !== 'failed'))); });
    el('rescan').addEventListener('click', () => command(() => bridge.rescanWidgets()));
    el('import').addEventListener('click', async () => {
      if (importBusy || pendingToken) return;
      importBusy = true; el('import').disabled = true;
      try {
        const result = await command(() => bridge.importWidget());
        if (result?.status === 'confirmation-required') {
          pendingToken = result.token;
          el('replacement-detail').textContent = `Installed: ${result.installed.name} (${result.installed.version})\nIncoming: ${result.incoming.name} (${result.incoming.version})`;
          try { el('replacement').showModal(); } catch (err) { await disposeToken(false); error(err); }
        }
      } finally { importBusy = false; el('import').disabled = false; }
    });
    el('replacement-cancel').addEventListener('click', () => disposeToken(false));
    el('replacement-confirm').addEventListener('click', () => disposeToken(true));
    el('replacement').addEventListener('cancel', event => { event.preventDefault(); disposeToken(false); });
    el('replacement').addEventListener('close', () => disposeToken(false));
    el('window-controls').hidden = bridge.nativeControls || config.showWindowControls === false;
    for (const [id, method] of [['minimize', 'minimize'], ['maximize', 'toggleMaximize'], ['close', 'close']]) el(id).addEventListener('click', () => command(() => bridge[method]()));
    return {
      async start() {
        unsubscribe = bridge.onState(render);
        const snapshot = await command(() => bridge.getState());
        if (snapshot) render(snapshot);
        await command(() => migrateLegacySettings(storage, bridge));
      },
      dispose() { unsubscribe?.(); disposeToken(false); }
    };
  }
  const api = { createController, migrateLegacySettings };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.icueController) {
    const controller = createController({ document: root.document, bridge: root.icueController, storage: root.localStorage, config: root.ICUE_RUNNER_CONFIG });
    root.addEventListener('pagehide', () => controller.dispose()); controller.start();
  } else {
    const error = root.document.getElementById('error'); error.hidden = false; error.textContent = 'Open the controller through the Widget Runner app.';
  }
})(typeof globalThis === 'object' ? globalThis : this);
