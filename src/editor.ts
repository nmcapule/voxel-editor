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
export type ResizeAnchor = 'origin' | 'center'

export interface PaletteMaterial {
  name: string
  roughness: number
  metalness: number
  emissiveIntensity: number
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

export interface LayerChunkSnapshot {
  layerId: number
  data: Uint8Array
}

export interface ChunkChange {
  id: number
  before?: LayerChunkSnapshot[]
  after?: LayerChunkSnapshot[]
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
  0x8bd3c7, 0xb8e0d2, 0xa9c6ea, 0xd7e3fc, 0xffb45e, 0x63d8ff,
])

const material = (name: string, roughness: number, metalness = 0, opacity = 1, transmission = 0, ior = 1.5, emissiveIntensity = 0): PaletteMaterial => ({ name, roughness, metalness, emissiveIntensity, opacity, transmission, ior })
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
  material('Warm light', 0.3, 0, 1, 0, 1.5, 2.5),
  material('Cool light', 0.3, 0, 1, 0, 1.5, 2.5),
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

function equalChunkSnapshots(a?: LayerChunkSnapshot[], b?: LayerChunkSnapshot[]) {
  if (!a || !b || a.length !== b.length) return a === b
  return a.every((chunk, index) => chunk.layerId === b[index].layerId && equalChunks(chunk.data, b[index].data))
}

export function normalizeDimensions(dimensions: Dimensions): Dimensions {
  return {
    x: Math.max(16, Math.min(256, Math.round(dimensions.x))),
    y: Math.max(16, Math.min(256, Math.round(dimensions.y))),
    z: Math.max(16, Math.min(256, Math.round(dimensions.z))),
  }
}

export class VoxelDocument {
  readonly chunks = new Map<number, Map<number, Uint8Array>>()
  readonly palette: Uint32Array
  readonly materials: PaletteMaterial[]
  readonly dimensions: Dimensions
  readonly layers: VoxelLayer[]
  activeLayerId: number
  name: string
  voxelCount = 0

  constructor(dimensions: Dimensions = { x: 32, y: 32, z: 32 }, name = 'Untitled', palette: ArrayLike<number> = DEFAULT_PALETTE, materials?: readonly Partial<PaletteMaterial>[], layers?: readonly VoxelLayer[], activeLayerId?: number) {
    this.dimensions = normalizeDimensions(dimensions)
    this.name = name.trim().slice(0, 60) || 'Untitled'
    this.palette = new Uint32Array(256)
    this.palette.set(palette)
    const addedPresetStart = DEFAULT_PALETTE.length - 2
    const legacyDefaultPalette = !this.palette[addedPresetStart] && !this.palette[addedPresetStart + 1]
      && DEFAULT_PALETTE.subarray(0, addedPresetStart).every((color, index) => this.palette[index] === color)
    if (legacyDefaultPalette) this.palette.set(DEFAULT_PALETTE.subarray(addedPresetStart), addedPresetStart)
    const defaultPalette = DEFAULT_PALETTE.every((color, index) => this.palette[index] === color)
    const presets = materials ?? (defaultPalette ? DEFAULT_PALETTE_MATERIALS : [])
    this.materials = Array.from({ length: 256 }, (_, index) => {
      const preset = legacyDefaultPalette && index >= addedPresetStart && index < DEFAULT_PALETTE.length ? undefined : presets[index]
      const fallback = defaultPalette ? DEFAULT_PALETTE_MATERIALS[index] ?? DEFAULT_MATERIAL : DEFAULT_MATERIAL
      return {
        name: typeof preset?.name === 'string' && preset.name.trim() ? preset.name.trim().slice(0, 40) : fallback.name === 'Matte' ? `Color ${index}` : fallback.name,
        roughness: materialValue(preset?.roughness, fallback.roughness),
        metalness: materialValue(preset?.metalness, fallback.metalness),
        emissiveIntensity: materialValue(preset?.emissiveIntensity, fallback.emissiveIntensity, 0, 5),
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
    for (const [chunkId, layers] of this.chunks) {
      const colors = layers.get(id)
      if (!colors) continue
      for (const color of colors) if (color) this.voxelCount--
      layers.delete(id)
      changed.push(chunkId)
      if (!layers.size) this.chunks.delete(chunkId)
    }
    this.layers.splice(index, 1)
    if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.min(index, this.layers.length - 1)].id
    return changed
  }

  layerVoxelCount(id: number) {
    let count = 0
    for (const layers of this.chunks.values()) for (const color of layers.get(id) ?? []) if (color) count++
    return count
  }

  contains(x: number, y: number, z: number) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.dimensions.x && y < this.dimensions.y && z < this.dimensions.z
  }

  idAt(x: number, y: number, z: number) {
    return chunkId(x >> 4, y >> 4, z >> 4)
  }

  getVoxel(x: number, y: number, z: number) {
    return this.resolveVoxel(x, y, z)?.color ?? 0
  }

  getVoxelLayer(x: number, y: number, z: number) {
    return this.resolveVoxel(x, y, z)?.layerId ?? 0
  }

  getVisibleVoxel(x: number, y: number, z: number) {
    return this.resolveVoxel(x, y, z, true)?.color ?? 0
  }

  getVisibleVoxelLayer(x: number, y: number, z: number) {
    return this.resolveVoxel(x, y, z, true)?.layerId ?? 0
  }

  getLayerVoxel(x: number, y: number, z: number, layerId = this.activeLayerId) {
    if (!this.contains(x, y, z)) return 0
    return this.chunks.get(this.idAt(x, y, z))?.get(layerId)?.[chunkIndex(x & 15, y & 15, z & 15)] ?? 0
  }

  private resolveVoxel(x: number, y: number, z: number, visibleOnly = false) {
    if (!this.contains(x, y, z)) return
    const layers = this.chunks.get(this.idAt(x, y, z))
    if (!layers) return
    const index = chunkIndex(x & 15, y & 15, z & 15)
    for (let layerIndex = this.layers.length - 1; layerIndex >= 0; layerIndex--) {
      const layer = this.layers[layerIndex]
      if (visibleOnly && !layer.visible) continue
      const color = layers.get(layer.id)?.[index] ?? 0
      if (color) return { color, layerId: layer.id }
    }
  }

  setVoxel(x: number, y: number, z: number, color: number, layerId?: number) {
    if (!this.contains(x, y, z)) return false
    const targetLayer = layerId ?? this.activeLayerId
    if (!this.getLayer(targetLayer)) return false
    const id = this.idAt(x, y, z)
    let layers = this.chunks.get(id)
    let chunk = layers?.get(targetLayer)
    if (!chunk) {
      if (color === 0) return false
      layers ??= new Map<number, Uint8Array>()
      chunk = new Uint8Array(CHUNK_VOLUME)
      layers.set(targetLayer, chunk)
      this.chunks.set(id, layers)
    }
    const index = chunkIndex(x & 15, y & 15, z & 15)
    const before = chunk[index]
    if (before === color) return false
    chunk[index] = color
    if (before === 0) this.voxelCount++
    if (color === 0) this.voxelCount--
    if (color === 0 && !chunk.some(Boolean)) {
      layers!.delete(targetLayer)
      if (!layers!.size) this.chunks.delete(id)
    }
    return true
  }

  copyChunk(id: number) {
    const layers = this.chunks.get(id)
    if (!layers) return undefined
    return this.layers.flatMap(layer => {
      const data = layers.get(layer.id)
      return data ? [{ layerId: layer.id, data: data.slice() }] : []
    })
  }

  replaceChunk(id: number, snapshot?: LayerChunkSnapshot[]) {
    const previous = this.chunks.get(id)
    if (previous) for (const chunk of previous.values()) for (const color of chunk) if (color) this.voxelCount--
    this.chunks.delete(id)
    const layers = new Map<number, Uint8Array>()
    for (const stored of snapshot ?? []) {
      if (!this.getLayer(stored.layerId) || stored.data.length !== CHUNK_VOLUME || !stored.data.some(Boolean)) continue
      const data = stored.data.slice()
      layers.set(stored.layerId, data)
      for (const color of data) if (color) this.voxelCount++
    }
    if (layers.size) this.chunks.set(id, layers)
  }

  replaceLegacyChunk(id: number, data: Uint8Array, layerData?: Uint16Array) {
    const layers = new Map<number, Uint8Array>()
    for (let index = 0; index < data.length; index++) {
      if (!data[index]) continue
      const layerId = this.getLayer(layerData?.[index] ?? 0)?.id ?? this.layers[0].id
      let chunk = layers.get(layerId)
      if (!chunk) { chunk = new Uint8Array(CHUNK_VOLUME); layers.set(layerId, chunk) }
      chunk[index] = data[index]
    }
    this.replaceChunk(id, [...layers].map(([layerId, chunk]) => ({ layerId, data: chunk })))
  }

  fillChunkRegion(id: number, from: Vec3, to: Vec3, color: number, layerId = this.activeLayerId) {
    let layers = this.chunks.get(id)
    let chunk = layers?.get(layerId)
    if (!chunk) {
      if (color === 0) return false
      layers ??= new Map<number, Uint8Array>()
      chunk = new Uint8Array(CHUNK_VOLUME)
      layers.set(layerId, chunk)
      this.chunks.set(id, layers)
    }
    let changed = false
    for (let z = from.z; z <= to.z; z++) {
      for (let y = from.y; y <= to.y; y++) {
        for (let x = from.x; x <= to.x; x++) {
          const index = chunkIndex(x, y, z)
          const before = chunk[index]
          if (before === color) continue
          chunk[index] = color
          if (before === 0) this.voxelCount++
          if (color === 0) this.voxelCount--
          changed = true
        }
      }
    }
    if (color === 0 && !chunk.some(Boolean)) {
      layers!.delete(layerId)
      if (!layers!.size) this.chunks.delete(id)
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
    for (const [id, layers] of this.chunks) {
      const origin = chunkCoords(id)
      for (const layer of this.layers) {
        const chunk = layers.get(layer.id)
        if (!chunk) continue
        for (let z = 0; z < CHUNK_SIZE; z++) {
          for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
              const color = chunk[chunkIndex(x, y, z)]
              if (color) visitor(origin.x * CHUNK_SIZE + x, origin.y * CHUNK_SIZE + y, origin.z * CHUNK_SIZE + z, color, layer.id)
            }
          }
        }
      }
    }
  }

  forEachVisibleVoxel(visitor: (x: number, y: number, z: number, color: number, layerId: number) => void) {
    for (const id of this.chunks.keys()) {
      const origin = chunkCoords(id)
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let y = 0; y < CHUNK_SIZE; y++) {
          for (let x = 0; x < CHUNK_SIZE; x++) {
            const position = { x: origin.x * CHUNK_SIZE + x, y: origin.y * CHUNK_SIZE + y, z: origin.z * CHUNK_SIZE + z }
            const resolved = this.resolveVoxel(position.x, position.y, position.z, true)
            if (resolved) visitor(position.x, position.y, position.z, resolved.color, resolved.layerId)
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

function resizeOffset(source: Dimensions, target: Dimensions, anchor: ResizeAnchor) {
  return anchor === 'center' ? {
    x: Math.trunc((target.x - source.x) / 2),
    y: Math.trunc((target.y - source.y) / 2),
    z: Math.trunc((target.z - source.z) / 2),
  } : { x: 0, y: 0, z: 0 }
}

export function croppedVoxelCount(source: VoxelDocument, dimensions: Dimensions, anchor: ResizeAnchor) {
  const target = normalizeDimensions(dimensions)
  const offset = resizeOffset(source.dimensions, target, anchor)
  let cropped = 0
  source.forEachVoxel((x, y, z) => {
    if (x + offset.x < 0 || y + offset.y < 0 || z + offset.z < 0 || x + offset.x >= target.x || y + offset.y >= target.y || z + offset.z >= target.z) cropped++
  })
  return cropped
}

export function resizeVoxelDocument(source: VoxelDocument, dimensions: Dimensions, anchor: ResizeAnchor) {
  const resized = new VoxelDocument(dimensions, source.name, source.palette, source.materials, source.layers, source.activeLayerId)
  const offset = resizeOffset(source.dimensions, resized.dimensions, anchor)
  let cropped = 0
  source.forEachVoxel((x, y, z, color, layerId) => {
    x += offset.x; y += offset.y; z += offset.z
    if (resized.contains(x, y, z)) resized.setVoxel(x, y, z, color, layerId)
    else cropped++
  })
  return { document: resized, cropped }
}

export function* fillShapeVoxels(min: Vec3, max: Vec3, shape: FillShape, axis: keyof Vec3, dimensions: Dimensions) {
  const from = {
    x: Math.max(0, Math.min(min.x, max.x)),
    y: Math.max(0, Math.min(min.y, max.y)),
    z: Math.max(0, Math.min(min.z, max.z)),
  }
  const to = {
    x: Math.min(dimensions.x - 1, Math.max(min.x, max.x)),
    y: Math.min(dimensions.y - 1, Math.max(min.y, max.y)),
    z: Math.min(dimensions.z - 1, Math.max(min.z, max.z)),
  }
  const center = { x: (from.x + to.x + 1) / 2, y: (from.y + to.y + 1) / 2, z: (from.z + to.z + 1) / 2 }
  const radius = { x: (to.x - from.x + 1) / 2, y: (to.y - from.y + 1) / 2, z: (to.z - from.z + 1) / 2 }
  for (let z = from.z; z <= to.z; z++) {
    for (let y = from.y; y <= to.y; y++) {
      for (let x = from.x; x <= to.x; x++) {
        const distance = { x: (x + 0.5 - center.x) / radius.x, y: (y + 0.5 - center.y) / radius.y, z: (z + 0.5 - center.z) / radius.z }
        const inside = shape === 'box' || shape === 'sphere' && distance.x ** 2 + distance.y ** 2 + distance.z ** 2 <= 1
          || shape === 'cylinder' && (axis === 'x' ? distance.y ** 2 + distance.z ** 2 <= 1
            : axis === 'y' ? distance.x ** 2 + distance.z ** 2 <= 1
              : distance.x ** 2 + distance.y ** 2 <= 1)
        if (inside) yield { x, y, z }
      }
    }
  }
}

export class EditSession {
  private before = new Map<number, LayerChunkSnapshot[] | undefined>()
  private changed = new Set<number>()
  private document: VoxelDocument
  private layerId: number

  constructor(document: VoxelDocument, layerId = document.activeLayerId) {
    this.document = document
    this.layerId = layerId
  }

  private capture(id: number) {
    if (!this.before.has(id)) this.before.set(id, this.document.copyChunk(id))
  }

  private editable(layerId = this.layerId) {
    const layer = this.document.getLayer(layerId)
    return Boolean(layer?.visible && !layer.locked)
  }

  set(x: number, y: number, z: number, color: number) {
    if (!this.editable() || !this.document.contains(x, y, z)) return false
    const id = this.document.idAt(x, y, z)
    this.capture(id)
    if (!this.document.setVoxel(x, y, z, color, this.layerId)) return false
    this.changed.add(id)
    return true
  }

  reassign(cells: Vec3[], targetLayerId: number) {
    if (!this.editable() || !this.editable(targetLayerId)) return
    for (const cell of cells) {
      const color = this.document.getLayerVoxel(cell.x, cell.y, cell.z, this.layerId)
      if (!color) continue
      const id = this.document.idAt(cell.x, cell.y, cell.z)
      this.capture(id)
      const removed = this.document.setVoxel(cell.x, cell.y, cell.z, 0, this.layerId)
      const added = this.document.setVoxel(cell.x, cell.y, cell.z, color, targetLayerId)
      if (removed || added) this.changed.add(id)
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
    for (const cell of fillShapeVoxels(min, max, shape, axis, this.document.dimensions)) this.set(cell.x, cell.y, cell.z, color)
  }

  commit(): EditCommand | undefined {
    const changes: ChunkChange[] = []
    let bytes = 0
    for (const id of this.changed) {
      const before = this.before.get(id)
      const after = this.document.copyChunk(id)
      if (equalChunkSnapshots(before, after)) continue
      bytes += [...before ?? [], ...after ?? []].reduce((sum, chunk) => sum + chunk.data.byteLength, 0)
      changes.push({ id, before, after })
    }
    return changes.length ? { changes, bytes } : undefined
  }

  cancel() {
    for (const [id, before] of this.before) this.document.replaceChunk(id, before)
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
    for (const change of command.changes) document.replaceChunk(change.id, change.before)
    this.redoStack.push(command)
    this.bytes -= command.bytes
    return { ids: command.changes.map(change => change.id), selection: command.selectionBefore, layerId: command.layerBefore }
  }

  redo(document: VoxelDocument): HistoryResult | undefined {
    const command = this.redoStack.pop()
    if (!command) return
    for (const change of command.changes) document.replaceChunk(change.id, change.after)
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

export function pushPullRange(document: VoxelDocument, cells: Vec3[], normal: Vec3, layerId = document.activeLayerId) {
  let pull = Infinity
  let push = Infinity
  for (const cell of cells) {
    let free = 0
    while (document.contains(cell.x + normal.x * (free + 1), cell.y + normal.y * (free + 1), cell.z + normal.z * (free + 1))
      && !document.getLayerVoxel(cell.x + normal.x * (free + 1), cell.y + normal.y * (free + 1), cell.z + normal.z * (free + 1), layerId)) free++
    pull = Math.min(pull, free)

    let filled = 0
    while (document.getLayerVoxel(cell.x - normal.x * filled, cell.y - normal.y * filled, cell.z - normal.z * filled, layerId)) filled++
    push = Math.min(push, filled)
  }
  return { pull: Number.isFinite(pull) ? pull : 0, push: Number.isFinite(push) ? push : 0 }
}

export function moveRange(document: VoxelDocument, cells: Vec3[], normal: Vec3) {
  const available = (direction: number) => {
    let limit = Infinity
    for (const cell of cells) {
      let free = 0
      while (document.contains(
        cell.x + normal.x * direction * (free + 1),
        cell.y + normal.y * direction * (free + 1),
        cell.z + normal.z * direction * (free + 1),
      )) free++
      limit = Math.min(limit, free)
    }
    return Number.isFinite(limit) ? limit : 0
  }
  return { pull: available(1), push: available(-1) }
}

export function moveVoxels(document: VoxelDocument, session: EditSession, cells: Vec3[], normal: Vec3, distance: number, layerId = document.activeLayerId) {
  const moving = cells.map(cell => ({ ...cell, color: document.getLayerVoxel(cell.x, cell.y, cell.z, layerId) })).filter(cell => cell.color)
  if (!moving.length) return 0
  const range = moveRange(document, moving, normal)
  const amount = Math.max(-range.push, Math.min(range.pull, Math.round(distance)))
  if (!amount) return 0
  for (const cell of moving) session.set(cell.x, cell.y, cell.z, 0)
  for (const cell of moving) session.set(cell.x + normal.x * amount, cell.y + normal.y * amount, cell.z + normal.z * amount, cell.color)
  return amount
}

export function pushPull(document: VoxelDocument, session: EditSession, cells: Vec3[], normal: Vec3, distance: number, layerId = document.activeLayerId) {
  const range = pushPullRange(document, cells, normal, layerId)
  const amount = Math.max(-range.push, Math.min(range.pull, Math.round(distance)))
  if (amount > 0) {
    for (const cell of cells) {
      const color = document.getLayerVoxel(cell.x, cell.y, cell.z, layerId)
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

export function surfaceVoxels(document: VoxelDocument, min: Vec3, max: Vec3, normal: Vec3, layerId?: number) {
  const cells: Vec3[] = []
  for (let z = min.z; z <= max.z; z++) {
    for (let y = min.y; y <= max.y; y++) {
      for (let x = min.x; x <= max.x; x++) {
        if (document.getVisibleVoxel(x, y, z) && (layerId === undefined || document.getVisibleVoxelLayer(x, y, z) === layerId)
          && !document.getVisibleVoxel(x + normal.x, y + normal.y, z + normal.z)) cells.push({ x, y, z })
      }
    }
  }
  return cells
}

export function occupiedVoxels(document: VoxelDocument, min: Vec3, max: Vec3, layerId?: number) {
  const cells: Vec3[] = []
  document.forEachVisibleVoxel((x, y, z, _color, owner) => {
    if ((layerId === undefined || owner === layerId)
      && x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z) cells.push({ x, y, z })
  })
  return cells
}

export function connectedSurfaceVoxels(document: VoxelDocument, start: Vec3, normal: Vec3, color?: number) {
  const cells: Vec3[] = []
  const pending = [{ ...start }]
  const visited = new Set<number>()
  const layerId = document.getVisibleVoxelLayer(start.x, start.y, start.z)
  const axes = (['x', 'y', 'z'] as const).filter(axis => normal[axis] === 0)
  for (let index = 0; index < pending.length; index++) {
    const cell = pending[index]
    const key = cell.x + cell.y * document.dimensions.x + cell.z * document.dimensions.x * document.dimensions.y
    if (visited.has(key)) continue
    visited.add(key)
    const cellColor = document.getVisibleVoxel(cell.x, cell.y, cell.z)
    if (!cellColor || document.getVisibleVoxelLayer(cell.x, cell.y, cell.z) !== layerId || color !== undefined && cellColor !== color
      || document.getVisibleVoxel(cell.x + normal.x, cell.y + normal.y, cell.z + normal.z)) continue
    cells.push(cell)
    for (const axis of axes) {
      for (const step of [-1, 1]) {
        const neighbor = { ...cell, [axis]: cell[axis] + step }
        if (document.contains(neighbor.x, neighbor.y, neighbor.z)) pending.push(neighbor)
      }
    }
  }
  return cells
}

export function connectedBodyVoxels(document: VoxelDocument, start: Vec3, color?: number) {
  const cells: Vec3[] = []
  const pending = [{ ...start }]
  const visited = new Set<number>()
  const layerId = document.getVisibleVoxelLayer(start.x, start.y, start.z)
  for (let index = 0; index < pending.length; index++) {
    const cell = pending[index]
    const key = cell.x + cell.y * document.dimensions.x + cell.z * document.dimensions.x * document.dimensions.y
    if (visited.has(key)) continue
    visited.add(key)
    const cellColor = document.getVisibleVoxel(cell.x, cell.y, cell.z)
    if (!cellColor || document.getVisibleVoxelLayer(cell.x, cell.y, cell.z) !== layerId || color !== undefined && cellColor !== color) continue
    cells.push(cell)
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const step of [-1, 1]) {
        const neighbor = { ...cell, [axis]: cell[axis] + step }
        if (document.contains(neighbor.x, neighbor.y, neighbor.z)) pending.push(neighbor)
      }
    }
  }
  return cells
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
