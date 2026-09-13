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
- On desktop, model editing uses a two-strip deck at bottom-center. The Action strip leads with
  Attach, Erase, Paint, Select, and Move, followed by Eyedropper and Layer utilities.
  The Brush strip leads with Voxel, Face, Box, Line, Center, Texture, Body, and Pattern, followed by Mirror
  and whole-axis X/Y/Z toggles, clipboard actions, and the active material cube.
  Action and brush stay independently legible; Eyedropper and Layer temporarily own
  the interaction without erasing the retained action and brush.
- Coordinates and mesh facts sit bottom-left.
- Stage settings enter from the right on desktop. Between 761 and 1100 px, the
  tool and context docks center within the remaining canvas area while the
  inspector is open.
- At 840 px and below, stage settings become an opaque bottom sheet above a compact
  tool shelf. A dedicated brush icon occupies its left edge; the adjacent Action
  control uses the same compact vertical wheel picker. Press opens the wheel above
  the control; dragging turns the drum with curved neighboring rows and a fixed
  center selection band. Release commits the centered mode without momentum.
  Tapping opens it for option taps or arrow keys and Enter; Escape, pointer
  cancellation, and editor changes discard the pending choice. Wheels keep 44 px
  row spacing, showing fewer rows in short landscape views. The retained Action
  stays visible beside an explicit
  **All tools** disclosure; an active utility is named there
  without replacing either retained value. All tools opens one nonmodal bottom
  sheet above the shelf with labeled Action, Brush, Utilities, Mirror axes, Whole
  axes, Clipboard, and Material groups. Controls wrap within each group and the
  sheet scrolls vertically, never through hidden horizontal strips. Project
  identity, undo, redo, framing, render mode, and stage settings share one compact
  top bar. The model status sits below it on a slightly translucent surface, and
  the active material cube opens the full Palette. Stage, All tools, and Layers
  replace rather than overlap one another.

## Scene Plugin

- Model editing and rendering remain the main workspace. The project menu keeps
  a secondary **Plugins** disclosure containing **Scene editor**. Opening it loads
  the plugin and resumes scene recovery; startup never opens or loads the scene
  editor automatically. Loading feedback and retryable failures stay in the model
  workspace without changing the standalone document.
- The scene menu offers **Create scene from standalone model...**, not the main
  project actions. It copies the preserved standalone model, not the last child.
  Child editing keeps a scene/model breadcrumb with the shared-instance count and
  **Done: Return to scene** plus **Export owning scene...** in the plugin's return
  bar. The scene menu's **Return to model editor** restores the standalone workspace
  and retains scene recovery; it is distinct from finishing a child edit.
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
- Model actions, brushes, modifiers, and utilities are direct controls on
  desktop. Mobile uses one responsive All tools disclosure, but every tool remains
  a visible, labeled direct control inside it rather than another nested menu.
  Pressed state is visible in each independent group; Pattern is disabled until
  clipboard voxels exist. Layer alone opens its anchored manager. Scene tools retain
  their existing click and fine-pointer hover popup behavior.
- Keyboard focus uses a 3 px dark-cobalt outline with a 3 px offset.
- Editing previews are spatial and transient. Render mode quiets editing
  chrome rather than replacing the workspace. It starts with the realtime
  image, then progressively refines lighting and palette-scoped PBR materials;
  camera, light, geometry, and material changes restart accumulation. The model
  status reports measured rendered FPS without announcing every update. On
  mobile, toggling Render mode does not summon the Stage settings sheet.
- The model Render tab starts with **Renderer: Standard / Cube sprites**. The
  **PBR materials** native checkbox below it is always visible and enabled, even when
  the plugin is unavailable. It controls one saved, default-on preference shared by
  both realtime renderers; switching renderer keeps its value. Concise help distinguishes
  this from independent **Progressive PBR** and explains that off uses opaque palette
  colors without changing authored materials or texture maps. Legacy saves retain
  their prior renderer's appearance through [migration](RENDERING.md#shared-realtime-pbr).
  Cube sprites applies in Edit and Render modes, retaining tool-driven layer scope,
  neutral ghost context, and mesh-based editing overlays.
  Its camera is orthographic and Progressive PBR is disabled without erasing the saved
  preference. A missing plugin shows Standard with an explicit fallback notice while
  retaining the saved choice. Keep the existing independent AO and shadow switches.
- Both Render tabs place **Volumetric lighting** beside **Shadows**, using the existing
  native checkbox row. It is saved per document and defaults off. Help explains
  sunbeams in realtime and Progressive PBR, added rendering cost, and unshadowed
  haze with Shadows off. The effect is visible in Edit/Render views and PNG captures.
  Enabling it reveals native **Density** (0-300%, default 100%), **Spread** (0-100%,
  default 25% padding on each side), and **Fog color** controls. Density and spread
  are relative to model/scene scale; settings persist with each document.
- One-finger touch dragging pans in Render mode in both editors, like the model
  Layer tool. Mouse mappings and two-finger orbit/zoom remain unchanged.
- Both Render tabs offer **Miniature photography**, a saved, default-off tilt-shift
  effect visible only in Render mode and included in PNG captures from that mode.
  Enabling it reveals native percentage sliders for **Blur strength**, **Focus
  position** (top to bottom), and **Sharp band width** (fraction of image height),
  without changing render mode or camera. Model sliders preview during dragging;
  scene sliders update on release or keyboard changes as one undoable command.
- Both Render tabs place a native **Skybox** select before **Backdrop**.
  **Solid color** is the default; Daylight, Overcast, Sunset, and Night hide the
  backdrop color control without resetting it or the lighting controls.
  Show the short Ambient, Key light, and Light angle explanation only for active skies.
  Non-solid presets include procedural clouds, layered mountain ranges and pine
  silhouettes. Orthographic models retain their projection but get a perspective-style
  panoramic backdrop. Night has a glowing moon and stronger actual moonlight, not
  merely a brighter icon; the other presets and global exposure remain independently controlled.
- A default-on key-light compass, not a scene object, shows warm **Sun** for Solid color,
  Daylight, Overcast, and Sunset; cool **Moon** for Night, with porcelain **Ahead/Behind** labels.
  It follows actual light and camera orientation in view space for orthographic/perspective views,
  stays stable on pan/zoom, never intercepts pointers, and leaves lighting and PNG captures unchanged.
  It avoids the desktop Stage inspector and clears mobile chrome, dock, and safe area.
  A saved **Show sun/moon** checkbox beside Skybox hides only the compass, without
  turning off illumination or the night panorama's moon. The moon marker has a cool glow.
- Render mode and PNG captures show authored geometry against the selected backdrop
  or sky, without an automatic ground plane. The editing grid remains an edit-only guide.
- The optional voxel face grid traces exposed unit-cell boundaries in adaptive
  graphite or porcelain. Like the editing grid, it disappears in Render mode.
- The editing grid covers the guide floor and rear side planes. Camera-side
  planes hide as the view orbits so grid lines never sit in front of the model.
- Screen-space ambient occlusion adds restrained contact depth to the realtime
  viewport and raster fallback, using half-resolution effect buffers to preserve
  interaction speed. Progressive PBR relies on physically traced occlusion
  instead; its FPS readout counts completed full samples rather than tile passes.
- Both Render tabs offer a default-off **Performance monitor**, remembered only in
  browser storage and shared across editors. Three classic stats graphs show FPS,
  average synchronous **Render ms** per pass, and **JS heap MiB** where available.
  These are not system CPU utilization, GPU time, or total RAM. Show idle and
  unavailable states explicitly, do not announce updates, never force extra frames,
  and exclude the overlay from PNG captures. Keep it below the top-left chrome on
  desktop and above the tool dock on mobile, behind inspectors and popups.
- During raster camera gestures, animated focus, and model/scene editing drags,
  temporarily cap viewport DPR at 1 and restore the normal DPR cap of 2 after a
  150 ms settling delay. Only the canvas becomes softer; interface controls remain
  sharp. PNG captures and Progressive PBR retain normal resolution. Hover-only
  previews and sidebar controls do not activate this interaction policy.
- Both Render tabs offer a default-off **Auto simplify rendering** checkbox next to
  Performance monitor, remembered in this browser and shared across editors. Help
  explains that camera movement and editing temporarily disable realtime PBR,
  shadows, AO and miniature photography, pause progressive PBR, and make glass
  opaque. Restore the latest requested quality after editing meshes settle and
  150 ms without interaction. Keep the individual quality checkboxes unchanged;
  PNG captures retain requested quality. No extra status overlay or animation.
- Realtime shadow maps omit opaque silhouettes from transmissive and
  alpha-transparent voxels. Progressive PBR traces their transmitted light;
  opaque materials continue to cast direct shadows onto other authored geometry in both modes.
- Realtime PBR scales neutral environment lighting with metalness: matte
  materials avoid an added brightness wash while metals retain reflected color
  outside direct highlights.
- Keep named voxel layers in the Layer popover at the end of the desktop Action
  strip and in the mobile Operations group, separate from stage settings. Each
  layer can hold a voxel at the same coordinate;
  the highest visible layer wins, and the list shows that layer first. A stationary
  tap or click on a visible voxel with Layer makes its owner active on release.
  Left-button, pen, and one-finger drags pan the viewport over voxels or background
  without activating a layer. Right-button orbit, middle-button pan, and two-finger
  navigation remain unchanged. The active layer can be renamed,
  shown or hidden, and locked or unlocked.
  Editing requires an active, visible, unlocked layer; selection targets the
  active visible layer. Hidden layers do not mesh, pick, or export.
- Paint, Erase, Select, and Move keep the active layer at its authored appearance
  (opaque palette colors when realtime PBR materials is off). Only while a selection
  exists do they render other visible layers as faint, neutral translucent context.
  Active-layer-only picking and every selection scope remain unchanged regardless
  of selection, passing through other layers even at exact coordinate overlaps.
  Attach may target any visible surface while writing only to the active layer.
  Without a selection, or during Attach, Layer, Eyedropper, Render mode, or model
  inspection, show the normal full visible composition. This is an editor-only
  visual treatment, not a change to picking, layer visibility, or palette opacity.
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
- Action and brush are independent. Attach, Erase, Paint, Select, and Move combine
  with Voxel, Face, Box, Line, Center, Texture, Body, or Pattern. Voxel draws a one-cell-wide path
  across the currently visible surface. Fast pointer motion is resampled across
  stepped heights, face-normal changes, and visible document layers. Intermediate
  cells must remain exposed; gaps and missing targets begin a new segment so strokes
  never tunnel through the model.
  Face uses the connected exposed surface; Attach and Erase drag along its normal
  to add or remove contiguous voxel-depth steps. Texture resolves the connected
  same-color region and Body resolves the complete connected region. Box uses opposite picked surface or
  guide-grid cells as inclusive XYZ corners; a same-plane drag remains one voxel
  thick. Line and Center stay on the initial hit plane. Pattern places the centered
  clipboard shape and preserves its source colors when attaching. Mirror reflects
  the resolved cells across the document midpoint; whole-axis expands them across
  the complete selected dimension. Selection scope and active/recent material
  choices persist across refreshes.
- Outside Layer, a one-finger touch drag rotates the camera when the active operation
  cannot act at its starting position. Touches on actionable voxels keep
  editing behavior; a stationary tap outside actionable voxels clears selection,
  while two-finger dolly and rotate remain available everywhere.
- Selected cells use a cobalt overlay and define the camera pivot. Paint recolors
  occupied brush cells with the active color; Erase removes occupied brush cells;
  Attach adds only where the active layer is empty. Right-drag remains dedicated to camera orbit.
  In the model editor, deselecting leaves both camera target and position unchanged
  and stops any in-flight selection-focus animation.
- Voxel, Box, and Face Attach/Erase preview their complete accumulated mask while dragging and sample
  the release position before committing once. Line and Center also preview while
  dragging and commit once on release; other Face actions and Pattern commit from one press.
  Voxel cancellation discards the full uncommitted stroke, including when a second
  touch starts camera navigation. Select uses the same masks and Shift or touch
  adds/removes them. Move over an unselected voxel first resolves the current brush;
  Ctrl/Command-drag resolves and moves immediately. Pressing blank space while selecting or moving clears selection
  without changing the retained action or brush.
- Undo and redo restore the selection associated with each side of the edit;
  their controls update availability after every history change.
- Model action shortcuts are T Attach, R Erase, G Paint, and N Select. Brush
  shortcuts are V Voxel, F Face, B Box, L Line, C Center, and P Pattern. Number
  keys 1/2/3 toggle Mirror X/Y/Z; Ctrl/Command+1/2/3 toggle whole-axis X/Y/Z.
  Ctrl/Command-drag invokes Move and Alt-click invokes Eyedropper. Model Render
  mode is toggled from the toolbar, not a keyboard shortcut.
- Move translates the occupied selection along the dragged face normal, preserves
  palette colors, stops at document bounds, and overwrites destination voxels on
  the active layer without changing overlapping voxels on other layers.
- The desktop Brush strip and mobile Clipboard group expose Cut, Copy, and Paste
  with standard Ctrl/Command X, C, and V shortcuts. Paste switches to Move and
  shows a detached cobalt ghost that commits on click or drag; Escape cancels it
  without modifying the document.
- Select distinguishes a click from a five-pixel drag. In Point mode, dragging
  between voxel hits previews a cobalt 3D box and selects every occupied voxel
  inside it. Other modes project a thin marquee onto the starting face and select
  exposed voxels on that plane. Shift and touch add or remove the active scope.
- Motion is limited to short panel and state transitions and is effectively
  removed when `prefers-reduced-motion` is enabled. The mobile tool sheet adds no
  custom entrance animation.

## Accessibility

Use native buttons, inputs, selects, disclosure controls, and a semantic tab
set. Keep tool names visible, expose pressed and selected state, label every
viewport and render control, announce coordinate changes politely, and retain
keyboard editing through the focused canvas. The mobile tool disclosure supports
keyboard traversal, Escape, explicit close, light dismissal, and focus restoration;
all touch targets remain at least 44 px. The collapsed and expanded layouts must
remain usable without horizontal overflow at 320 px wide.

## Assets And Provenance

The interface uses CSS, WebGL geometry, and an original inline SVG icon set.
There are no shipping raster images or third-party artwork. Screenshots under
`.impeccable/review/` are local QA evidence and are not application assets.
