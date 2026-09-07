import type { Database } from 'bun:sqlite'
import { chunkCoords } from '../src/editor'
import { parseSceneManifest } from '../src/scene'
import { describeSceneChunk } from '../src/scene-storage'
import type { SceneAsset, SceneChunk, SceneInstance, SceneManifest } from '../src/scene-types'
import { HttpError, MAX_REQUEST_BYTES, parseTags, readBody, responseHeaders } from './model-server'

export interface SceneSummary {
  id: string
  name: string
  tags: string[]
  version: number
  createdAt: string
  updatedAt: string
  instanceCount: number
  assetCount: number
  voxelCount: number
}

type SceneRow = Omit<SceneSummary, 'tags'> & { tags: string }
type RecordRow = { id: string; data: string }
type SceneHeader = Omit<SceneManifest, 'assets' | 'instances'> & { assetIds: string[]; instanceIds: string[] }
type BlobInfo = SceneChunk
const columns = 'id, name, tags, version, createdAt, updatedAt, instanceCount, assetCount, voxelCount'
const hashPattern = /^[0-9a-f]{64}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const summary = (row: SceneRow): SceneSummary => ({ ...row, tags: JSON.parse(row.tags) })

// Host, origin and decoded-path validation belong to the shared model-server entry point.
export function createSceneRoutes(db: Database, options: { maxRequestBytes?: number; isClosing?: () => boolean } = {}, query: Database['query'] = db.query.bind(db)) {
  const limit = Math.min(options.maxRequestBytes ?? MAX_REQUEST_BYTES, MAX_REQUEST_BYTES)
  db.exec(`
    CREATE TABLE IF NOT EXISTS scene_blobs (
      hash TEXT PRIMARY KEY CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
      bytes BLOB NOT NULL CHECK (length(bytes) = 4096), info TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, nameSearch TEXT NOT NULL, tags TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      instanceCount INTEGER NOT NULL, assetCount INTEGER NOT NULL, voxelCount INTEGER NOT NULL,
      header TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scenes_updated ON scenes(updatedAt DESC, id);
    CREATE TABLE IF NOT EXISTS scene_assets (
      sceneId TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (sceneId, id)
    );
    CREATE TABLE IF NOT EXISTS scene_instances (
      sceneId TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (sceneId, id)
    );
  `)
  const getSummary = query<SceneRow, [string]>(`SELECT ${columns} FROM scenes WHERE id = ?`)
  const getScene = query<SceneRow & { header: string }, [string]>(`SELECT ${columns}, header FROM scenes WHERE id = ?`)
  const blobInfo = query<{ info: string }, [string]>('SELECT info FROM scene_blobs WHERE hash = ?')
  const hasBlob = query<{ hash: string }, [string]>('SELECT hash FROM scene_blobs WHERE hash = ?')
  const getBlob = query<{ bytes: Uint8Array<ArrayBuffer> }, [string]>('SELECT bytes FROM scene_blobs WHERE hash = ?')
  const putBlob = query('INSERT OR IGNORE INTO scene_blobs (hash, bytes, info) VALUES (?, ?, ?)')
  const records = (table: 'scene_assets' | 'scene_instances') => ({
    get: query<RecordRow, [string]>(`SELECT id, data FROM ${table} WHERE sceneId = ?`),
    put: query(`INSERT INTO ${table} (sceneId, id, data) VALUES (?, ?, ?)
      ON CONFLICT (sceneId, id) DO UPDATE SET data = excluded.data`),
    remove: query(`DELETE FROM ${table} WHERE sceneId = ? AND id = ?`),
  })
  const assets = records('scene_assets'), instances = records('scene_instances')
  function syncRecords(statements: ReturnType<typeof records>, sceneId: string, values: (SceneAsset | SceneInstance)[]) {
    const previous = new Map(statements.get.all(sceneId).map(row => [row.id, row]))
    for (const value of values) {
      const data = JSON.stringify(value), old = previous.get(value.id)
      if (!old || old.data !== data) statements.put.run(sceneId, value.id, data)
      previous.delete(value.id)
    }
    for (const id of previous.keys()) statements.remove.run(sceneId, id)
  }
  const open = db.transaction((id: string) => {
    const row = getScene.get(id)
    if (!row) throw new HttpError(404, 'This scene was not found in the shared library.')
    const { header, ...metadata } = row
    const { assetIds, instanceIds, ...snapshot } = JSON.parse(header) as SceneHeader
    const storedAssets = new Map(assets.get.all(id).map(row => [row.id, JSON.parse(row.data) as SceneAsset]))
    const storedInstances = new Map(instances.get.all(id).map(row => [row.id, JSON.parse(row.data) as SceneInstance]))
    return { ...summary(metadata), snapshot: {
      ...snapshot, assets: assetIds.map(id => storedAssets.get(id)!), instances: instanceIds.map(id => storedInstances.get(id)!),
    } as SceneManifest }
  })
  const filter = `(? = '' OR instr(nameSearch, ?) > 0 OR EXISTS (SELECT 1 FROM json_each(scenes.tags) WHERE instr(value, ?) > 0))
    AND (? = '' OR EXISTS (SELECT 1 FROM json_each(scenes.tags) WHERE value = ?))`
  const browse = query<SceneRow, [string, string, string, string, string, number]>(`SELECT ${columns} FROM scenes WHERE ${filter} ORDER BY updatedAt DESC, id LIMIT 50 OFFSET ?`)
  const count = query<{ total: number }, [string, string, string, string, string]>(`SELECT count(*) AS total FROM scenes WHERE ${filter}`)
  const allTags = query<{ tag: string }, []>('SELECT DISTINCT value AS tag FROM scenes, json_each(scenes.tags) ORDER BY tag')
  const list = db.transaction((q: string, tag: string, offset: number) => ({
    scenes: browse.all(q, q, q, tag, tag, offset).map(summary), tags: allTags.all().map(row => row.tag),
    total: count.get(q, q, q, tag, tag)!.total,
  }))
  const insert = query(`INSERT INTO scenes (${columns}, nameSearch, header) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
  const update = query(`UPDATE scenes SET name = ?, nameSearch = ?, tags = ?, version = version + 1,
    updatedAt = CASE WHEN updatedAt >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt, '+0.001 seconds') ELSE ? END,
    instanceCount = ?, assetCount = ?, voxelCount = ?, header = ? WHERE id = ? AND version = ?`)
  const publish = db.transaction((snapshot: SceneManifest, tags: string[], id?: string, version?: number) => {
    if (id) {
      const previous = getSummary.get(id)
      if (!previous) throw new HttpError(404, 'This scene was not found in the shared library.')
      if (previous.version !== version) throw new HttpError(409, 'Someone saved a newer version of this scene. Reopen it before editing, or save your changes as a copy.')
    }
    const info = new Map<string, BlobInfo>()
    const counts = new Map<string, number>()
    let references = 0
    if (snapshot.assets.length > 10_000) throw new HttpError(400, 'Use at most 10000 scene assets.')
    for (const asset of snapshot.assets) {
      counts.set(asset.id, asset.voxelCount)
      references += asset.chunks.length
      if (references > 262_144) throw new HttpError(400, 'Use at most 262144 scene chunk references.')
      for (const chunk of asset.chunks) {
        let descriptor = info.get(chunk.blob)
        if (!descriptor) {
          const stored = blobInfo.get(chunk.blob)
          if (!stored) throw new HttpError(400, `Upload missing scene chunk ${chunk.blob} before saving the scene.`)
          descriptor = JSON.parse(stored.info) as BlobInfo
          if (!descriptor) throw new HttpError(400, 'Scene manifests cannot reference empty chunks.')
          info.set(chunk.blob, descriptor)
        }
        if (chunk.count !== descriptor.count || JSON.stringify([...chunk.colors].sort((a, b) => a - b)) !== JSON.stringify(descriptor.colors)
          || chunk.lod.some((color, index) => descriptor.lod[index] !== color)) {
          throw new HttpError(400, `Scene chunk ${chunk.blob} has incorrect count, colors or LOD metadata.`)
        }
        const origin = chunkCoords(chunk.id)
        if (['x', 'y', 'z'].some(key => {
          const axis = key as keyof typeof origin
          return chunk.bounds.min[axis] !== origin[axis] * 16 + descriptor.bounds.min[axis] || chunk.bounds.max[axis] !== origin[axis] * 16 + descriptor.bounds.max[axis]
        })) throw new HttpError(400, `Scene chunk ${chunk.blob} has incorrect bounds.`)
        if (asset.model.paletteOccupied && chunk.colors.some(color => !asset.model.paletteOccupied![color])) throw new HttpError(400, 'Scene chunks reference an unoccupied palette slot.')
      }
    }
    const voxelCount = snapshot.instances.reduce((sum, instance) => sum + counts.get(instance.assetId)!, 0)
    if (!Number.isSafeInteger(voxelCount)) throw new HttpError(400, 'The represented scene voxel count is too large.')
    const { assets: assetValues, instances: instanceValues, ...header } = snapshot
    // Keep order in the small header so deletion/reordering never rewrites otherwise unchanged records.
    const headerJson = JSON.stringify({ ...header, assetIds: assetValues.map(asset => asset.id), instanceIds: instanceValues.map(instance => instance.id) } satisfies SceneHeader)
    const now = new Date().toISOString(), tagsJson = JSON.stringify(tags)
    const sceneId = id ?? crypto.randomUUID()
    if (id) update.run(snapshot.name, snapshot.name.toLowerCase(), tagsJson, now, now, snapshot.instances.length, snapshot.assets.length, voxelCount, headerJson, id, version!)
    else insert.run(sceneId, snapshot.name, tagsJson, now, now, snapshot.instances.length, snapshot.assets.length, voxelCount, snapshot.name.toLowerCase(), headerJson)
    syncRecords(assets, sceneId, snapshot.assets)
    syncRecords(instances, sceneId, snapshot.instances)
    return summary(getSummary.get(sceneId)!)
  })

  return async (request: Request, path: string): Promise<Response> => {
    const parts = path === '/api/scenes' ? [] : path.slice('/api/scenes/'.length).split('/')
    const json = (value: unknown, status = 200) => request.method === 'HEAD' ? new Response(null, { status, headers: responseHeaders }) : Response.json(value, { status, headers: responseHeaders })
    const checkClosing = () => { if (options.isClosing?.()) throw new HttpError(500, 'The library server is stopping. Please retry after it restarts.') }
    if (parts[0] === 'blobs') {
      if (parts.length !== 2) throw new HttpError(404, 'Not found.')
      const hash = parts[1]
      if (hash === 'check') {
        if (request.method !== 'POST') throw new HttpError(400, 'Use POST to check for missing scene chunks.')
        const input = await readBody(request, Math.min(limit, 70_000), 'scene chunk check')
        checkClosing()
        if (!Array.isArray(input.hashes) || input.hashes.length > 1000 || input.hashes.some(hash => typeof hash !== 'string' || !hashPattern.test(hash))) throw new HttpError(400, 'Supply at most 1000 lowercase SHA256 hashes.')
        return json({ missing: [...new Set(input.hashes as string[])].filter(hash => !hasBlob.get(hash)) })
      }
      if (!hashPattern.test(hash)) throw new HttpError(400, 'Scene chunk hashes must be lowercase SHA256 hex strings.')
      if (request.method === 'GET' || request.method === 'HEAD') {
        const blob = getBlob.get(hash)
        if (!blob) throw new HttpError(404, 'This scene chunk was not found in the shared library.')
        const headers = { ...responseHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': '4096', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${hash}"` }
        if (request.headers.get('if-none-match')?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === headers.ETag)) return new Response(null, { status: 304, headers })
        return new Response(request.method === 'HEAD' ? null : blob.bytes, { headers })
      }
      if (request.method !== 'PUT') throw new HttpError(400, 'Use GET to load or PUT to upload an immutable scene chunk.')
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw new HttpError(400, 'Send scene chunks as application/octet-stream.')
      if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw new HttpError(400, 'Send uncompressed scene chunks.')
      const length = request.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== 4096)) throw new HttpError(Number(length) > 4096 ? 413 : 400, 'A scene chunk must contain exactly 4096 bytes.')
      if (!request.body) throw new HttpError(400, 'A scene chunk must contain exactly 4096 bytes.')
      const bytes = new Uint8Array(4096), reader = request.body.getReader()
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (size + value.byteLength > 4096) throw new HttpError(413, 'A scene chunk must contain exactly 4096 bytes.')
          bytes.set(value, size)
          size += value.byteLength
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      if (size !== 4096) throw new HttpError(400, 'A scene chunk must contain exactly 4096 bytes.')
      if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== hash) throw new HttpError(400, 'The scene chunk bytes do not match their SHA256 hash.')
      checkClosing()
      // Derive descriptors only at upload. Publication never reads or scans voxel bytes.
      putBlob.run(hash, bytes, JSON.stringify(describeSceneChunk(0, 1, bytes, hash) ?? null))
      return json({ hash })
    }
    if (parts.length > 1) throw new HttpError(404, 'Not found.')
    const id = parts[0]?.toLowerCase()
    if (id !== undefined && !uuid.test(id)) throw new HttpError(400, 'The scene ID must be a valid UUID.')
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (id) return json(open(id))
      const url = new URL(request.url), offset = url.searchParams.get('offset') ?? '0'
      if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) throw new HttpError(400, 'Offset must be a non-negative integer.')
      return json(list(url.searchParams.get('q')?.toLowerCase() ?? '', url.searchParams.get('tag')?.trim().toLowerCase() ?? '', Number(offset)))
    }
    if (!(request.method === 'POST' && id === undefined || request.method === 'PUT' && id !== undefined)) throw new HttpError(400, 'Use GET to browse or open, POST to create, or PUT with a version to update a scene.')
    const input = await readBody(request, limit, 'scene')
    checkClosing()
    const tags = parseTags(input.tags)
    if (id && (typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1)) throw new HttpError(400, 'An update requires the positive integer version returned when opening the scene.')
    let snapshot: SceneManifest
    try { snapshot = parseSceneManifest(input.snapshot) }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'The scene manifest is invalid.') }
    return json(publish.immediate(snapshot, tags, id, input.version as number | undefined), id ? 200 : 201)
  }
}
