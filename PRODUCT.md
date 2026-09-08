# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated recommendation confirmed: Bun, TypeScript, Vite, and Three.js. The
application uses a browser-based editor with native local recovery and file APIs,
plus a Bun/SQLite server for shared model and scene libraries.

## Users

Voxel artists and game creators working on a desktop or tablet who want to make,
inspect, and render voxel models and compose them into scenes without installing
desktop software.

## Product Purpose

Voxel Studio is a focused browser-based voxel editor and renderer. Success means
a creator can open the app, shape and color a model directly in 3D, return to it
later, exchange it with MagicaVoxel, arrange model instances into a larger scene,
and capture a finished image.

## Positioning

The product combines MagicaVoxel-compatible model editing with a canvas-first,
contextual interface inspired by Feather's approachable 3D interaction model.
It should feel like drawing in space rather than operating a traditional desktop
3D suite.

## Operating Context

Creators work in one full-screen 3D viewport using a mouse and keyboard, pen, or
touch. In the model editor they retain a point, surface, texture, or body selection
mode while using four primary tools: Select, Volume, Sculpt, and Layer. Volume
(formerly Place) holds Paint, Fill (the former Volume operation), a momentary
Eyedropper, and Erase (moved from Sculpt); Paint and Erase reuse the selection mode.
Sculpt holds Push/Pull and Move. Layer activates the owner of a tapped or clicked
voxel on release and pans the viewport on drag. Creators can also navigate the
camera, adjust the palette and lighting, and import or export files.

The separate scene editor places, selects, transforms, and layers model instances.
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
  Layer tool activates its owner on release. Left-button, pen, and one-finger drags
  pan the viewport over voxels or background; right-button orbit, middle-button
  pan, and two-finger navigation remain unchanged. VOX export flattens visible
  layers into one model.
- Point clicks and occupied 3D box drags, connected-surface, contiguous same-texture,
  contiguous-body, and marquee selection with Volume's Paint and Erase plus
  Sculpt's Push/Pull and Move. In Point mode, Paint and Erase preview the dragged
  box and commit on release; clicking either operation within the current selection
  applies it to the full selection, while clicking elsewhere resolves a new scope.
  Push/Pull and Move first select an unselected target
  and apply on the next drag. Push/Pull reshapes the whole selection along the
  clicked face normal, preserving staggered face depths rather than restricting
  edits to one plane. It supports multiple voxel-depth steps per drag and pulls
  through occupied destinations, replacing colors on the active
  layer. Select, Paint, Erase, and Sculpt retain active-layer-only picking, but show
  other visible layers as faint, noninteractive context only while a selection
  exists. Without a selection, or during Fill, Layer, Eyedropper, Render, or model
  inspection, the full visible composition is shown. Move overwrites occupied destinations on the active
  layer while preserving overlapping voxels on other layers. The Select popup and
  standard keyboard shortcuts provide Cut, Copy, and movable ghost Paste. The editor also includes a momentary eyedropper,
  undo and redo with matching selection and layer restoration, and
  selection-centered camera orbit. Deselecting leaves the camera target and
  position unchanged and stops any in-flight selection-focus animation. The main
  Select tile clears the current selection; expand, swipe, hover, and selection-mode
  choice do not. Right-drag remains dedicated to camera orbit.
- Volume's Fill operation provides box, sphere, and cylinder shapes with
  two dragged 3D corners to create undoable volumes in the active material and
  layer. Corners snap outside model faces or onto the floor and visible side
  grids of the guide volume. Explicit depth remains available for keyboard fills.
- Orthographic and perspective camera modes, editing-grid, voxel-face-grid, and
  shadow and ambient-occlusion controls, an FPS readout, palette-scoped
  roughness, metalness, emissive intensity, opacity, transmission, refraction, albedo, normal,
  roughness, and metalness maps, progressive PBR rendering with an
  ambient-occluded realtime fallback, and PNG capture.
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
- Desktop-first interaction with pen and touch support and a mobile-safe layout.
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

The confirmed implementation plan and Feather's public interface documentation
are the product brief. No commercial claims, user research, customer assets, or
third-party artwork are available and none should be fabricated.

## Product Principles

- Keep the model visually dominant and reveal controls in context.
- Make every edit immediate, reversible, and spatially legible.
- Preserve local ownership through offline storage and standard file export.
- Remain approachable without hiding exact dimensions, colors, or coordinates.
- Spend performance on the model, not persistent interface animation.

## Accessibility & Inclusion

Use semantic controls, visible keyboard focus, text-backed tool state, keyboard
shortcuts, live coordinate announcements, reduced-motion support, 44-pixel touch
targets, and a layout that remains usable at 320 pixels wide.
