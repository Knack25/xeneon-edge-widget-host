'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { enterEdgePresentation, leaveEdgePresentation } = require('../presentation');
const bounds = { x: -1280, y: 0, width: 1280, height: 360 };

test('Edge helpers apply target bounds, Mac simple fullscreen and Dock level without Escape listeners', () => {
  const calls = [];
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.setBounds = value => calls.push(['bounds', value]);
  win.setSimpleFullScreen = value => calls.push(['simple', value]);
  win.setAlwaysOnTop = (...args) => calls.push(['top', ...args]);
  enterEdgePresentation(win, bounds, 'darwin');
  leaveEdgePresentation(win, 'darwin');
  assert.deepEqual(calls, [['bounds', bounds], ['simple', true], ['top', true, 'pop-up-menu'], ['simple', false], ['top', false]]);
  assert.equal(win.webContents.listenerCount('before-input-event'), 0);
  assert.equal(win.eventNames().length, 0);
});
test('Edge helpers use native fullscreen outside macOS', () => {
  const calls = [];
  const win = { setBounds: value => calls.push(['bounds', value]), setFullScreen: value => calls.push(['fullscreen', value]) };
  enterEdgePresentation(win, bounds, 'win32');
  leaveEdgePresentation(win, 'win32');
  assert.deepEqual(calls, [['bounds', bounds], ['fullscreen', true], ['fullscreen', false]]);
});
