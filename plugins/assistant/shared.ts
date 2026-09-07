import { parseCommand, type RemoteCommand } from '../../src/editors/model/protocol'
import { StudioCommandError } from '../../src/shared/errors'

export type CommandResult = { revision: number; changed?: boolean; result: unknown }
export type ToolResponse = { ok: true } & CommandResult | { ok: false; error: { code: string; message: string } }
export type BatchResponse = { results: ToolResponse[] } & (
  | { ok: true }
  | (Extract<ToolResponse, { ok: false }> & { failedIndex: number | null })
)
export type AssistantModel = { providerID: string; modelID: string; providerName: string; name: string }
export type AssistantHost = {
  root: HTMLElement
  menu: HTMLElement
  execute: (command: unknown, options: { signal: AbortSignal; ifRevision?: number }) => Promise<CommandResult>
  subscribe: (listener: (event: { source: string; command: string; revision: number; changed: boolean }) => void) => () => void
}

export type ClientMessage =
  | { type: 'prompt'; text: string; model: { providerID: string; modelID: string } }
  | { type: 'stop'; runID: string }
  | { type: 'new' }
  | { type: 'result'; runID: string; id: string; response: ToolResponse }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'ready'; models: AssistantModel[]; defaultModel?: { providerID: string; modelID: string }; modelsError?: string }
  | { type: 'run'; runID: string }
  | { type: 'part'; runID: string; id: string; kind: 'text' | 'reasoning' | 'tool'; text: string }
  | { type: 'command'; runID: string; id: string; command: RemoteCommand; ifRevision?: number }
  | { type: 'done'; runID: string; stopped: boolean; error?: string }
  | { type: 'error'; message: string }
  | { type: 'reset' }
  | { type: 'pong' }

const allowed = new Set([
  'state.get', 'composition.get', 'view.get', 'view.capture', 'view.inspect', 'view.set', 'view.frame',
  'edit.setVoxels', 'edit.paint', 'edit.erase', 'edit.fill', 'edit.move', 'edit.pushPull',
  'document.new', 'document.rename', 'document.resize',
  'layer.create', 'layer.rename', 'layer.visibility', 'layer.lock', 'layer.delete',
  'palette.setColor', 'material.update', 'settings.update', 'renderMode.set', 'save.flush',
])

export function parseCanvasCommand(value: unknown): RemoteCommand {
  const command = parseCommand(value)
  const fail = (message: string): never => { throw new StudioCommandError('invalid_argument', message) }
  if (!allowed.has(command.type)) fail(`${command.type} is not available to the canvas assistant.`)
  if (command.type.startsWith('edit.')) {
    if (!('layerId' in command) || command.layerId === undefined) fail('Specify layerId for every edit.')
    if ('cells' in command && (!command.cells || command.cells.length > 4096)) fail('Specify up to 4096 cells per edit.')
    if (command.type === 'edit.setVoxels' && command.voxels.length > 4096) fail('Use at most 4096 voxels per edit.')
    if ((command.type === 'edit.paint' || command.type === 'edit.fill') && command.color === undefined) fail('Specify a palette color index.')
    if (command.type === 'edit.fill') {
      const size = (['x', 'y', 'z'] as const).reduce((n, axis) => n * (Math.abs(command.max[axis] - command.min[axis]) + 1), 1)
      if (size > 32768) fail('Split volumes into batches of at most 32768 cells.')
    }
  }
  if (command.type === 'composition.get') command.limit = Math.min(command.limit ?? 1024, 4096)
  // Only the frontend's approval can authorize a destructive command.
  if (command.type === 'document.resize') command.allowCrop = false
  if (command.type === 'layer.delete') command.allowNonEmpty = false
  return command
}

export function needsApproval(command: RemoteCommand) {
  return command.type === 'document.new' || command.type === 'document.resize' || command.type === 'layer.delete'
}

export function isInspection(command: RemoteCommand) {
  return ['state.get', 'composition.get', 'view.get', 'view.capture', 'view.inspect'].includes(command.type)
}
