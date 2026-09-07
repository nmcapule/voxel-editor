import { StudioCommandError } from '../../shared/errors'
import { record, invalid, stringValue, numberValue, integer, booleanValue, oneOf, optional, vec3, dimensions, base64, type RecordValue } from '../../shared/validation'
import { materialPatch } from '../../shared/voxel/material'
import { settingsPatch } from '../../shared/rendering/settings'
import { parseProjectSnapshot, type ProjectSnapshot } from '../../shared/voxel/snapshot'
import type { Vec3 } from '../../shared/voxel/document'
import type { CameraSnapshot } from '../../shared/rendering/contracts'
import { inspectionViews, type InspectionView } from './inspection'
import type { PbrMap, StudioCommand } from './studio'

export const PROTOCOL = 'voxel-studio/1'
export const MAX_EDIT_VOXELS = 250_000

export type RemoteCommand = StudioCommand
  | { type: 'state.get' }
  | { type: 'composition.get'; visibility?: 'composited' | 'all' | 'layer'; layerId?: number; bounds?: { min: Vec3; max: Vec3 }; cursor?: number; limit?: number }
  | { type: 'project.snapshot.get' }
  | { type: 'project.snapshot.replace'; snapshot: ProjectSnapshot; allowReplace?: boolean }
  | { type: 'view.get' }
  | { type: 'view.set'; view: Pick<CameraSnapshot, 'position' | 'target'> & Partial<Pick<CameraSnapshot, 'up' | 'zoom' | 'fov' | 'orthographicSpan'>> }
  | { type: 'view.frame' }
  | { type: 'view.capture' }
  | { type: 'view.inspect'; views?: readonly InspectionView[] }
  | { type: 'io.vox.import'; dataBase64: string; name?: string; allowReplace?: boolean }
  | { type: 'io.vox.export' }
  | { type: 'material.map.set'; index: number; map: PbrMap; name: string; mime: string; dataBase64: string }
  | { type: 'material.map.clear'; index: number; map?: PbrMap }
  | { type: 'save.flush' }

export interface RemoteRequest {
  protocol: typeof PROTOCOL
  id: string
  ifRevision?: number
  command: RemoteCommand
}

export type RemoteResponse = {
  protocol: typeof PROTOCOL
  id: string | null
  sequence: number
  revision: number
  ok: true
  result: unknown
} | {
  protocol: typeof PROTOCOL
  id: string | null
  sequence: number
  revision: number
  ok: false
  error: { code: string; message: string; details?: Record<string, unknown> }
}

function normal(value: unknown, name: string): Vec3 {
  const result = vec3(value, name)
  if (Math.abs(result.x) + Math.abs(result.y) + Math.abs(result.z) !== 1) throw invalid(`${name} must be an axis-aligned unit vector.`)
  return result
}

function cells(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > MAX_EDIT_VOXELS) throw invalid(`${name} must contain at most ${MAX_EDIT_VOXELS} cells.`)
  return value.map((cell, index) => vec3(cell, `${name}[${index}]`))
}

function voxels(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > MAX_EDIT_VOXELS) throw invalid(`${name} must contain at most ${MAX_EDIT_VOXELS} voxels.`)
  return value.map((voxel, index) => {
    const input = record(voxel, `${name}[${index}]`)
    return { ...vec3(input, `${name}[${index}]`), color: integer(input.color, `${name}[${index}].color`, 0, 255) }
  })
}

function optionalLayer(input: RecordValue) {
  return optional(input.layerId, value => integer(value, 'command.layerId', 1, 65535))
}

function optionalCells(input: RecordValue) {
  return optional(input.cells, value => cells(value, 'command.cells'))
}

export function parseRequest(value: unknown): RemoteRequest {
  const request = record(value, 'request')
  if (request.protocol !== PROTOCOL) throw new StudioCommandError('unsupported_version', `protocol must be ${PROTOCOL}.`)
  const id = stringValue(request.id, 'request.id', 128)
  const ifRevision = optional(request.ifRevision, value => integer(value, 'request.ifRevision', 0))
  return { protocol: PROTOCOL, id, ifRevision, command: parseCommand(request.command) }
}

export function parseCommand(value: unknown): RemoteCommand {
  const input = record(value, 'command')
  const type = stringValue(input.type, 'command.type', 64)
  switch (type) {
    case 'document.new': return { type, dimensions: optional(input.dimensions, value => dimensions(value, 'command.dimensions')), name: optional(input.name, value => stringValue(value, 'command.name', 60, true)) }
    case 'document.rename': return { type, name: stringValue(input.name, 'command.name', 60, true) }
    case 'document.resize': return { type, dimensions: dimensions(input.dimensions, 'command.dimensions'), anchor: oneOf(input.anchor, 'command.anchor', ['origin', 'center'] as const), allowCrop: optional(input.allowCrop, value => booleanValue(value, 'command.allowCrop')) }
    case 'edit.paint': return { type, cells: optionalCells(input), color: optional(input.color, value => integer(value, 'command.color', 1, 255)), layerId: optionalLayer(input) }
    case 'edit.erase': return { type, cells: optionalCells(input), layerId: optionalLayer(input) }
    case 'edit.setVoxels': return { type, voxels: voxels(input.voxels, 'command.voxels'), layerId: optionalLayer(input) }
    case 'edit.fill': return { type, min: vec3(input.min, 'command.min'), max: vec3(input.max, 'command.max'), color: optional(input.color, value => integer(value, 'command.color', 1, 255)), shape: oneOf(input.shape, 'command.shape', ['box', 'sphere', 'cylinder'] as const), axis: optional(input.axis, value => oneOf(value, 'command.axis', ['x', 'y', 'z'] as const)), layerId: optionalLayer(input) }
    case 'edit.move': return { type, cells: optionalCells(input), normal: normal(input.normal, 'command.normal'), distance: integer(input.distance, 'command.distance', -256, 256), layerId: optionalLayer(input) }
    case 'edit.pushPull': return { type, cells: optionalCells(input), normal: normal(input.normal, 'command.normal'), distance: integer(input.distance, 'command.distance', -256, 256), layerId: optionalLayer(input) }
    case 'history.undo': case 'history.redo': case 'clipboard.copy': case 'clipboard.cut': case 'clipboard.paste.begin': case 'clipboard.paste.cancel': case 'state.get': case 'project.snapshot.get': case 'view.get': case 'view.frame': case 'view.capture': case 'io.vox.export': case 'save.flush': return { type }
    case 'selection.set': return { type, cells: cells(input.cells, 'command.cells'), additive: optional(input.additive, value => booleanValue(value, 'command.additive')), floating: optional(input.floating, value => booleanValue(value, 'command.floating')), focus: optional(input.focus, value => booleanValue(value, 'command.focus')) }
    case 'selection.resolve': return { type, cell: vec3(input.cell, 'command.cell'), normal: normal(input.normal, 'command.normal'), mode: optional(input.mode, value => oneOf(value, 'command.mode', ['point', 'surface', 'texture', 'body'] as const)), additive: optional(input.additive, value => booleanValue(value, 'command.additive')), focus: optional(input.focus, value => booleanValue(value, 'command.focus')) }
    case 'selection.clear': return { type, focus: optional(input.focus, value => booleanValue(value, 'command.focus')) }
    case 'clipboard.paste.place': return { type, offset: vec3(input.offset, 'command.offset') }
    case 'layer.create': return { type, name: optional(input.name, value => stringValue(value, 'command.name', 40)) }
    case 'layer.activate': return { type, id: integer(input.id, 'command.id', 1, 65535) }
    case 'layer.rename': return { type, id: integer(input.id, 'command.id', 1, 65535), name: stringValue(input.name, 'command.name', 40) }
    case 'layer.visibility': return { type, id: integer(input.id, 'command.id', 1, 65535), visible: booleanValue(input.visible, 'command.visible') }
    case 'layer.lock': return { type, id: integer(input.id, 'command.id', 1, 65535), locked: booleanValue(input.locked, 'command.locked') }
    case 'layer.delete': return { type, id: integer(input.id, 'command.id', 1, 65535), allowNonEmpty: optional(input.allowNonEmpty, value => booleanValue(value, 'command.allowNonEmpty')) }
    case 'palette.activate': return { type, index: integer(input.index, 'command.index', 1, 255) }
    case 'palette.duplicate': return { type, source: optional(input.source, value => integer(value, 'command.source', 1, 255)), name: optional(input.name, value => stringValue(value, 'command.name', 40)) }
    case 'palette.setColor': return { type, index: integer(input.index, 'command.index', 1, 255), color: integer(input.color, 'command.color', 0, 0xffffff) }
    case 'material.update': return { type, index: integer(input.index, 'command.index', 1, 255), patch: materialPatch(input.patch) }
    case 'tool.set': return { type, tool: oneOf(input.tool, 'command.tool', ['select', 'paint', 'sculpt', 'layer'] as const) }
    case 'tool.selectionMode': return { type, mode: oneOf(input.mode, 'command.mode', ['point', 'surface', 'texture', 'body'] as const) }
    case 'tool.paintMode': return { type, mode: oneOf(input.mode, 'command.mode', ['paint', 'fill'] as const) }
    case 'tool.sculptMode': return { type, mode: oneOf(input.mode, 'command.mode', ['push', 'move', 'erase'] as const) }
    case 'tool.auxiliary': return { type, tool: optional(input.tool, value => oneOf(value, 'command.tool', ['pick'] as const)) }
    case 'tool.fill': return { type, shape: optional(input.shape, value => oneOf(value, 'command.shape', ['box', 'sphere', 'cylinder'] as const)), depth: optional(input.depth, value => integer(value, 'command.depth', 1, 256)) }
    case 'settings.update': return { type, patch: settingsPatch(input.patch) }
    case 'renderMode.set': return { type, enabled: booleanValue(input.enabled, 'command.enabled') }
    case 'composition.get': {
      const bounds = optional(input.bounds, value => {
        const range = record(value, 'command.bounds')
        return { min: vec3(range.min, 'command.bounds.min'), max: vec3(range.max, 'command.bounds.max') }
      })
      return { type, visibility: optional(input.visibility, value => oneOf(value, 'command.visibility', ['composited', 'all', 'layer'] as const)), layerId: optionalLayer(input), bounds, cursor: optional(input.cursor, value => integer(value, 'command.cursor', 0)), limit: optional(input.limit, value => integer(value, 'command.limit', 1, 65_536)) }
    }
    case 'project.snapshot.replace': return { type, snapshot: parseProjectSnapshot(input.snapshot), allowReplace: optional(input.allowReplace, value => booleanValue(value, 'command.allowReplace')) }
    case 'view.inspect': {
      const views = optional(input.views, value => {
        if (!Array.isArray(value) || !value.length || value.length > 10) throw invalid('command.views must contain 1 to 10 views.')
        const parsed = value.map((view, index) => oneOf(view, `command.views[${index}]`, inspectionViews))
        if (new Set(parsed).size !== parsed.length) throw invalid('command.views must contain unique views.')
        return parsed
      })
      return { type, views }
    }
    case 'view.set': {
      const view = record(input.view, 'command.view')
      const optionalVector = optional(view.up, value => {
        const vector = record(value, 'command.view.up')
        return { x: numberValue(vector.x, 'command.view.up.x'), y: numberValue(vector.y, 'command.view.up.y'), z: numberValue(vector.z, 'command.view.up.z') }
      })
      const vector = (value: unknown, name: string) => {
        const point = record(value, name)
        return { x: numberValue(point.x, `${name}.x`), y: numberValue(point.y, `${name}.y`), z: numberValue(point.z, `${name}.z`) }
      }
      return { type, view: { position: vector(view.position, 'command.view.position'), target: vector(view.target, 'command.view.target'), up: optionalVector, zoom: optional(view.zoom, value => numberValue(value, 'command.view.zoom', 0.01, 100)), fov: optional(view.fov, value => numberValue(value, 'command.view.fov', 1, 120)), orthographicSpan: optional(view.orthographicSpan, value => numberValue(value, 'command.view.orthographicSpan', 1, 2048)) } }
    }
    case 'io.vox.import': return { type, dataBase64: base64(input.dataBase64, 'command.dataBase64'), name: optional(input.name, value => stringValue(value, 'command.name', 255, true)), allowReplace: optional(input.allowReplace, value => booleanValue(value, 'command.allowReplace')) }
    case 'material.map.set': return { type, index: integer(input.index, 'command.index', 1, 255), map: oneOf(input.map, 'command.map', ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const), name: stringValue(input.name, 'command.name', 255), mime: stringValue(input.mime, 'command.mime', 128), dataBase64: base64(input.dataBase64, 'command.dataBase64', 32 * 1024 * 1024) }
    case 'material.map.clear': return { type, index: integer(input.index, 'command.index', 1, 255), map: optional(input.map, value => oneOf(value, 'command.map', ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const)) }
    default: throw new StudioCommandError('unknown_command', `Unknown command: ${type}.`)
  }
}

export class SerialCommandQueue<C, R> {
  private queued: { command: C; signal?: AbortSignal; resolve: (result: R) => void; reject: (error: unknown) => void }[] = []
  private running = false
  private execute: (command: C) => R | Promise<R>
  private limit: number

  constructor(execute: (command: C) => R | Promise<R>, limit = 256) {
    this.execute = execute
    this.limit = limit
  }

  dispatch(command: C, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.queued.length >= this.limit) return Promise.reject(new StudioCommandError('limit_exceeded', 'The command queue is full.'))
    const pending = new Promise<R>((resolve, reject) => this.queued.push({ command, signal, resolve, reject }))
    void this.drain()
    return pending
  }

  private async drain() {
    if (this.running) return
    this.running = true
    while (this.queued.length) {
      const next = this.queued.shift()!
      try { next.signal?.throwIfAborted(); next.resolve(await this.execute(next.command)) }
      catch (error) { next.reject(error) }
    }
    this.running = false
  }
}
