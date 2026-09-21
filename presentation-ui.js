'use strict';
window.addEventListener('DOMContentLoaded', async () => {
  const api = window.icueWindow;
  if (!api?.presentation) return;
  const picker = document.getElementById('displayPicker');
  const status = document.getElementById('displayStatus');
  document.getElementById('presentationControls').hidden = false;
  function render(state) {
    document.body.classList.toggle('presenting', state.active);
    const selected = picker.value;
    picker.replaceChildren();
    const automatic = new Option(state.automaticId === null ? 'Automatic — no unique Edge detected' : 'Automatic — Edge detected', '');
    picker.add(automatic);
    for (const display of state.displays) {
      picker.add(new Option(`${display.label || 'Display'} (${display.width} × ${display.height}) — ${display.id}`, String(display.id)));
    }
    if ([...picker.options].some(option => option.value === selected)) picker.value = selected;
    status.textContent = state.active ? 'Press Escape or tap Exit fullscreen to return.' :
      state.automaticId === null ? 'Choose a display to show the current widget fullscreen.' : 'Edge detected. Fullscreen shows the current widget.';
  }
  async function control(action, id) {
    try { render(await api.presentation(action, id)); }
    catch (error) { status.textContent = error.message; }
  }
  api.onPresentationChanged(render);
  document.getElementById('presentBtn').addEventListener('click', () => control('enter', picker.value === '' ? undefined : Number(picker.value)));
  document.getElementById('exitPresentation').addEventListener('click', () => control('exit'));
  await control('state');
});
