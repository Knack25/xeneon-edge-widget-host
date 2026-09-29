'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const artifacts = path.resolve(__dirname, '../artifacts');
fs.mkdirSync(artifacts, { recursive: true });
// Keep the smoke test independent of real user's saved widget settings.
const profile = fs.mkdtempSync(path.join(artifacts, 'smoke-profile-'));
app.setPath('userData', profile);
const errors = [];
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
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
  throw new Error(`Timed out: ${description}`);
}
const snapshot = `(() => {
  const viewer = document.getElementById('viewer');
  const win = viewer?.contentWindow;
  const doc = viewer?.contentDocument;
  const hand = doc?.getElementById('second-hand');
  const box = hand?.ownerSVGElement.getBoundingClientRect();
  return {
    title: document.getElementById('widgetTitle')?.textContent,
    initialized: win?.iCUE_initialized === true,
    date: doc?.getElementById('date-text')?.textContent,
    rotation: hand?.style.transform,
    visible: !!box && box.width > 0 && box.height > 0,
    node: typeof win?.require,
    nativeControls: window.icueWindow?.nativeControls,
    customControlsHidden: document.getElementById('windowControls')?.hidden
  };
})()`;

require('../main');
app.whenReady().then(async () => {
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'window creation');
  const first = await until(async () => {
    if (win.webContents.isLoadingMainFrame()) return false;
    const result = await win.webContents.executeJavaScript(snapshot);
    return result.initialized && result.rotation ? result : false;
  }, 'clock initialization through upstream shim');
  assert.equal(first.title, 'Robex Tourbillon');
  assert.equal(first.visible, true);
  assert.match(first.date, /^\d{1,2}$/);
  assert.equal(first.node, 'undefined');
  const second = await until(async () => {
    const current = await win.webContents.executeJavaScript(snapshot);
    return current.rotation !== first.rotation ? current : false;
  }, 'clock hand animation');
  if (process.platform === 'darwin') {
    assert.equal(second.nativeControls, true);
    assert.equal(second.customControlsHidden, true);
  }
  fs.writeFileSync(path.join(artifacts, 'clock-electron.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`window.icueWindow.presentation('exit')`);
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('viewer').contentWindow.__presentationProbe = 'same-widget';
    const picker = document.getElementById('displayPicker');
    picker.value = picker.options[1].value;
    document.getElementById('presentBtn').click();
  })()`);
  const isFullscreen = () => process.platform === 'darwin' ? win.isSimpleFullScreen() : win.isFullScreen();
  await until(async () => isFullscreen() && await win.webContents.executeJavaScript(`document.body.classList.contains('presenting')`), 'fullscreen entry');
  await delay(400);
  const fullscreenLayout = await win.webContents.executeJavaScript(`(() => {
    const viewer = document.getElementById('viewer');
    const rect = viewer.getBoundingClientRect();
    return { width: rect.width, height: rect.height, expectedWidth: innerWidth, expectedHeight: innerHeight,
      sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
      preserved: viewer.contentWindow.__presentationProbe };
  })()`);
  assert.equal(fullscreenLayout.sidebar, 'none');
  assert.equal(fullscreenLayout.width, fullscreenLayout.expectedWidth);
  assert.equal(fullscreenLayout.height, fullscreenLayout.expectedHeight);
  assert.equal(fullscreenLayout.preserved, 'same-widget');
  fs.writeFileSync(path.join(artifacts, 'clock-fullscreen.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.getElementById('viewer').contentWindow.focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(async () => !isFullscreen() && !await win.webContents.executeJavaScript(`document.body.classList.contains('presenting')`), 'Escape from focused widget');
  await win.webContents.executeJavaScript(`document.getElementById('presentBtn').click()`);
  await until(() => isFullscreen(), 'second fullscreen entry');
  await win.webContents.executeJavaScript(`document.getElementById('exitPresentation').click()`);
  await until(async () => !isFullscreen() && !await win.webContents.executeJavaScript(`document.body.classList.contains('presenting')`), 'touch-accessible exit button');
  // Real Dock-style close/reopen is exercised when this is run on a Mac.
  if (process.platform === 'darwin') {
    win.close();
    await until(() => BrowserWindow.getAllWindows().length === 0, 'Mac window close');
    app.emit('activate');
    app.emit('activate');
    const reopened = await until(() => BrowserWindow.getAllWindows()[0], 'Mac reopen');
    await until(async () => {
      if (reopened.webContents.isLoadingMainFrame()) return false;
      return (await reopened.webContents.executeJavaScript(snapshot)).initialized;
    }, 'clock after Mac reopen');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
  }
  assert.deepEqual(errors, [], 'renderer errors');
  const report = {
    platform: process.platform, arch: process.arch, electron: process.versions.electron,
    widget: first.title, shimInitialized: first.initialized, animationVerified: true,
    fullscreenVerified: true, escapeFromWidgetVerified: true, exitButtonVerified: true,
    macReopenVerified: process.platform === 'darwin', rendererErrors: errors,
    screenshot: 'clock-electron.png', timestamp: new Date().toISOString()
  };
  fs.writeFileSync(path.join(artifacts, 'smoke-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
