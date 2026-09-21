'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { selectEdgeDisplay, createPresentation } = require('../presentation');
const laptop = { id: 1, label: 'Built-in', internal: true, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 } };
const edge = { id: 2, label: 'XENEON EDGE', internal: false, scaleFactor: 2, bounds: { x: -1280, y: 0, width: 1280, height: 360 } };
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
test('manual targeting validates IDs and repeated enter preserves original bounds', () => {
  const { controller, win } = fixture();
  assert.throws(() => controller.enter(999), /display/i);
  controller.enter(1);
  controller.enter(1);
  controller.exit();
  assert.equal(win.bounds.x, 30);
});
test('native Mac fullscreen must be exited before moving to another display', () => {
  const { controller, win } = fixture();
  win.isFullScreen = () => true;
  assert.throws(() => controller.enter(), /Exit macOS fullscreen/);
  assert.equal(controller.state().active, false);
  assert.equal(win.bounds.x, 30);
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
