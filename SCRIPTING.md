# Voxel Studio Scripting

Voxel Studio accepts ordered JSON commands through a local WebSocket relay. The normal application URL does not enable remote control.

## Start

Run the app and relay in separate terminals:

```sh
bun run dev
bun run relay
```

The relay prints two URLs:

- Open the **Browser launch URL** to attach Voxel Studio.
- Connect the scripter to the **Agent WebSocket URL**.

The relay binds to `127.0.0.1`, generates a 256-bit capability token, and accepts one app plus one agent. The browser removes the tokenized relay URL from its address bar and retains it only for the tab session.

Use `bun run relay -- --port 43110 --app http://127.0.0.1:5173/` to change the relay port or app URL.

## Protocol

Send one JSON request per WebSocket message:

```json
{
  "protocol": "voxel-studio/1",
  "id": "add-base",
  "ifRevision": 4,
  "command": {
    "type": "edit.fill",
    "min": { "x": 4, "y": 0, "z": 4 },
    "max": { "x": 11, "y": 1, "z": 11 },
    "shape": "box",
    "color": 5
  }
}
```

Responses retain request order:

```json
{
  "protocol": "voxel-studio/1",
  "id": "add-base",
  "sequence": 1,
  "revision": 5,
  "ok": true,
  "result": { "changed": true, "changedChunks": 1 }
}
```

`ifRevision` is optional. When supplied, the command fails with `revision_conflict` if a project mutation occurred first: document/voxel edits, undo/redo, layer changes, palette/material edits (including texture maps), or saved scene settings. Camera movement and framing, selection, tools, clipboard previews, and render-mode toggles do not advance this revision.

UI changes still publish `state.changed` events with their own increasing `sequence`, even when the mutation `revision` stays the same. Scripted edits should specify cells, color, and layer explicitly: transient editing scope is intentionally not covered by the conflict guard.

## Inspection

Use `state.get` for document, layer, palette, tool, selection, camera, mesh, and save summaries.

Prefer `view.inspect` for visual understanding and verification. It returns named PNGs without changing camera state, selection, settings, or the document revision. No framing is needed.

```json
{"protocol":"voxel-studio/1","id":"views","command":{"type":"view.inspect","views":["front","top","iso-front-right"]}}
```

The optional `views` array accepts 1 to 10 unique names: `front`, `back`, `left`, `right`, `top`, `bottom`, `iso-front-right`, `iso-front-left`, `iso-back-right`, `iso-back-left`. Images retain requested order. Omit `views` for the default seven: the six faces in that order plus `iso-front-right`. Empty arrays, duplicates, and unknown names are rejected.

The result is `{ revision, images: [{ name, width, height, mime: "image/png", dataBase64, direction, pixelAxes? }] }`. Both the response revision and result revision identify the revision captured before inspection begins, not a later revision after PNG encoding. Inspection does not mutate the document (`changed: false` in the application/assistant result).

### Face Images

Faces are exact, unlit, one-pixel-per-voxel projections of the composited visible layers over the **full document extents**, not cropped occupied bounds. Each ray uses the nearest solid voxel's palette RGB with opaque alpha, regardless of material opacity or transmission. Empty rays are transparent. They show surface occupancy/colors, not depth, interiors, or physically rendered glass.

With document dimensions `X,Y,Z`, pixel `u` increases right and `v` increases down from the image's top-left. Directions name the side viewed **from**, looking inward:

| Name | Viewed From | Width x Height | Pixel Mapping |
| --- | --- | --- | --- |
| `front` | +Z (max z) | X x Y | `u=x, v=Y-1-y` |
| `back` | -Z (min z) | X x Y | `u=X-1-x, v=Y-1-y` |
| `left` | -X (min x) | Z x Y | `u=z, v=Y-1-y` |
| `right` | +X (max x) | Z x Y | `u=Z-1-z, v=Y-1-y` |
| `top` | +Y (max y) | X x Z | `u=x, v=z` |
| `bottom` | -Y (min y) | X x Z | `u=x, v=Z-1-z` |

### Isometric Images

Isometric images are 512 x 512 orthographic raster renders with scene lighting and materials, not exact voxel-color maps or progressive path-traced renders. All look down from +Y: front-right uses +X/+Z, front-left -X/+Z, back-right +X/-Z, back-left -X/-Z. Inspection images exclude editing overlays and leave the interactive camera untouched. Face images include `pixelAxes`; isometric images use `direction` without a per-pixel voxel mapping.

Each isometric image fits the entire visible model independently of selection, with a small margin and the configured background. The ground plane is excluded. Offscreen rendering leaves the live viewport and progressive samples untouched.

Use targeted `composition.get` bounds/layers for exact depth, interior, or layer questions that these images cannot answer, rather than dumping the whole model for visual understanding. Results are ordered by layer and then Z/Y/X, scan at most one million cells per response, and return `nextCursor` until complete.

```json
{
  "protocol": "voxel-studio/1",
  "id": "inspect",
  "command": {
    "type": "composition.get",
    "visibility": "composited",
    "bounds": {
      "min": { "x": 0, "y": 0, "z": 0 },
      "max": { "x": 31, "y": 31, "z": 31 }
    },
    "limit": 4096
  }
}
```

Use `view.capture` for a PNG of the current camera after voxel meshing settles. The response contains base64 PNG data and the camera metadata used for the image.

Use `project.snapshot.get` and `project.snapshot.replace` for lossless layers, materials, palette, settings, and chunk data. VOX and texture-map commands also exchange binary data as base64.

## Commands

The current command names are:

```text
document.new                 document.rename              document.resize
edit.paint                   edit.erase                   edit.setVoxels
edit.fill                    edit.move                    edit.pushPull
history.undo                 history.redo
selection.set                selection.resolve            selection.clear
clipboard.copy               clipboard.cut                clipboard.paste.begin
clipboard.paste.place        clipboard.paste.cancel
layer.create                 layer.activate               layer.rename
layer.visibility             layer.lock                   layer.delete
palette.activate             palette.duplicate            palette.setColor
material.update              material.map.set             material.map.clear
tool.set                     tool.selectionMode           tool.paintMode
tool.sculptMode              tool.auxiliary               tool.fill
settings.update              renderMode.set
state.get                    composition.get
project.snapshot.get         project.snapshot.replace
view.get                     view.set                     view.frame
view.capture                 view.inspect
io.vox.import                io.vox.export
save.flush
```

The runtime validator in `src/editors/model/protocol.ts` is the authoritative argument schema. Destructive resize, layer deletion, project replacement, and VOX replacement require their corresponding explicit approval flag.

`settings.update` and `scene.settings` accept `skybox`: `solid` (default),
`daylight`, `overcast`, `sunset`, or `night`. Older project snapshots, local recovery,
scene manifests, and child-model settings default a missing `skybox` to `solid`.
Changing the preset preserves `background`, lighting, camera, and tilt-shift values.
With a sky active, `background` is the ground color; Ambient scales sky lighting
and reflections, Key light controls the sun or moon, and Light angle rotates both.

`settings.update` accepts the saved miniature-photography fields `tiltShift`
(boolean, default `false`), `tiltShiftStrength` (default `0.5`), `tiltShiftFocus`
(default `0.5`), and `tiltShiftWidth` (default `0.3`). The three numbers must be
finite fractions in `[0, 1]`; UI sliders use `0.01` steps and display percentages.
Focus `0` is the image top and `1` the bottom; width is the sharp band's fraction
of image height. The effect is visible only in Render mode, including its PNG
captures. Updating these fields does not change render mode or camera. Older
project snapshots and local recovery default missing fields; scene manifests use
the same defaults and accept these fields through `scene.settings`.

`edit.pushPull` reshapes the entire supplied selection along `normal`. Each
contiguous selected run extends or retracts from its own front by the same
clamped distance, preserving stepped face offsets. Pulls preserve selected source
colors and overwrite unselected destinations on the edited layer; where sweeps
overlap, the farther front wins. The resulting fronts become the new selection.
