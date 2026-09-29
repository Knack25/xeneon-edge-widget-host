'use strict';

const { app, BrowserWindow, screen, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveEdgeDisplay } = require('../display-policy');

const artifacts = path.resolve(process.env.ICUE_SMOKE_ARTIFACTS || path.join(__dirname, '../artifacts'));
fs.mkdirSync(artifacts, { recursive: true });
const profile = process.env.ICUE_SMOKE_PROFILE || fs.mkdtempSync(path.join(artifacts, 'smoke-profile-'));
const phase = process.env.ICUE_SMOKE_PHASE || 'exercise';
const doodleId = 'com.corsair.widget.doodle-pad';
const clockId = 'com.shocksim.robextourbillon';
let importFolder = null;
dialog.showOpenDialog = async () => ({ canceled: !importFolder, filePaths: importFolder ? [importFolder] : [] });
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
if (phase === 'exercise') {
  // A genuine v1 file is read by the production state store during startup.
  fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({
    version: 1, revision: 3, legacySettingsMigrated: true, controllerBounds: null,
    displayPreference: { mode: 'automatic', fingerprint: null },
    widgetSettings: { [clockId]: { tint: 'blue' } },
    scene: { visible: true, activePageId: 'legacy-page', pages: [{
      id: 'legacy-page', name: 'Original', regions: [{
        id: 'primary', widgetId: doodleId, settings: { backgroundColor: '#223344' },
        bounds: { x: 0, y: 0, width: 1, height: 1 }
      }]
    }] }
  }));
}

const errors = [];
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', details => {
    if (details.level === 'error' || details.level === 3) errors.push(details.message);
  });
  contents.on('render-process-gone', (_, details) => errors.push(JSON.stringify(details)));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + description);
}
function role(name) {
  return BrowserWindow.getAllWindows().find(win =>
    new URL(win.webContents.getURL() || 'about:blank').pathname === '/' + name + '.html');
}
const state = controller => controller.webContents.executeJavaScript('window.icueController.getState()');
const command = (controller, method, argument) => controller.webContents.executeJavaScript(
  'window.icueController.' + method + '(' + JSON.stringify(argument) + ')');
const query = (edge, body) => edge.webContents.executeJavaScript('(() => { ' + body + ' })()');
const fullscreen = edge => process.platform === 'darwin' ? edge.isSimpleFullScreen() : edge.isFullScreen();
const nativeFrameIds = edge => edge.webContents.mainFrame.frames.map(frame => frame.frameTreeNodeId);
async function pageFrame(edge, pageId) {
  return query(edge, `
    const page = [...document.querySelectorAll('.page-scene')].find(item => item.dataset.pageId === ${JSON.stringify(pageId)});
    const frame = page?.querySelector('iframe');
    const canvas = frame?.contentDocument?.getElementById('drawCanvas');
    const bounds = canvas?.getBoundingClientRect();
    const pixel = (x, y) => canvas ? Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data) : null;
    return { exists: !!frame, live: frame?.dataset.live === 'true',
      initialized: frame?.contentWindow?.iCUE_initialized === true,
      inert: page?.inert, ariaHidden: page?.getAttribute('aria-hidden'),
      width: frame?.getBoundingClientRect().width, height: frame?.getBoundingClientRect().height,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      canvas: !!canvas, canvasBounds: bounds && { x: bounds.x, y: bounds.y,
        width: bounds.width, height: bounds.height, pixelsWidth: canvas.width, pixelsHeight: canvas.height },
      ticks: frame?.contentWindow?.__smokeTicks || 0,
      a: pixel(160, 160), b: pixel(360, 160) };
  `);
}
async function loaded(controller, edge, pageId) {
  return until(async () => {
    const snapshot = await state(controller);
    const frame = await pageFrame(edge, pageId);
    return snapshot.edge.presentedPageId === pageId && snapshot.edge.loadStatus === 'loaded' &&
      frame.initialized && frame.canvas ? frame : false;
  }, pageId + ' presented');
}
async function stroke(edge, x, y) {
  edge.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  edge.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  edge.webContents.sendInputEvent({ type: 'mouseMove', x: x + 15, y });
  edge.webContents.sendInputEvent({ type: 'mouseUp', x: x + 15, y, button: 'left', clickCount: 1 });
  await delay(200);
}
const reportPath = path.join(artifacts, 'smoke-result.json');
const report = phase === 'restart' && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : {
  platform: process.platform, arch: process.arch, electron: process.versions.electron,
  timestamp: new Date().toISOString(), profile, artifacts, physicalTouchTested: false
};
function saveReport() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }

require('../main');
app.whenReady().then(async () => {
  report.displays = screen.getAllDisplays().map(({ id, label, internal, scaleFactor, bounds }) =>
    ({ id, label, internal, scaleFactor, bounds }));
  assert.ok(resolveEdgeDisplay(screen.getAllDisplays(), { mode: 'automatic' }).display,
    'A unique physical XENEON Edge is required');
  const controller = await until(() => role('controller'), 'controller window');
  assert.equal(await controller.presentationReady, true);
  let edge = await until(() => role('edge'), 'Edge window');
  assert.equal(await edge.presentationReady, true);
  assert.equal(fullscreen(edge), true);
  assert.equal(await controller.webContents.executeJavaScript('document.querySelectorAll("iframe, webview").length'), 0);
  let edgeId = edge.id;
  const migrated = await state(controller);
  assert.equal(migrated.state.version, 2);
  assert.equal(migrated.state.scene.pages[0].id, phase === 'exercise' ? 'legacy-page' : report.pages.secondId);

  if (phase === 'restart') {
    assert.deepEqual(migrated.state.scene.pages.map(page => page.name), ['Second', 'Original']);
    assert.equal(migrated.state.scene.activePageId, report.pages.secondId);
    assert.equal(migrated.state.scene.navigationPosition, 'top-left');
    assert.equal(migrated.state.scene.pages[0].regions[0].settings.backgroundColor, '#556677');
    await loaded(controller, edge, report.pages.secondId);
    report.restart = { activePageId: migrated.state.scene.activePageId,
      order: migrated.state.scene.pages.map(page => page.name), position: 'top-left',
      setting: '#556677', fullscreen: true };
    report.rendererErrors = [...(report.rendererErrors || []), ...errors];
    assert.deepEqual(errors, []);
    report.success = true; saveReport(); app.quit(); return;
  }

  assert.equal(migrated.state.scene.pages[0].regions[0].settings.backgroundColor, '#223344');
  assert.equal(migrated.state.scene.pages[0].widgetSettings[clockId].tint, 'blue');
  const first = await loaded(controller, edge, 'legacy-page');
  assert.equal(first.width, first.viewportWidth);
  assert.equal(first.height, first.viewportHeight);
  assert.equal(await query(edge, 'return document.getElementById("page-navigation").hidden'), true);
  const created = await command(controller, 'createPage', { name: 'Draft' });
  const secondId = created.state.scene.activePageId;
  const secondInitial = await loaded(controller, edge, secondId);
  assert.equal(secondInitial.width, secondInitial.viewportWidth);
  assert.equal(secondInitial.height, secondInitial.viewportHeight);
  assert.equal((await pageFrame(edge, 'legacy-page')).inert, true);
  assert.equal((await pageFrame(edge, 'legacy-page')).ariaHidden, 'true');
  // Execute in an actual widget child frame, not the Edge main frame. Legacy
  // widgets share the DOM origin but must have no callable selection capability.
  const widgetFrame = edge.webContents.mainFrame.frames[0];
  const selectionAttack = await widgetFrame.executeJavaScript(`(async () => {
    const exposed = typeof parent.icueEdge?.selectPage === 'function';
    if (exposed) await parent.icueEdge.selectPage({ pageId: 'legacy-page' });
    const button = [...parent.document.querySelectorAll('#page-navigation button')].find(item => item.title === 'Original');
    button.click();
    button.dispatchEvent(new parent.MouseEvent('click', { bubbles: true }));
    return { exposed };
  })()`);
  await delay(150);
  assert.equal(selectionAttack.exposed, false, 'widget cannot call parent page-selection bridge');
  assert.equal((await state(controller)).state.scene.activePageId, secondId, 'widget synthetic clicks cannot select a page');
  report.widgetSelectionBoundary = { callableBridgeAbsent: true, syntheticClicksRejected: true };
  const edgeButton = await query(edge, `
    const button = [...document.querySelectorAll('#page-navigation button')].find(item => item.title === 'Original');
    const r = button.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `);
  edge.webContents.sendInputEvent({ type: 'mouseDown', ...edgeButton, button: 'left', clickCount: 1 });
  edge.webContents.sendInputEvent({ type: 'mouseUp', ...edgeButton, button: 'left', clickCount: 1 });
  await loaded(controller, edge, 'legacy-page');
  const initialIds = nativeFrameIds(edge);
  const aBounds = (await pageFrame(edge, 'legacy-page')).canvasBounds;
  await stroke(edge, Math.round(aBounds.x + 160 * aBounds.width / aBounds.pixelsWidth),
    Math.round(aBounds.y + 160 * aBounds.height / aBounds.pixelsHeight));
  assert.ok((await pageFrame(edge, 'legacy-page')).a[3] > 0, 'A received real mouse input');
  await query(edge, `
    const win = document.querySelector('.page-scene[data-page-id="legacy-page"] iframe').contentWindow;
    win.__smokeTicks = 0; win.__smokeTimer = setInterval(() => { win.__smokeTicks++; }, 50);
  `);
  await command(controller, 'selectPage', { pageId: secondId });
  await loaded(controller, edge, secondId);
  const bBounds = (await pageFrame(edge, secondId)).canvasBounds;
  await stroke(edge, Math.round(bBounds.x + 360 * bBounds.width / bBounds.pixelsWidth),
    Math.round(bBounds.y + 160 * bBounds.height / bBounds.pixelsHeight));
  const second = await pageFrame(edge, secondId);
  assert.ok(second.b[3] > 0, 'B received real mouse input');
  assert.equal(second.a[3], 0, 'B has a distinct in-memory canvas');
  await delay(350);
  const inactive = await pageFrame(edge, 'legacy-page');
  assert.equal(inactive.inert, true);
  assert.equal(inactive.ariaHidden, 'true');
  assert.equal(inactive.width, first.viewportWidth);
  assert.equal(inactive.height, first.viewportHeight);
  await query(edge, 'document.querySelector("#page-navigation button")?.focus()');
  edge.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  edge.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  assert.notEqual(await query(edge, 'return document.activeElement?.closest(".page-scene")?.dataset.pageId'), 'legacy-page');
  await command(controller, 'selectPage', { pageId: 'legacy-page' });
  const returned = await loaded(controller, edge, 'legacy-page');
  assert.ok(returned.a[3] > 0);
  assert.equal(returned.b[3], 0);
  const inactiveSecond = await pageFrame(edge, secondId);
  assert.equal(inactiveSecond.inert, true);
  assert.equal(inactiveSecond.ariaHidden, 'true');
  assert.equal(inactiveSecond.width, first.viewportWidth);
  assert.equal(inactiveSecond.height, first.viewportHeight);
  await command(controller, 'selectPage', { pageId: secondId });
  const returnedSecond = await loaded(controller, edge, secondId);
  assert.ok(returnedSecond.b[3] > 0, 'B stroke survives switch-back');
  assert.equal(returnedSecond.a[3], 0);
  await command(controller, 'selectPage', { pageId: 'legacy-page' });
  assert.ok((await loaded(controller, edge, 'legacy-page')).a[3] > 0);
  assert.deepEqual(nativeFrameIds(edge), initialIds, 'native frame IDs survive A-B-A-B-A');
  assert.equal(edge.id, edgeId);
  assert.equal(fullscreen(edge), true);
  report.pages = { firstId: 'legacy-page', secondId, edgeButtonSelectedFirst: true, nativeFrameIds: initialIds,
    distinctCanvasPixels: true, bothStrokesSurvivedReturn: true,
    inactiveFramesFullSize: true, inactiveFrameTicksObserved: inactive.ticks,
    inactiveFrameTimerCadenceAsserted: false, inactiveTabFocusBlocked: true };

  const positions = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
  for (const position of positions) {
    await command(controller, 'setNavigationPosition', { position });
    const nav = await until(async () => query(edge, `
      const node = document.getElementById('page-navigation');
      if (node.dataset.position !== ${JSON.stringify(position)}) return null;
      const r = node.getBoundingClientRect();
      return { buttons: node.querySelectorAll('button').length, x: r.x, y: r.y,
        width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    `), position + ' placement');
    assert.equal(nav.buttons, 2);
    assert.ok(nav.x >= 0 && nav.y >= 0 && nav.x + nav.width <= nav.viewportWidth && nav.y + nav.height <= nav.viewportHeight);
    if (position.startsWith('top-')) assert.ok(nav.y < nav.viewportHeight / 2);
    else assert.ok(nav.y > nav.viewportHeight / 2);
    if (position.endsWith('-left')) assert.ok(nav.x < nav.viewportWidth / 3);
    if (position.endsWith('-center')) assert.ok(Math.abs(nav.x + nav.width / 2 - nav.viewportWidth / 2) < 2);
    if (position.endsWith('-right')) assert.ok(nav.x > nav.viewportWidth / 2);
    assert.equal((await pageFrame(edge, 'legacy-page')).width, first.viewportWidth);
    assert.equal((await pageFrame(edge, 'legacy-page')).height, first.viewportHeight);
    assert.equal(edge.id, edgeId);
  }
  report.navigationPositions = positions;
  const temporary = await command(controller, 'createPage', { name: 'Temporary' });
  const temporaryId = temporary.state.scene.activePageId;
  await loaded(controller, edge, temporaryId);
  await command(controller, 'deletePage', { pageId: temporaryId });
  await until(async () => !(await pageFrame(edge, temporaryId)).exists, 'deleted page frame removed');
  assert.equal((await state(controller)).state.scene.activePageId, secondId);
  report.deletedPageFrameRemoved = true;
  await command(controller, 'selectPage', { pageId: 'legacy-page' });
  await loaded(controller, edge, 'legacy-page');

  const source = path.join(profile, 'unavailable-source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ id: 'com.smoke.failure', name: 'Expected failure' }));
  fs.writeFileSync(path.join(source, 'index.html'), '<!doctype html><script>throw new Error("smoke expected failure")</script>');
  importFolder = source;
  const imported = await command(controller, 'importWidget');
  assert.equal(imported.status, 'installed');
  const beforeFailureEdgeId = edge.id;
  await command(controller, 'setEdgeVisible', false);
  await until(() => edge.isDestroyed() && !role('edge'), 'hide before unvisited failure page setup');
  const failurePage = await command(controller, 'createPage', { name: 'Failure' });
  const failurePageId = failurePage.state.scene.activePageId;
  await command(controller, 'selectWidget', { pageId: failurePageId, widgetId: 'com.smoke.failure' });
  await command(controller, 'selectPage', { pageId: 'legacy-page' });
  await command(controller, 'setEdgeVisible', true);
  edge = await until(() => role('edge'), 'Edge restored for failed first visit');
  edgeId = edge.id;
  assert.notEqual(edgeId, beforeFailureEdgeId);
  await loaded(controller, edge, 'legacy-page');
  assert.equal((await pageFrame(edge, failurePageId)).exists, false, 'failure page has not yet visited Edge');
  await command(controller, 'selectPage', { pageId: failurePageId });
  const failure = await until(async () => {
    const value = await state(controller);
    return value.edge.loadStatus === 'failed' ? value : false;
  }, 'controlled widget load failure');
  assert.equal(failure.state.scene.activePageId, failurePageId);
  assert.equal(failure.edge.presentedPageId, 'legacy-page');
  const retained = await pageFrame(edge, 'legacy-page');
  assert.equal(retained.canvas, true, 'previous Doodle remains available');
  assert.equal(retained.inert, false, 'previous Doodle remains interactive');
  assert.notEqual((await pageFrame(edge, failurePageId)).live, true, 'failed page was not presented');
  const diagnostic = await controller.webContents.executeJavaScript('document.getElementById("status").textContent');
  assert.match(diagnostic, /previous widget retained/);
  assert.match(diagnostic, /Requested Failure; showing Original/);
  const failureButtons = await query(edge, `
    const buttons = [...document.querySelectorAll('#page-navigation button')];
    const original = buttons.find(button => button.title === 'Original');
    const failed = buttons.find(button => button.title === 'Failure');
    return { presented: original?.getAttribute('aria-current'),
      failedPresented: failed?.getAttribute('aria-current'), failedRequested: failed?.getAttribute('data-loading') };
  `);
  assert.deepEqual(failureButtons, { presented: 'page', failedPresented: null, failedRequested: 'true' });
  report.failedPage = { requestedPageId: failurePageId, presentedPageId: 'legacy-page',
    priorPageVisible: true, controllerDiagnostic: diagnostic, buttonState: failureButtons };
  await command(controller, 'deletePage', { pageId: failurePageId });
  await until(async () => !(await pageFrame(edge, failurePageId)).exists, 'failed page frame removed');
  await command(controller, 'selectPage', { pageId: 'legacy-page' });
  await loaded(controller, edge, 'legacy-page');

  importFolder = path.join(__dirname, '../widgets/Doodle Pad-1');
  const replacement = await command(controller, 'importWidget');
  assert.equal(replacement.status, 'confirmation-required');
  assert.equal((await command(controller, 'confirmImport', replacement.token)).status, 'replaced');
  await loaded(controller, edge, 'legacy-page');
  await until(async () => !(await pageFrame(edge, secondId)).exists, 'inactive Doodle invalidated');
  await command(controller, 'selectPage', { pageId: secondId });
  await loaded(controller, edge, secondId);
  report.reimport = { activeReloaded: true, inactiveReloadedOnNextVisit: true };
  await command(controller, 'renamePage', { pageId: secondId, name: 'Second' });
  await command(controller, 'movePage', { pageId: secondId, direction: 'up' });
  await command(controller, 'setNavigationPosition', { position: 'top-left' });
  await command(controller, 'selectPage', { pageId: secondId });
  await loaded(controller, edge, secondId);
  await command(controller, 'updateSetting', {
    pageId: secondId, widgetId: doodleId, name: 'backgroundColor', value: '#556677'
  });
  await until(async () => (await state(controller)).state.scene.pages[0].regions[0].settings.backgroundColor === '#556677',
    'second page setting');
  assert.equal((await state(controller)).state.scene.pages[1].regions[0].settings.backgroundColor, '#223344');

  const oldControllerId = controller.id;
  await controller.webContents.executeJavaScript('window.icueController.close()');
  await until(() => controller.isDestroyed(), 'controller close');
  assert.equal(role('edge').id, edgeId);
  app.emit('activate');
  const reopened = await until(() => role('controller'), 'controller reopen');
  assert.notEqual(reopened.id, oldControllerId);
  assert.equal(role('edge').id, edgeId);
  assert.equal(fullscreen(edge), true);
  report.controllerReopen = { oldControllerId, newControllerId: reopened.id, edgeId };
  fs.writeFileSync(path.join(artifacts, 'controller-electron.png'), (await reopened.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(artifacts, 'edge-multi-page-electron.png'), (await edge.webContents.capturePage()).toPNG());
  await command(reopened, 'setEdgeVisible', false);
  await until(() => edge.isDestroyed() && !role('edge'), 'Hide Edge');
  await command(reopened, 'setEdgeVisible', true);
  const shown = await until(() => role('edge'), 'Show Edge');
  assert.notEqual(shown.id, edgeId);
  assert.equal(await shown.presentationReady, true);
  await loaded(reopened, shown, secondId);
  assert.equal(fullscreen(shown), true);
  report.visibility = { hiddenOldEdgeId: edgeId, shownEdgeId: shown.id, activePageRestored: true };
  const reloaded = new Promise(resolve => shown.webContents.once('did-finish-load', resolve));
  shown.webContents.reload();
  await reloaded;
  await loaded(reopened, shown, secondId);
  const reloadedButton = await until(async () => query(shown, `
    const button = [...document.querySelectorAll('#page-navigation button')].find(item => item.title === 'Original');
    if (!button) return null;
    const r = button.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `), 'navigation restored after reload');
  shown.webContents.sendInputEvent({ type: 'mouseDown', ...reloadedButton, button: 'left', clickCount: 1 });
  shown.webContents.sendInputEvent({ type: 'mouseUp', ...reloadedButton, button: 'left', clickCount: 1 });
  await loaded(reopened, shown, 'legacy-page');
  await command(reopened, 'selectPage', { pageId: secondId });
  await loaded(reopened, shown, secondId);
  report.edgeReload = { activePageRestored: true, navigationRestoredAndClicked: true };
  assert.deepEqual((await state(reopened)).state.scene.pages.map(page => page.name), ['Second', 'Original']);
  assert.deepEqual(errors.filter(message => !message.includes('smoke expected failure')), [], 'unexpected renderer errors');
  report.rendererErrors = errors;
  report.exercise = { success: true, migrationVersion: 2, fullscreen: true };
  saveReport();
  app.quit();
}).catch(error => {
  report.success = false; report.failure = error.stack || String(error);
  report.rendererErrors = [...(report.rendererErrors || []), ...errors];
  saveReport(); console.error(error); app.exit(1);
});
