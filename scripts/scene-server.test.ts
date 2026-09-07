import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chunkCoords, VoxelDocument } from '../src/editor'
import { encodeProjectSnapshot } from '../src/protocol'
import { parseSceneManifest } from '../src/scene'
import type { SceneManifest } from '../src/scene-types'
import * as storage from '../src/scene-storage'
import { createModelServer, PROJECT_ROOT } from './model-server'
import { createSceneRoutes, type SceneSummary } from './scene-server'

const bytes = new Uint8Array(4096).fill(80)
const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const model = new VoxelDocument({ x: 16, y: 16, z: 16 }, 'Black glass')
model.palette[80] = 0
model.paletteOccupied[80] = model.paletteOccupied[81] = 1
model.materials[80] = { name: 'Glass', roughness: 0.12, metalness: 0.3, emissiveIntensity: 0.4, opacity: 0.9, transmission: 0.7, ior: 1.4 }
model.replaceChunk(0, [{ layerId: 1, data: bytes }])
const project = encodeProjectSnapshot(model, {
  background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42,
  ambientOcclusion: true, shadows: true, grid: true, faceGrid: false, meshVertices: false, meshTriangles: false,
  projection: 'orthographic', pathTracing: true,
})
function fixture(): SceneManifest {
  const { chunks: _chunks, ...metadata } = structuredClone(project)
  const assetIds = [crypto.randomUUID(), crypto.randomUUID()]
  return {
    schema: 'voxel-studio/scene', version: 1, id: crypto.randomUUID(), name: '100%_ Glass city', revision: 0,
    extent: { x: 16384, y: 16384, z: 16384 }, settings: { ...project.settings },
    layers: [{ id: 1, name: 'Buildings', visible: true, locked: false }], activeLayerId: 1,
    assets: assetIds.map(id => ({
      id, revision: 1, model: structuredClone(metadata), pivot: { x: 8, y: 0, z: 8 },
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 16, y: 16, z: 16 } }, voxelCount: 4096,
      source: { id: crypto.randomUUID(), version: 7 },
      chunks: [{ id: 0, layerId: 1, blob: hash, count: 4096, colors: [80], lod: Array(64).fill(80), bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 16, y: 16, z: 16 } } }],
    })),
    instances: Array.from({ length: 3 }, (_, index) => ({
      id: crypto.randomUUID(), assetId: assetIds[index % 2], name: `Tower ${index}`, layerId: 1,
      position: { x: 32 + index * 20, y: 0, z: 32 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 },
    })),
  }
}

function largeFixture(count: number): SceneManifest {
  const scene = fixture(), template = scene.assets[0]
  scene.instances = []
  scene.assets = Array.from({ length: Math.ceil(count / 4096) }, (_, group) => {
    const chunks = Array.from({ length: Math.min(4096, count - group * 4096) }, (_, id) => {
      const origin = chunkCoords(id)
      return { ...template.chunks[0], id, blob: (group * 4096 + id).toString(16).padStart(64, '0'), bounds: {
        min: { x: origin.x * 16, y: origin.y * 16, z: origin.z * 16 },
        max: { x: (origin.x + 1) * 16, y: (origin.y + 1) * 16, z: (origin.z + 1) * 16 },
      } }
    })
    return { ...template, id: crypto.randomUUID(), model: { ...template.model, dimensions: { x: 256, y: 256, z: 256 } },
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 256, y: 256, z: 256 } }, chunks, voxelCount: chunks.length * 4096 }
  })
  return scene
}

let directory: string
let library: ReturnType<typeof createModelServer>
let services: ReturnType<typeof createModelServer>[]
let snapshot: SceneManifest
const request = (path = '', init?: RequestInit) => fetch(new URL(`/api/scenes${path}`, library.server.url), { signal: AbortSignal.timeout(10_000), ...init })
const save = (body: unknown, path = '', method = 'POST', headers: Record<string, string> = {}) => request(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const upload = (data: Uint8Array = bytes, key = hash, headers: Record<string, string> = {}) => request(`/blobs/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: Uint8Array.from(data) })
async function error(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(response.headers.has('access-control-allow-origin')).toBe(false)
  const result = await response.json()
  expect(Object.keys(result)).toEqual(['error'])
  expect(result.error).toBeString()
  return result.error as string
}
function start(options: Parameters<typeof createModelServer>[0] = {}) {
  const server = createModelServer({ databasePath: resolve(directory, 'models.sqlite'), port: 0, ...options })
  services.push(server)
  return server
}
beforeEach(() => {
  directory = mkdtempSync(resolve(tmpdir(), 'voxel-scene-library-'))
  services = []
  library = start()
  snapshot = fixture()
})
afterEach(async () => {
  await Promise.all(services.map(service => service.close()))
  rmSync(directory, { recursive: true, force: true })
})

test('immutable 4096-byte blobs validate hashes, content types, lengths, batches and cache headers', async () => {
  expect(await (await save({ hashes: [hash, hash] }, '/blobs/check')).json()).toEqual({ missing: [hash] })
  await error(await request(`/blobs/${hash}`), 404)
  for (const key of [hash.toUpperCase(), 'bad', 'a'.repeat(63), 'g'.repeat(64)]) await error(await upload(bytes, key), 400)
  await error(await upload(new Uint8Array(4095)), 400)
  await error(await upload(new Uint8Array(4097)), 413)
  await error(await upload(new Uint8Array(4096)), 400)
  await error(await upload(bytes, hash, { 'Content-Type': 'text/plain' }), 400)
  await error(await upload(bytes, hash, { 'Content-Encoding': 'gzip' }), 400)
  for (const hashes of [null, 'bad', [hash.toUpperCase()], Array(1001).fill(hash)]) await error(await save({ hashes }, '/blobs/check'), 400)
  expect((await upload()).status).toBe(200)
  expect((await upload()).status).toBe(200)
  const response = await request(`/blobs/${hash}`)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(response.headers.get('content-length')).toBe('4096')
  expect(response.headers.get('cache-control')).toContain('immutable')
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  const etag = response.headers.get('etag')!
  expect((await request(`/blobs/${hash}`, { headers: { 'if-none-match': etag } })).status).toBe(304)
  const head = await request(`/blobs/${hash}`, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  expect(await (await save({ hashes: [hash] }, '/blobs/check')).json()).toEqual({ missing: [] })
  const db = new Database(resolve(directory, 'models.sqlite'))
  try { expect(db.query('SELECT count(*) AS count FROM scene_blobs').get()).toEqual({ count: 1 }) }
  finally { db.close() }
})

test('publication requires all blobs and truthful descriptors without writing partial scenes', async () => {
  expect(await error(await save({ snapshot, tags: ['missing'] }), 400)).toContain('missing')
  expect(await (await request()).json()).toEqual({ scenes: [], tags: [], total: 0 })
  await upload()
  const created = await (await save({ snapshot, tags: ['original'] })).json()
  expect(created.id).toBeString()
  for (const patch of [
    { blob: 'a'.repeat(64) }, { count: 4095 }, { colors: [79] }, { lod: Array(64).fill(79) },
  ]) {
    const changed = structuredClone(snapshot)
    Object.assign(changed.assets[0].chunks[0], patch)
    if (patch.count) changed.assets[0].voxelCount = patch.count
    await error(await save({ snapshot: changed, tags: ['rejected'], version: 1 }, `/${created.id}`, 'PUT'), 400)
  }
  expect(await (await request(`/${created.id}`)).json()).toEqual({ ...created, snapshot })
  expect((await (await request()).json()).tags).toEqual(['original'])
})

test('round trips scene-local metadata independently from model rows and local scene IDs across restarts', async () => {
  const modelResponse = await fetch(new URL('/api/models', library.server.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: project, tags: ['model-only'] }) })
  expect(modelResponse.status).toBe(201)
  const modelSummary = await modelResponse.json()
  await upload()
  const response = await save({ snapshot, tags: [' Glass ', 'glass', 'CITY'] })
  expect(response.status).toBe(201)
  const created: SceneSummary = await response.json()
  expect(created).toEqual({
    id: expect.any(String), name: snapshot.name, tags: ['glass', 'city'], version: 1,
    createdAt: expect.any(String), updatedAt: expect.any(String), instanceCount: 3, assetCount: 2, voxelCount: 12288,
  })
  expect(created.id).not.toBe(snapshot.id)
  expect(created.createdAt).toBe(created.updatedAt)
  const copy = await (await save({ snapshot, tags: [] })).json()
  expect(copy.id).not.toBe(created.id)
  await library.close()
  library = start()
  expect(await (await request(`/${created.id.toUpperCase()}`)).json()).toEqual({ ...created, snapshot })
  expect(await (await fetch(new URL(`/api/models/${modelSummary.id}`, library.server.url))).json()).toEqual({ ...modelSummary, snapshot: project })
  const db = new Database(resolve(directory, 'models.sqlite'))
  try {
    expect(db.query('SELECT count(*) AS count FROM scene_blobs').get()).toEqual({ count: 1 })
    expect(db.query('SELECT count(*) AS count FROM scene_assets').get()).toEqual({ count: 4 })
    const header = db.query<{ header: string }, [string]>('SELECT header FROM scenes WHERE id = ?').get(created.id)!
    expect(JSON.parse(header.header)).not.toHaveProperty('assets')
    expect(JSON.parse(header.header)).not.toHaveProperty('instances')
  } finally { db.close() }
})

test('CAS updates only changed records, retain unchanged blobs, and roll back record failures', async () => {
  await upload()
  const created = await (await save({ snapshot, tags: [] })).json()
  const db = new Database(resolve(directory, 'models.sqlite'))
  db.exec(`CREATE TABLE changes (kind TEXT, id TEXT);
    CREATE TRIGGER asset_changes AFTER UPDATE ON scene_assets BEGIN INSERT INTO changes VALUES ('asset', NEW.id); END;
    CREATE TRIGGER instance_changes AFTER UPDATE ON scene_instances BEGIN INSERT INTO changes VALUES ('instance', NEW.id); END;`)
  try {
    const moved = structuredClone(snapshot)
    moved.revision++
    moved.instances[0].position.x++
    const updated = await (await save({ snapshot: moved, tags: ['moved'], version: 1 }, `/${created.id}`, 'PUT')).json()
    expect(updated.version).toBe(2)
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt > created.updatedAt).toBe(true)
    expect(db.query('SELECT * FROM changes').all()).toEqual([{ kind: 'instance', id: moved.instances[0].id }])
    await error(await save({ snapshot, tags: [], version: 1 }, `/${created.id}`, 'PUT'), 409)
    db.exec('DELETE FROM changes')
    moved.assets[1].model.materials[80].roughness = 0.5
    moved.assets[1].revision++
    const next = await (await save({ snapshot: moved, tags: [], version: 2 }, `/${created.id}`, 'PUT')).json()
    expect(next.version).toBe(3)
    expect(db.query('SELECT * FROM changes').all()).toEqual([{ kind: 'asset', id: moved.assets[1].id }])
    db.exec("CREATE TRIGGER fail_record BEFORE UPDATE ON scene_instances BEGIN SELECT RAISE(ABORT, 'private record details'); END")
    const rejected = structuredClone(moved)
    rejected.instances[0].name = 'Rejected'
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try { expect(await error(await save({ snapshot: rejected, tags: ['bad'], version: 3 }, `/${created.id}`, 'PUT'), 500)).not.toContain('private record details') }
    finally { log.mockRestore() }
    expect(await (await request(`/${created.id}`)).json()).toEqual({ ...next, snapshot: moved })
    db.exec('DROP TRIGGER fail_record; DELETE FROM changes')
    const reordered = { ...moved, assets: [...moved.assets].reverse(), instances: moved.instances.slice(1).reverse() }
    const reorderedSummary = await (await save({ snapshot: reordered, tags: [], version: 3 }, `/${created.id}`, 'PUT')).json()
    expect(reorderedSummary.version).toBe(4)
    expect(reorderedSummary.instanceCount).toBe(2)
    expect(db.query('SELECT * FROM changes').all()).toEqual([])
    expect(await (await request(`/${created.id}`)).json()).toEqual({ ...reorderedSummary, snapshot: reordered })
    expect(db.query('SELECT count(*) AS count FROM scene_instances').get()).toEqual({ count: 2 })
  } finally { db.close() }
})

test('concurrent server connections cannot overwrite the winning scene version', async () => {
  await upload()
  const created = await (await save({ snapshot, tags: [] })).json()
  const other = start()
  const responses = await Promise.all([
    save({ snapshot: { ...snapshot, name: 'First' }, tags: ['first'], version: 1 }, `/${created.id}`, 'PUT'),
    fetch(new URL(`/api/scenes/${created.id}`, other.server.url), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: { ...snapshot, name: 'Second' }, tags: ['second'], version: 1 }) }),
  ])
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  const winner = await responses.find(response => response.ok)!.json()
  expect(winner.version).toBe(2)
  expect((await (await request(`/${created.id}`)).json()).name).toBe(winner.name)
})

test('100M+ asset voxel coordinates publish from descriptors without reading blob bytes', async () => {
  const scene = largeFixture(26_000)
  for (const asset of scene.assets) for (const chunk of asset.chunks) chunk.blob = hash
  scene.instances = scene.assets.map((asset, index) => ({ ...snapshot.instances[0], id: crypto.randomUUID(), assetId: asset.id, position: { x: index * 256, y: 0, z: 0 } }))
  await upload()
  const db = new Database(resolve(directory, 'models.sqlite'))
  db.exec('ALTER TABLE scene_blobs RENAME COLUMN bytes TO unavailable_bytes')
  try {
    const response = await save({ snapshot: scene, tags: ['large'] })
    expect(response.status).toBe(201)
    expect((await response.json()).voxelCount).toBe(106_496_000)
  } finally { db.exec('ALTER TABLE scene_blobs RENAME COLUMN unavailable_bytes TO bytes'); db.close() }
}, 30_000)

test('browse is metadata-only, paginated, and searches names/tags literally with global tags', async () => {
  const empty = { ...snapshot, assets: [], instances: [] }
  for (let i = 0; i < 52; i++) expect((await save({ snapshot: { ...empty, name: i ? `City ${i}` : '100%_ Glass' }, tags: [i % 2 ? 'odd' : 'glass'] })).status).toBe(201)
  const first = await (await request()).json(), second = await (await request('?offset=50')).json()
  expect(first.scenes).toHaveLength(50)
  expect(second.scenes).toHaveLength(2)
  expect(first.total).toBe(52)
  expect(first.scenes[0]).not.toHaveProperty('snapshot')
  const filtered = await (await request('?q=%25_&tag=GLASS')).json()
  expect(filtered.total).toBe(1)
  expect(filtered.scenes[0].name).toBe('100%_ Glass')
  expect(filtered.tags).toEqual(['glass', 'odd'])
  for (const offset of ['-1', '1.5', 'x', '', '9007199254740992']) await error(await request(`?offset=${offset}`), 400)
})

test('scene routes share all host/origin defenses, strict metadata and JSON body bounds', async () => {
  for (const headers of [
    { origin: 'https://attacker.test' }, { origin: 'null' }, { referer: 'https://attacker.test/page' },
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
    { host: 'attacker.test', origin: 'http://attacker.test', 'sec-fetch-site': 'same-origin' },
    { origin: 'https://attacker.test', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https' },
  ] as Record<string, string>[]) {
    for (const path of ['', `/blobs/${hash}`, `/${crypto.randomUUID()}`]) await error(await request(path, { headers }), 400)
    await error(await upload(bytes, hash, headers), 400)
    await error(await save({ hashes: [hash] }, '/blobs/check', 'POST', headers), 400)
    await error(await save({ snapshot, tags: [] }, '', 'POST', headers), 400)
  }
  library = start({ trustProxy: true, allowedHosts: ['studio.example'] })
  const forwarded = { origin: 'https://studio.example', 'x-forwarded-host': 'studio.example', 'x-forwarded-proto': 'https' }
  expect((await upload(bytes, hash, forwarded)).status).toBe(200)
  expect((await save({ snapshot, tags: [] }, '', 'POST', forwarded)).status).toBe(201)
  await error(await request('', { headers: { ...forwarded, host: 'attacker.test' } }), 400)
  for (const value of [null, {}, { ...snapshot, version: 2 }, { ...snapshot, assets: [snapshot.assets[0], snapshot.assets[0]] }, { ...snapshot, instances: [{ ...snapshot.instances[0], assetId: crypto.randomUUID() }] }]) await error(await save({ snapshot: value, tags: [] }), 400)
  for (const tags of [undefined, null, [1], ['a,b'], ['x'.repeat(41)], ['a\nb'], Array.from({ length: 21 }, (_, i) => `tag${i}`)]) await error(await save({ snapshot, tags }), 400)
  for (const version of [undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) await error(await save({ snapshot, tags: [], version }, `/${crypto.randomUUID()}`, 'PUT'), 400)
  await error(await save({ snapshot, tags: [], version: 1 }, `/${crypto.randomUUID()}`, 'PUT'), 404)
  for (const body of ['{', 'null', '[]']) await error(await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 400)
  await error(await save({ snapshot, tags: [] }, '', 'POST', { 'Content-Encoding': 'gzip' }), 400)
  library = start({ maxRequestBytes: 1024 })
  await error(await save({ snapshot, tags: [] }), 413)
  const db = new Database(resolve(directory, 'bounded.sqlite'))
  try {
    const routes = createSceneRoutes(db, { maxRequestBytes: 1024 })
    const stream = (size: number) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close() } })
    await expect(routes(new Request('http://localhost/api/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream(1025) }), '/api/scenes')).rejects.toMatchObject({ status: 413 })
    await expect(routes(new Request(`http://localhost/api/scenes/blobs/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: stream(4097) }), `/api/scenes/blobs/${hash}`)).rejects.toMatchObject({ status: 413 })
  } finally { db.close() }
})

test('client saves deduplicated missing chunks, opens only manifests, and preserves CAS links', async () => {
  const { saveLibraryScene, openLibraryScene, listSceneLibrary } = await import('../src/scene-library')
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input), library.server.url)
    paths.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    return originalFetch(url, init)
  }, { preconnect: originalFetch.preconnect }))
  const load = spyOn(storage, 'loadSceneChunk').mockResolvedValue(bytes)
  try {
    const link = await saveLibraryScene(snapshot, [' Glass '])
    expect(link).toEqual({ id: expect.any(String), version: 1, tags: ['glass'], dirty: false })
    expect(link.id).not.toBe(snapshot.id)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith(hash)
    expect(paths).toEqual(['POST /api/scenes/blobs/check', `PUT /api/scenes/blobs/${hash}`, 'POST /api/scenes'])
    paths.length = 0
    expect(await openLibraryScene(link.id)).toEqual({ snapshot, library: link })
    expect(paths).toEqual([`GET /api/scenes/${link.id}`])
    const next = await saveLibraryScene({ ...snapshot, name: 'Changed' }, ['glass'], link)
    expect(next.version).toBe(2)
    expect(load).toHaveBeenCalledTimes(1)
    await expect(saveLibraryScene(snapshot, [], link)).rejects.toThrow(/newer version/)
    expect((await listSceneLibrary('Changed', 'glass')).total).toBe(1)
  } finally { network.mockRestore(); load.mockRestore() }
})

test('portable files stream deduplicated records, validate hashes and require complete self-contained data', async () => {
  const { exportSceneFile, importSceneFile } = await import('../src/scene-library')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const lines: Uint8Array<ArrayBuffer>[] = []
  let closed = false, aborted = false
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    showSaveFilePicker: async (options: { suggestedName: string }) => {
      expect(options.suggestedName).toEndWith('.vscene')
      return { createWritable: async () => ({ write: async (bytes: Uint8Array) => { lines.push(Uint8Array.from(bytes)) }, close: async () => { closed = true }, abort: async () => { aborted = true } }) }
    },
  } })
  const load = spyOn(storage, 'loadSceneChunk').mockResolvedValue(bytes)
  const put = spyOn(storage, 'putSceneBlob').mockResolvedValue(undefined)
  try {
    await exportSceneFile(snapshot)
    expect(closed).toBe(true)
    expect(aborted).toBe(false)
    expect(lines).toHaveLength(2)
    expect(lines[1].byteLength).toBeLessThan(8192)
    expect(load).toHaveBeenCalledWith(hash, { persist: false })
    expect(put).not.toHaveBeenCalled()
    const file = new File(lines, 'city.vscene')
    const text = spyOn(file, 'text').mockImplementation(() => { throw new Error('Whole-file reads are forbidden') })
    expect(await importSceneFile(file)).toEqual(snapshot)
    expect(text).not.toHaveBeenCalled()
    expect(put).toHaveBeenCalledWith(hash, bytes)
    await expect(importSceneFile(new File([lines[0]], 'incomplete.vscene'))).rejects.toThrow('incomplete')
    await expect(importSceneFile(new File([...lines, lines[1]], 'duplicate.vscene'))).rejects.toThrow('duplicate')
    const record = JSON.parse(new TextDecoder().decode(lines[1]))
    record.dataBase64 = Buffer.alloc(4096).toString('base64')
    await expect(importSceneFile(new File([lines[0], JSON.stringify(record)], 'corrupt.vscene'))).rejects.toThrow('SHA256')
    const header = JSON.parse(new TextDecoder().decode(lines[0]))
    header.snapshot.assets[0].chunks[0].count--
    header.snapshot.assets[0].voxelCount--
    await expect(importSceneFile(new File([JSON.stringify(header) + '\n', lines[1]], 'false-metadata.vscene'))).rejects.toThrow('metadata')
    await expect(importSceneFile(new File([lines[0], ' '.repeat(8193)], 'oversized.vscene'))).rejects.toThrow('size limit')
    await expect(importSceneFile(new File(['{"schema":"other"}\n'], 'wrong.vscene'))).rejects.toThrow('header')
    const split = new File([], 'split.vscene')
    const encoded = new Uint8Array(await file.arrayBuffer())
    spyOn(split, 'stream').mockReturnValue(new ReadableStream({ start(controller) {
      for (let i = 0; i < encoded.length; i += 37) controller.enqueue(encoded.slice(i, i + 37))
      controller.close()
    } }))
    expect(await importSceneFile(split)).toEqual(snapshot)
    closed = false
    load.mockRejectedValueOnce(new Error('Missing local chunk'))
    await expect(exportSceneFile(snapshot)).rejects.toThrow('Missing local chunk')
    expect(aborted).toBe(true)
    expect(closed).toBe(false)
  } finally {
    load.mockRestore(); put.mockRestore()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('native export validates every shared-blob descriptor exactly and aborts instead of closing corrupt files', async () => {
  const { exportSceneFile, importSceneFile } = await import('../src/scene-library')
  const sparse = new Uint8Array(4096)
  sparse[1 + 2 * 16 + 3 * 256] = 80
  sparse[14 + 12 * 16 + 10 * 256] = 81
  const sparseHash = new Bun.CryptoHasher('sha256').update(sparse).digest('hex')
  snapshot.assets.forEach((asset, index) => {
    const chunk = storage.describeSceneChunk(index, 1, sparse, sparseHash)!
    asset.model.dimensions.x = 32
    asset.chunks = [chunk]
    asset.bounds = structuredClone(chunk.bounds)
    asset.voxelCount = chunk.count
  })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let closed = false, aborted = false
  const lines: Uint8Array<ArrayBuffer>[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    showSaveFilePicker: async () => ({ createWritable: async () => ({
      write: async (line: Uint8Array) => { lines.push(Uint8Array.from(line)) },
      close: async () => { closed = true }, abort: async () => { aborted = true },
    }) }),
  } })
  const load = spyOn(storage, 'loadSceneChunk').mockImplementation(async (_hash, options) => {
    if (options?.persist !== false) throw new DOMException('Local disk quota exceeded', 'QuotaExceededError')
    return sparse
  })
  const put = spyOn(storage, 'putSceneBlob').mockRejectedValue(new DOMException('Local disk quota exceeded', 'QuotaExceededError'))
  const describe = spyOn(storage, 'describeSceneChunk')
  try {
    await exportSceneFile(snapshot)
    expect(closed).toBe(true)
    expect(aborted).toBe(false)
    expect(lines).toHaveLength(2)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith(sparseHash, { persist: false })
    expect(describe).toHaveBeenCalledTimes(1)
    expect(put).not.toHaveBeenCalled()
    put.mockResolvedValue(undefined)
    expect(await importSceneFile(new File(lines, 'valid-shared-chunk.vscene'))).toEqual(snapshot)
    put.mockClear()
    for (const field of ['count', 'colors', 'lod', 'bounds']) {
      const changed = structuredClone(snapshot), asset = changed.assets[1], chunk = asset.chunks[0]
      if (field === 'count') { chunk.count++; asset.voxelCount++ }
      if (field === 'colors') { chunk.colors = [80, 82]; chunk.lod = chunk.lod.map(color => color === 81 ? 82 : color) }
      if (field === 'lod') chunk.lod = chunk.lod.map(color => color === 80 ? 81 : color === 81 ? 80 : 0)
      if (field === 'bounds') { chunk.bounds.min.x--; asset.bounds = structuredClone(chunk.bounds) }
      expect(() => parseSceneManifest(changed)).not.toThrow()
      closed = aborted = false
      lines.length = 0
      load.mockClear(); describe.mockClear()
      await expect(exportSceneFile(changed)).rejects.toThrow('metadata does not match')
      expect(aborted).toBe(true)
      expect(closed).toBe(false)
      expect(lines).toHaveLength(1)
      expect(load).toHaveBeenCalledTimes(1)
      expect(describe).toHaveBeenCalledTimes(1)
      expect(put).not.toHaveBeenCalled()
    }
    load.mockResolvedValueOnce(bytes)
    closed = aborted = false
    await expect(exportSceneFile(snapshot)).rejects.toThrow('SHA256')
    expect(aborted).toBe(true)
    expect(closed).toBe(false)
  } finally {
    load.mockRestore(); put.mockRestore(); describe.mockRestore()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('cancelled native export rejects without a download or a success continuation', async () => {
  const { exportSceneFile } = await import('../src/scene-library')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const cancelled = new DOMException('The user cancelled the save dialog.', 'AbortError')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: async () => { throw cancelled } } })
  const load = spyOn(storage, 'loadSceneChunk')
  const objectURL = spyOn(URL, 'createObjectURL')
  let success = false
  try {
    await expect(exportSceneFile(snapshot).then(() => { success = true })).rejects.toBe(cancelled)
    expect(success).toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(objectURL).not.toHaveBeenCalled()
  } finally {
    load.mockRestore(); objectURL.mockRestore()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('client chunks/check batches stay below 1000 hashes and metadata carries no voxel bytes', async () => {
  const { saveLibraryScene } = await import('../src/scene-library')
  const scene = largeFixture(1001), sizes: number[] = []
  const originalFetch = globalThis.fetch
  const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body))
    if (String(input).endsWith('/blobs/check')) {
      sizes.push(body.hashes.length)
      return Response.json({ missing: [] })
    }
    expect(String(input)).toBe('/api/scenes')
    expect(body.snapshot).toEqual(scene)
    expect(String(init?.body)).not.toContain('dataBase64')
    return Response.json({ id: crypto.randomUUID(), version: 1, tags: [] })
  }, { preconnect: originalFetch.preconnect }))
  const load = spyOn(storage, 'loadSceneChunk').mockRejectedValue(new Error('No downloads expected'))
  try {
    expect((await saveLibraryScene(scene, [])).version).toBe(1)
    expect(sizes).toEqual([1000, 1])
    expect(load).not.toHaveBeenCalled()
  } finally { network.mockRestore(); load.mockRestore() }
})

test('file fallback downloads small scenes and rejects more than 64 MiB before loading any chunks', async () => {
  const { exportSceneFile, importSceneFile } = await import('../src/scene-library')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let clicked = false, download: Blob | undefined
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ click: () => { clicked = true } }) } })
  const objectURL = spyOn(URL, 'createObjectURL').mockImplementation(blob => { download = blob as Blob; return 'blob:scene-test' })
  const revokeURL = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 0 }) as typeof setTimeout)
  const load = spyOn(storage, 'loadSceneChunk').mockResolvedValue(bytes)
  const put = spyOn(storage, 'putSceneBlob').mockResolvedValue(undefined)
  try {
    await exportSceneFile(snapshot)
    expect(clicked).toBe(true)
    expect(download).toBeInstanceOf(Blob)
    expect(load).toHaveBeenCalledWith(hash, { persist: false })
    expect(await importSceneFile(new File([download!], 'fallback.vscene'))).toEqual(snapshot)
    const changed = structuredClone(snapshot)
    changed.assets[1].chunks[0].count--
    changed.assets[1].voxelCount--
    clicked = false
    objectURL.mockClear()
    await expect(exportSceneFile(changed)).rejects.toThrow('metadata does not match')
    expect(clicked).toBe(false)
    expect(objectURL).not.toHaveBeenCalled()
    load.mockClear()
    await expect(exportSceneFile(largeFixture(13_000))).rejects.toThrow('64 MiB')
    expect(load).not.toHaveBeenCalled()
  } finally {
    objectURL.mockRestore(); revokeURL.mockRestore(); timeout.mockRestore(); load.mockRestore(); put.mockRestore()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('Vite dev and preview proxy scene metadata and binary routes without changing origin or production serving', async () => {
  const distDir = resolve(directory, 'preview-dist')
  mkdirSync(distDir)
  await Bun.write(resolve(distDir, 'index.html'), '<!doctype html><title>Scene preview</title>')
  for (const mode of ['dev', 'preview']) {
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const url = reservation.url.origin, port = String(reservation.port)
    await reservation.stop(true)
    const dataDir = resolve(directory, mode)
    const child = Bun.spawn([process.execPath, resolve(PROJECT_ROOT, 'scripts/dev.ts'), ...(mode === 'preview' ? ['--preview', '--outDir', distDir] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], {
      cwd: PROJECT_ROOT, env: { ...process.env, VOXEL_DATA_DIR: dataDir }, stdout: 'ignore', stderr: 'pipe',
    })
    try {
      let ready = false
      for (let i = 0; i < 200; i++) {
        if (child.exitCode != null) throw new Error(await new Response(child.stderr).text())
        const response = await fetch(`${url}/api/scenes`, { signal: AbortSignal.timeout(250) }).catch(() => undefined)
        if (response?.status === 200) { expect(await response.json()).toEqual({ scenes: [], tags: [], total: 0 }); ready = true; break }
        await Bun.sleep(25)
      }
      expect(ready).toBe(true)
      const headers = { origin: url, 'sec-fetch-site': 'same-origin' }
      const upload = await fetch(`${url}/api/scenes/blobs/${hash}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes })
      expect(upload.status).toBe(200)
      const created = await fetch(`${url}/api/scenes`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot, tags: ['proxy'] }) })
      expect(created.status).toBe(201)
      expect(new Uint8Array(await (await fetch(`${url}/api/scenes/blobs/${hash}`)).arrayBuffer())).toEqual(bytes)
      expect((await (await fetch(`${url}/api/scenes?tag=proxy`)).json()).total).toBe(1)
      await error(await fetch(`${url}/api/scenes`, { headers: { origin: 'https://attacker.test' } }), 400)
      if (mode === 'preview') expect(await (await fetch(url)).text()).toContain('<title>Scene preview</title>')
    } finally {
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 7000)
      try { expect(await child.exited).toBe(143) } finally { clearTimeout(timeout) }
    }
    expect(existsSync(resolve(dataDir, 'models.sqlite-wal'))).toBe(false)
  }
}, 30_000)
