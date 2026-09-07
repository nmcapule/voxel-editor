# Rendering Maintenance

Implemented against `b533f88`, retaining the assistant, revision-conflict, face-projection,
and offscreen isometric-inspection changes. No dependency versions were upgraded.

## Audit Resolution

| Finding | Resolution | Regression coverage |
| --- | --- | --- |
| Eager maximum-range Push/Pull allocation | Allocate the displayed preview, grow on demand, update only live matrix ranges | `tests/rendering.ts` |
| Zero-normal Move hang | Validate shared operation normals; skip starting-solid backfaces in picking | `src/palette-vox.test.ts`, `src/renderer-state.test.ts` |
| Stale asynchronous trace readiness | Revision checks across import, preparation and publication; gate progress and sampling | `tests/rendering.ts` |
| Transparent interface gaps and L/T junctions | Exact integer surface geometry; GPU BVH ties prefer the front-facing interface | `src/transparency.test.ts`, `src/mesher-layout.test.ts`, `tests/gpu-rays.ts` |
| Alpha behind transmission; disconnected/reversed stacks | Per-pixel far-to-near peeling instead of palette-wide sorting | `src/raster-pipeline.test.ts`, `tests/rendering.ts` |
| Transparent/helper AO contamination | Reconstruct AO from opaque beauty depth; composite transparency and helpers afterward | `tests/rendering.ts` |
| Ambient/shadow settings ineffective in traced output | Supported hemisphere environment with matching orientation; uploaded material shadow flags | `src/renderer-state.test.ts`, `tests/rendering.ts`, `tests/recovery.ts` |
| Orthographic picking versus negative near plane | Pick from the rendered near plane, bounded by the far plane | `src/renderer-state.test.ts` |
| Tall shadow-frustum clipping | Fit caster/ground bounds in light-camera coordinates | `tests/rendering.ts` |
| Rays skipping the ground | Ground clearance exceeds the supported ray-origin offset | `tests/gpu-rays.ts` |
| Poisoned BVH retries; sampling failures | Dispose/recreate tracer and worker; route preparation, compilation and sampling errors to fallback | `src/render-dependencies.test.ts`, `tests/rendering.ts`, `tests/recovery.ts` |
| Growing generated groups and repeated material-index uploads | Version-keyed dependency patches clear groups and compare actual material counts | `src/render-dependencies.test.ts` |
| Instance, ground, GTAO and tracer resource omissions | Explicit ownership cleanup, including low-resolution tracer resources and pending compilation | `src/render-dependencies.test.ts`, `tests/recovery.ts` |
| Context restoration loses environment/idle frame | Regenerate the environment, invalidate shadows and redraw/rebuild automatically | `tests/recovery.ts` |
| Missing geometry AA | Linear-light FXAA with perceptual edge detection, before output conversion | `src/raster-pipeline.ts`, browser inspection |
| UV and face-grid mismatch | Integer-coordinate UVs and coplanar, deduplicated unit-cell grid edges | `src/mesher-layout.test.ts` |
| Misleading FPS | Count completed traced samples only; reset on completion; raster requests coalesce | `src/renderer.ts`, `tests/rendering.ts` |
| Material-count vertex amplification | Contiguous material-local attribute views and rebased indices | `src/renderer-state.test.ts`, `src/mesher-layout.test.ts` |
| Palette RGB baked into every vertex | Material color replaces the redundant color attribute | `src/mesher-layout.test.ts`, `tests/rendering.ts` |
| Unnecessary full trace preparation | Incremental material, light, environment and camera updates | `tests/recovery.ts` |
| Repeated raster/shadow passes | One scheduled raster frame; explicit shadow invalidation; no AO normal scene pass or built-in transmission prepass | `tests/rendering.ts`, `tests/recovery.ts` |
| Unused float blending targets | Allocate/clear blend targets only when alpha/manual blending requires them | `src/render-dependencies.test.ts` |
| AO full/half-resolution resize churn | Single half-resolution size policy; unchanged-size early return | `src/raster-pipeline.test.ts` |
| Oversized/noncancelable mesh batches | One transferable job per message; restart the worker on document replacement | `src/mesher-layout.test.ts`, `tests/rendering.ts` |
| Main-thread padding and bounds work | Resolve chunk/layer references outside voxel loops; emit tight group bounds in worker | `src/palette-vox.test.ts`, `src/mesher-layout.test.ts` |
| Mesher temporary arrays/index copies | Scalar mask traversal, compact quad staging and direct typed-buffer emission | `scripts/mesher-benchmark.ts` |
| Face-grid remeshing on every re-enable | Reuse valid grids; generate missing/stale grids independently | `tests/rendering.ts` |
| Black palette entries overwritten | Explicit occupancy through editing, copies, storage and snapshots, including map-only authoring | `src/palette-vox.test.ts` |
| Discarded Three scene during VOX import | Data-only parser with size, count, coordinate, duplicate and chunk-boundary validation | `src/palette-vox.test.ts` |
| Imported optical properties inferred from RGB | Explicit neutral fallback and lossy material/texture warnings | `src/palette-vox.test.ts` |

Follow-up review also fixed deletion-only queues failing to restart tracing, immediate
captures returning old pixels with new metadata, and disposal racing shader-compilation
polling. These are covered by the renderer-state, dependency and recovery tests.

## Pipeline And Invalidation

The raster path is `opaque color/depth -> half-resolution AO -> transparent layers ->
editor overlays -> FXAA -> ACES/sRGB`. Each transparent layer samples the already
composited linear background, preserving material maps, transmission and roughness.
Source materials and scene visibility are restored before returning, including failures.
Inspection uses its own offscreen pipeline without changing the live camera or canvas.

Geometry/visibility/material-assignment changes request scene preparation after meshing.
Color, scalar material properties and maps use material updates; lighting/background use
their corresponding tracer APIs. All affected updates reset accumulation. Capture flushes
the current raster image when the newest traced state has not yet been presented; it remains
a mesh-idle/current-image capture, not a request to wait for convergence.

Shadow maps are invalidated by caster geometry/classification, light direction, shadow
frustum, enablement and context changes, not by camera motion or editor overlays.
AO, guide grids and editor decorations remain raster-only. Production trace settings
remain four ordinary bounces, the existing transmissive traversal allowance, 128 samples,
2x2 tiles and 0.75 render scale.

`patches/` contains Bun patches for Three 0.185.1, three-gpu-pathtracer 0.0.24 and
three-mesh-bvh 0.9.14. `bun install --frozen-lockfile` reapplies them. Recheck the dependency
regressions before upgrading; do not replace them with private-field mutation in app code.

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

The completed run passed 172 Bun tests, production build/typecheck and the Impeccable
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
await rays.runGpuRayChecks(transparencyTest.renderer.renderer);
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
