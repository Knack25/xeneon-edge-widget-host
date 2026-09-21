'use strict';

function selectEdgeDisplay(displays) {
  const external = displays.filter(display => !display.internal);
  const named = external.filter(display => /xeneon.*edge|edge.*xeneon/i.test(display.label || ''));
  if (named.length) return named.length === 1 ? named[0] : null;
  const sized = external.filter(display => {
    const dimensions = [display.bounds.width, display.bounds.height]
      .map(value => Math.round(value * display.scaleFactor)).sort((a, b) => a - b);
    return dimensions[0] === 720 && dimensions[1] === 2560;
  });
  return sized.length === 1 ? sized[0] : null;
}

function createPresentation(win, screen, platform) {
  let active = false;
  let targetId = null;
  let previousBounds;
  function state() {
    const displays = screen.getAllDisplays();
    return { active, targetId, automaticId: selectEdgeDisplay(displays)?.id ?? null,
      displays: displays.map(({ id, label, bounds }) => ({ id, label, width: bounds.width, height: bounds.height })) };
  }
  function notify() {
    if (!win.isDestroyed()) win.webContents.send('presentation:changed', state());
  }
  function fullscreen(value) {
    // Simple fullscreen stays on the selected Mac display without creating a Space.
    if (platform === 'darwin') win.setSimpleFullScreen(value);
    else win.setFullScreen(value);
  }
  function leaveNativeFullScreen() {
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        win.removeListener('leave-full-screen', onLeave);
      };
      const onLeave = () => {
        cleanup();
        resolve();
      };
      win.once('leave-full-screen', onLeave);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('macOS did not finish exiting native fullscreen.'));
      }, 5000);
      win.setFullScreen(false);
    });
  }
  async function enter(id) {
    const displays = screen.getAllDisplays();
    const target = id == null ? selectEdgeDisplay(displays) : displays.find(display => display.id === id);
    if (!target) throw new Error('Choose a connected display; no unique Edge was detected.');
    if (active) return state();
    if (platform === 'darwin' && win.isFullScreen()) {
      await leaveNativeFullScreen();
    }
    previousBounds = win.getBounds();
    targetId = target.id;
    win.setBounds(target.bounds);
    fullscreen(true);
    active = true;
    notify();
    return state();
  }
  function exit() {
    if (!active) return state();
    active = false;
    targetId = null;
    fullscreen(false);
    win.setBounds(previousBounds);
    notify();
    return state();
  }
  function onRemoved(_, display) {
    if (active && display.id === targetId) {
      exit();
      const area = screen.getPrimaryDisplay().workArea;
      win.setBounds({ x: area.x, y: area.y, width: Math.min(1100, area.width), height: Math.min(720, area.height) });
    }
    notify();
  }
  function onKey(event, input) {
    if (active && input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      exit();
    }
  }
  function onLeaveFullscreen() {
    if (active) exit();
  }
  screen.on('display-added', notify);
  screen.on('display-removed', onRemoved);
  win.webContents.on('before-input-event', onKey);
  win.on('leave-full-screen', onLeaveFullscreen);
  win.once('closed', () => {
    screen.removeListener('display-added', notify);
    screen.removeListener('display-removed', onRemoved);
  });
  return { state, enter, exit };
}

module.exports = { selectEdgeDisplay, createPresentation };
