const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('../app-state');
const {
  MAX_PAGES, NAVIGATION_POSITIONS, activePage, createPage, renamePage,
  movePage, deletePage, selectPage, setNavigationPosition
} = require('../page-model');

function scene() { return createDefaultState('clock').scene; }

test('pages with the same widget retain independent literal settings', () => {
  const draft = scene();
  draft.pages[0].regions[0].settings = { backgroundColor: '#112233' };
  draft.pages[0].widgetSettings.clock = { backgroundColor: '#112233' };
  createPage(draft, { id: 'second', name: 'Second', widgetId: 'clock' });
  draft.pages[1].regions[0].settings = { backgroundColor: '#445566' };
  draft.pages[1].widgetSettings.clock = { backgroundColor: '#445566' };
  selectPage(draft, { pageId: 'second' });
  assert.equal(activePage(draft).id, 'second');
  assert.deepEqual(draft.pages[0].widgetSettings.clock, { backgroundColor: '#112233' });
  assert.deepEqual(draft.pages[1].widgetSettings.clock, { backgroundColor: '#445566' });
});

test('page limit accepts the twelfth page and rejects the thirteenth without mutation', () => {
  const draft = scene();
  for (let number = 2; number <= MAX_PAGES; number++) createPage(draft, { id: `page-${number}`, name: `Page ${number}`, widgetId: 'clock' });
  assert.equal(draft.pages.length, 12);
  assert.throws(() => createPage(draft, { id: 'page-13', name: 'Page 13', widgetId: 'clock' }), RangeError);
  assert.equal(draft.pages.length, 12);
});

test('page names and IDs reject malformed values', () => {
  const draft = scene();
  for (const name of ['', '  ', 'x'.repeat(81)]) assert.throws(() => createPage(draft, { id: 'other', name, widgetId: 'clock' }));
  assert.throws(() => createPage(draft, { id: 'page-1', name: 'Duplicate', widgetId: 'clock' }));
  assert.throws(() => renamePage(draft, { pageId: 'page-1', name: '  ' }));
  assert.throws(() => selectPage(draft, { pageId: 'missing' }));
  assert.equal(draft.pages.length, 1);
});

test('rename and reorder preserve stable page and active IDs', () => {
  const draft = scene();
  createPage(draft, { id: 'second', name: 'Second', widgetId: 'clock' });
  selectPage(draft, { pageId: 'second' });
  renamePage(draft, { pageId: 'second', name: 'Renamed' });
  movePage(draft, { pageId: 'second', direction: -1 });
  assert.deepEqual(draft.pages.map(page => page.id), ['second', 'page-1']);
  assert.equal(draft.pages[0].name, 'Renamed');
  assert.equal(draft.activePageId, 'second');
});

test('deleting an active middle page selects its previous neighbor', () => {
  const draft = scene();
  createPage(draft, { id: 'second', name: 'Second', widgetId: 'clock' });
  createPage(draft, { id: 'third', name: 'Third', widgetId: 'clock' });
  selectPage(draft, { pageId: 'second' });
  deletePage(draft, { pageId: 'second' });
  assert.deepEqual(draft.pages.map(page => page.id), ['page-1', 'third']);
  assert.equal(draft.activePageId, 'page-1');
  deletePage(draft, { pageId: 'third' });
  assert.throws(() => deletePage(draft, { pageId: 'page-1' }));
});

test('navigation position only accepts six presets', () => {
  const draft = scene();
  assert.deepEqual(NAVIGATION_POSITIONS, ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']);
  for (const position of NAVIGATION_POSITIONS) {
    setNavigationPosition(draft, { position });
    assert.equal(draft.navigationPosition, position);
  }
  assert.throws(() => setNavigationPosition(draft, { position: 'middle' }));
  assert.equal(draft.navigationPosition, 'bottom-right');
});
