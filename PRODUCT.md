# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated recommendation confirmed: Bun, TypeScript, Vite, and Three.js. The
application uses a browser-based editor with native local recovery and file APIs,
plus a Bun/SQLite server for shared model and scene libraries.

## Users

Voxel artists and game creators working on a desktop, tablet, or phone who want to make,
inspect, and render voxel models and compose them into scenes without installing
desktop software.

## Product Purpose

Voxel Studio is a focused, model-first browser-based voxel editor and renderer. Success means
a creator can open the app, shape and color a model directly in 3D, return to it
later, exchange it with MagicaVoxel, and capture a finished image. Scene composition
is an optional plugin, not the focus of the app or its startup workspace.

## Positioning

The product combines MagicaVoxel-compatible model editing with a canvas-first,
contextual interface inspired by Feather's approachable 3D interaction model.
It should feel like drawing in space rather than operating a traditional desktop
3D suite.

## Operating Context

Creators work in one full-screen 3D viewport using a mouse and keyboard, pen, or
touch. In the model editor they independently choose an action (Attach, Erase,
Paint, Select, or Move) and a brush (Voxel, Face, Box, Line, Center, Texture, Body,
or Pattern). Mirror and whole-axis modifiers apply on X, Y, and Z. Eyedropper and
Layer remain explicit utilities; Layer activates the owner of a tapped or clicked voxel on release and pans the
viewport on drag. Creators can also navigate the camera, adjust the palette and
lighting, and import or export files.

The scene editor plugin is available under Plugins in the project menu and loads
only when explicitly opened. Startup always restores the standalone model, even
when scene recovery exists. Opening the plugin resumes that scene/child context,
or starts an empty scene if there is no recovery; leaving retains scene recovery.
The plugin places, selects, transforms, and layers model instances.
Edit model enters the existing voxel editor for a shared scene asset; Done returns
to the composition without replacing the standalone model workspace.

## Capabilities and Constraints

- The model editor keeps one model per document, with dimensions from 16 to 256
  voxels on each axis and resizing anchored to the coordinate origin or canvas center.
- Scene documents support extents up to 16,384 units per axis and 10,000 composed
  model instances with independent position, quaternion rotation, and scale (TRS).
  Copies share a scene-local asset: Edit model updates all its instances, including
  hidden or locked copies; Make unique detaches one instance first. Scene layer
  locks protect instance edits and TRS, not shared model contents. Library models
  are copied into scene assets, not live-linked or updated by child editing.
- Named voxel layers with one active layer, visibility and locking controls,
  overlapping per-layer voxels, and local persistence. The highest visible layer
  wins at each coordinate; a stationary tap or click on a visible voxel with the
  Layer utility activates its owner on release. Left-button, pen, and one-finger drags
  pan the viewport over voxels or background; right-button orbit, middle-button
  pan, and two-finger navigation remain unchanged. VOX export flattens visible
  layers into one model.
- Primary brush gestures share one spatial preview and commit path. Voxel draws a
  one-cell-wide freehand stroke, resampling fast pointer movement across stepped
  heights, face changes, and visible document layers while starting a new segment
  at genuine surface gaps. Face resolves a connected exposed surface; Attach and
  Erase drags add or remove its contiguous voxel depth along the face normal. Texture
  resolves a connected same-color region, Body resolves the complete connected
  region, and Box spans X,
  Y, and Z between opposite
  surface or guide-grid cells, while Line and Center remain planar. Pattern places
  a centered copy of clipboard voxels and is disabled until voxels have been copied
  or cut. Mirror reflects the result across the document midpoint and whole-axis
  expands it through a complete X, Y, or Z span. Attach writes only empty
  active-layer cells, Paint recolors only occupied active-layer cells, and Erase
  removes only occupied active-layer cells. Each gesture commits as one undoable edit.
- Select uses the same brush geometry, with Shift or touch adding or removing a
  scope. Move translates a selected region; Ctrl/Command-drag resolves the current
  brush and moves it immediately. Move overwrites destinations on the active layer
  while preserving overlaps on other layers. Cut, Copy, movable ghost Paste, and a momentary
  Eyedropper remain available through All tools.
- Paint, Erase, Select, and Move use active-layer-only editing and
  picking. Attach may anchor to any visible surface but writes only the active layer.
  Other visible layers appear as faint, noninteractive context while a selection
  exists. Without a selection, or during Attach, Layer, Eyedropper, Render,
  or model inspection, the full visible composition is shown. Undo and redo restore
  matching selection and layer state. Deselecting leaves the camera target and
  position unchanged and stops any in-flight selection-focus animation. Right-drag
  remains dedicated to camera orbit.
- Orthographic and perspective camera modes, editing-grid, voxel-face-grid, and
  shadow and ambient-occlusion controls, an opt-in diagnostics FPS readout, palette-scoped
  roughness, metalness, emissive intensity, opacity, transmission, refraction, albedo, normal,
  roughness, and metalness maps, progressive PBR rendering with an
  ambient-occluded realtime fallback, and PNG capture.
- The canvas defaults to muted sage (`#becdc5`) with Solid color selected; saved,
  authored sky and background settings are preserved. The ground grid is optional,
  off by default, and quiet when enabled; enclosing grid guides are hidden by
  default. The model editor has no persistent sun/moon overlay, without removing
  authored sky lighting or the night panorama's moon.
- **PBR materials** is one saved, default-on realtime preference shared by Standard
  and Cube sprites. Off uses opaque, lit palette colors without changing authored
  materials or maps; switching renderers keeps the value. Progressive PBR remains
  independent. Legacy saves preserve their previous renderer's appearance through
  [settings migration](RENDERING.md#shared-realtime-pbr).
- An optional removable Cube sprites plugin provides an orthographic renderer
  in the model editor's Edit and Render modes. It uses depth-correct
  instanced cube sprites with independent AO/shadow switches and PNG capture.
  Tool-driven layer scope, neutral ghost context, mesh-based overlays, and picking
  remain unchanged. Shared PBR materials enables physical surfaces and texture maps;
  off uses stylized opaque palette colors. Progressive PBR is paused without erasing
  its preference. The plugin is model-only, including child asset editing.
- Grid and list palette views with named, editable presets for common surfaces
  including concrete, grass, wood, organic material, water, metals, glass, and warm and cool lights.
  The palette filters materials by opacity, transmission, metalness, and emission.
  Opaque surfaces remain visible where they meet transparent or transmissive
  voxels.
- Single-model MagicaVoxel VOX import and VOX 150 export with a 255-color palette.
- One standalone model autosave in IndexedDB, plus explicit server saves in a shared
  model library. A dedicated gallery overlay shows isometric model thumbnails with
  name search and custom-tag filters. Saving and saving copies use a separate
  dialog. Server saves include layers, palette, material properties and lighting,
  but not texture image files, camera position or undo history. No account is
  required; the shared library is for personal or trusted-team servers.
- The model top bar shows compact actual save state: Saved, Saving, or Not saved.
  Accessible text and a tooltip retain local/server detail rather than implying
  local autosave updates the server copy. At narrow widths the visible text can
  collapse to a state dot without losing that accessible detail.
- Scenes have separate local recovery, explicit scene-library saves, and streaming
  `.vscene` import/export. A recovered manifest may still need online access to
  uncached chunks; it is not a guarantee of a complete offline scene. Texture
  images remain session-only. See [MODEL-LIBRARY.md](MODEL-LIBRARY.md) for persistence.
- The standalone editing session is preserved while composing a scene. Only the
  last visited child model retains its editing session and undo history for reuse;
  visiting another child discards the older child's history, not its saved edits.
  Scene history is separate from model-content history, bounded, and may evict
  undo entries. Histories do not survive refresh or library/file round trips.
- Selection scope plus active and recent materials persist across refreshes.
- Mobile Paint and Erase reserve one-finger drags for editing, including drags
  starting off-model and moving onto editable active-layer voxels. Two-finger camera
  navigation remains available, and layer visibility and lock restrictions still apply.
- Mouse, keyboard, pen, and touch use the same bottom-left three-button dock at
  every screen size: Brush, Action, and active material. Press Brush or Action to
  open a horizontal strip immediately, slide onto an enabled option, and release
  to choose. A stationary tap keeps the popup open for option taps; tapping outside,
  including its trigger, dismisses it. Coordinate hit testing determines slide choices;
  sliding and releasing outside cancels. There is no hold delay or vertical wheel.
  Keyboard activation opens a listbox with arrow-key and Home/End navigation,
  Enter/Space selection, and Escape cancellation; focus leaving closes it.
  Pointer cancellation, lost capture, blur, resize, and editor changes also cancel
  without editing the canvas.
- Quick strips offer Voxel, Face, Box, Line, and Center brushes and Attach, Erase,
  and Paint actions. A separate bottom-right vertical-dots All tools button opens
  a compact, vertically scrolling popup with every action, brush, utility, axis
  modifier, clipboard action, and material control. Select, Move, Texture, Body,
  and Pattern remain available there. Retained action and brush stay independent
  when a utility is active; accessible names expose their state.
- The top bar orders project menu, project name, save state, Undo, Redo, and
  Settings gear. Settings opens a compact panel with Model, Palette, and Render
  tabs. The top-right view cube provides Top, Right, and Front views; its View
  popup offers Fit to scene, six axis views, Ground grid, Shadows, Ambient
  occlusion, Render mode, and lighting/camera settings.
- The material cube opens a separate compact material popover anchored above the dock;
  it has no title or close button and supports the same tap and press-slide-release
  interactions as Brush and Action, with native scrolling when tapped open.
  choosing a material closes it and restores focus to the cube. Edit materials opens
  the full Palette settings. Settings and tool popups
  replace rather than overlap one another, with bounded scrolling content on
  desktop and mobile. Show diagnostics in the Model tab opts into coordinates,
  voxel count, mesh status, and FPS; these and the contextual instruction strip
  are not persistent model chrome. The separate Performance monitor remains opt-in.
- Animation, per-voxel material metadata, cloud sync,
  and collaboration are outside the first release.
- A 256-cubed document is a supported coordinate volume. Pathological models
  with extreme exposed surface area may exceed practical WebGL geometry budgets.
- Scene metadata validation covers 100 million-plus represented/source voxel
  fixtures without hydrating a giant voxel document. This is not an FPS or
  full-detail rendering promise: streaming, adaptive LOD, model hydration, and
  full-scene PBR/capture have distinct [resource budgets](RENDERING.md#scene-resources).

## Brand Commitments

The product name is Voxel Studio. Feather is an interaction reference only; the
product must use its own colors, icons, components, copy, and identity.

## Evidence on Hand

The confirmed implementation plan, Feather's public interface documentation,
and the user-pinned UI reference inform the product brief. The current implemented
model UI uses the shared compact dock and contextual controls described above.
No commercial claims, user research, customer assets, or
third-party artwork are available and none should be fabricated.

## Product Principles

- Keep the model visually dominant and reveal controls in context.
- Make every edit immediate, reversible, and spatially legible.
- Preserve local ownership through offline storage and standard file export.
- Remain approachable without hiding exact dimensions, colors, or coordinates.
- Spend performance on the model, not persistent interface animation.

## Accessibility & Inclusion

Use semantic controls, visible keyboard focus, text-backed tool state, keyboard
shortcuts, live coordinate announcements when diagnostics are shown, reduced-motion
support, 44-pixel quick-picker targets, and a layout that remains usable at 320 pixels wide. Tool
disclosures support keyboard opening, Escape and explicit closing, light dismissal,
and predictable focus restoration.
