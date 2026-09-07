import { CHUNK_VOLUME, VoxelDocument, chunkCoords } from './editor'
import { MAX_BINARY_BYTES } from './protocol'
import { parseSceneAsset, parseSceneManifest, unionBounds, type SceneDocument } from './scene'
import { SCENE_CPU_BUDGET, type SceneAsset, type SceneBounds, type SceneChunk, type SceneManifest, type SceneRecoveryContext } from './scene-types'
import { StudioCommandError } from './studio'
import type { ViewSettings } from './storage'

const DATABASE = 'voxel-studio-scenes'
const MAX_ASSET_CHUNKS = MAX_BINARY_BYTES / CHUNK_VOLUME
const hashPattern = /^[a-f0-9]{64}$/
let opened: Promise<IDBDatabase> | undefined
let recoveryQueue: Promise<unknown> = Promise.resolve()
type CachedChunk = { bytes: Uint8Array<ArrayBuffer>; persisted: boolean; saving?: Promise<void> }
const rawCache = new Map<string, CachedChunk>()
const inflight = new Map<string, Promise<CachedChunk>>()
const expectedSaveIds = new Map<string, string>()

/** Resident raw-cache bytes and deduplicated outstanding chunk reads, excluding callers' owned copies. */
export function getSceneChunkCacheStats(): { bytes: number; inflight: number } {
  return { bytes: rawCache.size * CHUNK_VOLUME, inflight: inflight.size }
}

function database(): Promise<IDBDatabase> {
  if (!opened) opened = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      for (const name of ['scenes', 'instances', 'assets', 'blobs', 'meta']) request.result.createObjectStore(name)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); opened = undefined }
      resolve(db)
    }
    request.onerror = () => { opened = undefined; reject(request.error) }
    request.onblocked = () => { opened = undefined; reject(new Error('Scene storage upgrade is blocked by another tab.')) }
  }).catch(error => { opened = undefined; throw error })
  return opened
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
function complete(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Scene storage transaction aborted.'))
  })
  // A request can reject before callers reach their await of the transaction.
  void done.catch(() => {})
  return done
}
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = recoveryQueue.then(operation)
  recoveryQueue = result.catch(() => {})
  return result
}
function requireHash(hash: string) {
  if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new Error('Scene blob id must be a lowercase SHA-256 hash.')
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
function cache(hash: string, chunk: CachedChunk): CachedChunk {
  rawCache.delete(hash); rawCache.set(hash, chunk)
  while (rawCache.size * CHUNK_VOLUME > SCENE_CPU_BUDGET) rawCache.delete(rawCache.keys().next().value!)
  return chunk
}

/** Copies caller bytes before hashing; blobs are immutable and always exactly one 16^3 chunk. */
export async function putSceneBlob(hash: string, bytes: Uint8Array): Promise<void> {
  requireHash(hash)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== CHUNK_VOLUME) throw new Error('Scene blobs must contain exactly 4096 bytes.')
  const copy = Uint8Array.from(bytes)
  if (await digest(copy) !== hash) throw new Error('Scene blob SHA-256 mismatch.')
  const db = await database(), tx = db.transaction('blobs', 'readwrite'), done = complete(tx)
  tx.objectStore('blobs').put(copy.buffer, hash)
  await done
  cache(hash, { bytes: copy, persisted: true })
}

export async function hasSceneBlob(hash: string): Promise<boolean> {
  requireHash(hash)
  if (rawCache.get(hash)?.persisted) return true
  const db = await database(), tx = db.transaction('blobs'), done = complete(tx)
  const key = await request(tx.objectStore('blobs').getKey(hash))
  await done
  return key !== undefined
}

/** Every read owns its bytes. persist:false allows verified remote exports without local storage. */
export async function loadSceneChunk(hash: string, options: { persist?: boolean } = {}): Promise<Uint8Array<ArrayBuffer>> {
  requireHash(hash)
  const cached = rawCache.get(hash)
  let pending = inflight.get(hash)
  if (!cached && !pending) {
    pending = (async () => {
      let stored: unknown
      try {
        const db = await database(), tx = db.transaction('blobs'), done = complete(tx)
        stored = await request(tx.objectStore('blobs').get(hash))
        await done
      } catch { /* Remote export remains available if IndexedDB is blocked or unavailable. */ }
      if (stored !== undefined) {
        if (!(stored instanceof ArrayBuffer) || stored.byteLength !== CHUNK_VOLUME) throw new Error('Stored scene chunk has an invalid size.')
        const bytes = new Uint8Array(stored)
        if (await digest(bytes) !== hash) throw new Error('Stored scene chunk SHA-256 mismatch.')
        return cache(hash, { bytes, persisted: true })
      }
      const response = await fetch(`/api/scenes/blobs/${hash}`, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok || !response.body) throw new Error(`Scene chunk is unavailable (${response.status}): ${hash}`)
      const reader = response.body.getReader(), bytes = new Uint8Array(CHUNK_VOLUME)
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (size + value.length > CHUNK_VOLUME) throw new Error('Downloaded scene chunk exceeds 4096 bytes.')
          bytes.set(value, size); size += value.length
        }
        if (size !== CHUNK_VOLUME) throw new Error('Downloaded scene chunk must contain exactly 4096 bytes.')
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      if (await digest(bytes) !== hash) throw new Error('Scene blob SHA-256 mismatch.')
      return cache(hash, { bytes, persisted: false })
    })()
    inflight.set(hash, pending)
    void pending.finally(() => inflight.delete(hash)).catch(() => {})
  }
  const chunk = cache(hash, cached ?? await pending!)
  if (options.persist !== false && !chunk.persisted) {
    chunk.saving ??= putSceneBlob(hash, chunk.bytes).then(() => { chunk.persisted = true }).finally(() => { chunk.saving = undefined })
    await chunk.saving
  }
  return chunk.bytes.slice()
}

/** Model-space, exclusive bounds; LOD offset is x + 4*y + 16*z. Empty chunks have no descriptor. */
export function describeSceneChunk(id: number, layerId: number, bytes: Uint8Array, blob: string): SceneChunk | undefined {
  if (!Number.isInteger(id) || id < 0 || id > 4095 || !Number.isInteger(layerId) || layerId < 1 || layerId > 65535 || bytes.byteLength !== CHUNK_VOLUME) throw new Error('Invalid scene chunk coordinates or bytes.')
  requireHash(blob)
  const origin = chunkCoords(id), min = { x: 256, y: 256, z: 256 }, max = { x: 0, y: 0, z: 0 }
  const used = new Set<number>(), lod = new Array<number>(64).fill(0), frequencies = new Uint8Array(64 * 256)
  let count = 0
  for (let offset = 0; offset < bytes.length; offset++) {
    const color = bytes[offset]
    if (!color) continue
    count++; used.add(color)
    const x = offset % 16, y = Math.floor(offset / 16) % 16, z = Math.floor(offset / 256)
    min.x = Math.min(min.x, origin.x * 16 + x); min.y = Math.min(min.y, origin.y * 16 + y); min.z = Math.min(min.z, origin.z * 16 + z)
    max.x = Math.max(max.x, origin.x * 16 + x + 1); max.y = Math.max(max.y, origin.y * 16 + y + 1); max.z = Math.max(max.z, origin.z * 16 + z + 1)
    const coarse = (x >> 2) + (y >> 2) * 4 + (z >> 2) * 16
    frequencies[coarse * 256 + color]++
  }
  if (!count) return undefined
  for (let coarse = 0; coarse < 64; coarse++) {
    let majority = 0
    for (let color = 1; color < 256; color++) if (frequencies[coarse * 256 + color] > majority) {
      majority = frequencies[coarse * 256 + color]; lod[coarse] = color
    }
  }
  return { id, layerId, blob, count, bounds: { min, max }, colors: [...used].sort((a, b) => a - b), lod }
}

/** Compare a parsed descriptor with metadata from verified blob bytes; actual may use another chunk origin. */
export function validateSceneChunkDescriptor(chunk: SceneChunk, actual: SceneChunk | undefined): void {
  const origin = chunkCoords(chunk.id), actualOrigin = chunkCoords(actual?.id ?? 0)
  const colors = new Set(chunk.colors)
  if (!actual || chunk.blob !== actual.blob || actual.count !== chunk.count || actual.colors.length !== chunk.colors.length || colors.size !== chunk.colors.length
    || actual.colors.some(color => !colors.has(color)) || actual.lod.length !== chunk.lod.length || actual.lod.some((color, i) => color !== chunk.lod[i])
    || (['x', 'y', 'z'] as const).some(axis => chunk.bounds.min[axis] !== actual.bounds.min[axis] + (origin[axis] - actualOrigin[axis]) * 16
      || chunk.bounds.max[axis] !== actual.bounds.max[axis] + (origin[axis] - actualOrigin[axis]) * 16)) throw new Error('Scene chunk metadata does not match its immutable blob.')
}

export async function putSceneAsset(document: VoxelDocument, settings: ViewSettings, previous?: SceneAsset, dirtyChunks?: Iterable<number>, source?: { id: string; version: number }): Promise<SceneAsset> {
  let chunkCount = 0
  for (const layers of document.chunks.values()) {
    chunkCount += layers.size
    if (chunkCount > MAX_ASSET_CHUNKS) throw new Error('Editing a scene asset requires at most 72 MiB of chunk bytes.')
  }
  // Capture headers and only dirty bytes before the first await so edits during hashing cannot tear a save.
  const model: SceneAsset['model'] = {
    schema: 'voxel-studio/project', version: 1, name: document.name, dimensions: { ...document.dimensions },
    palette: [...document.palette], paletteOccupied: Array.from(document.palette, (_color, index) => Number(document.hasPaletteColor(index))),
    materials: document.materials.map(material => ({ ...material })), layers: document.layers.map(layer => ({ ...layer })), activeLayerId: document.activeLayerId, settings: { ...settings },
  }
  const resized = previous && (['x', 'y', 'z'] as const).some(axis => previous.model.dimensions[axis] !== model.dimensions[axis])
  const dirty = new Set<number>()
  for (const id of previous && dirtyChunks !== undefined && !resized ? dirtyChunks : [...document.chunks.keys(), ...previous?.chunks.map(chunk => chunk.id) ?? []]) {
    if (!Number.isInteger(id) || id < 0 || id > 4095) throw new Error('Invalid dirty scene chunk id.')
    dirty.add(id)
  }
  const layerIds = new Set(model.layers.map(layer => layer.id))
  const chunks = (previous?.chunks ?? []).filter(chunk => !dirty.has(chunk.id) && layerIds.has(chunk.layerId) && document.chunks.get(chunk.id)?.has(chunk.layerId))
  const pending: { id: number; layerId: number; bytes: Uint8Array<ArrayBuffer> }[] = []
  for (const id of dirty) for (const [layerId, bytes] of document.chunks.get(id) ?? []) {
    if (!layerIds.has(layerId)) throw new Error('Document chunk references an unknown layer.')
    if (bytes.byteLength !== CHUNK_VOLUME) throw new Error('Document chunks must contain exactly 4096 bytes.')
    pending.push({ id, layerId, bytes: Uint8Array.from(bytes) })
  }
  const old = new Map(previous?.chunks.map(chunk => [`${chunk.id}:${chunk.layerId}`, chunk]))
  const provenance = source ?? previous?.source
  const capturedSource = provenance ? { id: provenance.id, version: provenance.version } : undefined
  const pivot = previous && !resized ? { ...previous.pivot } : { x: model.dimensions.x / 2, y: 0, z: model.dimensions.z / 2 }
  const id = previous?.id ?? crypto.randomUUID(), revision = previous ? previous.revision + 1 : 0
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    while (cursor < pending.length) {
      const { id, layerId, bytes } = pending[cursor++]
      const blob = await digest(bytes), unchanged = old.get(`${id}:${layerId}`)
      if (unchanged?.blob === blob) { chunks.push(unchanged); continue }
      const chunk = describeSceneChunk(id, layerId, bytes, blob)
      if (!chunk) continue
      await putSceneBlob(blob, bytes)
      chunks.push(chunk)
    }
  }))
  chunks.sort((a, b) => a.id - b.id || a.layerId - b.layerId)
  let bounds: SceneBounds | undefined, voxelCount = 0
  for (const chunk of chunks) { voxelCount += chunk.count; bounds = unionBounds(bounds, chunk.bounds) }
  const asset: SceneAsset = { id, revision, model, chunks, pivot, bounds, voxelCount, ...(capturedSource ? { source: capturedSource } : {}) }
  // Header validation is shared with remote manifests, without encoding any voxel arrays.
  return parseSceneAsset(asset)
}

export async function loadSceneAsset(input: SceneAsset): Promise<{ document: VoxelDocument; settings: ViewSettings }> {
  // Every layer chunk needs an owned array, even when many descriptors share one hash.
  if (Array.isArray(input?.chunks) && input.chunks.length > MAX_ASSET_CHUNKS) throw new Error('This asset exceeds the 72 MiB fully hydrated model-editor limit. Split it into smaller assets.')
  const asset = parseSceneAsset(input)
  const model = asset.model
  const document = new VoxelDocument(model.dimensions, model.name, model.palette, model.materials, model.layers, model.activeLayerId, model.paletteOccupied)
  // Owned document arrays pin every chunk independently of the bounded, evictable raw cache.
  for (const chunk of asset.chunks) {
    const bytes = await loadSceneChunk(chunk.blob), actual = describeSceneChunk(chunk.id, chunk.layerId, bytes, chunk.blob)
    validateSceneChunkDescriptor(chunk, actual)
    const layers = document.chunks.get(chunk.id) ?? new Map<number, Uint8Array>()
    layers.set(chunk.layerId, bytes); document.chunks.set(chunk.id, layers)
    document.voxelCount += chunk.count
    for (const color of chunk.colors) document.paletteOccupied[color] = 1
  }
  return { document, settings: model.settings }
}

type StoredHeader = Omit<SceneManifest, 'instances' | 'assets'> & { instanceIds: string[]; assetIds: string[]; context: SceneRecoveryContext; saveId: string }
type SavedRecords = { id: string; saveId: string; assets: Map<string, { value: SceneAsset; json: string }>; instances: Map<string, { value: SceneManifest['instances'][number]; json: string }> }
let lastSaved: SavedRecords | undefined

function recoveryContext(value: SceneRecoveryContext, scene: SceneManifest): SceneRecoveryContext {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['editingAssetId', 'view', 'selection', 'library'].includes(key))) throw new Error('Invalid scene recovery context.')
  const context: SceneRecoveryContext = {}
  if (value.editingAssetId !== undefined) {
    if (!scene.assets.some(asset => asset.id === value.editingAssetId)) throw new Error('Recovery editor references an unknown asset.')
    context.editingAssetId = value.editingAssetId
  }
  if (value.selection !== undefined) {
    const layers = new Set(scene.layers.filter(layer => layer.visible).map(layer => layer.id))
    const instances = new Set(scene.instances.filter(instance => layers.has(instance.layerId)).map(instance => instance.id))
    if (!Array.isArray(value.selection) || value.selection.length > 10_000 || Array.from(value.selection).some(id => !instances.has(id))) throw new Error('Invalid scene recovery selection.')
    context.selection = [...new Set(value.selection)]
  }
  if (value.view !== undefined) {
    const v = value.view
    const finite = (n: unknown, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
    const point = (p: unknown) => p && typeof p === 'object' && ['x', 'y', 'z'].every(axis => finite((p as Record<string, unknown>)[axis]))
    if (!v || !['orthographic', 'perspective'].includes(v.projection) || !point(v.position) || !point(v.target) || !point(v.up) || !finite(v.orthographicSpan, 0.01) || v.zoom !== undefined && !finite(v.zoom, 0.01, 100) || v.fov !== undefined && !finite(v.fov, 1, 120) || !v.viewport || !finite(v.viewport.width, 0, 65536) || !finite(v.viewport.height, 0, 65536)) throw new Error('Invalid scene recovery camera.')
    context.view = { projection: v.projection, position: { x: v.position.x, y: v.position.y, z: v.position.z }, target: { x: v.target.x, y: v.target.y, z: v.target.z }, up: { x: v.up.x, y: v.up.y, z: v.up.z }, orthographicSpan: v.orthographicSpan, viewport: { width: v.viewport.width, height: v.viewport.height }, ...(v.zoom === undefined ? {} : { zoom: v.zoom }), ...(v.fov === undefined ? {} : { fov: v.fov }) }
  }
  if (value.library !== undefined) {
    const link = value.library
    if (!link || typeof link.id !== 'string' || !link.id.trim() || link.id.length > 128 || !Number.isSafeInteger(link.version) || link.version < 1 || typeof link.dirty !== 'boolean' || !Array.isArray(link.tags) || link.tags.length > 100 || Array.from(link.tags).some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 64)) throw new Error('Invalid scene library recovery link.')
    context.library = { id: link.id, version: link.version, dirty: link.dirty, tags: [...link.tags] }
  }
  return context
}

async function records(tx: IDBTransaction, header: StoredHeader): Promise<SceneManifest> {
  if (!Array.isArray(header.assetIds) || !Array.isArray(header.instanceIds) || header.assetIds.length > 10_000 || header.instanceIds.length > 10_000) throw new Error('Invalid scene recovery record counts.')
  const { assetIds, instanceIds, context: _context, saveId: _saveId, ...scene } = header
  const [assets, instances] = await Promise.all([
    Promise.all(assetIds.map(id => request(tx.objectStore('assets').get([scene.id, id])))),
    Promise.all(instanceIds.map(id => request(tx.objectStore('instances').get([scene.id, id])))),
  ])
  if (assets.some((asset, i) => asset?.id !== assetIds[i]) || instances.some((instance, i) => instance?.id !== instanceIds[i])) throw new Error('Scene recovery references missing or mismatched records.')
  return { ...scene, assets, instances }
}

export async function saveSceneRecovery(manifest: SceneManifest, context: SceneRecoveryContext = {}): Promise<void> {
  // Boundary callers may mutate their input while this save waits behind another transaction.
  return persistSceneRecovery(structuredClone(parseSceneManifest(manifest)), context)
}

/** Autosave for SceneDocument-owned snapshots. Mutations must go through execute, never data in place. */
export async function saveSceneDocumentRecovery(document: SceneDocument, context: SceneRecoveryContext = {}): Promise<void> {
  return persistSceneRecovery(document.snapshot(), context)
}

async function persistSceneRecovery(scene: SceneManifest, context: SceneRecoveryContext): Promise<void> {
  const capturedContext = recoveryContext(context, scene)
  await serial(async () => {
    const db = await database(), tx = db.transaction(['scenes', 'instances', 'assets', 'meta'], 'readwrite'), done = complete(tx)
    try {
      const previous: StoredHeader | undefined = await request(tx.objectStore('scenes').get(scene.id))
      const expected = expectedSaveIds.get(scene.id)
      if (previous ? !expected || previous.saveId !== expected || previous.revision > scene.revision : expected !== undefined) {
        throw new StudioCommandError('storage_conflict', 'Scene recovery changed in another tab. Autosave is blocked; keep this document and export it or explicitly reload recovery.')
      }
      let saved = lastSaved
      if (!saved || saved.id !== scene.id || saved.saveId !== previous?.saveId) {
        const prior = previous ? await records(tx, previous) : undefined
        saved = { id: scene.id, saveId: previous?.saveId ?? '', assets: new Map(prior?.assets.map(asset => [asset.id, { value: asset, json: JSON.stringify(asset) }])), instances: new Map(prior?.instances.map(instance => [instance.id, { value: instance, json: JSON.stringify(instance) }])) }
      }
      const next: SavedRecords = { id: scene.id, saveId: crypto.randomUUID(), assets: new Map(), instances: new Map() }
      for (const asset of scene.assets) {
        const previous = saved.assets.get(asset.id)
        const json = previous?.value === asset ? previous.json : JSON.stringify(asset)
        if (previous?.json !== json) tx.objectStore('assets').put(asset, [scene.id, asset.id])
        next.assets.set(asset.id, { value: asset, json })
      }
      for (const instance of scene.instances) {
        const previous = saved.instances.get(instance.id)
        const json = previous?.value === instance ? previous.json : JSON.stringify(instance)
        if (previous?.json !== json) tx.objectStore('instances').put(instance, [scene.id, instance.id])
        next.instances.set(instance.id, { value: instance, json })
      }
      for (const id of saved.assets.keys()) if (!next.assets.has(id)) tx.objectStore('assets').delete([scene.id, id])
      for (const id of saved.instances.keys()) if (!next.instances.has(id)) tx.objectStore('instances').delete([scene.id, id])
      const { assets, instances, ...header } = scene
      // Remote manifests may intentionally reference uncached blobs. Their hash references remain intact.
      tx.objectStore('scenes').put({ ...header, assetIds: assets.map(asset => asset.id), instanceIds: instances.map(instance => instance.id), context: capturedContext, saveId: next.saveId } satisfies StoredHeader, scene.id)
      tx.objectStore('meta').put(scene.id, 'active')
      await done
      lastSaved = next
      expectedSaveIds.set(scene.id, next.saveId)
    } catch (error) {
      try { tx.abort() } catch { /* The transaction may already have aborted. */ }
      await done.catch(() => {})
      throw error
    }
  })
}

export function loadSceneRecovery(): Promise<{ scene: SceneManifest; context: SceneRecoveryContext } | undefined> {
  return serial(async () => {
    const db = await database(), tx = db.transaction(['scenes', 'instances', 'assets', 'meta']), done = complete(tx)
    const id: unknown = await request(tx.objectStore('meta').get('active'))
    if (id === undefined) { await done; return undefined }
    if (typeof id !== 'string') throw new Error('Invalid active scene recovery marker.')
    const header: StoredHeader | undefined = await request(tx.objectStore('scenes').get(id))
    if (!header || header.id !== id) throw new Error('Active scene recovery header is missing.')
    if (typeof header.saveId !== 'string' || !header.saveId || header.saveId.length > 128) throw new StudioCommandError('storage_conflict', 'Scene recovery is missing its save token.')
    const manifest = await records(tx, header)
    await done
    const scene = parseSceneManifest(manifest)
    const context = recoveryContext(header.context ?? {}, scene)
    expectedSaveIds.set(scene.id, header.saveId)
    return { scene, context }
  })
}

/** Ordered after pending saves; existing scene records and immutable blobs are retained. */
export function deactivateSceneRecovery(): Promise<void> {
  return serial(async () => {
    const db = await database(), tx = db.transaction('meta', 'readwrite'), done = complete(tx)
    tx.objectStore('meta').delete('active')
    await done
    lastSaved = undefined
  })
}
