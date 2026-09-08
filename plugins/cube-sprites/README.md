# Cube Sprites

Optional orthographic rendering for the model editor's **Edit and Render modes**.
In Stage > Render choose **Renderer: Cube sprites** to use it in both modes.
The scene renderer does not use the plugin; child asset editing uses the model renderer. Isometric views
are orthographic camera orientations; continuous orbit and axis-aligned views work.

## Behavior

- **PBR materials** is one saved realtime preference shared with Standard, on by default.
  Switching renderers keeps its value; Progressive PBR remains independent.
- With **PBR materials** off, rendered cells use palette colors, stylized hemispheric ambient light, and the
  existing directional light. All occupied cells are opaque, even if their authored
  materials describe glass, opacity, or emission. Physical properties and texture
  maps remain saved and unmodified, but are not applied in this mode.
- With **PBR materials** on, every material surface remains an impostor. Palette/chunk batches
  use cloned Standard physical materials, including opacity, transmission, IOR,
  roughness, metalness, emission, normal maps, other texture maps and environment
  bindings. Nonopaque surfaces use the same layered raster pipeline as Standard.
  Only opaque batches cast realtime shadows. Beauty uses front-entry surfaces only;
  shadow casters use back-exit surfaces. Same-material internal faces are suppressed;
  a face against a different transparent neighbor remains exposed, matching the mesher.
- Select, Sculpt, and Paint use active-layer sprites with the existing neutral ghost
  context. Volume, Layer, Eyedropper, and Render mode use the full visible composition.
  Picking and tool behavior are unchanged.
- Ambient occlusion and Shadows reuse the existing independent UI switches.
  The sky/backdrop and optional Miniature photography finishing effect still work.
  Ambient remains stylized when PBR is off; PBR uses Standard environment lighting.
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

In PBR mode the six bits indicate mesher-suppressed faces, in both beauty and shadows.
The plugin chooses `PreviewFrame.materials` only during `prepare`, copies changed
material values/bindings into owned clones, and never disposes borrowed textures.
The host signals material edits with `needsUpdate`, including environment changes;
borrowed texture image/UV-transform updates remain live. Unchanged frames retain both materials and voxel buffers. Scalar/map changes update
materials without repacking; opaque/alpha/transmission classification changes and
PBR toggles repack the current scope, including neighbor masks across chunk seams.

The physical `onBeforeCompile` patch keeps Three's BRDF and normal mapping, replacing
its geometry inputs with the hit normal, view/world position and chunk-local planar
face UVs. Fragment inputs are mutable globals, not writes to varyings. Directional
shadow coordinates use the hit position and Standard's normal bias.

Integration requires `ViewSettings.pbrMaterials` (default `true`) and borrowed
`PreviewFrame.materials?: readonly THREE.MeshPhysicalMaterial[]`, populated by the
host each prepare with current map/environment bindings. The raster pipeline must
call the material callback **after** its patch and place `// voxel-fragment-depth`
immediately after `gl_FragDepth = gl_FragCoord.z;`. The plugin replaces that entire
assignment/marker pair (whitespace tolerated), before any peel rejection. Unlayered
shaders initialize hits at the start of `main`. Missing layered markers fail loudly.
The versioned shader cache key includes this marker contract. Layer bounds must count
`InstancedBufferGeometry.instanceCount`, not just the two billboard triangles.

Physical mesh materials are hidden while the plugin is active, but the helper tree
is retained, including neutral ghost context and mesh-based face grids/topology overlays.

Saves without `pbrMaterials` migrate using their saved renderer: Cube sprites uses
legacy `cubeSpritesPbr`, or `false` if absent; Standard/missing renderer uses `true`
regardless of the unused legacy flag. Canonical values win, but legacy values are
still boolean-validated. Old `settings.update` commands accept `cubeSpritesPbr` as an
alias; conflicting canonical/alias values are rejected. Resaves contain only `pbrMaterials`.

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
No scene streaming or transformed scene instances. PBR is raster-only, not path
tracing. Geometry displacement is not reconstructed; surfaces remain unit cubes.
Transmission retains Standard's screen-space approximation, not ray-traced refraction,
caustics or colored transmitted shadows. Neutral editing ghosts and guide overlays
retain the existing helper meshes; no authored material falls back to mesh rendering.

Run `bun test plugins/cube-sprites`. For GPU checks, start the existing browser harness
with `bunx vite --config tests/vite.config.ts`, open `/tests/transparency.html`, then:

```js
const checks = await import('/plugins/cube-sprites/browser-checks.ts')
checks.runCubeSpriteDepthChecks()
checks.runCubeSpritePbrChecks()
await checks.runCubeSpriteChecks()
await checks.runCubeSpriteEditingChecks(false)
await checks.runCubeSpriteEditingChecks(true)
await checks.runCubeSpriteBenchmark()
```

Depth checks compare against real cubes across nine orientations and verify
subpixel rasterization differences against exact ray/geometry intersections.
PBR GPU checks compare real meshed cubes in 28 cases across four orientations, chunk seams,
physical/map/environment/shadow/alpha/transmission cases, exact layer counts and
toggle restoration. Maps include normal, roughness, metalness, transmission and
thickness with nonidentity UV transforms. They reject shader errors and compare
readback pixels (a small whole-image tolerance allows subpixel rasterization edges).
A twelve-layer alpha column in two palette batches catches billboard-only layer bounds.
Integration checks cover palette updates, dirty edits, bake reuse, AO/shadows,
capture, offscreen views, renderer switching, and context recovery. Editing checks
cover automatic live frames, scoped picking, layer/tool changes, helper overlays,
inspection restoration, and document replacement. The benchmark
compares sparse, solid, and checkerboard models with PBR materials and AO/shadows off, separately for
stationary frames and orbit. It is a diagnostic, not a hardware-independent FPS
promise: greedy meshes can be cheaper for flat solids, and impostors can be limited
by fragment cost and overdraw.

Remove this entire directory to uninstall, including its tests. The application
still builds and uses Standard rendering. Saved `cube-sprites` choices remain
readable and are retained with an explicit unavailable-plugin notice.
The shared PBR materials checkbox remains available for Standard after removal. Restart a
running development server after installing/removing the directory if its glob
discovery cache is stale. Rebuilding production always rediscovers installed files.
