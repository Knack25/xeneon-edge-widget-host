'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fingerprintDisplay, resolveEdgeDisplay, safeControllerBounds } = require('../display-policy');

const laptop = { id: 1, label: 'Built-in', internal: true, scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 25, width: 1512, height: 957 } };
const edge = { id: 2, label: 'XENEON EDGE', internal: false, scaleFactor: 2,
  bounds: { x: -1280, y: 0, width: 1280, height: 360 },
  workArea: { x: -1280, y: 0, width: 1280, height: 360 } };
const manual = { mode: 'manual', fingerprint: { label: 'XENEON EDGE', physicalWidth: 720, physicalHeight: 2560 } };

test('fingerprints omit session IDs and normalize physical size across scaling and rotation', () => {
  const expected = manual.fingerprint;
  assert.deepEqual(fingerprintDisplay(edge), expected);
  assert.deepEqual(fingerprintDisplay({ ...edge, id: 999, scaleFactor: 1,
    bounds: { x: 40, y: 50, width: 720, height: 2560 } }), expected);
  assert.deepEqual(fingerprintDisplay({ ...edge, label: undefined }), { ...expected, label: '' });
});
test('manual fingerprint restores a unique display after its session ID changes', () => {
  const reconnected = { ...edge, id: 999 };
  assert.deepEqual(resolveEdgeDisplay([laptop, reconnected], manual), { display: reconnected, reason: 'matched' });
  assert.deepEqual(resolveEdgeDisplay([laptop, edge, reconnected], manual), { display: null, reason: 'ambiguous' });
  assert.deepEqual(resolveEdgeDisplay([laptop, { ...edge, label: 'Other' }], manual), { display: null, reason: 'unavailable' });
  assert.deepEqual(resolveEdgeDisplay([edge], { mode: 'manual', fingerprint: null }), { display: null, reason: 'unavailable' });
});
test('automatic detection prioritizes external names then scaled size and never guesses', () => {
  const sized = { ...edge, id: 3, label: '' };
  assert.deepEqual(resolveEdgeDisplay([laptop, edge, sized], { mode: 'automatic' }), { display: edge, reason: 'matched' });
  assert.deepEqual(resolveEdgeDisplay([laptop, sized], { mode: 'automatic' }), { display: sized, reason: 'matched' });
  assert.deepEqual(resolveEdgeDisplay([edge, { ...edge, id: 4 }, sized], { mode: 'automatic' }), { display: null, reason: 'ambiguous' });
  assert.deepEqual(resolveEdgeDisplay([sized, { ...sized, id: 4 }], { mode: 'automatic' }), { display: null, reason: 'ambiguous' });
  assert.deepEqual(resolveEdgeDisplay([laptop, { ...edge, internal: true }], { mode: 'automatic' }), { display: null, reason: 'unavailable' });
});
test('controller restores bounds with at least half visible on a non-Edge work area', () => {
  const other = { ...laptop, id: 3, workArea: { x: -2400, y: 500, width: 1200, height: 900 } };
  const saved = { x: -2450, y: 550, width: 1000, height: 700 };
  assert.deepEqual(safeControllerBounds(saved, [laptop, edge, other], edge.id, laptop), saved);
  assert.deepEqual(safeControllerBounds({ x: 1012, y: 100, width: 1000, height: 700 }, [laptop, edge], edge.id, laptop),
    { x: 1012, y: 100, width: 1000, height: 700 });
});
test('Edge, barely visible, off-screen, missing and invalid controller bounds use centered fallback', () => {
  const expected = { x: 206, y: 143, width: 1100, height: 720 };
  for (const saved of [edge.bounds, { x: 1400, y: 100, width: 1100, height: 720 },
    { x: 9000, y: 9000, width: 1100, height: 720 }, null, {},
    { x: 20, y: 50, width: 0, height: 720 }, { x: NaN, y: 50, width: 1000, height: 700 },
    { x: -10, y: 100, width: 1000, height: 700 }]) {
    assert.deepEqual(safeControllerBounds(saved, [laptop, edge], edge.id, laptop), expected);
  }
});
test('fallback fits a small primary work area at negative coordinates', () => {
  const small = { ...laptop, workArea: { x: -900, y: -500, width: 800, height: 600 } };
  assert.deepEqual(safeControllerBounds(null, [small, edge], edge.id, small), small.workArea);
});
