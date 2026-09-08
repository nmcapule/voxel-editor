# Cube Sprites

Optional, opaque orthographic rendering for the model editor's **Edit and Render modes**.
In Stage > Render choose **Renderer: Cube sprites** to use it in both modes.
The scene renderer is unchanged; child asset editing uses the model renderer. Isometric views
are orthographic camera orientations; continuous orbit and axis-aligned views work.

## Behavior

- Rendered cells use palette colors, stylized hemispheric ambient light, and the
  existing directional light. All occupied cells are opaque, even if their authored
  materials describe glass, opacity, or emission. Physical properties and texture
  maps remain saved and unmodified, but are not applied by this renderer.
- Select, Sculpt, and Paint use active-layer sprites with the existing neutral ghost
  context. Volume, Layer, Eyedropper, and Render mode use the full visible composition.
  Picking and tool behavior are unchanged.
- Ambient occlusion and Shadows reuse the existing independent UI switches.
  The sky/backdrop and optional Miniature photography finishing effect still work.
  Ambient remains stylized rather than sampling physical environment reflections.
- Selecting the plugin enforces orthographic projection, including restored or
  scripted conflicting settings. Progressive PBR is paused without overwriting its
  saved preference; selecting Standard enables it again if previously selected.
- PNG captures include current edits. Isometric inspection uses the full visible
  composition and prepares the actual offscreen camera, then restores editing scope;
  subsequent live renders prepare the live camera again.

## Implementation

`index.ts` exports one `ModelPreviewPlugin`. The application discovers it with a
narrow `import.meta.glob` and injects it through `ModelEditorOptions`. There are
no editor-to-plugin imports, extra canvas, animation loop, or rendering dependencies.

Each exposed cell is a four-byte instance: 12-bit chunk-local coordinates and an
8-bit palette index, plus six occupied-neighbor bits. Active-layer or highest-visible-layer
composition and six-neighbor enclosed cell removal use the document's existing padded
chunks, including chunk boundaries.
Chunks have independent instance buffers and conservative bounds. Palette colors
live in one linear-color lookup texture, so recoloring doesn't rebuild instances.
Edits dirty affected chunk instance buffers for live updates. There is one current-scope
cache, not a per-layer cache; scope changes repack chunks on demand.

Physical mesh materials are hidden while the plugin is active, but the helper tree
is retained, including neutral ghost context and mesh-based face grids/topology overlays.

Two reusable RGBA16F atlases contain unit-cube normals and view-relative depth:
one for the view and one for the directional light. The fragment shader reconstructs
exact face-plane depth from screen pixel coordinates, and uses ray/box intersection
only at invalid or discontinuous atlas texels. This avoids magnification cracks and
interpolated-quad depth errors. It writes conventional `gl_FragDepth`, letting the
existing GTAO consume true cube surfaces. A custom light-facing depth material
feeds Three's existing PCF shadow map; receivers use reconstructed world positions.
The light atlas stores back faces, matching Three's normal shadow-caster policy and
avoiding PCF self-shadow speckling on flat faces. Occupied-neighbor bits discard
internal back faces, which otherwise cast false grid-shaped shadows on flat walls.

Orbit rebakes the view atlas, not voxel buffers or the light atlas. Pan changes no
bakes. Zoom/resize can grow atlas resolution; sizes never shrink until disposal.
Light direction changes invalidate the light atlas and shadow map. Each atlas is
128-1024 pixels square, capped at 8 MiB of color storage plus its depth attachment.
Disabling shadows skips light baking and shadow rendering. Context loss, document
replacement, and editor deactivation release or rebuild the appropriate resources.

## Limits And Checks

Dirty chunks are packed synchronously on the first required frame. Highly exposed
256-cubed models can stall activation and still incur substantial overdraw; move
packing to a worker if measurements justify it. Conventional editing meshes remain
resident in model mode, so four bytes per sprite is not a total-memory claim.
No scene streaming, transformed scene instances, transparency, or full PBR support.

Run `bun test plugins/cube-sprites`. For GPU checks, start the existing browser harness
with `bunx vite --config tests/vite.config.ts`, open `/tests/transparency.html`, then:

```js
const checks = await import('/plugins/cube-sprites/browser-checks.ts')
checks.runCubeSpriteDepthChecks()
await checks.runCubeSpriteChecks()
await checks.runCubeSpriteEditingChecks()
await checks.runCubeSpriteBenchmark()
```

Depth checks compare against real cubes across nine orientations and verify
subpixel rasterization differences against exact ray/geometry intersections.
Integration checks cover palette updates, dirty edits, bake reuse, AO/shadows,
capture, offscreen views, renderer switching, and context recovery. Editing checks
cover automatic live frames, scoped picking, layer/tool changes, helper overlays,
inspection restoration, and document replacement. The benchmark
compares sparse, solid, and checkerboard models with AO/shadows off, separately for
stationary frames and orbit. It is a diagnostic, not a hardware-independent FPS
promise: greedy meshes can be cheaper for flat solids, and impostors can be limited
by fragment cost and overdraw.

Remove this entire directory to uninstall, including its tests. The application
still builds and uses Standard rendering. Saved `cube-sprites` choices remain
readable and are retained with an explicit unavailable-plugin notice. Restart a
running development server after installing/removing the directory if its glob
discovery cache is stale. Rebuilding production always rediscovers installed files.
