'use strict';

const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { resolveEdgeDisplay } = require('../display-policy');
const artifacts = path.resolve(process.env.ICUE_SMOKE_ARTIFACTS || path.join(__dirname, '../artifacts'));
fs.mkdirSync(artifacts, { recursive: true });
// Neither state.json, localStorage nor managed imports belong to the real user.
const profile = fs.mkdtempSync(path.join(artifacts, 'smoke-profile-'));
app.setPath('userData', profile);
const errors = [];
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', details => {
    if (details.level === 'error' || details.level === 3) errors.push(details.message);
  });
  contents.on('render-process-gone', (_, details) => errors.push(JSON.stringify(details)));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out: ' + description);
}
function role(name) {
  return BrowserWindow.getAllWindows().find(win => new URL(win.webContents.getURL() || 'about:blank').pathname === '/' + name + '.html');
}
const state = controller => controller.webContents.executeJavaScript('window.icueController.getState()');
const command = (controller, method, ...args) => controller.webContents.executeJavaScript('window.icueController.' + method + '(...' + JSON.stringify(args) + ')');
const fullscreen = edge => process.platform === 'darwin' ? edge.isSimpleFullScreen() : edge.isFullScreen();
const frameSnapshot = `(() => {
  const frames = [...document.querySelectorAll('iframe')];
  const frame = frames.find(item => item.dataset.live === 'true');
  const win = frame?.contentWindow, doc = frame?.contentDocument;
  const hand = doc?.getElementById('second-hand');
  const rect = frame?.getBoundingClientRect();
  return { frames: frames.length, liveFrames: frames.filter(item => item.dataset.live === 'true').length,
    widgetId: frame?.dataset.widgetId, initialized: win?.iCUE_initialized === true,
    rotation: hand?.style.transform, date: doc?.getElementById('date-text')?.textContent,
    width: rect?.width, height: rect?.height, expectedWidth: innerWidth, expectedHeight: innerHeight,
    node: typeof win?.require, controllerBridge: typeof win?.icueController, edgeBridge: typeof win?.icueEdge,
    background: doc?.documentElement.style.getPropertyValue('--bg-color'),
    renderedBackground: doc?.querySelector('.main-glass') ? win.getComputedStyle(doc.querySelector('.main-glass')).backgroundColor : null,
    overlay: !!document.querySelector('#exitPresentation, button, header, aside'),
    bodyChildren: [...document.body.children].map(item => item.id),
    token: frame?.__smokeToken, canvas: !!doc?.getElementById('drawCanvas') };
})()`;
const frame = edge => edge.webContents.executeJavaScript(frameSnapshot);
async function loaded(controller, edge, widgetId) {
  return until(async () => {
    const snapshot = await frame(edge), current = await state(controller);
    return current.edge.loadStatus === 'loaded' && snapshot.widgetId === widgetId && snapshot.initialized ? snapshot : false;
  }, widgetId + ' live initialization');
}
async function animated(edge, first) {
  return until(async () => { const next = await frame(edge); return next.rotation && next.rotation !== first.rotation ? next : false; }, 'Clock hand animation');
}
async function screenshot(win, name) {
  fs.writeFileSync(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG());
}
const report = { platform: process.platform, arch: process.arch, electron: process.versions.electron,
  timestamp: new Date().toISOString(), profile, artifacts, rendererErrors: errors, physicalTouchTested: false };
function saveReport() { fs.writeFileSync(path.join(artifacts, 'smoke-result.json'), JSON.stringify(report, null, 2) + '\n'); }

require('../main');
app.whenReady().then(async () => {
  report.displays = screen.getAllDisplays().map(({ id, label, internal, scaleFactor, bounds, workArea }) => ({ id, label, internal, scaleFactor, bounds, workArea }));
  report.primaryDisplayId = screen.getPrimaryDisplay().id;
  const controller = await until(() => role('controller'), 'controller role URL');
  await until(() => controller.presentationReady, 'controller presentation contract');
  assert.equal(await controller.presentationReady, true);
  const initial = await state(controller);
  report.automaticStatus = initial.edge.status;
  const detected = resolveEdgeDisplay(screen.getAllDisplays(), { mode: 'automatic' }).display;
  assert.ok(detected, 'A unique real XENEON Edge must be connected; smoke never guesses or fullscreens the laptop');
  report.targetDisplay = detected.id;
  report.displaySelection = 'automatic';
  const windows = await until(() => BrowserWindow.getAllWindows().length === 2 && role('edge') ? BrowserWindow.getAllWindows() : false, 'controller and Edge windows');
  const edge = role('edge'), edgeId = edge.id;
  assert.ok(windows.includes(controller));
  assert.equal(await edge.presentationReady, true);
  assert.equal(edge.isVisible(), true);
  assert.equal(fullscreen(edge), true);
  assert.equal(controller.webContents.getURL(), 'http://127.0.0.1:8080/controller.html');
  assert.equal(edge.webContents.getURL(), 'http://127.0.0.1:8080/edge.html');
  assert.equal(await controller.webContents.executeJavaScript('document.querySelectorAll("iframe, webview").length'), 0, 'controller must be static');
  const first = await loaded(controller, edge, 'com.shocksim.robextourbillon');
  assert.match(first.date, /^\d{1,2}$/);
  assert.equal(first.node, 'undefined');
  assert.equal(first.controllerBridge, 'undefined');
  assert.equal(first.edgeBridge, 'undefined');
  assert.equal(first.frames, 1);
  assert.equal(first.liveFrames, 1);
  assert.equal(first.width, first.expectedWidth);
  assert.equal(first.height, first.expectedHeight);
  assert.equal(first.overlay, false);
  assert.deepEqual(first.bodyChildren, ['scene']);
  await animated(edge, first);
  report.startup = { controllerId: controller.id, edgeId, urls: windows.map(win => win.webContents.getURL()), clockInitialized: true, clockAnimated: true, controllerStatic: true, soleLiveFrame: true, fullscreen: true };
  await screenshot(controller, 'controller-electron.png');
  await screenshot(edge, 'edge-clock-electron.png');
  await command(controller, 'selectWidget', 'com.corsair.widget.doodle-pad');
  const doodle = await loaded(controller, edge, 'com.corsair.widget.doodle-pad');
  assert.equal(doodle.canvas, true);
  assert.equal(doodle.frames, 1);
  assert.equal(role('edge').id, edgeId);
  assert.equal(fullscreen(edge), true);
  await edge.webContents.executeJavaScript('document.querySelector("iframe").__smokeToken = "same-doodle-frame"');
  await command(controller, 'updateSetting', 'backgroundColor', '#123456');
  const changed = await until(async () => { const value = await frame(edge); return value.background === '#123456' ? value : false; }, 'visible Doodle background setting');
  assert.equal(changed.renderedBackground, 'rgb(18, 52, 86)');
  assert.equal(changed.token, 'same-doodle-frame');
  assert.equal(role('edge').id, edgeId);
  assert.equal(fullscreen(edge), true);
  report.swap = { widgetId: doodle.widgetId, sameEdgeId: true, fullscreenPreserved: true };
  report.setting = { name: 'backgroundColor', value: changed.background, renderedBackground: changed.renderedBackground, sameWidgetFrame: true };
  // Wait for Chromium to paint the observed computed style before capture.
  await edge.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await screenshot(edge, 'edge-doodle-electron.png');
  await edge.webContents.executeJavaScript('document.querySelector("iframe").contentWindow.focus()');
  edge.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  edge.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await delay(250);
  assert.equal(role('edge').id, edgeId);
  assert.equal(edge.isVisible(), true);
  assert.equal(fullscreen(edge), true);
  assert.equal((await frame(edge)).overlay, false);
  report.escapeIgnored = true;
  await command(controller, 'selectWidget', 'com.shocksim.robextourbillon');
  await loaded(controller, edge, 'com.shocksim.robextourbillon');
  await edge.webContents.executeJavaScript('document.querySelector("iframe").__smokeToken = "clock-before-controller-close"');
  const oldControllerId = controller.id;
  await command(controller, 'close');
  await until(() => controller.isDestroyed(), 'controller close');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(role('edge').id, edgeId);
  const closedBaseline = await frame(edge);
  assert.equal(closedBaseline.token, 'clock-before-controller-close');
  const closedAnimated = await animated(edge, closedBaseline);
  assert.equal(closedAnimated.token, closedBaseline.token);
  assert.equal(role('edge').id, edgeId);
  assert.equal(role('controller'), undefined);
  report.closedControllerAnimation = { edgeId, sameWidgetFrame: true,
    baselineRotation: closedBaseline.rotation, laterRotation: closedAnimated.rotation };
  app.emit('activate'); app.emit('activate');
  const reopened = await until(() => role('controller'), 'controller recreation');
  assert.equal(await reopened.presentationReady, true);
  assert.notEqual(reopened.id, oldControllerId);
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  assert.equal(role('edge').id, edgeId);
  assert.equal(fullscreen(edge), true);
  await animated(edge, await frame(edge));
  report.reopen = { oldControllerId, controllerId: reopened.id, edgeId, clockContinued: true, controllerCount: 1 };
  // Visible controller buttons exercise the same Hide/Show view commands.
  await reopened.webContents.executeJavaScript('document.getElementById("visibility").click()');
  await until(() => edge.isDestroyed() && !role('edge'), 'Hide destroys only Edge');
  assert.equal(role('controller').id, reopened.id);
  assert.equal((await state(reopened)).edge.status, 'hidden');
  await until(() => reopened.webContents.executeJavaScript('document.getElementById("visibility").textContent === "Show Edge"'), 'controller Show state');
  await reopened.webContents.executeJavaScript('document.getElementById("visibility").click()');
  const shown = await until(() => role('edge'), 'Show recreates Edge');
  assert.equal(await shown.presentationReady, true);
  assert.notEqual(shown.id, edgeId);
  assert.equal(role('controller').id, reopened.id);
  const shownClock = await loaded(reopened, shown, 'com.shocksim.robextourbillon');
  await animated(shown, shownClock);
  assert.equal(fullscreen(shown), true);
  report.visibility = { controllerId: reopened.id, destroyedEdgeId: edgeId, shownEdgeId: shown.id, clockAnimated: true };
  const root = await new Promise((resolve, reject) => http.get('http://127.0.0.1:8080/', response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body })); }).on('error', reject));
  assert.equal(root.status, 200);
  assert.match(root.body, /iCUE Widget Runner — Controller/, 'root must serve the new controller');
  report.rootController = true;
  report.screenshots = ['controller-electron.png', 'edge-clock-electron.png', 'edge-doodle-electron.png'];
  assert.deepEqual(errors, [], 'renderer errors');
  report.success = true;
  saveReport();
  console.log(JSON.stringify(report, null, 2));
  // app.quit takes the same before-quit shutdown path as macOS Cmd-Q.
  app.quit();
}).catch(error => {
  report.success = false; report.failure = error.stack || String(error); saveReport();
  console.error(error); app.exit(1);
});
