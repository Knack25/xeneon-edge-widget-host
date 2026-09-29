(function (root) {
  'use strict';
  function createPageNavigation({ document, onSelect }) {
    const cluster = document.getElementById('page-navigation');
    let buttons = [], destroyed = false;

    function clear() {
      for (const { button, click } of buttons) button.removeEventListener('click', click);
      buttons = [];
      cluster.replaceChildren();
    }

    function render({ pages, requestedPageId, presentedPageId, position }) {
      if (destroyed) return;
      cluster.dataset.position = position;
      cluster.hidden = pages.length <= 1;
      if (cluster.hidden) { clear(); return; }
      const previous = new Map(buttons.map(item => [item.id, item]));
      const next = pages.map((page, index) => {
        let item = previous.get(page.id);
        if (item) previous.delete(page.id);
        else {
          const button = document.createElement('button');
          const click = () => onSelect(page.id);
          button.addEventListener('click', click);
          item = { id: page.id, button, click };
        }
        const { button } = item;
        button.type = 'button';
        button.textContent = String(index + 1);
        button.title = page.name;
        button.setAttribute('aria-label', `Page ${index + 1}: ${page.name}`);
        if (page.id === presentedPageId) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
        if (page.id === requestedPageId && page.id !== presentedPageId) button.setAttribute('data-loading', 'true');
        else button.removeAttribute('data-loading');
        return item;
      });
      for (const { button, click } of previous.values()) button.removeEventListener('click', click);
      if (cluster.children.length !== next.length || next.some((item, index) => cluster.children[index] !== item.button)) {
        cluster.replaceChildren(...next.map(item => item.button));
      }
      buttons = next;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clear();
      cluster.hidden = true;
    }
    return { render, destroy };
  }
  const api = { createPageNavigation };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ICUEPageNavigation = api;
})(typeof globalThis === 'object' ? globalThis : this);
