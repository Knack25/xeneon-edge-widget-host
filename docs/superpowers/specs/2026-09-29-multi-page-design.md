# Multi-page Edge presentation

Status: proposed for user review. Implementation has not started.

## Intent and approved scope

Extend the hardware-validated two-window host with multiple pages. Configuration
stays on the laptop controller; page switching is also available on the Edge.
Each page initially contains one full-size widget with independent host-managed
settings. Inactive widgets remain loaded so returning to a page preserves its
in-memory state, particularly Doodle drawings. Restore the last active page after
restart. Do not change the touch driver or native fullscreen/window behavior.

Controller controls create, name, reorder, select and delete pages. Edge shows
small numbered page buttons only when there is more than one page. A controller
setting selects top-left, top-center, top-right, bottom-left, bottom-center or
bottom-right; default bottom-right. Save this choice across restarts.

Deferred: swipe/wheel navigation, freely positioned controls, simultaneous
multi-widget layouts, page duplication, packaging and driver work.

## Approach and alternatives

Use one runtime instance per visited page, keyed by stable page ID, within the
existing Edge window. Load pages lazily on first selection and retain them until
deletion, widget replacement or Edge destruction. This keeps switch-back state
without loading every configured widget at startup. Reload-on-every-switch would
use fewer resources but contradict the approved state-preservation behavior.
Eagerly loading all pages would impose startup cost for pages never visited.

The page-button surface is the only new Edge host overlay. There are no editing,
settings or fullscreen-exit controls. Its explicit hit area avoids interpreting
widget drawing or scrolling as navigation.

## Persistent state and migration

Introduce state version 2. Preserve the existing scene.pages/regions shape, but
allow multiple uniquely identified pages and exactly one full-size region per
page. Resolve the active page by activePageId, never by array position. Store
navigationPosition on scene, validated against the six presets.

Keep per-widget remembered settings inside each page, not in the existing global
widgetSettings cache. Switching widgets on one page remembers that page's previous
settings without modifying another page using the same widget. Page settings are
JSON-normalized using the existing safety rules.

Migrate version 1 explicitly: retain its page ID, name, region, widget, current
settings, visibility, display preference, controller bounds and legacy-migration
flag. Transfer the global remembered settings to that page's cache; the active
region's settings take precedence. Default navigation to bottom-right. Write the
migrated state atomically with the existing recovery/backup policy. Unknown future
versions must not be silently overwritten or treated as successful migrations.

Stable page IDs do not change with names or order. Keep at least one page.
Invalid active IDs recover to the first valid page with a diagnostic. Reject
duplicate IDs, malformed page data and invalid mutation requests without partial
writes. Proposed guardrails for review: at most 12 pages and names of 1–80 trimmed
characters. These bound retained runtimes and keep navigation manageable.

## Controller behavior

Add a page list with selection, Add, Rename, Move up/down and Delete controls.
The selected controller page is the active Edge page: no separate edit-target
mode in this phase. Library selection and settings target that page explicitly.
Add creates and activates a named page using the current widget's default settings,
not a copy of its drawing or settings. Rename does not reload a runtime; reorder
does not change the active ID. Confirm deletion and warn that live widget state
will be discarded. Disable deletion of the last page. Deleting the active page
selects its previous neighbor, or the first remaining page if there is none.

The existing controller remains static: no live widget copy. Selection made on
the Edge updates the controller. Page controls and navigation position update
live without leaving fullscreen. Display selection, Hide/Show and import retain
their existing semantics.

## Edge runtime ownership

Introduce a scene runtime manager owning a map from page IDs to widget runtimes.
Reuse existing staged loading, deadlines, stale-load cancellation and settings
delivery within each page runtime. Refactor the runtime's container selection so
each instance owns its own page container, rather than a shared primary-region.

Retained inactive containers keep full display dimensions, but are invisible,
non-interactive and excluded from keyboard focus/accessibility navigation. Do
not destroy, navigate or resize their frames just to switch pages. Use an
offscreen positioned container rather than display:none to reduce visibility-
dependent widget behavior. Electron background throttling must be evaluated in
real smoke tests; retaining a frame does not promise exact timer cadence or
override widget-owned pause behavior. Background pages may consume CPU or play
audio; there is no automatic suspension policy in this phase.

On page switch, show the selected retained runtime immediately when available.
For a first visit, stage its widget before promotion; keep the previous visible
widget until preparation succeeds. Show loading/error state in the controller;
on failure keep previous visible content and distinguish requested page from
presented page. Page-button active styling reflects the presented page. Retry by
selecting the failed page again. Persist the requested active page so restart
can retry it. Fast switches must never promote stale preparation.

Deleting a page destroys only its runtime. Changing its widget replaces only
that page's runtime content. Re-importing a widget invalidates retained instances
of that widget, lazily reloading inactive instances on next visit and replacing
the active one through staging. Other pages remain intact. Hide/Show, disconnect,
renderer crash and quit may destroy Edge and its runtimes; host settings persist,
but runtime-only data follows each widget's existing persistence behavior.

Host-managed settings are independent. Widget-authored localStorage, cookies and
other same-origin storage are not automatically isolated per page. Do not claim
independent persisted Doodle documents or arbitrary widget state across app
restarts. Preserve upstream widget identities and storage behavior in this phase.

## Navigation and command boundaries

Use numbered buttons with page names as accessible labels/tooltips, visible active
state, keyboard activation and at least 44 CSS-pixel touch targets. Keep controls
inset from display edges; only the control cluster intercepts input. It must not
disappear on focus restoration. Moving the cluster changes placement only, not
the widget's dimensions or runtime identity. At the proposed 12-page limit, the
cluster may wrap into compact rows rather than overflow the display.

Only authenticated current controller main frames may create/rename/reorder/delete
pages, select widgets/settings or change placement. Add one narrowly scoped page
selection command for the authenticated current Edge main frame. Widget iframes
cannot invoke it or mutate page configuration. Validate IDs, limits and command
arguments in the coordinator, not only the renderer. Setting edits include target
page/widget identity to reject stale events after a switch. Reports identify page,
widget, runtime generation and revision so inactive or replaced runtimes cannot
overwrite the current presentation status.

## Verification and acceptance

Unit tests cover version-1 migration, independent same-widget settings, page
invariants/CRUD/order/deletion fallback, preset persistence, sender authorization,
stale edits/reports and recovery. Runtime tests cover lazy retention, staged first
visit, fast switches, failed-page retry, deletion disposal, re-import invalidation
and no frame recreation for settings/name/order/position changes.

Real Electron smoke uses an isolated profile and an available server port. Cover
two Doodle instances retaining distinct in-memory canvases, stable frame identity
on return, background execution observation, all navigation placements, unchanged
fullscreen/window IDs, controller close/reopen and restart migration/restoration.
Do not disturb the running normal-profile app for automated smoke.

Physical acceptance requires user confirmation: Edge buttons select pages with
single taps; pointer restoration does not dismiss controls; drawing and supported
scrolling are unaffected; all six presets are usable; settings and drawings remain
distinct on switch-back; restart restores page/order/position/settings; deletion,
re-import, display reconnect, controller close/reopen and Dock coverage still work.

## Delivery

Checkpoint the accepted Doodle fix and physical-validation record on the existing
two-window feature branch before branching. Create feat/multi-page-navigation
from that checkpoint; use Conventional Commits. No merge or push is implied by
this design. Update HANDOFF and validation evidence as work progresses.

After written-spec approval, write the implementation plan for review and choose
its execution method. Product implementation starts only after those approvals.
