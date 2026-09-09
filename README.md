# Voxel Studio

A model-first voxel editor and renderer. Scene composition is an optional,
lazy-loaded plugin available from **Project menu > Plugins > Scene editor** in
the normal app, not a separate deployment or the startup workspace.

## Development

Use Bun and a Node version supported by Vite 8 (20.19+ or 22.12+).

```sh
bun install --frozen-lockfile
bun run dev
```

The development launcher starts Vite and the same-origin model/scene library API.
It runs Vite on Node because Bun's Vite runtime hangs during connected config
restarts. Keep the lockfile and `patches/`: the rendering dependencies require
those patches.

```sh
bun test
bun run typecheck
bun run build
bun run preview
# Serve the built app and library without Vite:
bun run start
```

Library data defaults to `data/models.sqlite`. Use `VOXEL_DATA_DIR` outside the
workspace for disposable browser checks. Do not test destructive flows against
your working library or recovery profile. See [MODEL-LIBRARY.md](MODEL-LIBRARY.md)
for backup, security, and deployment details.

## Code Map

| Location | Responsibility |
| --- | --- |
| `src/main.ts` | Mount the application and handle hot-reload teardown |
| `src/app/application.ts` | Model-first shell, active-editor command routing, integrations |
| `plugins/scene/` | On-demand scene integration, cross-editor transitions, child sessions, save ownership |
| `src/editors/model/` | Model UI, `Studio` commands/history, voxel interactions, model recovery |
| `src/editors/scene/` | Scene UI, instances/history, asset streaming, scene recovery and exchange |
| `src/shared/voxel/` | Voxel documents, meshing, project snapshots, projections, VOX codecs |
| `src/shared/rendering/` | Viewport, cameras, lighting, raster/PBR, settings, capture |
| `src/shared/library/` | Library DTOs and model-library HTTP client used by both editors |
| `src/shared/ui/` | Scoped visual primitives, icons, DOM helpers |
| `scripts/` | Bun server, server-only HTTP helpers, launchers and benchmarks |
| `plugins/assistant/` | Optional assistant, gated by application integration |
| `tests/` | Browser rendering, library, and assistant fixtures |

Unit tests live beside their owners. Cross-editor regression tests live in
`src/app/scene-model-bridge.test.ts`.

## Dependency Rules

```text
application -> model editor -> shared code
application --on demand--> scene plugin -> scene editor -> shared code
                                      -> model editor (session handoff)
```

Neither editor imports the other or the application. Shared code imports neither
editor, application, nor server implementation. `src/architecture.test.ts` enforces
these rules for runtime imports, type imports, workers, and CSS imports.
The app and model core must not statically import scene runtime code or styles.

Put code in `shared/` only when it has a real cross-feature consumer. In particular,
voxel documents and project snapshots are shared data; `Studio` is the model
editor's controller, not an application-wide store. Scene asset validation does
not depend on the model command protocol. The server consumes data/validation
modules, never browser storage or editor UI.

## Editor Lifecycles

`mountModelEditor(root, options?)` in `src/editors/model/editor.ts` mounts a complete
standalone model editor into a sized element. Without an application host it owns
its command queue, recovery, notifications, and viewport. Application-specific
menu actions and save ownership are supplied as callbacks.

`ScenePlugin` in `plugins/scene/client.ts` loads only when explicitly opened. It
mounts scene controls and restores scene/child recovery, or starts an empty scene
if none exists. Refresh always opens the standalone model editor without reading
scene recovery. Leaving the plugin retains that recovery for the next explicit
opening. The scene menu can create a scene from the preserved standalone model.

`SceneEditor(root, options)` in `src/editors/scene/editor.ts` mounts scene controls
against a shared `Viewport`. The host supplies a sized viewport element, settings,
and notifications. Model editing and returning to another editor are optional host
callbacks; scene construction does not create a model document or model worker.

The combined app uses one WebGL viewport. Deactivate the current renderer before
activating the other. Model-specific tools/meshes remain in `VoxelRenderer`; scene
streaming/instances remain in `SceneRenderer`. Each adapter owns its resources,
while the viewport owns the canvas, camera, lights, and rendering pipelines.

Editor and application `dispose()` methods are asynchronous. Await disposal before
replacing a mount: it drains accepted commands and saves pending edits before
removing listeners, workers, and UI. A failed save rejects teardown and leaves
the editor available for retry/export. Finish active transitions before disposal.
Dispose scene/model adapters before disposing a separately owned viewport.

## Save Ownership

The visible editor and the persistence owner are different concepts. A child model
uses the model editor UI, but its changes belong to the scene.

- Standalone model edits use the existing standalone recovery slot.
- The scene plugin retains the standalone model session while composing a scene.
- Opening a scene asset hydrates a model session; dirty chunks update the owning
  asset, affecting all its instances without modifying the source library model.
- The last visited child retains model undo history. Scene history remains separate.
- Returning to the standalone model restores its session, camera, and texture maps.
- Texture images and histories are runtime-only, not portable snapshot content.

Do not merge recovery, explicit library publication, and file export into one
generic save path. Their guarantees and conflict handling differ. Existing storage
keys, snapshot schemas, library endpoints, and VOX coordinate conventions remain
unchanged.

## Further Reading

- [PRODUCT.md](PRODUCT.md): product scope and behavior.
- [DESIGN.md](DESIGN.md): visual and interaction conventions.
- [MODEL-LIBRARY.md](MODEL-LIBRARY.md): libraries, recovery, and `.vscene` files.
- [RENDERING.md](RENDERING.md): resource budgets, dependency patches, browser checks.
- [SCRIPTING.md](SCRIPTING.md): external command protocol.
- [Assistant guide](plugins/assistant/README.md): optional integration and checks.

A future app split can replace `src/app/` with separate bootstraps and an explicit
asset handoff. No editor framework, cross-app transport, or duplicate build setup
is needed until that split is actually required.
