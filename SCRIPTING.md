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

`ifRevision` is optional. When supplied, the command fails with `revision_conflict` if UI or script activity changed the application first. UI changes are published as `state.changed` events so a connected agent can refresh its assumptions.

## Inspection

Use `state.get` for document, layer, palette, tool, selection, camera, mesh, and save summaries.

Use `composition.get` for exact voxel data. Results are ordered by layer and then Z/Y/X, scan at most one million cells per response, and return `nextCursor` until complete.

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
view.capture                 io.vox.import                io.vox.export
save.flush
```

The runtime validator in `src/protocol.ts` is the authoritative argument schema. Destructive resize, layer deletion, project replacement, and VOX replacement require their corresponding explicit approval flag.
