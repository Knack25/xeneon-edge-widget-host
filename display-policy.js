'use strict';

function fingerprintDisplay(display) {
  const physical = [display.bounds.width, display.bounds.height]
    .map(value => Math.round(value * display.scaleFactor)).sort((a, b) => a - b);
  return { label: display.label || '', physicalWidth: physical[0], physicalHeight: physical[1] };
}

function automaticCandidates(displays) {
  const external = displays.filter(display => !display.internal);
  const named = external.filter(display => /xeneon.*edge|edge.*xeneon/i.test(display.label || ''));
  if (named.length) return named;
  return external.filter(display => {
    const fingerprint = fingerprintDisplay(display);
    return fingerprint.physicalWidth === 720 && fingerprint.physicalHeight === 2560;
  });
}

function resolveEdgeDisplay(displays, preference) {
  let candidates = [];
  if (preference?.mode === 'manual' && preference.fingerprint) {
    const saved = preference.fingerprint;
    candidates = displays.filter(display => {
      const current = fingerprintDisplay(display);
      return current.label === saved.label && current.physicalWidth === saved.physicalWidth &&
        current.physicalHeight === saved.physicalHeight;
    });
  } else if (preference?.mode === 'automatic') {
    candidates = automaticCandidates(displays);
  }
  if (candidates.length === 1) return { display: candidates[0], reason: 'matched' };
  return { display: null, reason: candidates.length ? 'ambiguous' : 'unavailable' };
}

function validBounds(bounds) {
  return bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) &&
    bounds.width > 0 && bounds.height > 0;
}

function intersectionArea(first, second) {
  if (!validBounds(second)) return 0;
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  return width * height;
}

function safeControllerBounds(savedBounds, displays, edgeDisplayId, primaryDisplay) {
  if (validBounds(savedBounds)) {
    const onEdge = displays.some(display => display.id === edgeDisplayId &&
      intersectionArea(savedBounds, display.bounds) > 0);
    // A sliver on another monitor is not enough to recover the controller.
    const visible = displays.some(display => display.id !== edgeDisplayId &&
      intersectionArea(savedBounds, display.workArea) >= savedBounds.width * savedBounds.height / 2);
    if (!onEdge && visible) return { ...savedBounds };
  }
  const fallbackDisplay = primaryDisplay.id !== edgeDisplayId ? primaryDisplay :
    displays.find(display => display.id !== edgeDisplayId) || primaryDisplay;
  const area = fallbackDisplay.workArea;
  const width = Math.min(1100, area.width);
  const height = Math.min(720, area.height);
  return { x: Math.floor(area.x + (area.width - width) / 2),
    y: Math.floor(area.y + (area.height - height) / 2), width, height };
}

module.exports = { fingerprintDisplay, resolveEdgeDisplay, safeControllerBounds };
