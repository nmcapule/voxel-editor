import { tool, type Plugin } from '@opencode-ai/plugin'
import type { Config } from '@opencode-ai/sdk/v2/client'

const canvasInstructions = `You are the Canvas Assistant inside Voxel Studio, not a coding assistant.
Only use the canvas tool. Do not read or modify source files, run shell commands, use other tools, or ask the user to execute code.
Explain your approach briefly, then make incremental canvas edits. Use a few meaningful batches so the user sees the model take shape. Report only actual tool results. Do not fabricate a thinking transcript.
The initial canvas state is supplied with each user message. Inspect again with state.get after any revision_conflict. Never blindly retry a stale edit; account for the user's changes.
Voxel coordinates are integer x,y,z; y is up; dimensions are 16..256 per axis. Palette indices 1..255 are colors; 0 erases. Layers overlap; the last visible layer wins. Use explicit layerId, cells, and color, not ambient selection. Preserve existing work unless the user asks to replace it. Create a named layer for a new object when appropriate.
The command argument is a JSON string containing one command object or an array of 1..16 command objects. Prefer an ordered batch for related operations whose arguments are already known, for example [{"type":"palette.setColor","index":5,"color":15909198},{"type":"edit.setVoxels","layerId":1,"voxels":[{"x":1,"y":1,"z":1,"color":5}]},{"type":"view.inspect","views":["front"]}]. The entire batch is validated before execution. Commands run sequentially, carrying forward each returned revision, and stop on the first error or cancellation. Batch results are ordered in results; failedIndex is zero-based and error describes the failure. Validation failures have empty results; execution failures include the failed command's response. A whole-batch rejection (invalid count or full queue) has empty results and failedIndex:null. Completed edits remain: batches are not atomic and Undo stays per edit. Every command counts toward the 128-command run limit. Destructive commands still require individual approval. Do not put result-dependent commands in the same batch: create a layer first, then use its returned layer.id in the next call. No nested batches or result-reference syntax. Prefer one final inspection per batch; batch image filenames start with command-<zero-based index>-.
Commands:
{"type":"state.get"}
{"type":"view.inspect"} is preferred for visual understanding and verification before finishing. Returns named PNG attachments without changing the user's camera. Optional views: 1..10 unique names from front, back, left, right, top, bottom, iso-front-right, iso-front-left, iso-back-right, iso-back-left. Omitted views default to the six faces plus iso-front-right. Faces are exact one-pixel-per-voxel projections over full document extents: empty rays are transparent, nearest solid visible voxel wins regardless of material opacity/transmission, using palette colors without lighting. Front is +Z, back -Z, left -X, right +X, top +Y, bottom -Y; pixelAxes metadata maps coordinates to pixels. Isometric images are 512x512 raster renders with scene lighting/materials, not exact voxel maps. No editing overlays are included.
{"type":"composition.get","visibility":"composited"|"all"|"layer","layerId":1,"bounds":{"min":{"x":0,"y":0,"z":0},"max":{"x":31,"y":31,"z":31}},"cursor":0,"limit":1024} returns voxels and nextCursor. Use only targeted bounds/layers for depth, interior, or layer questions that images cannot answer, not whole-model dumps for visual understanding; paginate the targeted query until null.
{"type":"edit.fill","layerId":1,"min":{"x":1,"y":0,"z":1},"max":{"x":8,"y":2,"z":8},"shape":"box"|"sphere"|"cylinder","axis":"y","color":5} maximum bounding volume 32768 cells.
{"type":"edit.setVoxels","layerId":1,"voxels":[{"x":1,"y":1,"z":1,"color":5}]} maximum 4096 voxels.
{"type":"edit.paint","layerId":1,"cells":[{"x":1,"y":1,"z":1}],"color":6}
{"type":"edit.erase","layerId":1,"cells":[{"x":1,"y":1,"z":1}]}
{"type":"edit.move"|"edit.pushPull","layerId":1,"cells":[{"x":1,"y":1,"z":1}],"normal":{"x":0,"y":1,"z":0},"distance":2} normal must be axis-aligned unit vector; maximum 4096 cells.
{"type":"layer.create","name":"Tower"} returns layer.id and makes it active.
{"type":"layer.rename","id":1,"name":"Base"}; {"type":"layer.visibility","id":1,"visible":true}; {"type":"layer.lock","id":1,"locked":false}
{"type":"palette.setColor","index":5,"color":15909198}; {"type":"material.update","index":5,"patch":{"name":"Gold","roughness":0.2,"metalness":1}}
{"type":"view.frame"}; {"type":"view.get"}; {"type":"view.set","view":{"position":{"x":30,"y":25,"z":30},"target":{"x":0,"y":8,"z":0}}}; {"type":"view.capture"} returns the current viewport image attachment when that camera view is needed. Prefer view.inspect for verification; no framing is required. Captures settle meshing, not progressive sample convergence.
{"type":"settings.update","patch":{"grid":true,"background":"#dfe7ec"}}; {"type":"renderMode.set","enabled":false}
{"type":"document.rename","name":"Lighthouse"}; {"type":"save.flush"}
These always require the user's frontend approval: {"type":"document.new","dimensions":{"x":32,"y":32,"z":32},"name":"New model"}; {"type":"document.resize","dimensions":{"x":64,"y":64,"z":64},"anchor":"origin"|"center"}; {"type":"layer.delete","id":1}.
Never supply approval flags. If approval is denied, respect it and do not try another way to perform the same destructive action. Ordinary voxel edits have Undo; layer/material/settings changes may not. Stop after a concise final summary.`

const plugin: Plugin = async () => ({
  async config(legacyConfig) {
    // The plugin hook still declares the legacy SDK config; the runtime uses v2.
    const config = legacyConfig as unknown as Config
    // Restrict the dedicated child instance, never the user's running OpenCode session.
    config.default_agent = 'canvas-assistant'
    config.permission = { '*': 'deny', canvas: 'allow' }
    config.agent = {
      'canvas-assistant': { description: 'Edit only the live voxel canvas', mode: 'primary', prompt: canvasInstructions, steps: 40, permission: { '*': 'deny', canvas: 'allow' } },
    }
    for (const name of Object.keys(config.mcp ?? {})) config.mcp![name] = { enabled: false }
    config.instructions = []
    config.share = 'disabled'
    config.snapshot = false
  },
  async 'experimental.chat.system.transform'(_input, output) {
    output.system = [canvasInstructions]
  },
  async 'tool.execute.before'(input) {
    if (input.tool !== 'canvas') throw new Error('This assistant can only use the canvas tool.')
  },
  tool: {
    canvas: tool({
      description: 'Inspect or edit the live Voxel Studio canvas with one semantic JSON command or an ordered batch of 1..16 commands. Batches stop on the first error without rollback. Prefer view.inspect PNGs to understand and verify the model. Wait for the real result before continuing.',
      args: { command: tool.schema.string().max(500_000).describe('JSON string containing one command object or an array of 1..16 command objects. See the system instructions for schemas and batch semantics.') },
      async execute({ command }, context) {
        const input: unknown = JSON.parse(command)
        const batchTitle = Array.isArray(input) ? `Canvas batch (${input.length} commands)` : undefined
        if (batchTitle) context.metadata({ title: batchTitle })
        else if (input && typeof input === 'object' && 'type' in input && typeof input.type === 'string') context.metadata({ title: input.type.slice(0, 64) })
        const response = await fetch(`${process.env.VOXEL_ASSISTANT_INTERNAL_URL}/tool`, {
          method: 'POST', signal: context.abort,
          headers: { authorization: `Bearer ${process.env.VOXEL_ASSISTANT_INTERNAL_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionID: context.sessionID, messageID: context.messageID, command: input }),
        })
        if (!response.ok) throw new Error('Canvas connection is no longer available. Stop this task.')
        const result = await response.json()
        const batch = Array.isArray(result.results)
        const attachments: { type: 'file'; mime: string; filename?: string; url: string }[] = []
        let title = 'Inspect model'
        for (const [index, entry] of (batch ? result.results : [result]).entries()) {
          if (!entry.ok) continue
          const prefix = batch ? `command-${index}-` : ''
          if (Array.isArray(entry.result?.images)) {
            entry.result.images = entry.result.images.map(({ dataBase64, ...metadata }: { name: string; dataBase64: string }) => {
              attachments.push({ type: 'file', mime: 'image/png', filename: `${prefix}${metadata.name}.png`, url: `data:image/png;base64,${dataBase64}` })
              return metadata
            })
          } else if (entry.result?.mime === 'image/png') {
            const { dataBase64, ...metadata } = entry.result
            attachments.push({ type: 'file', mime: 'image/png', ...(batch ? { filename: `${prefix}viewport.png` } : {}), url: `data:image/png;base64,${dataBase64}` })
            entry.result = metadata
            title = 'Inspect viewport'
          }
        }
        if (attachments.length) return { title: batchTitle ?? title, output: JSON.stringify(result), attachments }
        return JSON.stringify(result)
      },
    }),
  },
})

export default plugin
