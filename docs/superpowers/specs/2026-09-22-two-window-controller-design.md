# Two-Window Controller and Edge Presentation Design

## Purpose

Split the macOS widget host into a laptop controller window and a dedicated
XENEON Edge presentation window. The controller must remain available while
the Edge stays fullscreen, allowing widget selection and settings changes
without moving, resizing, or exiting the Edge presentation.

The design also establishes a versioned scene model for later page navigation
and multi-widget layouts. This feature implements one page containing one
full-screen widget. Page navigation and multi-widget editing remain separate
follow-up features.

## User-visible behavior

- App startup opens a controller on the primary Mac display and restores the
  last active widget on the saved or automatically detected Edge display.
- The controller shows static widget thumbnails, metadata, settings, display
  status, display selection, durable import, and Show/Hide Edge controls.
- The controller never runs a live copy of a widget.
- The Edge window contains only the live widget. It has no toolbar, sidebar,
  status text, exit button, or Escape shortcut.
- Selecting a widget immediately replaces the Edge content without recreating,
  moving, or leaving fullscreen in the Edge window.
- Setting changes update the running Edge widget live.
- Closing the controller leaves the Edge widget running. Clicking the Dock icon
  recreates or focuses the controller. Command-Q closes both windows and the
  application-owned local server.
- Hiding the Edge from the controller closes the presentation window but keeps
  the saved scene. Showing it recreates the presentation on the selected Edge.
- Disconnecting the target closes only the Edge window. Reconnecting the same
  uniquely identifiable display restores the saved presentation automatically.
  The app never substitutes another display silently.
- Controller size and position are restored only when the saved bounds remain
  visible on a connected non-Edge display. Otherwise it opens centered on the
  primary display.

## Non-goals

- Multiple pages in the controller or Edge UI.
- Page-switch gestures or page indicator buttons.
- Multiple widgets on one page or a layout editor.
- A live widget preview inside the controller.
- Remote or browser-based control.
- Sandboxing arbitrary third-party widget code beyond the current trusted-local
  widget model.
- Application signing, notarization, packaging, or login launch.

## Architecture

### Main-process coordinator

An `AppCoordinator` in the Electron main process is the source of truth. It
owns:

- Controller and Edge window lifecycle.
- Widget catalog and durable imports.
- Display discovery and selected-display resolution.
- Active scene and widget settings.
- Versioned persistence and migration.
- State revisioning and renderer broadcasts.

Renderer windows never mutate shared state directly. Controller commands enter
through a narrow preload bridge, are validated by the coordinator, update the
in-memory model, schedule persistence, and produce a new state snapshot.

### Controller renderer

`controller.html` and `controller.js` replace the mixed launcher/presentation
role of the current `index.html` renderer. The controller provides:

- A searchable widget list with manifest thumbnails.
- An active-widget indicator.
- Widget metadata and settings controls.
- Edge display and connection status.
- Display selection and Show Edge/Hide Edge actions.
- Import widget folder and replacement confirmation.

It does not create a widget iframe or execute widget scripts.

### Edge renderer

`edge.html` and `edge.js` own the presentation surface. The Edge window:

- Uses Electron simple fullscreen on macOS to avoid creating a Space.
- Uses the `pop-up-menu` always-on-top level while active so it covers the Dock.
- Accepts the first mouse event so inactive-window touches reach widgets.
- Has no app-owned overlay controls and does not handle Escape as an exit.
- Maintains one live widget runtime in this phase.

The window requests the current scene after it is ready and subscribes to state
updates. Widget selection swaps only the widget content, not the BrowserWindow.

### Shared widget runtime

The widget shim, shell construction, settings application, and load preparation
currently mixed into `runner-v2.js` move into a renderer-neutral
`widget-runtime.js` module. The Edge renderer is its only live consumer.

Before replacing visible content, the runtime fetches and constructs the new
widget shell in a staging frame. A successful load promotes the staging frame.
Fetch or shell-construction failure leaves the last working widget visible and
reports an error to the coordinator. Runtime script errors are reported when
observable but do not trigger an unrelated widget selection.

### Local server

The existing application-owned loopback server continues serving the UI,
bundled widgets, and assets. It gains a canonicalized route for app-managed
imports stored below Electron's `userData` directory. Requests cannot traverse
outside the configured bundled or managed widget roots.

## Scene and persisted state

The persisted file is versioned and stored below `app.getPath('userData')`.
The initial schema is conceptually:

```json
{
  "version": 1,
  "revision": 1,
  "controllerBounds": null,
  "displayPreference": {
    "mode": "automatic",
    "fingerprint": null
  },
  "scene": {
    "visible": true,
    "activePageId": "page-1",
    "pages": [
      {
        "id": "page-1",
        "name": "Page 1",
        "regions": [
          {
            "id": "primary",
            "widgetId": "com.shocksim.robextourbillon",
            "settings": {},
            "bounds": { "x": 0, "y": 0, "width": 1, "height": 1 }
          }
        ]
      }
    ]
  }
}
```

Phase-one validation requires exactly one page and one region whose normalized
bounds fill the page. The collection shapes remain in the schema so future
features can add pages and regions without replacing the coordinator contract.

Electron display IDs are session-scoped and are not trusted across restarts.
Manual selection persists a display fingerprint based on the stable information
Electron exposes, such as label and physical-size estimate. A saved fingerprint
must resolve uniquely in the current topology. Otherwise the controller reports
that the Edge is unavailable or ambiguous and waits for user selection.

Settings updates broadcast immediately but disk writes are debounced. State is
written to a temporary file and atomically renamed. An unreadable or invalid
file is preserved as a dated backup before safe defaults are created.

On the first two-window launch, the controller reads the legacy
`icueWidgetRunner.widgetSettings.v1` local-storage entry and offers it to the
coordinator for a one-time merge. The persisted state records completion so the
migration is not repeated. With no usable prior selection, the existing offline
Robex clock remains the default.

## IPC contract

The controller preload exposes task-specific methods rather than raw IPC:

- Get the current application snapshot.
- Subscribe to snapshot changes.
- Select the active widget.
- Update one widget setting.
- Select the target display.
- Show or hide the Edge.
- Start an import through the native directory picker.
- Confirm or cancel an import replacement token.

The Edge preload can:

- Get the current scene snapshot.
- Subscribe to scene changes.
- Report widget load success or failure for the current revision.

Mutating commands are accepted only from the current controller main frame.
Edge reports are accepted only from the current Edge main frame. IDs, settings,
display selections, revisions, and import tokens are checked in the main
process. Unknown actions and stale tokens fail closed.

## Live update flow

1. The user selects a widget in the controller.
2. The coordinator verifies that the widget exists and updates the in-memory
   scene revision.
3. The new snapshot is broadcast and persistence is scheduled.
4. The Edge runtime stages the selected widget while the current widget remains
   visible.
5. On successful preparation, the Edge promotes the staged widget and reports
   success. On failure it retains the previous content and reports the error.
6. The controller renders the resulting status without moving either window.

Setting changes follow the same command and broadcast path. The runtime applies
settings to the active widget immediately. Rapid range-input changes may
coalesce disk writes but not visible Edge updates.

## Durable widget imports

Import uses Electron's native directory picker from the controller. The main
process requires `index.html`, parses and normalizes `manifest.json` when
present, derives a stable widget ID, and rejects symbolic links or paths that
escape the selected root.

Files are copied into a staging directory under the managed widget library. If
the ID is new, the staged directory is promoted and the catalog is refreshed.
If the ID already exists, the coordinator returns a one-use confirmation token
plus installed and incoming name/version metadata. Approval replaces the
managed files through a backup-and-rename sequence with rollback on failure.
Settings remain attached to scene regions that reference the widget ID and are
preserved. Cancellation or a failed replacement leaves the installed widget
untouched.

The former browser-only dropped-folder representation is removed. Imported
widgets are durable, server-addressable catalog entries and survive restart.

## Window and display lifecycle

- Startup creates the controller after the server is listening and state is
  loaded. The Edge is created independently when the scene is visible and the
  target resolves uniquely.
- Closing the controller destroys only that BrowserWindow. The coordinator,
  Edge, and server remain alive.
- macOS app activation recreates or focuses the controller.
- Explicit Hide Edge destroys only the Edge BrowserWindow. Explicit Show Edge
  resolves the selected display and recreates it from the saved scene.
- Edge renderer failure recreates the Edge window with bounded retry behavior;
  repeated failure leaves it hidden and reports the error in the controller.
- Display removal destroys the affected Edge window. Display addition reruns
  saved-display resolution and restores it only on a unique match.
- Application quit disables recovery, closes both windows, flushes persistence,
  and closes the server.

## Error reporting

The controller is the sole app-owned status surface. It distinguishes:

- Edge active.
- Edge hidden.
- Edge disconnected.
- Display selection ambiguous.
- Widget failed to prepare; previous widget retained.
- Import rejected.
- Import replacement awaiting confirmation.
- State recovered from invalid persisted data.

No status or recovery UI is drawn over the Edge widget.

## Testing

### Unit and boundary tests

- Coordinator creates and independently manages two windows.
- Controller close leaves Edge and server running; app activation recreates it.
- Command-Q shuts down both windows and server without recovery loops.
- IPC rejects unrecognized senders, stale revisions, malformed settings,
  invalid displays, and expired import tokens.
- Scene validation enforces one page and one full-page region for phase one.
- State writes are atomic; corrupt state is backed up and defaulted.
- Legacy settings migrate once.
- Controller bounds never restore onto the Edge or a disconnected display.
- Saved display fingerprints restore only on a unique match.
- Edge disconnect/reconnect removes and restores only the presentation window.
- Widget staging retains the previous widget after a preparation failure.
- New imports persist, symlinks are rejected, replacement requires confirmation,
  confirmed replacement preserves settings, and failed replacement rolls back.

### Electron smoke test

The real Electron smoke test launches both production windows and verifies:

- Controller and Edge load their separate pages.
- Controller is usable while Edge remains simple-fullscreen above the Dock.
- Selecting another widget updates Edge content without recreating the Edge
  BrowserWindow or leaving fullscreen.
- A setting change reaches the live widget.
- Closing and reopening the controller does not interrupt Edge content.
- Hide/Show Edge works only through the controller.
- No controller or exit overlay appears in the Edge document.

### Hardware acceptance

On the Mac and physical XENEON Edge, verify:

- Controller stays on the laptop while Edge stays fullscreen.
- Widget selection and settings update live.
- Tap, scrolling, Doodle dragging, cursor return, and Dock coverage still work.
- Closing/reopening the controller leaves the Edge widget uninterrupted.
- Edge unplug/reconnect restores the saved presentation.
- Imports survive restart and same-ID re-import asks for confirmation.
- Command-Q exits the complete application.

## Delivery

Implementation proceeds on `feat/two-window-controller` with Conventional
Commits. The feature branch is not merged or pushed without an explicit user
choice after verification.

After this feature is complete, page navigation receives its own design and
feature branch. It will add page creation, naming, ordering, and Edge-side
navigation, with hardware testing to prevent navigation gestures from stealing
widget scrolling or drawing. Multi-widget regions and layout editing follow on
a separate branch after page behavior is stable.
