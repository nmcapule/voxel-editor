# Rendering Maintenance

The historical model-renderer audit below was implemented against `b533f88`, retaining
the assistant, revision-conflict, face-projection, and offscreen isometric-inspection
changes. No dependency versions were upgraded. Scene sections describe the current source.

## Audit Resolution

| Finding | Resolution | Regression coverage |
| --- | --- | --- |
| Eager maximum-range Push/Pull allocation | Allocate the displayed preview, grow on demand, update only live matrix ranges | `tests/rendering.ts` |
| Zero-normal Move hang | Validate shared operation normals; skip starting-solid backfaces in picking | `src/editors/model/storage-vox.test.ts`, `src/editors/model/renderer.test.ts` |
| Stale asynchronous trace readiness | Revision checks across import, preparation and publication; gate progress and sampling | `tests/rendering.ts` |
| Transparent interface gaps and L/T junctions | Exact integer surface geometry; GPU BVH ties prefer the front-facing interface | `src/shared/rendering/transparency.test.ts`, `src/shared/voxel/mesher.test.ts`, `tests/gpu-rays.ts` |
| Alpha behind transmission; disconnected/reversed stacks | Per-pixel far-to-near peeling instead of palette-wide sorting | `src/shared/rendering/raster-pipeline.test.ts`, `tests/rendering.ts` |
| Transparent/helper AO contamination | Reconstruct AO from opaque beauty depth; composite transparency and helpers afterward | `tests/rendering.ts` |
| Ambient/shadow settings ineffective in traced output | Supported hemisphere environment with matching orientation; uploaded material shadow flags | `src/editors/model/renderer.test.ts`, `tests/rendering.ts`, `tests/recovery.ts` |
| Orthographic picking versus negative near plane | Pick from the rendered near plane, bounded by the far plane | `src/editors/model/renderer.test.ts` |
| Tall shadow-frustum clipping | Fit caster/ground bounds in light-camera coordinates | `tests/rendering.ts` |
| Rays skipping the ground | Ground clearance exceeds the supported ray-origin offset | `tests/gpu-rays.ts` |
| Poisoned BVH retries; sampling failures | Dispose/recreate tracer and worker; route preparation, compilation and sampling errors to fallback | `src/shared/rendering/dependencies.test.ts`, `tests/rendering.ts`, `tests/recovery.ts` |
| Growing generated groups and repeated material-index uploads | Version-keyed dependency patches clear groups and compare actual material counts | `src/shared/rendering/dependencies.test.ts` |
| Instance, ground, GTAO and tracer resource omissions | Explicit ownership cleanup, including low-resolution tracer resources and pending compilation | `src/shared/rendering/dependencies.test.ts`, `tests/recovery.ts` |
| Context restoration loses environment/idle frame | Regenerate the environment, invalidate shadows and redraw/rebuild automatically | `tests/recovery.ts` |
| Missing geometry AA | Linear-light FXAA with perceptual edge detection, before output conversion | `src/shared/rendering/raster-pipeline.ts`, browser inspection |
| UV and face-grid mismatch | Integer-coordinate UVs and coplanar, deduplicated unit-cell grid edges | `src/shared/voxel/mesher.test.ts` |
| Misleading FPS | Count completed traced samples only; reset on completion; raster requests coalesce | `src/shared/rendering/viewport.ts`, `tests/rendering.ts` |
| Material-count vertex amplification | Contiguous material-local attribute views and rebased indices | `src/editors/model/renderer.test.ts`, `src/shared/voxel/mesher.test.ts` |
| Palette RGB baked into every vertex | Material color replaces the redundant color attribute | `src/shared/voxel/mesher.test.ts`, `tests/rendering.ts` |
| Unnecessary full trace preparation | Incremental material, light, environment and camera updates | `tests/recovery.ts` |
| Repeated raster/shadow passes | One scheduled raster frame; explicit shadow invalidation; no AO normal scene pass or built-in transmission prepass | `tests/rendering.ts`, `tests/recovery.ts` |
| Unused float blending targets | Allocate/clear blend targets only when alpha/manual blending requires them | `src/shared/rendering/dependencies.test.ts` |
| AO full/half-resolution resize churn | Single half-resolution size policy; unchanged-size early return | `src/shared/rendering/raster-pipeline.test.ts` |
| Oversized/noncancelable mesh batches | One transferable job per message; restart the worker on document replacement | `src/shared/voxel/mesher.test.ts`, `tests/rendering.ts` |
| Main-thread padding and bounds work | Resolve chunk/layer references outside voxel loops; emit tight group bounds in worker | `src/editors/model/storage-vox.test.ts`, `src/shared/voxel/mesher.test.ts` |
| Mesher temporary arrays/index copies | Scalar mask traversal, compact quad staging and direct typed-buffer emission | `scripts/mesher-benchmark.ts` |
| Face-grid remeshing on every re-enable | Reuse valid grids; generate missing/stale grids independently | `tests/rendering.ts` |
| Black palette entries overwritten | Explicit occupancy through editing, copies, storage and snapshots, including map-only authoring | `src/editors/model/storage-vox.test.ts` |
| Discarded Three scene during VOX import | Data-only parser with size, count, coordinate, duplicate and chunk-boundary validation | `src/editors/model/storage-vox.test.ts` |
| Imported optical properties inferred from RGB | Explicit neutral fallback and lossy material/texture warnings | `src/editors/model/storage-vox.test.ts` |

Follow-up review also fixed deletion-only queues failing to restart tracing, immediate
captures returning old pixels with new metadata, and disposal racing shader-compilation
polling. These are covered by the renderer-state, dependency and recovery tests.

## Pipeline And Invalidation

The raster path is `opaque color/depth -> half-resolution AO -> transparent layers ->
editor overlays -> FXAA -> ACES/sRGB`. Each transparent layer samples the already
composited linear background, preserving material maps, transmission and roughness.
Source materials and scene visibility are restored before returning, including failures.
Inspection uses its own offscreen pipeline without changing the live camera or canvas.

Raster camera gestures, animated focus, model tool drags, and scene marquee/transform
drags temporarily cap drawing-buffer DPR at 1. Normal quality remains
`min(devicePixelRatio, 2)` and returns in a scheduled frame 150 ms after the last
gesture ends. Overlapping gestures hold quality independently; wheel bursts share the
settling delay. Pointer cancellation, lost capture, blur, hidden pages, editor changes,
context loss, and disposal release abandoned interaction state. Hover-only previews
and sidebar controls do not start reduced quality. DPR-1 displays are unchanged.

DPR-only transitions resize pixel buffers, retaining the half-resolution AO policy,
without changing camera projection, notifying scene/picking listeners, invalidating
shadows, or rebuilding meshes/BVHs. Actual viewport resizes still recheck scene budgets
at normal-quality pixel dimensions. Progressive PBR, including preparation and its
existing low-resolution previews, stays at normal DPR. PNG captures hold normal DPR
through preparation and encoding (also for overlapping requests), then restore the
current gesture policy. Capture metadata describes the full-resolution image.

Run `transparencyTest.runInteractionDprChecks()` in `/tests/transparency.html` at DPR 1
and 2 for real WebGL checks of camera gestures, wheel settling, capture dimensions,
unchanged geometry, and matching restored pixels with AO, glass, grids, and shadows.
Pixel reduction is not an FPS claim: measure frame times and transition costs on target
hardware; software-GPU checks only establish rendering correctness.

Skybox presets generate a 256x128 linear equirectangular texture for the background
and traced environment, with a 64-pixel-face PMREM for realtime materials. Ambient
scales sky illumination and reflections; the hemisphere is disabled in sky mode.
Preset sun/moon color, elevation and strength combine with the existing Key light
and Light angle controls. The latter rotates the background, environment and key
together without regenerating textures. Solid color retains the original room and
hemisphere lighting. The viewport owns and replaces both sky resources on preset
changes; model, scene and capture materials only borrow them. Context loss releases
GPU handles before restoration rebuilds PMREM and reuploads the retained CPU sky.
Orthographic raster backgrounds sample the parallel viewing direction, matching
tracing instead of Three's small unit sky cube. Perspective cameras show the panorama.
Both PNG capture qualities include the selected sky; VOX and CPU library thumbnails
remain unchanged. Run `transparencyTest.runSkyboxChecks()` in the browser harness for
preset, material, projection, capture and context-recovery regressions.

Miniature photography is an optional Render-mode finishing effect shared by raster and
PBR, including low-resolution previews and PNG captures. `tilt-shift.ts` copies the
completed canvas on the GPU and applies two nine-tap blur passes outside a horizontal
sharp band. It filters display-referred ACES/sRGB values, not physical depth or HDR
lighting, and does not change the camera. The two RGBA8 surfaces allocate lazily (about
8 bytes per output pixel), resize with the drawing buffer, and release on context loss
and disposal. Disabled/zero-strength and Edit-mode frames skip the copy and passes.
Effect-only changes re-present the accumulated trace paused, including at the 128-sample
cap, rather than resetting samples. Inspection and library thumbnails remain unfiltered.
Run `transparencyTest.runTiltShiftChecks()` in `/tests/transparency.html` for GPU pixel
checks of the focus band, both projections, current PNGs and converged PBR presentation.

In the model editor, geometry/visibility/material-assignment changes request trace
preparation after meshing.
Color, scalar material properties and maps use material updates; lighting/background use
their corresponding tracer APIs. All affected updates reset accumulation. Capture flushes
the current raster image when the newest traced state has not yet been presented; it remains
a mesh-idle/current-image capture, not a request to wait for convergence.

In the model editor, shadow maps are invalidated by caster geometry/classification,
light direction, shadow frustum, enablement and context changes, not by camera motion
or editor overlays. Progressive preparation/compilation previews neither update nor sample
shadow maps; traced samples use ray visibility. Existing raster maps remain cached, with
pending invalidation preserved for Edit mode, raster fallback, full-scene raster capture
and offscreen inspection.
AO, guide grids and editor decorations remain raster-only. Production trace settings
remain four ordinary bounces, the existing transmissive traversal allowance, 128 samples,
2x2 tiles and 0.75 model render scale; scene scaling also follows the viewport ceiling below.

`patches/` contains Bun patches for Three 0.185.1, three-gpu-pathtracer 0.0.24 and
three-mesh-bvh 0.9.14. `bun install --frozen-lockfile` reapplies them. Recheck the dependency
regressions before upgrading; do not replace them with private-field mutation in app code.

## Layer Isolation

Tool-driven ghost context is a cached surface, not a palette-opacity change. Each
stored model chunk retains its normal composition and at most one active/context
variant. Content versions advance on edits, visibility changes and material topology
changes, not tool switches. Missing normal and isolation surfaces can be meshed and
installed independently without replacing the chunk parent or unrelated geometry.
Empty results are cached too. Worker replies validate content and scope independently;
a superseded isolation result cannot discard valid normal work or overwrite the current
isolation/grid. Chunk transforms are propagated explicitly to newly attached static meshes.

Chunks without active-layer data in their own or six face-neighbor chunks share a
context-only cache key. Switching distant active layers therefore remeshes only their
affected neighborhoods. The first isolation still builds context across the model;
switching between layers covering the entire model still rebuilds isolation everywhere.
The single-variant cache deliberately does not retain geometry for every visited layer.

Tool/submode/eyedropper state is applied together, with worker submission deferred until
the command's synchronous scope and content effects finish. Visibility dirtiness is
limited to the changed layer's chunks and face neighbors. Layer metadata changes reuse
UI voxel counts, and activation without a selection no longer recenters a panned camera.
Scene-owned visibility saves persist metadata without recopying unchanged raw chunks;
standalone autosave still snapshots raw data after its existing debounce.

Run `bun scripts/isolation-benchmark.ts` for real-worker CPU measurements. The default
uses 16 chunks, three layers, three warmups and nine measured sequences. Baseline
`b80f566` dense-fixture exit/reentry medians were 7.15/45.57 ms; cached exit/reentry
are below 0.1 ms on the same EPYC/Bun host. These exclude GPU uploads and rendering.
Work counts are more portable than timings:

| Dense 16-chunk transition | Normal mesh passes, before/after | Active + context passes, before/after | Geometry allocations, before/after |
| --- | ---: | ---: | ---: |
| First isolation | 16 / 0 | 32 / 32 | 112 / 48 |
| Exit | 16 / 0 | 0 / 0 | 64 / 0 |
| Unchanged reentry | 16 / 0 | 32 / 0 | 112 / 0 |
| Active A to B | 16 / 0 | 32 / 32 | 112 / 48 |

`bun scripts/isolation-benchmark.ts 5 16` expands to 64 chunks. Localized A/B switches
rebuild eight chunks at both sizes; the unrelated context and all normal meshes survive.
`renderer-isolation.test.ts` covers reuse, localized seams, edits/undo, empty surfaces,
material topology, stale meshes/grids, inspection, replacement and disposal.

In the dedicated browser harness, run:

```js
await (await import('/tests/isolation.ts')).runIsolationChecks(
  transparencyTest.renderer, transparencyTest.settings,
);
```

This checks automatic RAF presentation before capture, identical cold/warm pixels,
zero warm worker messages, and stable CPU/GPU geometry identities/counts. Its software
GPU timings are not native-device performance guarantees.

## Scene Resources

Scenes compose models sized 16-256 voxels per axis rather than enlarging
`VoxelDocument`. Extents are at most 16,384 per axis, with 10,000 instances; pivot
positions lie within centered X/Z extents and Y from zero to the extent.
Transformed geometry can extend beyond
those pivot limits. `WorldIndex` is a fixed sparse grid of **256-unit world cells**,
not an octree. An instance spanning more than 512 cells goes into an oversized
fallback set that each query checks against its bounds.

Adaptive rendering uses chunk-local greedy meshes, shared geometry and instanced
batches. LOD **1/4/8** denotes voxel step size: LOD 1 reads full 16-cubed chunks;
LOD 4 uses each descriptor's 4-cubed occupied-majority preview; LOD 8 downsamples
that preview. Screen-size hysteresis avoids oscillation, and selection requests
LOD 1 without bypassing resource limits. Coarse surfaces remain while detail loads.

| Resource | Current bound and accounting |
| --- | --- |
| Raw chunk cache | 64 MiB (`SCENE_CPU_BUDGET`); immutable hashes, deduplicated in-flight reads, evictable cache; callers own separate byte copies |
| Scene geometry | 128 MiB (`SCENE_GEOMETRY_BUDGET`), counting retained CPU and GPU surface/matrix copies, pending-worker allowance, and full-detail staging reservations |
| Scene metadata | 128 MiB conservative estimate (`METADATA_BYTES`), at most 262,144 chunk references and 10,000 each of instances, assets, and layers; these limits apply together |
| Hydrated child editor | 72 MiB of owned layer-chunk bytes (`MAX_BINARY_BYTES`), checked before loading; not a total editor-memory limit |
| Scene undo/redo | 8 MiB estimated delta history (`HISTORY_BYTES`); old entries, or an oversized entry itself, may be evicted; child voxel edits are not scene undo entries |
| Model undo | Existing 64 MiB chunk-history target (`HISTORY_LIMIT`), separate from hydration and scene history; the newest edit is retained even if oversized |
| Streaming work | One mesh worker/job at a time, at most 64 queued demands, 8 MiB frame upload allowance; adaptive grouping stops at 16,384 groups and reports omitted contributors |

Constants live in `src/editors/scene/types.ts`, `src/editors/scene/document.ts`, `src/editors/scene/storage.ts`,
`src/editors/scene/renderer.ts`, `src/editors/model/protocol.ts`, and `src/shared/voxel/document.ts`. These are resource
budgets, not a combined browser-memory cap or voxel-performance claim. Retained
standalone/child editing state and session texture payloads are additional. In particular,
`src/editors/scene/document.test.ts` covers 100M-plus repeated and unique-source voxel metadata without
fetching/scanning voxel arrays; it does not demonstrate rendering all those voxels.
The viewport's represented count describes source voxels for drawn instance/chunks,
not unique occupied world cells or the number of full-detail cells resident in RAM.

## Scene Dependencies

`sceneChunkFingerprint` in `src/editors/scene/mesher.ts` keys a mesh by its chunk and six
face neighbors, ordered visible model-layer ownership, immutable blob descriptors,
and transparency classes of materials used in that neighborhood. Editing a chunk
invalidates only dependent surfaces; RGB/scalar PBR changes reuse meshes unless
their opacity/transmission classification changes. TRS updates reuse asset surfaces;
reverse asset/instance references localize world-index updates. Worker generations
and dependency keys reject stale results. Child saves hash dirty chunk bytes (all
chunks on replacement/resize). Record-delta persistence and compare-and-swap are
described in [MODEL-LIBRARY.md](MODEL-LIBRARY.md#scene-recovery).

Committed scene content, material, lighting, or visibility changes invalidate prepared
full-scene content. Streaming and selection alone do not rebuild the tracer; camera
changes restart accumulation, and viewport pixel-area changes recheck preparation.
Scene mode suspends model mesh work; child editing releases dormant scene surfaces.

## Scene Quality Ceilings

Progressive PBR in Render mode prepares **every visible scene layer at LOD 1**,
including offscreen shadow/reflection contributors. The adapter expands instances
into ordinary world-space meshes grouped by material before BVH preparation; it
never hands adaptive instancing to the tracer as a supposedly complete scene.
Both tracing and full-scene capture require at most **1,000,000 expanded triangles**
(including two stage triangles) and a **96 MiB conservative estimated peak**.
`sceneDetailBudget` and `expandSceneDetail` in `src/editors/scene/renderer.ts` are authoritative:

```text
peakBytes = sourceBytes + 16 MiB + triangles * 2048
          + materialEntries * 8192 + min(viewportPixels, 1_000_000) * 48
```

The estimate covers retained source buffers, expanded/baked/merged arrays, BVH worker
copies and GPU tables, material tables, and new viewport-dependent trace targets.
`viewportPixels` is drawing-buffer width times height, not CSS pixel area.
The material-entry guard is 65,534, with the stage included in preflight. The memory
ceiling rejects far below the triangle ceiling; 1M is not an admitted workload
promise. Staging must also fit the 128 MiB geometry budget alongside live adaptive
resources. Existing host raster targets and the raw cache are separate, so 96 MiB
is not total page/GPU memory. `Viewport.prepareSceneContent` rechecks the adapter.

`Viewport.ensurePathTracer` uses four bounces, 2x2 tiles, and scene render scale
`0.75 * min(1, sqrt(1_000_000 / viewportPixels))`; sampling stops at 128 completed
samples. Budget, dependency, or tracing failures report realtime **Raster fallback**.
Adaptive raster may reduce detail under pressure. Its shadow working set uses a
receiver-scoped light-space volume, including the visible ground and relevant
offscreen casters without making every scene instance resident. The query extends
through scene depth rather than imposing an arbitrary shadow-distance cutoff.
Streaming, budget failures, or omitted contributors are reported rather than
claiming exact shadows/reflections.

- **Viewport detail** is the default Capture quality. It waits for drawable current
  scene dependencies, then captures the current image: a current progressive sample
  when available, otherwise adaptive raster. It does not wait for convergence.
- **Full-scene detail** requests `capture(true)`: full LOD-1 raster geometry for all
  visible layers, even if PBR is enabled. Missing/oversized dependencies or a changed
  scene/camera reject rather than silently returning a partial or lower-detail PNG.
  Scene editing overlays are excluded; the live viewport is restored afterward.

Labels come from `src/editors/scene/ui.ts`; capture behavior is in
`src/shared/rendering/viewport.ts`.
`src/editors/scene/renderer.test.ts` covers localized invalidation, bounded preparation, ordinary
trace meshes, fallback, stale results, and exact-capture rejection/restoration.

## Measurements

Surface payload includes positions, normals, UVs and indices (previously also colors).
Quad counts for these fixtures are unchanged.

| 16-cubed chunk | Previous bytes | Current bytes | Current surface median |
| --- | ---: | ---: | ---: |
| Filled | 1,224 | 840 | 0.121 ms |
| Isolated checkerboard | 2,506,752 | 1,720,320 | 1.867 ms |
| Four transparent materials | 5,308,416 | 3,735,552 | 3.024 ms |

Current timings are local Bun 1.3.14 CPU medians, 10 warmups and 25 measured runs,
excluding padding, transport, upload and BVH generation. They are not GPU frame-time claims.

- A five-material, 120-vertex fixture now produces 120 traced vertices, rather than 600.
- Color-only changes and color/normal-map changes produce zero mesh/grid jobs. Map and
  shadow-setting updates also produce zero BVH builds.
- Twenty synchronous raster requests produce one pipeline frame.
- Camera and hover changes produce zero shadow-map draws after initial generation.
- A 256-cell floor with 255 layers of available extrusion starts with 16 KiB of instance
  matrices, rather than allocating its maximum operation. Full 256x256-floor arithmetic
  is 4 MiB initially rather than approximately 1 GiB.
- Conditional blend targets avoid approximately 142 MiB of unused RGBA32F color storage
  at a 1920x1080 CSS viewport, DPR 2 and 0.75 trace scale on native-float-blending devices.

## Verification

```sh
bun test
bun run build
bun scripts/mesher-benchmark.ts
bunx vite --config tests/vite.config.ts --port 5188
```

The historical audit run passed 172 Bun tests, production build/typecheck and the Impeccable
detector on changed rendering/UI files. Browser checks used Chromium WebGL2 via ANGLE
SwiftShader, not a discrete GPU. Desktop 1280x577 and mobile 393x852 app checks loaded,
edited/rendered a model and showed no horizontal overflow.

Open `/tests/transparency.html` in a dedicated test browser and run these sequentially:

```js
await transparencyTest.runRasterChecks();
await transparencyTest.runInspectionChecks();
await transparencyTest.runRendererStateChecks();
await transparencyTest.runRenderingChecks();
await transparencyTest.runPathTracingChecks(8);
const rays = await import('/tests/gpu-rays.ts');
await rays.runGpuRayChecks(transparencyTest.renderer.viewport.renderer);
const recovery = await import('/tests/recovery.ts');
const result = await recovery.runRecoveryChecks(
  transparencyTest.renderer, transparencyTest.settings,
);
if (!result.ok) throw new Error(JSON.stringify(result));
```

All suites passed, including 270 actual GPU ray checks. Recovery checks compare idle
pixels without forcing a capture redraw, interrupt BVH/compilation, and compare exactly
eight fixed-seed traced samples for shadow/map edits. The shadow-toggle fixture changed
umbra brightness from 18.80 to 173.84 while the lit-control mean difference was 0.14;
on/off/on reproduced the original image exactly. Both AO isolation checks had zero
buffer difference. Shader compilation on SwiftShader can take tens of seconds; when
automating, start the async suite and poll its result instead of holding a short CDP call.

## Remaining Platform Limits

Exact depth peeling costs extra passes and a small synchronous occupancy readback per
layer. It does not impose a fixed layer-count quality cap or silently drop layers. A
five-second frame watchdog reports failure without publishing partial output for
pathological depth complexity. Profile this cost on target hardware before claiming a
universal raster speedup. Refraction remains Three's screen-space approximation; the
path tracer remains the physically sampled alternative. Coincident same-facing geometry
outside the voxel model's nonoverlapping ownership rules is not uniquely ordered.

VOX has no unused-palette-slot marker. Imported standard palettes conservatively reserve
all 255 entries; existing stored projects recover referenced black, but cannot infer
historically unused black whose occupancy was never saved. VOX material/texture loss is
reported explicitly, and the existing single-model coordinate convention is preserved.
