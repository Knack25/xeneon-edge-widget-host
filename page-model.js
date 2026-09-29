const MAX_PAGES = 12;
const NAVIGATION_POSITIONS = Object.freeze([
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right'
]);

function validName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) {
    throw new TypeError('Page name must contain 1–80 trimmed characters');
  }
  return name.trim();
}

function validId(id) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Page ID is required');
  return id;
}

function pageIndex(scene, pageId) {
  validId(pageId);
  const index = scene.pages.findIndex(page => page.id === pageId);
  if (index < 0) throw new RangeError('Unknown page ID');
  return index;
}

function activePage(scene) {
  return scene.pages[pageIndex(scene, scene.activePageId)];
}

function createPage(scene, { id, name, widgetId } = {}) {
  validId(id);
  const normalizedName = validName(name);
  if (widgetId !== null && (typeof widgetId !== 'string' || !widgetId.trim())) throw new TypeError('Invalid widget ID');
  if (scene.pages.length >= MAX_PAGES) throw new RangeError('Page limit reached');
  if (scene.pages.some(page => page.id === id)) throw new TypeError('Duplicate page ID');
  const page = {
    id, name: normalizedName, widgetSettings: {},
    regions: [{ id: 'primary', widgetId, settings: {}, bounds: { x: 0, y: 0, width: 1, height: 1 } }]
  };
  scene.pages.push(page);
  return page;
}

function renamePage(scene, { pageId, name } = {}) {
  const index = pageIndex(scene, pageId);
  scene.pages[index].name = validName(name);
  return scene.pages[index];
}

function movePage(scene, { pageId, direction } = {}) {
  const index = pageIndex(scene, pageId);
  if (direction !== -1 && direction !== 1) throw new TypeError('Direction must be -1 or 1');
  const target = index + direction;
  if (target < 0 || target >= scene.pages.length) throw new RangeError('Page cannot move further');
  [scene.pages[index], scene.pages[target]] = [scene.pages[target], scene.pages[index]];
  return scene.pages[target];
}

function deletePage(scene, { pageId } = {}) {
  const index = pageIndex(scene, pageId);
  if (scene.pages.length === 1) throw new RangeError('Cannot delete the last page');
  const [removed] = scene.pages.splice(index, 1);
  if (scene.activePageId === pageId) scene.activePageId = scene.pages[Math.max(0, index - 1)].id;
  return removed;
}

function selectPage(scene, { pageId } = {}) {
  pageIndex(scene, pageId);
  scene.activePageId = pageId;
  return activePage(scene);
}

function setNavigationPosition(scene, { position } = {}) {
  if (!NAVIGATION_POSITIONS.includes(position)) throw new TypeError('Invalid navigation position');
  scene.navigationPosition = position;
  return position;
}

module.exports = { MAX_PAGES, NAVIGATION_POSITIONS, activePage, createPage, renamePage, movePage, deletePage, selectPage, setNavigationPosition };
