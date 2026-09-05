export const CHUNK_SIZE = 16
export const CHUNK_VOLUME = CHUNK_SIZE ** 3
export const PADDED_SIZE = CHUNK_SIZE + 2
const HISTORY_LIMIT = 64 * 1024 * 1024

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Dimensions extends Vec3 {}

export type FillShape = 'box' | 'sphere' | 'cylinder'

export interface PaletteMaterial {
  name: string
  roughness: number
  metalness: number
  opacity: number
  transmission: number
  ior: number
}

export interface VoxelLayer {
  id: number
  name: string
  visible: boolean
  locked: boolean
}

export interface ChunkChange {
  id: number
  before?: Uint8Array
  after?: Uint8Array
  beforeLayers?: Uint16Array
  afterLayers?: Uint16Array
}

export interface EditCommand {
  changes: ChunkChange[]
  bytes: number
}

interface HistoryEntry extends EditCommand {
  selectionBefore: Vec3[]
  selectionAfter: Vec3[]
  layerBefore?: number
  layerAfter?: number
}

export interface HistoryResult {
  ids: number[]
  selection: Vec3[]
  layerId?: number
}

export const DEFAULT_PALETTE = new Uint32Array([
  0x000000, 0xf7f3e8, 0x25272b, 0x697078, 0xb8bec2, 0xf2c14e, 0xf78154,
  0xe54b4b, 0xb83b5e, 0x8f5db7, 0x4b55a8, 0x3978c5, 0x43a6c6, 0x56b4a6,
  0x57a773, 0x87b34d, 0xb9c46a, 0xe7d6a2, 0xd99f65, 0xaa6f46, 0x754f44,
  0x593c58, 0x765d86, 0x9d84b7, 0xc7afd4, 0xf0b7c8, 0xe86f92, 0xf39caa,
  0x8bd3c7, 0xb8e0d2, 0xa9c6ea, 0xd7e3fc,
])

const material = (name: string, roughness: number, metalness = 0, opacity = 1, transmission = 0, ior = 1.5): PaletteMaterial => ({ name, roughness, metalness, opacity, transmission, ior })
const DEFAULT_MATERIAL = material('Matte', 0.68, 0.02)
const DEFAULT_PALETTE_MATERIALS: readonly PaletteMaterial[] = [
  material('Empty', 0.68),
  material('Porcelain', 0.28), material('Graphite', 0.38, 0.35),
  material('Concrete', 0.9), material('Brushed steel', 0.3, 0.86),
  material('Gold', 0.2, 1), material('Copper', 0.28, 0.94),
  material('Fired brick', 0.82), material('Terracotta', 0.76),
  material('Organic', 0.58), material('Coated steel', 0.3, 0.68),
  material('Painted plastic', 0.42), material('Water', 0.08, 0, 1, 0.75, 1.333),
  material('Sea glass', 0.14, 0, 1, 0.72, 1.46), material('Grass', 0.8),
  material('Moss', 0.92), material('Leaf', 0.68),
  material('Sandstone', 0.86), material('Pale wood', 0.72),
  material('Oak', 0.66), material('Leather', 0.62),
  material('Bark', 0.9), material('Plum fabric', 0.88),
  material('Violet resin', 0.24), material('Lavender clay', 0.74),
  material('Wax', 0.4), material('Coral', 0.56),
  material('Rose ceramic', 0.26), material('Jade glass', 0.16, 0, 1, 0.8, 1.5),
  material('Mint plastic', 0.36), material('Frosted glass', 0.34, 0, 1, 0.68, 1.5),
  material('Blue glass', 0.08, 0, 1, 0.86, 1.5),
]

function materialValue(value: number | undefined, fallback: number, min = 0, max = 1) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value!)) : fallback
}

export function chunkId(cx: number, cy: number, cz: number) {
  return cx | (cy << 4) | (cz << 8)
}

export function chunkCoords(id: number): Vec3 {
  return { x: id & 15, y: (id >> 4) & 15, z: (id >> 8) & 15 }
}

function chunkIndex(x: number, y: number, z: number) {
  return x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE
}

function equalChunks(a?: ArrayLike<number>, b?: ArrayLike<number>) {
  if (!a || !b) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function normalizeDimensions(dimensions: Dimensions): Dimensions {
  return {
    x: Math.max(16, Math.min(256, Math.round(dimensions.x))),
    y: Math.max(16, Math.min(256, Math.round(dimensions.y))),
    z: Math.max(16, Math.min(256, Math.round(dimensions.z))),
  }
}

export class VoxelDocument {
  readonly chunks = new Map<number, Uint8Array>()
  readonly layerChunks = new Map<number, Uint16Array>()
  readonly palette: Uint32Array
  readonly materials: PaletteMaterial[]
  readonly dimensions: Dimensions
  readonly layers: VoxelLayer[]
  activeLayerId: number
  name: string
  voxelCount = 0

  constructor(dimensions: Dimensions = { x: 32, y: 32, z: 32 }, name = 'Untitled', palette: ArrayLike<number> = DEFAULT_PALETTE, materials?: readonly Partial<PaletteMaterial>[], layers?: readonly VoxelLayer[], activeLayerId?: number) {
    this.dimensions = normalizeDimensions(dimensions)
    this.name = name
    this.palette = new Uint32Array(256)
    this.palette.set(palette)
    const defaultPalette = palette === DEFAULT_PALETTE || DEFAULT_PALETTE.every((color, index) => palette[index] === color)
    const presets = materials ?? (defaultPalette ? DEFAULT_PALETTE_MATERIALS : [])
    this.materials = Array.from({ length: 256 }, (_, index) => {
      const preset = presets[index]
      const fallback = defaultPalette ? DEFAULT_PALETTE_MATERIALS[index] ?? DEFAULT_MATERIAL : DEFAULT_MATERIAL
      return {
        name: typeof preset?.name === 'string' && preset.name.trim() ? preset.name.trim().slice(0, 40) : fallback.name === 'Matte' ? `Color ${index}` : fallback.name,
        roughness: materialValue(preset?.roughness, fallback.roughness),
        metalness: materialValue(preset?.metalness, fallback.metalness),
        opacity: materialValue(preset?.opacity, fallback.opacity),
        transmission: materialValue(preset?.transmission, fallback.transmission),
        ior: materialValue(preset?.ior, fallback.ior, 1, 2.5),
      }
    })
    const seen = new Set<number>()
    this.layers = (layers ?? []).filter(layer => Number.isInteger(layer.id) && layer.id > 0 && layer.id <= 65535 && !seen.has(layer.id) && seen.add(layer.id))
      .map(layer => ({ id: layer.id, name: layer.name.trim().slice(0, 40) || `Layer ${layer.id}`, visible: layer.visible !== false, locked: layer.locked === true }))
    if (!this.layers.length) this.layers.push({ id: 1, name: 'Layer 1', visible: true, locked: false })
    this.activeLayerId = this.layers.some(layer => layer.id === activeLayerId) ? activeLayerId! : this.layers[0].id
  }

  get activeLayer() { return this.layers.find(layer => layer.id === this.activeLayerId)! }

  getLayer(id: number) { return this.layers.find(layer => layer.id === id) }

  createLayer() {
    let id = 1
    while (this.getLayer(id)) id++
    if (id > 65535) throw new Error('The layer limit has been reached.')
    const layer = { id, name: `Layer ${this.layers.length + 1}`, visible: true, locked: false }
    this.layers.push(layer)
    this.activeLayerId = id
    return layer
  }

  setActiveLayer(id: number) {
    if (!this.getLayer(id)) return false
    this.activeLayerId = id
    return true
  }

  renameLayer(id: number, name: string) {
    const layer = this.getLayer(id)
    const next = name.trim().slice(0, 40)
    if (!layer || !next || layer.name === next) return false
    layer.name = next
    return true
  }

  deleteLayer(id: number) {
    const index = this.layers.findIndex(layer => layer.id === id)
    if (index < 0 || this.layers.length === 1) return []
    const changed: number[] = []
    for (const [chunkId, owners] of this.layerChunks) {
      const colors = this.chunks.get(chunkId)!
      let touched = false
      for (let cell = 0; cell < owners.length; cell++) {
        if (owners[cell] !== id) continue
        owners[cell] = 0
        colors[cell] = 0
        this.voxelCount--
        touched = true
      }
      if (!touched) continue
      changed.push(chunkId)
      if (!colors.some(Boolean)) {
        this.chunks.delete(chunkId)
        this.layerChunks.delete(chunkId)
      }
    }
    this.layers.splice(index, 1)
    if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.min(index, this.layers.length - 1)].id
    return changed
  }

  layerVoxelCount(id: number) {
    let count = 0
    for (const owners of this.layerChunks.values()) for (const owner of owners) if (owner === id) count++
    return count
  }

  contains(x: number, y: number, z: number) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.dimensions.x && y < this.dimensions.y && z < this.dimensions.z
  }

  idAt(x: number, y: number, z: number) {
    return chunkId(x >> 4, y >> 4, z >> 4)
  }

  getVoxel(x: number, y: number, z: number) {
    if (!this.contains(x, y, z)) return 0
    return this.chunks.get(this.idAt(x, y, z))?.[chunkIndex(x & 15, y & 15, z & 15)] ?? 0
  }

  getVoxelLayer(x: number, y: number, z: number) {
    if (!this.contains(x, y, z)) return 0
    return this.layerChunks.get(this.idAt(x, y, z))?.[chunkIndex(x & 15, y & 15, z & 15)] ?? 0
  }

  getVisibleVoxel(x: number, y: number, z: number) {
    const color = this.getVoxel(x, y, z)
    return color && this.getLayer(this.getVoxelLayer(x, y, z))?.visible ? color : 0
  }

  setVoxel(x: number, y: number, z: number, color: number, layerId?: number) {
    if (!this.contains(x, y, z)) return false
    const id = this.idAt(x, y, z)
    let chunk = this.chunks.get(id)
    let owners = this.layerChunks.get(id)
    if (!chunk) {
      if (color === 0) return false
      chunk = new Uint8Array(CHUNK_VOLUME)
      owners = new Uint16Array(CHUNK_VOLUME)
      this.chunks.set(id, chunk)
      this.layerChunks.set(id, owners)
    } else if (!owners) {
      owners = new Uint16Array(CHUNK_VOLUME)
      for (let cell = 0; cell < chunk.length; cell++) if (chunk[cell]) owners[cell] = this.layers[0].id
      this.layerChunks.set(id, owners)
    }
    const index = chunkIndex(x & 15, y & 15, z & 15)
    const before = chunk[index]
    const beforeLayer = owners![index]
    const nextLayer = color ? layerId ?? (before ? beforeLayer : this.activeLayerId) : 0
    if (color && !this.getLayer(nextLayer) || before === color && beforeLayer === nextLayer) return false
    chunk[index] = color
    owners![index] = nextLayer
    if (before === 0) this.voxelCount++
    if (color === 0) this.voxelCount--
    if (color === 0 && !chunk.some(Boolean)) {
      this.chunks.delete(id)
      this.layerChunks.delete(id)
    }
    return true
  }

  copyChunk(id: number) {
    const chunk = this.chunks.get(id)
    return chunk ? chunk.slice() : undefined
  }

  copyLayerChunk(id: number) {
    const chunk = this.layerChunks.get(id)
    return chunk ? chunk.slice() : undefined
  }

  replaceChunk(id: number, data?: Uint8Array, layerData?: Uint16Array) {
    const previous = this.chunks.get(id)
    if (previous) for (const color of previous) if (color) this.voxelCount--
    if (!data?.some(Boolean)) {
      this.chunks.delete(id)
      this.layerChunks.delete(id)
      return
    }
    const copy = data.slice()
    const owners = layerData?.length === CHUNK_VOLUME ? layerData.slice() : new Uint16Array(CHUNK_VOLUME)
    for (let index = 0; index < copy.length; index++) {
      if (!copy[index]) owners[index] = 0
      else if (!this.getLayer(owners[index])) owners[index] = this.layers[0].id
    }
    this.chunks.set(id, copy)
    this.layerChunks.set(id, owners)
    for (const color of copy) if (color) this.voxelCount++
  }

  fillChunkRegion(id: number, from: Vec3, to: Vec3, color: number, layerId = this.activeLayerId) {
    let chunk = this.chunks.get(id)
    let owners = this.layerChunks.get(id)
    if (!chunk) {
      if (color === 0) return false
      chunk = new Uint8Array(CHUNK_VOLUME)
      owners = new Uint16Array(CHUNK_VOLUME)
      this.chunks.set(id, chunk)
      this.layerChunks.set(id, owners)
    }
    let changed = false
    for (let z = from.z; z <= to.z; z++) {
      for (let y = from.y; y <= to.y; y++) {
        for (let x = from.x; x <= to.x; x++) {
          const index = chunkIndex(x, y, z)
          const before = chunk[index]
          if (before && owners![index] !== layerId) continue
          if (before === color) continue
          chunk[index] = color
          owners![index] = color ? layerId : 0
          if (before === 0) this.voxelCount++
          if (color === 0) this.voxelCount--
          changed = true
        }
      }
    }
    if (color === 0 && !chunk.some(Boolean)) {
      this.chunks.delete(id)
      this.layerChunks.delete(id)
    }
    return changed
  }

  paddedChunk(id: number, visibleOnly = false) {
    const origin = chunkCoords(id)
    const padded = new Uint8Array(PADDED_SIZE ** 3)
    let index = 0
    for (let z = -1; z <= CHUNK_SIZE; z++) {
      for (let y = -1; y <= CHUNK_SIZE; y++) {
        for (let x = -1; x <= CHUNK_SIZE; x++) {
          const position = { x: origin.x * CHUNK_SIZE + x, y: origin.y * CHUNK_SIZE + y, z: origin.z * CHUNK_SIZE + z }
          padded[index++] = visibleOnly ? this.getVisibleVoxel(position.x, position.y, position.z) : this.getVoxel(position.x, position.y, position.z)
        }
      }
    }
    return padded
  }

  forEachVoxel(visitor: (x: number, y: number, z: number, color: number, layerId: number) => void) {
    for (const [id, chunk] of this.chunks) {
      const origin = chunkCoords(id)
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let y = 0; y < CHUNK_SIZE; y++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const color = chunk[chunkIndex(x, y, z)]
            if (color) visitor(origin.x * CHUNK_SIZE + x, origin.y * CHUNK_SIZE + y, origin.z * CHUNK_SIZE + z, color, this.layerChunks.get(id)?.[chunkIndex(x, y, z)] ?? this.layers[0].id)
          }
        }
      }
    }
  }

  bounds(visibleOnly = false): { min: Vec3; max: Vec3 } | undefined {
    if (!this.voxelCount) return undefined
    const min = { x: this.dimensions.x, y: this.dimensions.y, z: this.dimensions.z }
    const max = { x: 0, y: 0, z: 0 }
    let found = false
    this.forEachVoxel((x, y, z, _color, layerId) => {
      if (visibleOnly && !this.getLayer(layerId)?.visible) return
      found = true
      min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z)
      max.x = Math.max(max.x, x + 1); max.y = Math.max(max.y, y + 1); max.z = Math.max(max.z, z + 1)
    })
    return found ? { min, max } : undefined
  }
}

export class EditSession {
  private before = new Map<number, { colors?: Uint8Array; layers?: Uint16Array }>()
  private changed = new Set<number>()
  private document: VoxelDocument
  private layerId: number

  constructor(document: VoxelDocument) {
    this.document = document
    this.layerId = document.activeLayerId
  }

  private capture(id: number) {
    if (!this.before.has(id)) this.before.set(id, { colors: this.document.copyChunk(id), layers: this.document.copyLayerChunk(id) })
  }

  private editable(layerId = this.layerId) {
    const layer = this.document.getLayer(layerId)
    return Boolean(layer?.visible && !layer.locked)
  }

  set(x: number, y: number, z: number, color: number) {
    if (!this.editable() || !this.document.contains(x, y, z)) return false
    const owner = this.document.getVoxelLayer(x, y, z)
    if (owner && owner !== this.layerId) return false
    const id = this.document.idAt(x, y, z)
    this.capture(id)
    if (!this.document.setVoxel(x, y, z, color, this.layerId)) return false
    this.changed.add(id)
    return true
  }

  reassign(cells: Vec3[], targetLayerId: number) {
    if (!this.editable() || !this.editable(targetLayerId)) return
    for (const cell of cells) {
      if (this.document.getVoxelLayer(cell.x, cell.y, cell.z) !== this.layerId) continue
      const id = this.document.idAt(cell.x, cell.y, cell.z)
      this.capture(id)
      if (this.document.setVoxel(cell.x, cell.y, cell.z, this.document.getVoxel(cell.x, cell.y, cell.z), targetLayerId)) this.changed.add(id)
    }
  }

  fill(min: Vec3, max: Vec3, color: number) {
    if (!this.editable()) return
    const from = {
      x: Math.max(0, Math.min(min.x, max.x)),
      y: Math.max(0, Math.min(min.y, max.y)),
      z: Math.max(0, Math.min(min.z, max.z)),
    }
    const to = {
      x: Math.min(this.document.dimensions.x - 1, Math.max(min.x, max.x)),
      y: Math.min(this.document.dimensions.y - 1, Math.max(min.y, max.y)),
      z: Math.min(this.document.dimensions.z - 1, Math.max(min.z, max.z)),
    }
    if (from.x > to.x || from.y > to.y || from.z > to.z) return
    for (let cz = from.z >> 4; cz <= to.z >> 4; cz++) {
      for (let cy = from.y >> 4; cy <= to.y >> 4; cy++) {
        for (let cx = from.x >> 4; cx <= to.x >> 4; cx++) {
          const id = chunkId(cx, cy, cz)
          this.capture(id)
          const localFrom = {
            x: Math.max(0, from.x - cx * CHUNK_SIZE),
            y: Math.max(0, from.y - cy * CHUNK_SIZE),
            z: Math.max(0, from.z - cz * CHUNK_SIZE),
          }
          const localTo = {
            x: Math.min(15, to.x - cx * CHUNK_SIZE),
            y: Math.min(15, to.y - cy * CHUNK_SIZE),
            z: Math.min(15, to.z - cz * CHUNK_SIZE),
          }
          if (this.document.fillChunkRegion(id, localFrom, localTo, color, this.layerId)) this.changed.add(id)
        }
      }
    }
  }

  fillShape(min: Vec3, max: Vec3, color: number, shape: FillShape, axis: keyof Vec3 = 'y') {
    if (shape === 'box') { this.fill(min, max, color); return }
    if (!this.editable()) return
    const from = {
      x: Math.max(0, Math.min(min.x, max.x)),
      y: Math.max(0, Math.min(min.y, max.y)),
      z: Math.max(0, Math.min(min.z, max.z)),
    }
    const to = {
      x: Math.min(this.document.dimensions.x - 1, Math.max(min.x, max.x)),
      y: Math.min(this.document.dimensions.y - 1, Math.max(min.y, max.y)),
      z: Math.min(this.document.dimensions.z - 1, Math.max(min.z, max.z)),
    }
    const center = { x: (from.x + to.x + 1) / 2, y: (from.y + to.y + 1) / 2, z: (from.z + to.z + 1) / 2 }
    const radius = { x: (to.x - from.x + 1) / 2, y: (to.y - from.y + 1) / 2, z: (to.z - from.z + 1) / 2 }
    for (let z = from.z; z <= to.z; z++) {
      for (let y = from.y; y <= to.y; y++) {
        for (let x = from.x; x <= to.x; x++) {
          const distance = { x: (x + 0.5 - center.x) / radius.x, y: (y + 0.5 - center.y) / radius.y, z: (z + 0.5 - center.z) / radius.z }
          const inside = shape === 'sphere' ? distance.x ** 2 + distance.y ** 2 + distance.z ** 2 <= 1
            : axis === 'x' ? distance.y ** 2 + distance.z ** 2 <= 1
              : axis === 'y' ? distance.x ** 2 + distance.z ** 2 <= 1
                : distance.x ** 2 + distance.y ** 2 <= 1
          if (inside) this.set(x, y, z, color)
        }
      }
    }
  }

  commit(): EditCommand | undefined {
    const changes: ChunkChange[] = []
    let bytes = 0
    for (const id of this.changed) {
      const snapshot = this.before.get(id)!
      const before = snapshot.colors
      const beforeLayers = snapshot.layers
      const after = this.document.copyChunk(id)
      const afterLayers = this.document.copyLayerChunk(id)
      if (equalChunks(before, after) && equalChunks(beforeLayers, afterLayers)) continue
      bytes += (before?.byteLength ?? 0) + (after?.byteLength ?? 0) + (beforeLayers?.byteLength ?? 0) + (afterLayers?.byteLength ?? 0)
      changes.push({ id, before, after, beforeLayers, afterLayers })
    }
    return changes.length ? { changes, bytes } : undefined
  }

  cancel() {
    for (const [id, before] of this.before) this.document.replaceChunk(id, before.colors, before.layers)
    return [...this.changed]
  }
}

export class History {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private bytes = 0

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  push(command?: EditCommand, selectionBefore: Vec3[] = [], selectionAfter = selectionBefore, layerBefore?: number, layerAfter = layerBefore) {
    if (!command) return
    this.undoStack.push({ ...command, selectionBefore, selectionAfter, layerBefore, layerAfter })
    this.bytes += command.bytes
    this.redoStack = []
    while (this.bytes > HISTORY_LIMIT && this.undoStack.length > 1) {
      this.bytes -= this.undoStack.shift()!.bytes
    }
  }

  undo(document: VoxelDocument): HistoryResult | undefined {
    const command = this.undoStack.pop()
    if (!command) return
    for (const change of command.changes) document.replaceChunk(change.id, change.before, change.beforeLayers)
    this.redoStack.push(command)
    this.bytes -= command.bytes
    return { ids: command.changes.map(change => change.id), selection: command.selectionBefore, layerId: command.layerBefore }
  }

  redo(document: VoxelDocument): HistoryResult | undefined {
    const command = this.redoStack.pop()
    if (!command) return
    for (const change of command.changes) document.replaceChunk(change.id, change.after, change.afterLayers)
    this.undoStack.push(command)
    this.bytes += command.bytes
    return { ids: command.changes.map(change => change.id), selection: command.selectionAfter, layerId: command.layerAfter }
  }

  clear() {
    this.undoStack = []
    this.redoStack = []
    this.bytes = 0
  }
}

export function pushPullRange(document: VoxelDocument, cells: Vec3[], normal: Vec3) {
  let pull = Infinity
  let push = Infinity
  for (const cell of cells) {
    const layerId = document.getVoxelLayer(cell.x, cell.y, cell.z)
    let free = 0
    while (document.contains(cell.x + normal.x * (free + 1), cell.y + normal.y * (free + 1), cell.z + normal.z * (free + 1))
      && !document.getVoxel(cell.x + normal.x * (free + 1), cell.y + normal.y * (free + 1), cell.z + normal.z * (free + 1))) free++
    pull = Math.min(pull, free)

    let filled = 0
    while (document.getVoxel(cell.x - normal.x * filled, cell.y - normal.y * filled, cell.z - normal.z * filled)
      && document.getVoxelLayer(cell.x - normal.x * filled, cell.y - normal.y * filled, cell.z - normal.z * filled) === layerId) filled++
    push = Math.min(push, filled)
  }
  return { pull: Number.isFinite(pull) ? pull : 0, push: Number.isFinite(push) ? push : 0 }
}

function voxelKey(document: VoxelDocument, cell: Vec3) {
  return cell.x + cell.y * document.dimensions.x + cell.z * document.dimensions.x * document.dimensions.y
}

export function moveRange(document: VoxelDocument, cells: Vec3[], normal: Vec3) {
  const selected = new Set(cells.map(cell => voxelKey(document, cell)))
  const available = (direction: number) => {
    let limit = Infinity
    for (const cell of cells) {
      const adjacent = {
        x: cell.x + normal.x * direction,
        y: cell.y + normal.y * direction,
        z: cell.z + normal.z * direction,
      }
      if (selected.has(voxelKey(document, adjacent))) continue
      let free = 0
      while (true) {
        const destination = {
          x: cell.x + normal.x * direction * (free + 1),
          y: cell.y + normal.y * direction * (free + 1),
          z: cell.z + normal.z * direction * (free + 1),
        }
        if (!document.contains(destination.x, destination.y, destination.z)
          || document.getVoxel(destination.x, destination.y, destination.z) && !selected.has(voxelKey(document, destination))) break
        free++
      }
      limit = Math.min(limit, free)
    }
    return Number.isFinite(limit) ? limit : 0
  }
  return { pull: available(1), push: available(-1) }
}

export function moveVoxels(document: VoxelDocument, session: EditSession, cells: Vec3[], normal: Vec3, distance: number) {
  const range = moveRange(document, cells, normal)
  const amount = Math.max(-range.push, Math.min(range.pull, Math.round(distance)))
  if (!amount) return 0
  const moving = cells.map(cell => ({ ...cell, color: document.getVoxel(cell.x, cell.y, cell.z) }))
  for (const cell of moving) session.set(cell.x, cell.y, cell.z, 0)
  for (const cell of moving) session.set(cell.x + normal.x * amount, cell.y + normal.y * amount, cell.z + normal.z * amount, cell.color)
  return amount
}

export function pushPull(document: VoxelDocument, session: EditSession, cells: Vec3[], normal: Vec3, distance: number) {
  const range = pushPullRange(document, cells, normal)
  const amount = Math.max(-range.push, Math.min(range.pull, Math.round(distance)))
  if (amount > 0) {
    for (const cell of cells) {
      const color = document.getVoxel(cell.x, cell.y, cell.z)
      for (let step = 1; step <= amount; step++) session.set(cell.x + normal.x * step, cell.y + normal.y * step, cell.z + normal.z * step, color)
    }
  } else if (amount < 0) {
    for (const cell of cells) {
      for (let step = 0; step < -amount; step++) session.set(cell.x - normal.x * step, cell.y - normal.y * step, cell.z - normal.z * step, 0)
    }
  }
  return amount
}

export function dirtyChunks(document: VoxelDocument, ids: Iterable<number>) {
  const dirty = new Set<number>()
  for (const id of ids) {
    const current = chunkCoords(id)
    const candidates = [
      current,
      { x: current.x - 1, y: current.y, z: current.z }, { x: current.x + 1, y: current.y, z: current.z },
      { x: current.x, y: current.y - 1, z: current.z }, { x: current.x, y: current.y + 1, z: current.z },
      { x: current.x, y: current.y, z: current.z - 1 }, { x: current.x, y: current.y, z: current.z + 1 },
    ]
    for (const candidate of candidates) {
      if (candidate.x < 0 || candidate.y < 0 || candidate.z < 0) continue
      if (candidate.x * CHUNK_SIZE >= document.dimensions.x || candidate.y * CHUNK_SIZE >= document.dimensions.y || candidate.z * CHUNK_SIZE >= document.dimensions.z) continue
      dirty.add(chunkId(candidate.x, candidate.y, candidate.z))
    }
  }
  return dirty
}

export function voxelLine(from: Vec3, to: Vec3) {
  const distance = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), Math.abs(to.z - from.z))
  if (!distance) return [{ ...from }]
  const cells: Vec3[] = []
  let previous = ''
  for (let step = 0; step <= distance; step++) {
    const t = step / distance
    const cell = {
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
      z: Math.round(from.z + (to.z - from.z) * t),
    }
    const key = `${cell.x},${cell.y},${cell.z}`
    if (key !== previous) cells.push(cell)
    previous = key
  }
  return cells
}
