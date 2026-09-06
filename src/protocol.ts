import { CHUNK_SIZE, CHUNK_VOLUME, VoxelDocument, chunkCoords, type Dimensions, type PaletteMaterial, type Vec3, type VoxelLayer } from './editor'
import type { CameraSnapshot } from './renderer'
import { StudioCommandError, type MaterialPatch, type PbrMap, type StudioCommand } from './studio'
import type { ViewSettings } from './storage'

export const PROTOCOL = 'voxel-studio/1'
export const MAX_EDIT_VOXELS = 250_000
export const MAX_BINARY_BYTES = 72 * 1024 * 1024

export type RemoteCommand = StudioCommand
  | { type: 'state.get' }
  | { type: 'composition.get'; visibility?: 'composited' | 'all' | 'layer'; layerId?: number; bounds?: { min: Vec3; max: Vec3 }; cursor?: number; limit?: number }
  | { type: 'project.snapshot.get' }
  | { type: 'project.snapshot.replace'; snapshot: ProjectSnapshot; allowReplace?: boolean }
  | { type: 'view.get' }
  | { type: 'view.set'; view: Pick<CameraSnapshot, 'position' | 'target'> & Partial<Pick<CameraSnapshot, 'up' | 'zoom' | 'fov' | 'orthographicSpan'>> }
  | { type: 'view.frame' }
  | { type: 'view.capture' }
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

export interface ProjectSnapshot {
  schema: 'voxel-studio/project'
  version: 1
  name: string
  dimensions: Dimensions
  palette: number[]
  materials: PaletteMaterial[]
  layers: VoxelLayer[]
  activeLayerId: number
  chunks: { id: number; layerId: number; dataBase64: string }[]
  settings: ViewSettings
}

type RecordValue = Record<string, unknown>

function record(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid(`${name} must be an object.`)
  return value as RecordValue
}

function invalid(message: string): StudioCommandError {
  return new StudioCommandError('invalid_argument', message)
}

function stringValue(value: unknown, name: string, max: number, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || !allowEmpty && !value.trim()) throw invalid(`${name} must be a${allowEmpty ? '' : ' non-empty'} string up to ${max} characters.`)
  return value
}

function numberValue(value: unknown, name: string, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`${name} must be a finite number from ${min} to ${max}.`)
  return value
}

function integer(value: unknown, name: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const result = numberValue(value, name, min, max)
  if (!Number.isInteger(result)) throw invalid(`${name} must be an integer.`)
  return result
}

function booleanValue(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw invalid(`${name} must be a boolean.`)
  return value
}

function oneOf<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw invalid(`${name} must be one of: ${values.join(', ')}.`)
  return value as T
}

function optional<T>(value: unknown, parse: (value: unknown) => T) {
  return value === undefined ? undefined : parse(value)
}

function vec3(value: unknown, name: string): Vec3 {
  const input = record(value, name)
  return { x: integer(input.x, `${name}.x`), y: integer(input.y, `${name}.y`), z: integer(input.z, `${name}.z`) }
}

function normal(value: unknown, name: string): Vec3 {
  const result = vec3(value, name)
  if (Math.abs(result.x) + Math.abs(result.y) + Math.abs(result.z) !== 1) throw invalid(`${name} must be an axis-aligned unit vector.`)
  return result
}

function dimensions(value: unknown, name: string): Dimensions {
  const input = record(value, name)
  return { x: integer(input.x, `${name}.x`, 16, 256), y: integer(input.y, `${name}.y`, 16, 256), z: integer(input.z, `${name}.z`, 16, 256) }
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

function base64(value: unknown, name: string, maxBytes = MAX_BINARY_BYTES) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid(`${name} must be valid base64 within the size limit.`)
  return value
}

function optionalLayer(input: RecordValue) {
  return optional(input.layerId, value => integer(value, 'command.layerId', 1, 65535))
}

function optionalCells(input: RecordValue) {
  return optional(input.cells, value => cells(value, 'command.cells'))
}

function materialPatch(value: unknown): MaterialPatch {
  const input = record(value, 'command.patch')
  const patch: MaterialPatch = {}
  const allowed = new Set(['name', 'roughness', 'metalness', 'emissiveIntensity', 'opacity', 'transmission', 'ior'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`Unknown material property: ${key}.`)
  if (input.name !== undefined) patch.name = stringValue(input.name, 'command.patch.name', 40)
  if (input.roughness !== undefined) patch.roughness = numberValue(input.roughness, 'command.patch.roughness', 0, 1)
  if (input.metalness !== undefined) patch.metalness = numberValue(input.metalness, 'command.patch.metalness', 0, 1)
  if (input.emissiveIntensity !== undefined) patch.emissiveIntensity = numberValue(input.emissiveIntensity, 'command.patch.emissiveIntensity', 0, 5)
  if (input.opacity !== undefined) patch.opacity = numberValue(input.opacity, 'command.patch.opacity', 0, 1)
  if (input.transmission !== undefined) patch.transmission = numberValue(input.transmission, 'command.patch.transmission', 0, 1)
  if (input.ior !== undefined) patch.ior = numberValue(input.ior, 'command.patch.ior', 1, 2.5)
  if (!Object.keys(patch).length) throw invalid('command.patch must change at least one material property.')
  return patch
}

function settingsPatch(value: unknown): Partial<ViewSettings> {
  const input = record(value, 'command.patch')
  const patch: Partial<ViewSettings> = {}
  const allowed = new Set(['background', 'ambient', 'light', 'lightAzimuth', 'ambientOcclusion', 'shadows', 'grid', 'faceGrid', 'projection', 'pathTracing'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`Unknown setting: ${key}.`)
  if (input.background !== undefined) {
    const background = stringValue(input.background, 'command.patch.background', 7)
    if (!/^#[0-9a-f]{6}$/i.test(background)) throw invalid('command.patch.background must be a six-digit hex color.')
    patch.background = background
  }
  if (input.ambient !== undefined) patch.ambient = numberValue(input.ambient, 'command.patch.ambient', 0, 3)
  if (input.light !== undefined) patch.light = numberValue(input.light, 'command.patch.light', 0, 5)
  if (input.lightAzimuth !== undefined) patch.lightAzimuth = numberValue(input.lightAzimuth, 'command.patch.lightAzimuth', -180, 180)
  if (input.ambientOcclusion !== undefined) patch.ambientOcclusion = booleanValue(input.ambientOcclusion, 'command.patch.ambientOcclusion')
  if (input.shadows !== undefined) patch.shadows = booleanValue(input.shadows, 'command.patch.shadows')
  if (input.grid !== undefined) patch.grid = booleanValue(input.grid, 'command.patch.grid')
  if (input.faceGrid !== undefined) patch.faceGrid = booleanValue(input.faceGrid, 'command.patch.faceGrid')
  if (input.pathTracing !== undefined) patch.pathTracing = booleanValue(input.pathTracing, 'command.patch.pathTracing')
  if (input.projection !== undefined) patch.projection = oneOf(input.projection, 'command.patch.projection', ['orthographic', 'perspective'] as const)
  if (!Object.keys(patch).length) throw invalid('command.patch must change at least one setting.')
  return patch
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

export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

export function base64ToBytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export function encodeProjectSnapshot(document: VoxelDocument, settings: ViewSettings): ProjectSnapshot {
  const order = new Map(document.layers.map((layer, index) => [layer.id, index]))
  const chunks = [...document.chunks].flatMap(([id, layers]) => [...layers].map(([layerId, data]) => ({ id, layerId, dataBase64: bytesToBase64(data) })))
    .sort((a, b) => a.id - b.id || (order.get(a.layerId) ?? 0) - (order.get(b.layerId) ?? 0))
  return {
    schema: 'voxel-studio/project',
    version: 1,
    name: document.name,
    dimensions: { ...document.dimensions },
    palette: [...document.palette],
    materials: document.materials.map(material => ({ ...material })),
    layers: document.layers.map(layer => ({ ...layer })),
    activeLayerId: document.activeLayerId,
    chunks,
    settings: { ...settings },
  }
}

export function parseProjectSnapshot(value: unknown): ProjectSnapshot {
  const input = record(value, 'snapshot')
  if (input.schema !== 'voxel-studio/project' || input.version !== 1) throw new StudioCommandError('unsupported_version', 'Unsupported project snapshot.')
  const palette = Array.isArray(input.palette) ? input.palette.map((color, index) => integer(color, `snapshot.palette[${index}]`, 0, 0xffffff)) : []
  if (palette.length !== 256) throw invalid('snapshot.palette must contain 256 colors.')
  if (!Array.isArray(input.materials) || input.materials.length !== 256) throw invalid('snapshot.materials must contain 256 materials.')
  const materials = input.materials.map((material, index) => {
    const parsed = materialPatch(material)
    const required = ['name', 'roughness', 'metalness', 'emissiveIntensity', 'opacity', 'transmission', 'ior'] as const
    if (required.some(property => parsed[property] === undefined)) throw invalid(`snapshot.materials[${index}] is incomplete.`)
    return parsed as PaletteMaterial
  })
  if (!Array.isArray(input.layers) || !input.layers.length) throw invalid('snapshot.layers must contain at least one layer.')
  const layerIds = new Set<number>()
  const layers = input.layers.map((layer, index) => {
    const parsed = record(layer, `snapshot.layers[${index}]`)
    const id = integer(parsed.id, `snapshot.layers[${index}].id`, 1, 65535)
    if (layerIds.has(id)) throw invalid(`snapshot.layers contains duplicate id ${id}.`)
    layerIds.add(id)
    return { id, name: stringValue(parsed.name, `snapshot.layers[${index}].name`, 40), visible: booleanValue(parsed.visible, `snapshot.layers[${index}].visible`), locked: booleanValue(parsed.locked, `snapshot.layers[${index}].locked`) }
  })
  const activeLayerId = integer(input.activeLayerId, 'snapshot.activeLayerId', 1, 65535)
  if (!layerIds.has(activeLayerId)) throw invalid('snapshot.activeLayerId must reference a layer.')
  if (!Array.isArray(input.chunks)) throw invalid('snapshot.chunks must be an array.')
  const parsedDimensions = dimensions(input.dimensions, 'snapshot.dimensions')
  const seen = new Set<string>()
  const chunks = input.chunks.map((chunk, index) => {
    const parsed = record(chunk, `snapshot.chunks[${index}]`)
    const id = integer(parsed.id, `snapshot.chunks[${index}].id`, 0, 4095)
    const layerId = integer(parsed.layerId, `snapshot.chunks[${index}].layerId`, 1, 65535)
    if (!layerIds.has(layerId)) throw invalid(`snapshot.chunks[${index}] references an unknown layer.`)
    const key = `${id}:${layerId}`
    if (seen.has(key)) throw invalid(`snapshot.chunks contains duplicate ${key}.`)
    seen.add(key)
    const dataBase64 = base64(parsed.dataBase64, `snapshot.chunks[${index}].dataBase64`, CHUNK_VOLUME)
    const data = base64ToBytes(dataBase64)
    if (data.length !== CHUNK_VOLUME) throw invalid(`snapshot.chunks[${index}] must decode to ${CHUNK_VOLUME} bytes.`)
    const origin = chunkCoords(id)
    if (origin.x * CHUNK_SIZE >= parsedDimensions.x || origin.y * CHUNK_SIZE >= parsedDimensions.y || origin.z * CHUNK_SIZE >= parsedDimensions.z) throw invalid(`snapshot.chunks[${index}] is outside the document.`)
    for (let offset = 0; offset < data.length; offset++) {
      if (!data[offset]) continue
      const x = origin.x * CHUNK_SIZE + offset % CHUNK_SIZE
      const y = origin.y * CHUNK_SIZE + Math.floor(offset / CHUNK_SIZE) % CHUNK_SIZE
      const z = origin.z * CHUNK_SIZE + Math.floor(offset / (CHUNK_SIZE * CHUNK_SIZE))
      if (x >= parsedDimensions.x || y >= parsedDimensions.y || z >= parsedDimensions.z) throw invalid(`snapshot.chunks[${index}] has voxels outside the document.`)
    }
    return { id, layerId, dataBase64 }
  })
  return {
    schema: 'voxel-studio/project',
    version: 1,
    name: stringValue(input.name, 'snapshot.name', 60, true),
    dimensions: parsedDimensions,
    palette,
    materials,
    layers,
    activeLayerId,
    chunks,
    settings: parseSettings(input.settings),
  }
}

function parseSettings(value: unknown): ViewSettings {
  const input = record(value, 'snapshot.settings')
  const patch = settingsPatch(input)
  const required = ['background', 'ambient', 'light', 'lightAzimuth', 'ambientOcclusion', 'shadows', 'grid', 'faceGrid', 'projection', 'pathTracing'] as const
  if (required.some(property => patch[property] === undefined)) throw invalid('snapshot.settings is incomplete.')
  return patch as ViewSettings
}

export function decodeProjectSnapshot(value: unknown) {
  const snapshot = parseProjectSnapshot(value)
  const document = new VoxelDocument(snapshot.dimensions, snapshot.name, snapshot.palette, snapshot.materials, snapshot.layers, snapshot.activeLayerId)
  const chunks = new Map<number, { layerId: number; data: Uint8Array }[]>()
  for (const chunk of snapshot.chunks) {
    const layers = chunks.get(chunk.id) ?? []
    layers.push({ layerId: chunk.layerId, data: base64ToBytes(chunk.dataBase64) })
    chunks.set(chunk.id, layers)
  }
  for (const [id, layers] of chunks) document.replaceChunk(id, layers)
  return { document, settings: snapshot.settings }
}
