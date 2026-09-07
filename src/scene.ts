import { Box3, Frustum, Matrix4, Quaternion, Ray, Vector3 } from 'three'
import { CHUNK_SIZE, CHUNK_VOLUME, chunkCoords, type Vec3, type VoxelLayer } from './editor'
import { parseCommand, parseProjectSnapshot } from './protocol'
import { StudioCommandError } from './studio'
import type { ViewSettings } from './storage'
import { MAX_SCENE_INSTANCES, SCENE_EXTENT, WORLD_CELL_SIZE, type SceneAsset, type SceneBounds, type SceneChange, type SceneChunk, type SceneCommand, type SceneInstance, type SceneManifest, type SceneTransform } from './scene-types'

const HISTORY_BYTES = 8 * 1024 * 1024
const METADATA_BYTES = 128 * 1024 * 1024
const MAX_CHUNKS = 262_144
const axes = ['x', 'y', 'z'] as const
const emptyChange = (): SceneChange => ({ changed: false, instanceIds: [], assetIds: [], selectionChanged: false })

function invalid(message: string): never { throw new StudioCommandError('invalid_argument', message) }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid('Expected a plain object.')
  const allowed = keys.split(' ')
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unknown scene property: ${key}.`)
  return value as Record<string, unknown>
}
function list(value: unknown, max = MAX_SCENE_INSTANCES): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`Expected an array with at most ${max} entries.`)
  return value
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`Expected a non-empty string of at most ${max} characters.`)
  return value
}
function number(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) invalid(`Expected ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}.`)
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('Expected a boolean.')
  return value
}
function vector(value: unknown, min: number, max: number, integer = false): Vec3 {
  const v = object(value, 'x y z')
  return { x: number(v.x, min, max, integer), y: number(v.y, min, max, integer), z: number(v.z, min, max, integer) }
}
function layer(value: unknown): VoxelLayer {
  const v = object(value, 'id name visible locked')
  return { id: number(v.id, 1, 65535, true), name: text(v.name, 40), visible: boolean(v.visible), locked: boolean(v.locked) }
}
function settings(value: unknown): ViewSettings {
  const parsed = parseCommand({ type: 'settings.update', patch: value })
  if (parsed.type !== 'settings.update') invalid('Invalid settings.')
  for (const key of ['background', 'ambient', 'light', 'lightAzimuth', 'ambientOcclusion', 'shadows', 'grid', 'faceGrid', 'projection', 'pathTracing']) {
    if (parsed.patch[key as keyof ViewSettings] === undefined) invalid(`Missing scene setting: ${key}.`)
  }
  return parsed.patch as ViewSettings
}
function bounds(value: unknown, dimensions: Vec3): SceneBounds {
  const v = object(value, 'min max')
  const min = vector(v.min, 0, 256, true), max = vector(v.max, 0, 256, true)
  for (const axis of axes) if (min[axis] >= max[axis] || max[axis] > dimensions[axis]) invalid('Invalid model-space bounds.')
  return { min, max }
}
function transform(value: unknown, extent: Vec3): SceneTransform {
  const v = value as Record<string, unknown>
  const position = vector(v.position, -SCENE_EXTENT, SCENE_EXTENT)
  if (Math.abs(position.x) > extent.x / 2 || Math.abs(position.z) > extent.z / 2 || position.y < 0 || position.y > extent.y) invalid('Instance pivot is outside the scene extent.')
  const scale = vector(v.scale, 0.01, 256)
  const q = object(v.rotation, 'x y z w')
  const components = ['x', 'y', 'z', 'w'].map(key => number(q[key], -Number.MAX_VALUE, Number.MAX_VALUE))
  const largest = Math.max(...components.map(Math.abs))
  if (!largest) invalid('Rotation quaternion must not be zero.')
  const length = Math.hypot(...components.map(value => value / largest))
  const [x, y, z, w] = components.map(value => value / largest / length)
  return { position, rotation: { x, y, z, w }, scale }
}

/** Bounds use model coordinates and exclusive maxima; palette index 0 alone is empty. */
export function parseSceneAsset(value: unknown): SceneAsset {
  const v = object(value, 'id revision model chunks pivot bounds voxelCount source')
  text(v.id); number(v.revision, 0, Number.MAX_SAFE_INTEGER, true)
  const header = object(v.model, 'schema version name dimensions palette paletteOccupied materials layers activeLayerId settings')
  if (list(header.palette, 256).length !== 256 || list(header.materials, 256).length !== 256) invalid('Model palette and materials must have 256 entries.')
  for (const color of header.palette as unknown[]) number(color, 0, 0xffffff, true)
  for (const material of header.materials as unknown[]) object(material, 'name roughness metalness emissiveIntensity opacity transmission ior')
  if (header.paletteOccupied !== undefined && list(header.paletteOccupied, 256).length !== 256) invalid('Model palette occupancy must have 256 entries.')
  for (const value of list(header.layers)) layer(value)
  vector(header.dimensions, 16, 256, true)
  // Preflight sizes before the project parser, whose legacy arrays are not bounded.
  const { chunks: _chunks, ...model } = parseProjectSnapshot({ ...header, chunks: [] })
  const rawChunks = list(v.chunks, MAX_CHUNKS)
  if (assetBytes({ model, chunks: rawChunks } as SceneAsset) > METADATA_BYTES) invalid('Asset metadata exceeds 128 MiB.')
  const layerIds = new Set(model.layers.map(layer => layer.id))
  const keys = new Set<string>()
  let count = 0
  let aggregate: SceneBounds | undefined
  const chunks = Array.from(rawChunks, value => {
    const c = object(value, 'id layerId blob count bounds colors lod')
    const id = number(c.id, 0, 4095, true), layerId = number(c.layerId, 1, 65535, true)
    const key = `${id}:${layerId}`
    if (keys.has(key) || !layerIds.has(layerId)) invalid('Duplicate chunk or unknown model layer.')
    keys.add(key)
    if (typeof c.blob !== 'string' || !/^[a-f0-9]{64}$/.test(c.blob)) invalid('Chunk blob must be a lowercase SHA-256 hash.')
    const chunkBounds = bounds(c.bounds, model.dimensions)
    const origin = chunkCoords(id)
    for (const axis of axes) if (chunkBounds.min[axis] < origin[axis] * CHUNK_SIZE || chunkBounds.max[axis] > (origin[axis] + 1) * CHUNK_SIZE) invalid('Chunk bounds do not match its id.')
    const chunkCount = number(c.count, 1, CHUNK_VOLUME, true)
    const volume = axes.reduce((n, axis) => n * (chunkBounds.max[axis] - chunkBounds.min[axis]), 1)
    if (chunkCount > volume) invalid('Chunk count exceeds its bounds.')
    const colors = Array.from(list(c.colors, 255), color => number(color, 1, 255, true))
    const colorSet = new Set(colors)
    if (!colors.length || colors.length > chunkCount || colorSet.size !== colors.length) invalid('Invalid chunk color usage.')
    const lod = Array.from(list(c.lod, 64), color => number(color, 0, 255, true))
    if (lod.length !== 64 || !lod.some(Boolean) || lod.some(color => color !== 0 && !colorSet.has(color))) invalid('Invalid chunk LOD.')
    let occupiedLod = 0
    for (let i = 0; i < 64; i++) if (lod[i]) {
      occupiedLod++
      const local = { x: i % 4, y: Math.floor(i / 4) % 4, z: Math.floor(i / 16) }
      for (const axis of axes) if (origin[axis] * 16 + local[axis] * 4 >= chunkBounds.max[axis] || origin[axis] * 16 + (local[axis] + 1) * 4 <= chunkBounds.min[axis]) invalid('LOD is outside chunk bounds.')
    }
    if (occupiedLod > chunkCount || chunkCount > occupiedLod * 64) invalid('LOD occupancy disagrees with chunk count.')
    count += chunkCount
    aggregate = unionBounds(aggregate, chunkBounds)
    // Validation does not clone immutable descriptors, including their shared LOD arrays.
    return value as SceneChunk
  })
  if (number(v.voxelCount, 0, Number.MAX_SAFE_INTEGER, true) !== count) invalid('Asset voxel count disagrees with its chunks.')
  const assetBounds = v.bounds === undefined ? undefined : bounds(v.bounds, model.dimensions)
  if (Boolean(assetBounds) !== Boolean(aggregate) || aggregate && axes.some(axis => assetBounds!.min[axis] > aggregate!.min[axis] || assetBounds!.max[axis] < aggregate!.max[axis])) invalid('Asset bounds must contain all chunks.')
  const pivot = vector(v.pivot, 0, 256)
  for (const axis of axes) if (pivot[axis] > model.dimensions[axis]) invalid('Asset pivot is outside model dimensions.')
  let source: SceneAsset['source']
  if (v.source !== undefined) {
    const s = object(v.source, 'id version')
    source = { id: text(s.id), version: number(s.version, 1, Number.MAX_SAFE_INTEGER, true) }
  }
  return { id: v.id as string, revision: v.revision as number, model, chunks, pivot, bounds: assetBounds, voxelCount: count, ...(source ? { source } : {}) }
}

export function unionBounds(a: SceneBounds | undefined, b: SceneBounds): SceneBounds {
  return { min: { x: Math.min(a?.min.x ?? Infinity, b.min.x), y: Math.min(a?.min.y ?? Infinity, b.min.y), z: Math.min(a?.min.z ?? Infinity, b.min.z) }, max: { x: Math.max(a?.max.x ?? -Infinity, b.max.x), y: Math.max(a?.max.y ?? -Infinity, b.max.y), z: Math.max(a?.max.z ?? -Infinity, b.max.z) } }
}

function instance(value: unknown, extent: Vec3, assets: Map<string, SceneAsset>, layers: Map<number, VoxelLayer>): SceneInstance {
  const v = object(value, 'id assetId name layerId position rotation scale')
  const id = text(v.id), assetId = text(v.assetId), layerId = number(v.layerId, 1, 65535, true)
  if (!assets.has(assetId) || !layers.has(layerId)) invalid('Instance references an unknown asset or layer.')
  return { id, assetId, name: text(v.name, 60), layerId, ...transform(v, extent) }
}

export function parseSceneManifest(value: unknown): SceneManifest {
  const v = object(value, 'schema version id name revision extent settings layers activeLayerId assets instances')
  if (v.schema !== 'voxel-studio/scene' || v.version !== 1) invalid('Unsupported scene manifest.')
  const extent = vector(v.extent, 1, SCENE_EXTENT, true)
  const rawAssets = list(v.assets), rawInstances = list(v.instances), rawLayers = list(v.layers)
  let budget = rawInstances.length * 1024 + rawLayers.length * 256, chunkCount = 0
  for (const value of rawAssets) {
    const asset = object(value, 'id revision model chunks pivot bounds voxelCount source')
    const model = object(asset.model, 'schema version name dimensions palette paletteOccupied materials layers activeLayerId settings')
    const chunks = list(asset.chunks, MAX_CHUNKS)
    const layers = list(model.layers)
    chunkCount += chunks.length
    budget += assetBytes({ model: { layers }, chunks } as SceneAsset)
    if (budget > METADATA_BYTES || chunkCount > MAX_CHUNKS) invalid('Scene metadata exceeds its bounded capacity.')
  }
  const layers = Array.from(rawLayers, layer)
  const layerMap = new Map(layers.map(layer => [layer.id, layer]))
  if (!layers.length || layerMap.size !== layers.length) invalid('Scene layers must be non-empty and unique.')
  const activeLayerId = number(v.activeLayerId, 1, 65535, true)
  if (!layerMap.has(activeLayerId)) invalid('Unknown active scene layer.')
  const assets = Array.from(rawAssets, parseSceneAsset)
  const assetMap = new Map(assets.map(asset => [asset.id, asset]))
  if (assetMap.size !== assets.length) invalid('Duplicate scene asset id.')
  const instances = Array.from(rawInstances, value => instance(value, extent, assetMap, layerMap))
  if (new Set(instances.map(instance => instance.id)).size !== instances.length) invalid('Duplicate scene instance id.')
  return { schema: 'voxel-studio/scene', version: 1, id: text(v.id), name: text(v.name, 60), revision: number(v.revision, 0, Number.MAX_SAFE_INTEGER, true), extent, settings: settings(v.settings), layers, activeLayerId, assets, instances }
}

export function createScene(view: ViewSettings, name = 'Untitled scene'): SceneManifest {
  return { schema: 'voxel-studio/scene', version: 1, id: crypto.randomUUID(), name: text(name, 60), revision: 0, extent: { x: SCENE_EXTENT, y: SCENE_EXTENT, z: SCENE_EXTENT }, settings: settings(view), layers: [{ id: 1, name: 'Layer 1', visible: true, locked: false }], activeLayerId: 1, assets: [], instances: [] }
}

export function instanceMatrix(instance: SceneTransform, asset: Pick<SceneAsset, 'pivot'>): Matrix4 {
  return new Matrix4().compose(new Vector3().copy(instance.position), new Quaternion().copy(instance.rotation), new Vector3().copy(instance.scale))
    .multiply(new Matrix4().makeTranslation(-asset.pivot.x, -asset.pivot.y, -asset.pivot.z))
}

/** Sparse broad phase. Queries return visible instance ids; ray hits are AABB distances, not voxel hits. */
export class WorldIndex {
  readonly cells = new Map<string, Set<string>>()
  readonly membership = new Map<string, string[]>()
  readonly oversized = new Set<string>()
  readonly bounds = new Map<string, Box3>()
  updateCount = 0

  constructor(scene?: SceneManifest) {
    if (!scene) return
    const assets = new Map(scene.assets.map(asset => [asset.id, asset]))
    const layers = new Map(scene.layers.map(layer => [layer.id, layer]))
    for (const instance of scene.instances) this.update(instance, assets.get(instance.assetId)!, layers.get(instance.layerId)!.visible)
  }

  remove(id: string) {
    for (const key of this.membership.get(id) ?? []) {
      const cell = this.cells.get(key)!
      cell.delete(id)
      if (!cell.size) this.cells.delete(key)
    }
    this.membership.delete(id); this.oversized.delete(id); this.bounds.delete(id)
  }

  update(instance: SceneInstance, asset: SceneAsset, visible = true) {
    this.updateCount++
    this.remove(instance.id)
    if (!visible) return
    const local = asset.bounds ?? { min: { x: 0, y: 0, z: 0 }, max: asset.model.dimensions }
    const box = new Box3(new Vector3().copy(local.min), new Vector3().copy(local.max)).applyMatrix4(instanceMatrix(instance, asset))
    this.bounds.set(instance.id, box)
    const min = box.min.clone().divideScalar(WORLD_CELL_SIZE).floor(), max = box.max.clone().divideScalar(WORLD_CELL_SIZE).floor()
    if ((max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1) > 512) {
      this.oversized.add(instance.id)
      this.membership.set(instance.id, [])
      return
    }
    const membership: string[] = []
    for (let z = min.z; z <= max.z; z++) for (let y = min.y; y <= max.y; y++) for (let x = min.x; x <= max.x; x++) {
      const key = `${x},${y},${z}`, cell = this.cells.get(key) ?? new Set<string>()
      cell.add(instance.id); this.cells.set(key, cell); membership.push(key)
    }
    this.membership.set(instance.id, membership)
  }

  queryBox(box: Box3): string[] {
    if (box.isEmpty()) return []
    const ids = new Set(this.oversized)
    const min = box.min.clone().divideScalar(WORLD_CELL_SIZE).floor(), max = box.max.clone().divideScalar(WORLD_CELL_SIZE).floor()
    const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1)
    if (volume <= this.cells.size) {
      for (let z = min.z; z <= max.z; z++) for (let y = min.y; y <= max.y; y++) for (let x = min.x; x <= max.x; x++) for (const id of this.cells.get(`${x},${y},${z}`) ?? []) ids.add(id)
    } else {
      for (const [key, cell] of this.cells) {
        const [x, y, z] = key.split(',').map(Number)
        if (x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z) for (const id of cell) ids.add(id)
      }
    }
    return [...ids].filter(id => box.intersectsBox(this.bounds.get(id)!))
  }

  queryFrustum(frustum: Frustum): string[] { return this.queryCells(box => frustum.intersectsBox(box)) }

  queryRay(ray: Ray, maxDistance = Infinity): { id: string; distance: number }[] {
    const hit = new Vector3()
    const intersects = (box: Box3) => box.containsPoint(ray.origin) || Boolean(ray.intersectBox(box, hit) && hit.distanceTo(ray.origin) <= maxDistance)
    return this.queryCells(intersects).map(id => {
      const box = this.bounds.get(id)!
      return { id, distance: box.containsPoint(ray.origin) ? 0 : ray.intersectBox(box, hit)!.distanceTo(ray.origin) }
    }).sort((a, b) => a.distance - b.distance)
  }

  private queryCells(intersects: (box: Box3) => boolean): string[] {
    const ids = new Set(this.oversized), box = new Box3()
    for (const [key, cell] of this.cells) {
      const [x, y, z] = key.split(',').map(Number)
      box.min.set(x, y, z).multiplyScalar(WORLD_CELL_SIZE)
      box.max.copy(box.min).addScalar(WORLD_CELL_SIZE)
      if (intersects(box)) for (const id of cell) ids.add(id)
    }
    return [...ids].filter(id => intersects(this.bounds.get(id)!))
  }
}

type Delta<T> = { before?: T; after?: T; index: number }
type Header = Pick<SceneManifest, 'name' | 'settings' | 'activeLayerId'>
type HistoryEntry = { instances: Delta<SceneInstance>[]; layers: Delta<VoxelLayer>[]; assets: Delta<SceneAsset>[]; before: Partial<Header>; after: Partial<Header>; selectionBefore: string[]; selectionAfter: string[]; bytes: number }
function assetBytes(asset: SceneAsset) {
  // Includes descriptor objects, bounds, hash strings, array overhead and 64 numeric LOD entries.
  return 96 * 1024 + asset.model.layers.length * 256 + asset.chunks.reduce((n, chunk) => n + 1536 + (Array.isArray(chunk?.colors) ? Math.min(255, chunk.colors.length) * 8 : 0), 0)
}
function historyBytes(entry: HistoryEntry) {
  return 256 + (entry.instances.length + entry.layers.length) * 512 + (entry.selectionBefore.length + entry.selectionAfter.length) * 8 + JSON.stringify({ ...entry, assets: undefined }).length * 2 + entry.assets.reduce((n, change) => n + assetBytes(change.after ?? change.before!), 0)
}
function replaceRecords<T extends { id: string | number }>(records: T[], changes: Delta<T>[], redo: boolean): T[] {
  if (!changes.length) return records
  const values = new Map(changes.map(change => [(change.after ?? change.before)!.id, redo ? change.after : change.before]))
  const next = records.flatMap(record => values.has(record.id) ? values.get(record.id) ? [values.get(record.id)!] : [] : [record])
  const present = new Set(records.map(record => record.id))
  for (const change of [...changes].sort((a, b) => a.index - b.index)) {
    const value = redo ? change.after : change.before
    if (value && !present.has(value.id)) next.splice(change.index, 0, value)
  }
  return next
}

/** data/snapshot records are immutable by convention; execute replaces only changed records. */
export class SceneDocument {
  data: SceneManifest
  selection: string[] = []
  readonly index: WorldIndex
  readonly instances = new Map<string, SceneInstance>()
  readonly assets = new Map<string, SceneAsset>()
  readonly assetInstances = new Map<string, Set<string>>()
  private layers = new Map<number, VoxelLayer>()
  private layerInstances = new Map<number, Set<string>>()
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private bytes = 0
  private metadataBytes = 0

  constructor(manifest: SceneManifest) {
    this.data = parseSceneManifest(manifest)
    for (const asset of this.data.assets) { this.assets.set(asset.id, asset); this.metadataBytes += assetBytes(asset) }
    for (const layer of this.data.layers) this.layers.set(layer.id, layer)
    for (const instance of this.data.instances) { this.instances.set(instance.id, instance); this.addReference(instance) }
    this.index = new WorldIndex(this.data)
  }

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }
  get historyBytes() { return this.bytes }
  snapshot(): SceneManifest { return this.data }

  private requireLayer(id: number, editable = false) {
    const layer = this.layers.get(id)
    if (!layer) invalid(`Unknown scene layer: ${id}.`)
    if (editable && (!layer.visible || layer.locked)) throw new StudioCommandError('not_editable', 'The target layer is hidden or locked.')
    return layer
  }
  private requireInstance(id: string, editable = true) {
    const instance = this.instances.get(id)
    if (!instance) invalid(`Unknown scene instance: ${id}.`)
    this.requireLayer(instance.layerId, editable)
    return instance
  }
  private addReference(instance: SceneInstance) {
    const assetRefs = this.assetInstances.get(instance.assetId) ?? new Set<string>(), layerRefs = this.layerInstances.get(instance.layerId) ?? new Set<string>()
    assetRefs.add(instance.id); layerRefs.add(instance.id)
    this.assetInstances.set(instance.assetId, assetRefs); this.layerInstances.set(instance.layerId, layerRefs)
  }
  private removeReference(instance: SceneInstance) {
    for (const [map, key] of [[this.assetInstances, instance.assetId], [this.layerInstances, instance.layerId]] as const) {
      // The maps have different key types but identical set values.
      const refs = (map as Map<string | number, Set<string>>).get(key)
      refs?.delete(instance.id)
      if (!refs?.size) (map as Map<string | number, Set<string>>).delete(key)
    }
  }

  execute(command: SceneCommand): SceneChange {
    if (command.type === 'history.undo' || command.type === 'history.redo') {
      const redo = command.type === 'history.redo', from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack
      const entry = from.at(-1)
      if (!entry) return emptyChange()
      for (const change of entry.instances) {
        const current = this.instances.get((change.after ?? change.before)!.id)
        const target = redo ? change.after : change.before
        for (const id of new Set([current?.layerId, target?.layerId])) if (id !== undefined && !entry.layers.some(change => (change.after ?? change.before)!.id === id)) this.requireLayer(id, true)
      }
      const result = this.apply(entry, redo)
      from.pop(); to.push(entry)
      return result
    }
    if (command.type === 'selection.set') {
      const ids = [...new Set(list(command.ids).map(id => text(id)))]
      for (const id of ids) if (!this.requireLayer(this.requireInstance(id, false).layerId).visible) invalid('Hidden instances cannot be selected.')
      const changed = ids.length !== this.selection.length || ids.some((id, i) => id !== this.selection[i])
      if (changed) this.selection = ids
      return { ...emptyChange(), changed, selectionChanged: changed }
    }
    const entry: HistoryEntry = { instances: [], assets: [], layers: [], before: {}, after: {}, selectionBefore: [...this.selection], selectionAfter: [...this.selection], bytes: 0 }
    let insertionIndex = this.data.instances.length
    let deletionIndices: Map<string, number> | undefined
    const changeInstance = (before: SceneInstance | undefined, after: SceneInstance | undefined) => {
      if (before && after && JSON.stringify(before) === JSON.stringify(after)) return
      if (before && !after) deletionIndices ??= new Map(this.data.instances.map((instance, index) => [instance.id, index]))
      entry.instances.push({ before, after, index: before ? after ? 0 : deletionIndices!.get(before.id)! : insertionIndex++ })
    }
    const header = <K extends keyof Header>(key: K, value: Header[K]) => {
      if (JSON.stringify(this.data[key]) === JSON.stringify(value)) return
      entry.before[key] = this.data[key]; entry.after[key] = value
    }
    switch (command.type) {
      case 'scene.rename': header('name', text(command.name, 60)); break
      case 'scene.settings': header('settings', settings({ ...this.data.settings, ...command.patch })); break
      case 'asset.add': case 'asset.update': {
        const previous = this.assets.get(command.asset.id)
        if (command.type === 'asset.add') {
          this.requireLayer(this.data.activeLayerId, true)
          if (previous || this.assets.size >= MAX_SCENE_INSTANCES) invalid('Duplicate asset id or asset limit reached.')
        } else {
          if (!previous) invalid('Cannot update an unknown asset.')
          // Layer locks protect instances, not the shared content saved by the model editor.
          if (previous === command.asset) return emptyChange()
          if (command.asset.revision <= previous.revision) invalid('Asset update must advance its revision.')
        }
        const asset = parseSceneAsset(command.asset)
        entry.assets.push({ before: previous, after: asset, index: previous ? this.data.assets.indexOf(previous) : this.assets.size })
        if (command.type === 'asset.update') {
          const result = this.apply(entry, true)
          // Creation history retains the latest asset, never an old model-editor revision.
          for (const old of [...this.undoStack, ...this.redoStack]) for (const change of old.assets) if (change.after?.id === asset.id) {
            this.bytes -= old.bytes; change.after = asset; old.bytes = historyBytes(old); this.bytes += old.bytes
          }
          this.trimHistory()
          return result
        }
        break
      }
      case 'instance.place': {
        const asset = this.assets.get(command.assetId)
        if (!asset) invalid('Unknown placement asset.')
        this.requireLayer(this.data.activeLayerId, true)
        const next = instance({ id: crypto.randomUUID(), assetId: asset.id, name: asset.model.name || 'Untitled', layerId: this.data.activeLayerId, position: command.position, rotation: command.rotation ?? { x: 0, y: 0, z: 0, w: 1 }, scale: command.scale ?? { x: 1, y: 1, z: 1 } }, this.data.extent, this.assets, this.layers)
        changeInstance(undefined, next); entry.selectionAfter = [next.id]
        break
      }
      case 'instances.insert': {
        const seen = new Set<string>()
        for (const value of list(command.instances)) {
          const next = instance(value, this.data.extent, this.assets, this.layers)
          this.requireLayer(next.layerId, true)
          if (this.instances.has(next.id) || seen.has(next.id)) invalid('Duplicate instance id.')
          seen.add(next.id); changeInstance(undefined, next)
        }
        entry.selectionAfter = [...seen]
        break
      }
      case 'instances.transform': {
        const seen = new Set<string>()
        for (const value of list(command.transforms)) {
          const input = object(value, 'id position rotation scale'), id = text(input.id)
          if (seen.has(id)) invalid('Duplicate transform target.')
          seen.add(id)
          const before = this.requireInstance(id)
          changeInstance(before, { ...before, ...transform(input, this.data.extent) })
        }
        break
      }
      case 'instances.delete': case 'instances.layer': {
        if (command.type === 'instances.layer') this.requireLayer(command.layerId, true)
        for (const id of new Set(list(command.ids).map(id => text(id)))) {
          const before = this.requireInstance(id)
          changeInstance(before, command.type === 'instances.delete' ? undefined : { ...before, layerId: command.layerId })
        }
        break
      }
      case 'instance.unique': {
        const before = this.requireInstance(command.id), asset = this.assets.get(before.assetId)!
        if (this.assets.size >= MAX_SCENE_INSTANCES) invalid('Scene asset capacity reached.')
        const copy: SceneAsset = { ...asset, id: crypto.randomUUID(), revision: 0, model: structuredClone(asset.model), pivot: { ...asset.pivot }, bounds: asset.bounds ? structuredClone(asset.bounds) : undefined, source: asset.source ? { ...asset.source } : undefined }
        entry.assets.push({ after: copy, index: this.assets.size })
        changeInstance(before, { ...before, assetId: copy.id })
        break
      }
      case 'layer.create': {
        if (this.layers.size >= MAX_SCENE_INSTANCES) invalid('Scene layer limit reached.')
        let id = 1
        while (this.layers.has(id)) id++
        entry.layers.push({ after: { id, name: text(command.name ?? `Layer ${id}`, 40), visible: true, locked: false }, index: this.layers.size })
        header('activeLayerId', id); entry.selectionAfter = []
        break
      }
      case 'layer.activate': this.requireLayer(command.id); header('activeLayerId', command.id); entry.selectionAfter = []; break
      case 'layer.rename': case 'layer.visibility': case 'layer.lock': case 'layer.delete': {
        const before = this.requireLayer(command.id, command.type === 'layer.rename' || command.type === 'layer.delete')
        let after: VoxelLayer | undefined = { ...before }
        if (command.type === 'layer.rename') after.name = text(command.name, 40)
        if (command.type === 'layer.visibility') after.visible = boolean(command.visible)
        if (command.type === 'layer.lock') after.locked = boolean(command.locked)
        if (command.type === 'layer.delete') {
          if (this.layers.size === 1) invalid('Cannot delete the last scene layer.')
          const ids = this.layerInstances.get(before.id) ?? new Set<string>()
          if (ids.size && !command.allowNonEmpty) throw new StudioCommandError('confirmation_required', `Deleting this layer removes ${ids.size} instances.`)
          for (const id of ids) changeInstance(this.requireInstance(id), undefined)
          after = undefined
          if (this.data.activeLayerId === before.id) header('activeLayerId', this.data.layers.find(layer => layer.id !== before.id)!.id)
        }
        if (JSON.stringify(before) !== JSON.stringify(after)) entry.layers.push({ before, after, index: this.data.layers.indexOf(before) })
        break
      }
      default: invalid('Unknown scene command.')
    }
    if (!entry.instances.length && !entry.assets.length && !entry.layers.length && !Object.keys(entry.after).length) {
      return this.execute({ type: 'selection.set', ids: entry.selectionAfter })
    }
    const result = this.apply(entry, true)
    entry.selectionAfter = [...this.selection]
    for (const old of this.redoStack) this.bytes -= old.bytes
    this.redoStack = []
    entry.bytes = historyBytes(entry); this.bytes += entry.bytes; this.undoStack.push(entry)
    this.trimHistory()
    return result
  }

  private trimHistory() {
    while (this.bytes > HISTORY_BYTES && this.undoStack.length) this.bytes -= this.undoStack.shift()!.bytes
    while (this.bytes > HISTORY_BYTES && this.redoStack.length) this.bytes -= this.redoStack.shift()!.bytes
  }

  private apply(entry: HistoryEntry, redo: boolean): SceneChange {
    let instanceCount = this.instances.size, layerCount = this.layers.size, assetCount = this.assets.size, metadataBytes = this.metadataBytes
    for (const change of entry.instances) instanceCount += Number(Boolean(redo ? change.after : change.before)) - Number(this.instances.has((change.after ?? change.before)!.id))
    for (const change of entry.layers) layerCount += Number(Boolean(redo ? change.after : change.before)) - Number(this.layers.has((change.after ?? change.before)!.id))
    for (const change of entry.assets) {
      const asset = redo ? change.after : change.before, current = this.assets.get((change.after ?? change.before)!.id)
      assetCount += Number(Boolean(asset)) - Number(Boolean(current))
      metadataBytes += (asset ? assetBytes(asset) : 0) - (current ? assetBytes(current) : 0)
    }
    // Asset edits are outside scene history, so even a formerly valid undo/redo can exceed capacity now.
    if (instanceCount > MAX_SCENE_INSTANCES || assetCount > MAX_SCENE_INSTANCES || layerCount < 1 || layerCount > MAX_SCENE_INSTANCES
      || metadataBytes + instanceCount * 1024 + layerCount * 256 > METADATA_BYTES) invalid('Scene capacity exceeded (128 MiB metadata; at most 10,000 instances, assets or layers).')
    const touched = new Set<string>(), assetIds: string[] = []
    for (const change of entry.assets) {
      const id = (change.after ?? change.before)!.id, asset = redo ? change.after : change.before
      if (asset) this.assets.set(id, asset); else this.assets.delete(id)
      assetIds.push(id)
      for (const ref of this.assetInstances.get(id) ?? []) touched.add(ref)
    }
    for (const change of entry.layers) {
      const id = (change.after ?? change.before)!.id, layer = redo ? change.after : change.before
      const previous = this.layers.get(id)
      if (layer) this.layers.set(id, layer); else this.layers.delete(id)
      if (previous?.visible !== layer?.visible) for (const ref of this.layerInstances.get(id) ?? []) touched.add(ref)
    }
    for (const change of entry.instances) {
      const id = (change.after ?? change.before)!.id, instance = redo ? change.after : change.before
      const previous = this.instances.get(id)
      if (previous) this.removeReference(previous)
      if (instance) { this.instances.set(id, instance); this.addReference(instance) } else this.instances.delete(id)
      touched.add(id)
    }
    this.metadataBytes = metadataBytes
    this.data = { ...this.data, ...(redo ? entry.after : entry.before), revision: this.data.revision + 1, instances: replaceRecords(this.data.instances, entry.instances, redo), assets: replaceRecords(this.data.assets, entry.assets, redo), layers: replaceRecords(this.data.layers, entry.layers, redo) }
    for (const id of touched) {
      const instance = this.instances.get(id)
      if (instance) this.index.update(instance, this.assets.get(instance.assetId)!, this.layers.get(instance.layerId)!.visible)
      else this.index.remove(id)
    }
    const selection = (redo ? entry.selectionAfter : entry.selectionBefore).filter(id => {
      const instance = this.instances.get(id)
      return instance && this.layers.get(instance.layerId)?.visible
    })
    const selectionChanged = selection.length !== this.selection.length || selection.some((id, i) => id !== this.selection[i])
    if (selectionChanged) this.selection = [...selection]
    return { changed: true, instanceIds: [...touched], assetIds, selectionChanged }
  }
}
