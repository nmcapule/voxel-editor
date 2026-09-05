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
- Recent colors form a vertical rail on the left.
- Select, Paint, Sculpt, and Fill sit bottom-center with retained selection modes and
  compact contextual actions above them.
- Coordinates and mesh facts sit bottom-left.
- Stage settings enter from the right on desktop. Between 761 and 1100 px, the
  tool and context docks center within the remaining canvas area while the
  inspector is open.
- At 840 px and below, stage settings become an opaque bottom sheet above the
  four-tool bar. Context controls wrap into compact touch-safe rows; secondary
  desktop controls and the color rail collapse.

## Interaction States

- Active tools use solid cobalt with white labels and icons.
- Hover states use a quiet neutral fill; disabled actions lower opacity.
- Keyboard focus uses a 3 px dark-cobalt outline with a 3 px offset.
- Editing previews are spatial and transient. Render mode quiets editing
  chrome rather than replacing the workspace. It starts with the realtime
  image, then progressively refines lighting and palette-scoped PBR materials;
  camera, light, geometry, and material changes restart accumulation. The model
  status reports measured rendered FPS without announcing every update.
- The optional voxel face grid traces exposed unit-cell boundaries in adaptive
  graphite or porcelain. Like the editing grid, it disappears in Render mode.
- Screen-space ambient occlusion adds restrained contact depth to the realtime
  viewport and raster fallback, using half-resolution effect buffers to preserve
  interaction speed. Progressive PBR relies on physically traced occlusion
  instead; its FPS readout counts completed full samples rather than tile passes.
- Keep named voxel layers in the Model tab. Each voxel belongs to one layer;
  the active layer can be renamed, shown or hidden, and locked or unlocked.
  Editing requires an active, visible, unlocked layer; selection targets the
  active visible layer. Hidden layers do not mesh, pick, or export.
- Keep swatch selection, color editing, material properties, and texture maps
  together in the Palette tab. Show every material as an isometric cube in the
  active editor, compact grid, and named list rather than as a flat color well;
  transparent presets identify themselves in the preview.
  Roughness, metalness, opacity, transmission, and refraction remain explicit
  native controls. Opaque interface faces remain visible through adjacent
  transparent materials. The Render tab is reserved for camera, lighting,
  presentation, and capture controls.
- Selection is retained independently from the primary tool. Point, connected
  surface, same-color texture, and contiguous body modes remain visible above
  Select, Paint, and Sculpt. Eyedropper is a momentary Paint action.
- Fill replaces selection modes with Box, Sphere, and Cylinder subtools plus a
  native depth input. Dragging defines a footprint on the hit plane; depth extends
  along its outward normal, and the translucent preview shows the full volume.
- Selected cells use a cobalt overlay and define the camera pivot. Paint fills
  them with the active color on pointer release. Right-clicking or holding a
  selected area opens compact Paint selection and Erase selection actions;
  opening the menu never edits the model. Sculpt retains Push/Pull, Move, or
  Erase as its current operation. Erase removes the resolved cells and clears
  selection.
- In Point mode, Paint and Erase drags preview the occupied 3D box and commit
  only on release. Push/Pull and Move over an unselected voxel use the first drag
  to select and the next drag over that selection to edit. Pressing blank space
  while sculpting clears selection without leaving Sculpt.
- Undo and redo restore the selection associated with each side of the edit;
  their controls update availability after every history change.
- Push/Pull previews every affected voxel in cobalt when pulling and red when
  pushing; Move remains cobalt.
- Move translates the occupied selection along the dragged face normal, preserves
  palette colors, and stops at document bounds or unselected voxels.
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
