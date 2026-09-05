# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated recommendation confirmed: Bun, TypeScript, Vite, and Three.js. The
application is a client-only editor with native browser storage and file APIs.

## Users

Voxel artists and game creators working on a desktop or tablet who want to make,
inspect, and render compact voxel models without installing desktop software.

## Product Purpose

Voxel Studio is a focused browser-based voxel editor and renderer. Success means
a creator can open the app, shape and color a model directly in 3D, return to it
later, exchange it with MagicaVoxel, and capture a finished image.

## Positioning

The product combines MagicaVoxel-compatible model editing with a canvas-first,
contextual interface inspired by Feather's approachable 3D interaction model.
It should feel like drawing in space rather than operating a traditional desktop
3D suite.

## Operating Context

Creators work in one full-screen 3D viewport using a mouse and keyboard, pen, or
touch. They retain a point, surface, texture, or body selection mode while using
four primary tools: Select, Paint, Sculpt, and Fill. Eyedropper is a momentary Paint
action. Creators can also navigate the camera, adjust the palette and lighting,
and import or export files.

## Capabilities and Constraints

- One model per document with dimensions from 16 to 256 voxels on each axis.
- Named voxel layers with one active layer, visibility and locking controls,
  per-voxel ownership, and local persistence. A coordinate can hold one voxel;
  VOX export flattens visible layers into one model.
- Point clicks and occupied 3D box drags, connected-surface, same-color texture,
  contiguous-body, and marquee selection with Paint plus Push/Pull, Move, and
  Erase Sculpt operations. In Point mode, Paint and Erase preview the dragged
  box and commit on release; Push/Pull and Move first select an unselected target
  and apply on the next drag. Right-clicking or holding an existing selection
  opens Paint and Erase selection actions. The editor also includes a momentary
  eyedropper, undo and redo with matching selection and layer restoration, and
  selection-centered camera orbit.
- Box, sphere, and cylinder Fill shapes use a dragged footprint and explicit
  depth to create undoable volumes in the active material and layer.
- Orthographic and perspective camera modes, editing-grid, voxel-face-grid, and
  shadow and ambient-occlusion controls, an FPS readout, palette-scoped
  roughness, metalness, opacity, transmission, refraction, albedo, normal,
  roughness, and metalness maps, progressive PBR rendering with an
  ambient-occluded realtime fallback, and PNG capture.
- Grid and list palette views with named, editable presets for common surfaces
  including concrete, grass, wood, organic material, water, metals, and glass.
  Opaque surfaces remain visible where they meet transparent or transmissive
  voxels.
- Single-model MagicaVoxel VOX import and VOX 150 export with a 255-color palette.
- One local autosave in IndexedDB. No account or network service is required.
- Desktop-first interaction with pen and touch support and a mobile-safe layout.
- Animation, multiple scene objects, per-voxel material metadata, cloud sync,
  and collaboration are outside the first release.
- A 256-cubed document is a supported coordinate volume. Pathological models
  with extreme exposed surface area may exceed practical WebGL geometry budgets.

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
