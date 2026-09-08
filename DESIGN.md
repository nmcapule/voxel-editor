# Voxel Studio Design

## Thesis

Voxel editing should feel like drawing on a spatial drafting table, not
operating a miniature desktop suite. The model owns the screen; controls float
at the edges and reveal detail only when requested.

## Visual Language

- Use a cool blue-gray drafting field (`#dfe7ec`) behind the viewport.
- Build controls from solid porcelain (`#f9faf8`) and paper (`#ffffff`) with
  graphite text (`#20262c`) and restrained gray linework (`#d9dddc`).
- Reserve cobalt (`#2f66db`) for active tools and primary state. Model colors
  provide the remaining ornament.
- Use soft, directional shadows to lift instruments without making them look
  glassy. The stage inspector is fully opaque so the model never competes with
  form content.
- Use original 1.7 px line icons with round caps and joins. Do not introduce
  illustration or decorative imagery.

## Typography

Use `Avenir Next`, then `Segoe UI Variable`, `Segoe UI`, Helvetica, Arial, and
the system sans-serif fallback. Controls are compact and semibold; headings use
weight and modest size changes rather than display typography. Numeric model
data uses tabular figures.

## Form And Spacing

- Base spacing follows an 8 px rhythm with deliberate 10, 18, and 22 px edge
  offsets where optical balance matters.
- Compact controls use 9-13 px radii. Floating instruments use 16 px radii and
  the stage inspector uses 22 px radii.
- Maintain at least 40 px controls on desktop and 44 px touch targets where
  touch interaction is expected.
- Prefer grouped pills, rails, and one inspector over permanent sidebars,
  cards, or nested panels.

## Layout

- The WebGL canvas fills the viewport.
- Project controls sit top-left; camera and stage actions sit top-right.
- Model browsing opens a dedicated gallery overlay with a fixed header and search
  controls above a scrolling grid of isometric thumbnails. Preview buttons open
  the saved model; names, dimensions, save dates, and clickable tags sit below.
  Save model uses a separate compact dialog, never a form inside the gallery.
  The gallery expands on desktop and remains usable as a single-column overlay
  at 320 px, with close and search controls remaining visible while browsing.
- Select, Place, Sculpt, and Layer sit bottom-center. Each tool shows its retained
  state beneath its name and opens its popup from the tool bar.
  Place's popup contains Paint, Volume, Eyedropper, and material selection; Place
  reuses the selection scope chosen under Select. Sculpt contains Push/Pull,
  Move, and Erase; Layer opens the layer manager and activates the owner of a
  clicked voxel.
- Coordinates and mesh facts sit bottom-left.
- Stage settings enter from the right on desktop. Between 761 and 1100 px, the
  tool and context docks center within the remaining canvas area while the
  inspector is open.
- At 840 px and below, stage settings become an opaque bottom sheet above the
  four-tool bar. Tool popups stay anchored above their trigger with touch-safe
  rows and internal scrolling on short screens. Project identity, undo, redo,
  framing, render mode, and stage settings share one compact top bar. The model
  status sits below it on a slightly translucent surface. Place keeps its active and recent
  material cubes inside its popup, and the active cube opens the full Palette.

## Scene Workspace

- The main project menu offers **Scene editor** and **Create scene from this model**.
  Child editing keeps a scene/model breadcrumb with the shared-instance count and
  **Done: Return to scene**. The scene menu's **Return to model editor** restores
  the standalone workspace; it is distinct from finishing a child edit.
- Reuse the canvas-first instruments and responsive layout. The scene dock is
  **Select, Place, Transform, Layer**; Stage contains **Scene, Instance, Render**.
  Transform offers Move, Rotate, Scale, snapping, and exact single-instance TRS
  fields. Searchable asset/instance lists and library results use 50-item pages.
- Keep **Edit model** and **Make unique** together with explicit sharing copy:
  editing changes every copy, including locked copies, but not the source library
  model. Locks protect instance changes, not the shared asset's voxel contents.
  The library's Models tab reuses existing thumbnails; Scenes lists saved scenes
  by name and instance/asset counts, without promising scene thumbnails.
- Render exposes **Progressive PBR** and **Capture quality** with **Viewport detail**
  and **Full-scene detail**, followed by **Capture PNG**. Full-scene detail is a
  budgeted exact-geometry raster capture, not a converged PBR image. Keep rejection
  and adaptive-fallback messages explicit; see [RENDERING.md](RENDERING.md#scene-quality-ceilings).
- Show local recovery and server-save state separately. Label represented voxel
  counts, current LOD/loading, and estimated CPU/GPU geometry usage truthfully,
  not as fully resident voxels or total device memory. Warn about uncached online
  assets and omitted session-only texture images; never imply unlimited undo.

## Interaction States

- Active tools use solid cobalt with white labels and icons.
- Hover states use a quiet neutral fill; disabled actions lower opacity.
- On fine pointers, hovering Select, Place, Sculpt, or Layer opens its popup. A short
  leave grace keeps the popup reachable across the anchor gap; click, keyboard,
  and touch activation continue to use the native popover behavior.
- Keyboard focus uses a 3 px dark-cobalt outline with a 3 px offset.
- Editing previews are spatial and transient. Render mode quiets editing
  chrome rather than replacing the workspace. It starts with the realtime
  image, then progressively refines lighting and palette-scoped PBR materials;
  camera, light, geometry, and material changes restart accumulation. The model
  status reports measured rendered FPS without announcing every update. On
  mobile, toggling Render mode does not summon the Stage settings sheet.
- Both Render tabs offer **Miniature photography**, a saved, default-off tilt-shift
  effect visible only in Render mode and included in PNG captures from that mode.
  Enabling it reveals native percentage sliders for **Blur strength**, **Focus
  position** (top to bottom), and **Sharp band width** (fraction of image height),
  without changing render mode or camera. Model sliders preview during dragging;
  scene sliders update on release or keyboard changes as one undoable command.
- The optional voxel face grid traces exposed unit-cell boundaries in adaptive
  graphite or porcelain. Like the editing grid, it disappears in Render mode.
- The editing grid covers the guide floor and rear side planes. Camera-side
  planes hide as the view orbits so grid lines never sit in front of the model.
- Screen-space ambient occlusion adds restrained contact depth to the realtime
  viewport and raster fallback, using half-resolution effect buffers to preserve
  interaction speed. Progressive PBR relies on physically traced occlusion
  instead; its FPS readout counts completed full samples rather than tile passes.
- Realtime shadow maps omit opaque silhouettes from transmissive and
  alpha-transparent voxels. Progressive PBR traces their transmitted light;
  opaque materials continue to cast direct ground shadows in both modes.
- Realtime PBR scales neutral environment lighting with metalness: matte
  materials avoid an added brightness wash while metals retain reflected color
  outside direct highlights.
- Keep named voxel layers in the Layer tool popover at the end of the tool bar,
  separate from stage settings. Each layer can hold a voxel at the same coordinate;
  the highest visible layer wins, and the list shows that layer first. Clicking a
  visible voxel with Layer makes its owner active. The active layer can be renamed,
  shown or hidden, and locked or unlocked.
  Editing requires an active, visible, unlocked layer; selection targets the
  active visible layer. Hidden layers do not mesh, pick, or export.
- Select, Paint, and Sculpt keep the active layer at its authored appearance and
  render other visible layers as faint, neutral translucent context. Picking and
  every selection scope pass through that context, including exact coordinate
  overlaps. Layer, Eyedropper, Volume, Render mode, and model inspection retain
  the normal visible composition. This is an editor-only treatment, not a change
  to layer visibility or palette opacity.
- Canvas resize offers Center and Origin anchors in the Model tab. Center is the
  default and shifts voxels by whole cells around the size change; Origin keeps
  existing voxel coordinates unchanged.
- Keep swatch selection, color editing, material properties, and texture maps
  together in the Palette tab. Show every material as an isometric cube in the
  active editor, compact grid, and named list rather than as a flat color well;
  transparent presets identify themselves in the preview. Grid previews label each
  material along their lower edge. Compact filters expose Opaque, Transparent,
  Metal, and Emissive subsets without changing the active material; no selected tag
  shows the full palette.
  Roughness, metalness, opacity, transmission, and refraction remain explicit
  native controls alongside emissive intensity. Opaque interface faces remain visible through adjacent
  transparent materials. The Render tab is reserved for camera, lighting,
  presentation, and capture controls.
- Selection is retained independently from the primary tool and defaults to
  Point. Point, connected surface, contiguous same-texture, and contiguous body are
  chosen from the Select popup and reused by Place. Place retains Paint or Volume,
  with Eyedropper as a momentary action; Sculpt retains Push/Pull, Move, or Erase.
  The selection mode and active/recent material choices persist across refreshes.
- The Place Volume operation replaces selection modes with Box, Sphere, and Cylinder subtools plus a
  native depth input. Dragging defines a footprint on the hit plane; depth extends
  away from model surfaces or inward from the floor and visible side grids, and
  voxel-aligned translucent ghost cubes preview the exact filled shape using the
  same spacing and depth treatment as Push/Pull.
- A one-finger touch drag rotates the camera when the active operation cannot act
  at its starting position. Touches on actionable voxels or Volume's guide planes keep
  editing behavior; a stationary tap outside actionable voxels clears selection,
  while two-finger dolly and rotate remain available everywhere.
- Selected cells use a cobalt overlay and define the camera pivot. Paint fills
  them with the active color on pointer release. Sculpt retains Push/Pull, Move,
  or Erase as its current operation. Erase removes the resolved cells and clears
  selection; right-drag remains dedicated to camera orbit.
- In Point mode, Paint and Erase drags preview the occupied 3D box and commit
  only on release. A click within their existing selection applies to the full
  selection; a click or drag elsewhere resolves and applies to the new scope.
  Push/Pull and Move over an unselected voxel use the first drag
  to select and the next drag over that selection to edit. Pressing blank space
  while sculpting clears selection without leaving Sculpt.
- Undo and redo restore the selection associated with each side of the edit;
  their controls update availability after every history change.
- Tool shortcuts use compact two-step chords. Q, W, and S immediately select
  the retained Select, Place, or Sculpt tool; a following number-row key chooses
  the listed operation in popup order (Q 1-4, W 1-3, S 1-3). Selecting a primary
  category by keyboard opens its popup; L selects Layer and opens its manager.
- Push/Pull previews every affected voxel in cobalt when pulling and red when
  pushing; Move remains cobalt. The clicked face determines direction, not scope:
  all selected regions reshape from their own directional fronts, retaining
  offsets between stepped faces. Interior selected voxels do not cause extra
  inward cuts. The resulting fronts stay selected for the next edit.
  One drag can add or remove multiple depth steps.
  Pulling overwrites occupied destinations on the active layer up to the canvas
  bounds; pushing removes contiguous solid voxels without cutting through gaps.
  Overlapping voxels on other named layers are preserved.
  Pulling also preserves original selected colors; when extrusion paths overlap,
  the front farther along the pull direction supplies the destination color.
- Move translates the occupied selection along the dragged face normal, preserves
  palette colors, stops at document bounds, and overwrites destination voxels on
  the active layer without changing overlapping voxels on other layers.
- The Select popup exposes Cut, Copy, and Paste with standard Ctrl/Command X, C,
  and V shortcuts. Paste switches to Move and shows a detached cobalt ghost that
  commits on click or drag; Escape cancels it without modifying the document.
- Select distinguishes a click from a five-pixel drag. In Point mode, dragging
  between voxel hits previews a cobalt 3D box and selects every occupied voxel
  inside it. Other modes project a thin marquee onto the starting face and select
  exposed voxels on that plane. Shift and touch add or remove the active scope.
- Motion is limited to short panel and state transitions and is effectively
  removed when `prefers-reduced-motion` is enabled.

## Accessibility

Use native buttons, inputs, selects, disclosure controls, and a semantic tab
set. Keep tool names visible, expose pressed and selected state, label every
viewport and render control, announce coordinate changes politely, and retain
keyboard editing through the focused canvas. The layout must remain usable at
320 px wide.

## Assets And Provenance

The interface uses CSS, WebGL geometry, and an original inline SVG icon set.
There are no shipping raster images or third-party artwork. Screenshots under
`.impeccable/review/` are local QA evidence and are not application assets.
