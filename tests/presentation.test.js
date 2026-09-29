'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { selectEdgeDisplay, createPresentation, enterEdgePresentation, leaveEdgePresentation } = require('../presentation');
const laptop = { id: 1, label: 'Built-in', internal: true, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 } };
const edge = { id: 2, label: 'XENEON EDGE', internal: false, scaleFactor: 2, bounds: { x: -1280, y: 0, width: 1280, height: 360 } };
test('Edge helpers apply target bounds, Mac simple fullscreen and Dock level without Escape listeners', () => {
  const calls = [];
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.setBounds = value => calls.push(['bounds', value]);
  win.setSimpleFullScreen = value => calls.push(['simple', value]);
  win.setAlwaysOnTop = (...args) => calls.push(['top', ...args]);
  enterEdgePresentation(win, edge.bounds, 'darwin');
  leaveEdgePresentation(win, 'darwin');
  assert.deepEqual(calls, [['bounds', edge.bounds], ['simple', true], ['top', true, 'pop-up-menu'], ['simple', false], ['top', false]]);
  assert.equal(win.webContents.listenerCount('before-input-event'), 0);
  assert.equal(win.eventNames().length, 0);
});
test('Edge helpers use native fullscreen outside macOS', () => {
  const calls = [];
  const win = { setBounds: value => calls.push(['bounds', value]), setFullScreen: value => calls.push(['fullscreen', value]) };
  enterEdgePresentation(win, edge.bounds, 'win32');
  leaveEdgePresentation(win, 'win32');
  assert.deepEqual(calls, [['bounds', edge.bounds], ['fullscreen', true], ['fullscreen', false]]);
});
test('name wins, scaled physical size is a fallback, ambiguous matches stay in launcher', () => {
  assert.equal(selectEdgeDisplay([laptop, edge]).id, 2);
  assert.equal(selectEdgeDisplay([laptop, { ...edge, label: '' }]).id, 2);
  assert.equal(selectEdgeDisplay([laptop]), null);
  assert.equal(selectEdgeDisplay([edge, { ...edge, id: 3 }]), null);
  assert.equal(selectEdgeDisplay([{ ...edge, label: '', internal: true }]), null);
});
function fixture() {
  const screen = new EventEmitter();
  let displays = [laptop, edge];
  screen.getAllDisplays = () => displays;
  screen.getPrimaryDisplay = () => laptop;
  const win = new EventEmitter();
  win.bounds = { x: 30, y: 40, width: 1100, height: 720 };
  win.getBounds = () => ({ ...win.bounds });
  win.setBounds = bounds => { win.bounds = { ...bounds }; };
  win.setSimpleFullScreen = value => { win.fullscreen = value; };
  win.alwaysOnTopCalls = [];
  win.setAlwaysOnTop = (value, level) => { win.alwaysOnTopCalls.push({ value, level }); };
  win.isFullScreen = () => false;
  win.webContents = new EventEmitter();
  win.webContents.send = () => {};
  win.isDestroyed = () => false;
  const controller = createPresentation(win, screen, 'darwin');
  return { controller, win, screen, disconnect() { displays = [laptop]; screen.emit('display-removed', {}, edge); } };
}
test('presentation uses logical target bounds and restores launcher on Escape', () => {
  const { controller, win } = fixture();
  controller.enter();
  assert.deepEqual(win.bounds, edge.bounds);
  assert.equal(win.fullscreen, true);
  let prevented = false;
  win.webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  assert.equal(prevented, true);
  assert.equal(controller.state().active, false);
  assert.equal(win.fullscreen, false);
  assert.deepEqual(win.bounds, { x: 30, y: 40, width: 1100, height: 720 });
});
test('macOS presentation covers the Dock only while active', async () => {
  const { controller, win } = fixture();
  await controller.enter();
  assert.deepEqual(win.alwaysOnTopCalls, [{ value: true, level: 'pop-up-menu' }]);
  controller.exit();
  assert.deepEqual(win.alwaysOnTopCalls, [
    { value: true, level: 'pop-up-menu' },
    { value: false, level: undefined }
  ]);
});
test('manual targeting validates IDs and repeated enter preserves original bounds', async () => {
  const { controller, win } = fixture();
  await assert.rejects(controller.enter(999), /display/i);
  await controller.enter(1);
  await controller.enter(1);
  controller.exit();
  assert.equal(win.bounds.x, 30);
});
test('rapid exit and re-entry recovers lingering native Mac fullscreen', async () => {
  const { controller, win } = fixture();
  await controller.enter();
  controller.exit();
  let nativeFullscreen = true;
  win.isFullScreen = () => nativeFullscreen;
  win.setFullScreen = value => {
    nativeFullscreen = value;
    if (!value) queueMicrotask(() => win.emit('leave-full-screen'));
  };
  await controller.enter();
  assert.equal(nativeFullscreen, false);
  assert.equal(controller.state().active, true);
  assert.deepEqual(win.bounds, edge.bounds);
  assert.equal(win.fullscreen, true);
});
test('unplug returns launcher to primary display and closing removes screen listeners', () => {
  const { controller, win, screen, disconnect } = fixture();
  controller.enter();
  disconnect();
  assert.equal(controller.state().active, false);
  assert.ok(win.bounds.x >= laptop.workArea.x);
  assert.ok(win.bounds.y >= laptop.workArea.y);
  win.emit('closed');
  assert.equal(screen.listenerCount('display-removed'), 0);
  assert.equal(screen.listenerCount('display-added'), 0);
});
