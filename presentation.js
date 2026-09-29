'use strict';

function enterEdgePresentation(win, bounds, platform) {
  win.setBounds(bounds);
  if (platform === 'darwin') {
    win.setSimpleFullScreen(true);
    win.setAlwaysOnTop(true, 'pop-up-menu');
  } else {
    win.setFullScreen(true);
  }
}

function leaveEdgePresentation(win, platform) {
  if (platform === 'darwin') {
    win.setSimpleFullScreen(false);
    win.setAlwaysOnTop(false);
  } else {
    win.setFullScreen(false);
  }
}

module.exports = { enterEdgePresentation, leaveEdgePresentation };
