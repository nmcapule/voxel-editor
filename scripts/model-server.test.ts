import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { chunkId, VoxelDocument } from '../src/editor'
import { decodeProjectSnapshot, encodeProjectSnapshot } from '../src/protocol'
import { createModelServer, MAX_REQUEST_BYTES, PROJECT_ROOT, type ModelSummary } from './model-server'
import { renderModelThumbnail } from './model-thumbnail'

const document = new VoxelDocument({ x: 32, y: 16, z: 16 }, 'Layered black model')
document.palette[80] = 0
document.paletteOccupied[80] = 1
document.paletteOccupied[81] = 1 // An unused, authored black slot must also survive.
document.materials[80] = { name: 'Black glass', roughness: 0.12, metalness: 0.3, emissiveIntensity: 0.4, opacity: 0.9, transmission: 0.7, ior: 1.4 }
document.setVoxel(1, 2, 3, 80)
document.setVoxel(20, 2, 3, 5)
const upper = document.createLayer()
document.setVoxel(1, 2, 3, 6)
upper.name = 'Hidden layer'
upper.visible = false
upper.locked = true
const snapshot = encodeProjectSnapshot(document, {
  background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42,
  ambientOcclusion: true, shadows: true, grid: true, faceGrid: false,
  projection: 'orthographic', pathTracing: true,
})

let directory: string
let library: ReturnType<typeof createModelServer>
let services: ReturnType<typeof createModelServer>[]
function start(options: Parameters<typeof createModelServer>[0] = {}) {
  const service = createModelServer({ databasePath: resolve(directory, 'models.sqlite'), port: 0, ...options })
  services.push(service)
  return service
}
const request = (path = '', init?: RequestInit) => fetch(new URL(`/api/models${path}`, library.server.url), { signal: AbortSignal.timeout(5000), ...init })
const save = (body: unknown, path = '', method = 'POST', headers: Record<string, string> = {}) => request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
async function expectError(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(response.headers.has('access-control-allow-origin')).toBe(false)
  const body = await response.json()
  expect(Object.keys(body)).toEqual(['error'])
  expect(body.error).toBeString()
  expect(body.error.length).toBeGreaterThan(0)
  return body.error as string
}

beforeEach(() => {
  directory = mkdtempSync(resolve(tmpdir(), 'voxel-model-library-'))
  services = []
  library = start()
})
afterEach(async () => {
  await Promise.all(services.map(service => service.close()))
  rmSync(directory, { recursive: true, force: true })
})

test('persists lossless layered/material/black snapshots and versions across database restarts', async () => {
  const response = await save({ snapshot, tags: [' Stone ', 'stone', 'BLACK', '', '   '] })
  expect(response.status).toBe(201)
  const created: ModelSummary = await response.json()
  expect(created).toEqual({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: snapshot.name, tags: ['stone', 'black'], version: 1,
    createdAt: expect.any(String), updatedAt: expect.any(String), dimensions: snapshot.dimensions, voxelCount: 3,
  })
  expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
  expect(created.updatedAt).toBe(created.createdAt)
  const db = new Database(resolve(directory, 'models.sqlite'))
  expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  db.close()
  await Promise.all([library.close(), library.close()])
  library = start()
  const opened = await (await request(`/${created.id}`)).json()
  expect(opened).toEqual({ ...created, snapshot })
  const decoded = decodeProjectSnapshot(opened.snapshot)
  expect(decoded.document.voxelCount).toBe(3)
  expect(decoded.document.getVisibleVoxel(1, 2, 3)).toBe(80)
  expect(decoded.document.getLayerVoxel(1, 2, 3, upper.id)).toBe(6)
  expect(decoded.document.hasPaletteColor(81)).toBe(true)
  expect(decoded.document.materials[80]).toEqual(snapshot.materials[80])
  const updated = await (await save({ snapshot, tags: ['updated'], version: 1 }, `/${created.id}`, 'PUT')).json()
  expect(updated.version).toBe(2)
  expect(updated.createdAt).toBe(created.createdAt)
  expect(updated.updatedAt > created.updatedAt).toBe(true)
  await library.close()
  library = start()
  expect(await (await request(`/${created.id.toUpperCase()}`)).json()).toEqual({ ...updated, snapshot })
  expect(await (await request()).json()).toEqual({ models: [updated], tags: ['updated'], total: 1 })
})

test('thumbnails are lazy, persistent PNGs; HEAD is read-only and cache hits never select snapshots', async () => {
  const created = await (await save({ snapshot, tags: ['thumbnail'] })).json()
  const path = `/${created.id}/thumbnail.png?v=${created.version}`
  const db = new Database(resolve(directory, 'models.sqlite'))
  const cached = () => db.query<{ thumbnail: Uint8Array | null }, [string]>('SELECT thumbnail FROM models WHERE id = ?').get(created.id)!.thumbnail
  try {
    expect(cached()).toBeNull()
    expect(await (await request(`/${created.id}`)).json()).toEqual({ ...created, snapshot })
    expect(await (await request()).json()).toEqual({ models: [created], tags: ['thumbnail'], total: 1 })
    const head = await request(path, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('image/png')
    expect(head.headers.get('cache-control')).toBe('no-cache')
    expect(await head.text()).toBe('')
    expect(cached()).toBeNull()
    const etag = head.headers.get('etag')!
    const notModified = await request(path, { headers: { 'if-none-match': etag } })
    expect(notModified.status).toBe(304)
    expect(await notModified.text()).toBe('')
    expect(cached()).toBeNull()

    const response = await request(path)
    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe(etag)
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const png = Buffer.from(await response.arrayBuffer())
    expect(png).toEqual(renderModelThumbnail(decodeProjectSnapshot(snapshot).document))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([256, 256])
    expect(response.headers.get('content-length')).toBe(String(png.length))
    expect(cached()).toEqual(new Uint8Array(png))
    await library.close()
    library = start()
    expect(cached()).toEqual(new Uint8Array(png))

    // A cached read must work even if selecting the snapshot column would fail.
    db.exec('ALTER TABLE models RENAME COLUMN snapshot TO unavailable_snapshot')
    try {
      for (const suffix of [`?v=1`, '?v=0', '?v=999', '']) {
        const hit = await request(`/${created.id.toUpperCase()}/thumbnail.png${suffix}`)
        expect(hit.status).toBe(200)
        expect(hit.headers.get('etag')).toBe(etag)
        expect(Buffer.from(await hit.arrayBuffer())).toEqual(png)
      }
      const cachedHead = await request(path, { method: 'HEAD' })
      expect(cachedHead.headers.get('content-length')).toBe(String(png.length))
      expect(await cachedHead.text()).toBe('')
      for (const tag of [etag, etag.replace('W/', ''), `"other", ${etag}`, '*']) {
        for (const method of ['GET', 'HEAD']) {
          const conditional = await request(path, { method, headers: { 'if-none-match': tag } })
          expect(conditional.status).toBe(304)
          expect(conditional.headers.get('etag')).toBe(etag)
          expect(await conditional.text()).toBe('')
        }
      }
      expect(await (await request()).json()).toEqual({ models: [created], tags: ['thumbnail'], total: 1 })
    } finally { db.exec('ALTER TABLE models RENAME COLUMN unavailable_snapshot TO snapshot') }
    expect(await (await request(`/${created.id}`)).json()).toEqual({ ...created, snapshot })
  } finally { db.close() }
})

test('successful atomic updates invalidate thumbnails; stale saves and failed writes retain them', async () => {
  const created = await (await save({ snapshot, tags: [] })).json()
  const path = `/${created.id}/thumbnail.png?v=1`
  const first = await request(path)
  const etag = first.headers.get('etag')!
  const png = Buffer.from(await first.arrayBuffer())
  const db = new Database(resolve(directory, 'models.sqlite'))
  const cached = () => db.query<{ thumbnail: Uint8Array | null }, [string]>('SELECT thumbnail FROM models WHERE id = ?').get(created.id)!.thumbnail
  try {
    await expectError(await save({ snapshot, tags: [], version: 2 }, `/${created.id}`, 'PUT'), 409)
    expect(cached()).toEqual(new Uint8Array(png))
    db.exec("CREATE TRIGGER fail_save BEFORE UPDATE ON models BEGIN SELECT RAISE(ABORT, 'private details'); END")
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expectError(await save({ snapshot, tags: [], version: 1 }, `/${created.id}`, 'PUT'), 500)
      expect(cached()).toEqual(new Uint8Array(png))
    } finally { log.mockRestore(); db.exec('DROP TRIGGER fail_save') }

    const changed = { ...snapshot, palette: snapshot.palette.map((color, index) => index === 80 ? 0x44eeaa : color) }
    const updated = await (await save({ snapshot: changed, tags: [], version: 1 }, `/${created.id}`, 'PUT')).json()
    expect(updated.version).toBe(2)
    expect(cached()).toBeNull()
    const head = await request(path, { method: 'HEAD', headers: { 'if-none-match': etag } })
    expect(head.status).toBe(200)
    expect(head.headers.get('etag')).not.toBe(etag)
    expect(await head.text()).toBe('')
    expect(cached()).toBeNull()
    await library.close()
    library = start()
    // Even a stale version URL must revalidate against the current model, not serve the old PNG.
    const next = await request(path, { headers: { 'if-none-match': etag } })
    expect(next.status).toBe(200)
    expect(next.headers.get('cache-control')).toBe('no-cache')
    expect(next.headers.get('etag')).toBe(head.headers.get('etag'))
    const nextPNG = Buffer.from(await next.arrayBuffer())
    expect(nextPNG).not.toEqual(png)
    expect(nextPNG).toEqual(renderModelThumbnail(decodeProjectSnapshot(changed).document))
    expect(cached()).toEqual(new Uint8Array(nextPNG))
    expect(Buffer.from(await (await request(`/${created.id}/thumbnail.png?v=2`)).arrayBuffer())).toEqual(nextPNG)
    expect(await (await request(`/${created.id}`)).json()).toEqual({ ...updated, snapshot: changed })
  } finally { db.close() }
})

test('migrates legacy SQLite with old rows but never backfills thumbnails on startup/list/load/HEAD', async () => {
  await library.close()
  const databasePath = resolve(directory, 'legacy.sqlite')
  const db = new Database(databasePath)
  const id = crypto.randomUUID(), other = crypto.randomUUID()
  const now = '2026-01-01T00:00:00.000Z'
  db.exec(`CREATE TABLE models (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, nameSearch TEXT NOT NULL,
    tags TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, dimensions TEXT NOT NULL,
    voxelCount INTEGER NOT NULL, snapshot TEXT NOT NULL
  )`)
  for (const key of [id, other]) db.query('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(key, snapshot.name, snapshot.name.toLowerCase(), '["legacy"]', 7, now, now, JSON.stringify(snapshot.dimensions), 3, JSON.stringify(snapshot))
  try {
    library = start({ databasePath })
    const column = db.query<{ name: string; type: string; notnull: number; dflt_value: unknown }, []>('PRAGMA table_info(models)').all().find(column => column.name === 'thumbnail')
    expect(column).toMatchObject({ type: 'BLOB', notnull: 0, dflt_value: null })
    expect((await (await request()).json()).total).toBe(2)
    expect((await (await request(`/${id}`)).json()).snapshot).toEqual(snapshot)
    expect((await request(`/${id}/thumbnail.png?v=7`, { method: 'HEAD' })).status).toBe(200)
    expect(db.query('SELECT count(*) AS count FROM models WHERE thumbnail IS NOT NULL').get()).toEqual({ count: 0 })
    expect((await request(`/${id}/thumbnail.png?v=7`)).status).toBe(200)
    expect(db.query('SELECT count(*) AS count FROM models WHERE thumbnail IS NOT NULL').get()).toEqual({ count: 1 })
    expect(db.query('SELECT version, createdAt, updatedAt FROM models WHERE id = ?').get(id)).toEqual({ version: 7, createdAt: now, updatedAt: now })
    await library.close()
    library = start({ databasePath })
    expect(db.query('SELECT count(*) AS count FROM models WHERE thumbnail IS NOT NULL').get()).toEqual({ count: 1 })
    expect((await request(`/${other}/thumbnail.png?v=7`)).status).toBe(200)
    expect(db.query('SELECT count(*) AS count FROM models WHERE thumbnail IS NOT NULL').get()).toEqual({ count: 2 })
  } finally { db.close() }
})

test('thumbnail routes preserve JSON errors and enforce same-origin and host defenses on GET and HEAD', async () => {
  const created = await (await save({ snapshot, tags: [] })).json()
  const path = `/${created.id}/thumbnail.png?v=1`
  for (const bad of [`/${crypto.randomUUID()}/thumbnail.png`, `/${created.id}/thumbnail.svg`, `/${created.id}/thumbnail.png/extra`, `/${created.id}/extra/thumbnail.png`]) {
    await expectError(await request(bad), 404)
    const head = await request(bad, { method: 'HEAD' })
    expect(head.status).toBe(404)
    expect(await head.text()).toBe('')
  }
  await expectError(await request('/bad/thumbnail.png'), 400)
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) await expectError(await request(path, { method }), 400)
  const origin = library.server.url.origin
  for (const headers of [
    { origin: 'https://attacker.test' }, { origin: 'null' }, { referer: 'https://attacker.test/page' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { host: 'attacker.test', origin: 'http://attacker.test', 'sec-fetch-site': 'same-origin' },
    { origin: 'https://attacker.test', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https' },
  ] as Record<string, string>[]) {
    await expectError(await request(path, { headers }), 400)
    const head = await request(path, { method: 'HEAD', headers })
    expect(head.status).toBe(400)
    expect(await head.text()).toBe('')
    expect(head.headers.has('access-control-allow-origin')).toBe(false)
  }
  const db = new Database(resolve(directory, 'models.sqlite'))
  try { expect(db.query('SELECT thumbnail FROM models WHERE id = ?').get(created.id)).toEqual({ thumbnail: null }) }
  finally { db.close() }
  expect((await request(path, { headers: { referer: `${origin}/app`, 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
  library = start({ trustProxy: true, allowedHosts: ['studio.example'] })
  const forwarded = { origin: 'https://studio.example', 'x-forwarded-host': 'studio.example', 'x-forwarded-proto': 'https' }
  for (const method of ['GET', 'HEAD']) {
    expect((await request(path, { method, headers: forwarded })).status).toBe(200)
    for (const headers of [{ ...forwarded, origin: 'https://attacker.test' }, { ...forwarded, host: 'attacker.test' }, { ...forwarded, 'x-forwarded-host': 'attacker.test' }]) {
      const rejected = await request(path, { method, headers })
      expect(rejected.status).toBe(400)
      if (method === 'HEAD') expect(await rejected.text()).toBe('')
      else await expectError(rejected, 400)
    }
  }
})

test('searches names and tags literally and case-insensitively with independent global tags', async () => {
  const models = [
    { name: '100%_ Cabin', tags: [' Stone ', 'rock%_', 'a_b'] },
    { name: '100XX Cabin', tags: ['stonework', 'rockZZ', 'axb'] },
    { name: 'Plain house', tags: ['TAG-only', '100%', 'STONE'] },
    { name: '\u00c4ther', tags: ['\u00d6L'] },
  ]
  for (const model of models) expect((await save({ snapshot: { ...snapshot, name: model.name }, tags: model.tags })).status).toBe(201)
  const names = async (query: Record<string, string>) => (await (await request(`?${new URLSearchParams(query)}`)).json()).models.map((model: ModelSummary) => model.name).sort()
  expect(await names({ q: '%_' })).toEqual(['100%_ Cabin'])
  expect(await names({ q: 'A_B' })).toEqual(['100%_ Cabin'])
  expect(await names({ q: '100%' })).toEqual(['100%_ Cabin', 'Plain house'])
  expect(await names({ q: 'TAG-ON' })).toEqual(['Plain house'])
  expect(await names({ tag: 'StOnE' })).toEqual(['100%_ Cabin', 'Plain house'])
  expect(await names({ tag: 'stone', q: 'HOUSE' })).toEqual(['Plain house'])
  expect(await names({ tag: 'sto' })).toEqual([])
  expect(await names({ tag: 'ROCK%_' })).toEqual(['100%_ Cabin'])
  expect(await names({ q: "%' OR 1=1 --" })).toEqual([])
  expect(await names({ q: '\u00e4T' })).toEqual(['\u00c4ther'])
  expect(await names({ tag: '\u00f6l' })).toEqual(['\u00c4ther'])
  const filtered = await (await request('?q=missing&offset=50')).json()
  expect(filtered).toEqual({ models: [], total: 0, tags: ['100%', 'a_b', 'axb', 'rock%_', 'rockzz', 'stone', 'stonework', 'tag-only', '\u00f6l'] })
})

test('paginates metadata only, counts matches, and sorts by most recent update', async () => {
  const created: ModelSummary[] = []
  for (let i = 0; i < 53; i++) created.push(await (await save({ snapshot: { ...snapshot, name: `Model ${i}`, chunks: [] }, tags: [i % 2 ? 'odd' : 'even'] })).json())
  await Bun.sleep(2)
  await save({ snapshot, tags: ['new'], version: 1 }, `/${created[0].id}`, 'PUT')
  const first = await (await request()).json()
  const second = await (await request('?offset=50')).json()
  expect(first.total).toBe(53)
  expect(second.total).toBe(53)
  expect(first.models).toHaveLength(50)
  expect(second.models).toHaveLength(3)
  expect(first.models[0].id).toBe(created[0].id)
  const all: ModelSummary[] = [...first.models, ...second.models]
  expect(new Set(all.map(model => model.id)).size).toBe(53)
  expect(all.map(model => model.updatedAt)).toEqual(all.map(model => model.updatedAt).sort().reverse())
  for (const model of all) expect(Object.keys(model).sort()).toEqual(['id', 'name', 'tags', 'version', 'createdAt', 'updatedAt', 'dimensions', 'voxelCount'].sort())
  expect((await (await request('?tag=ODD')).json()).total).toBe(26)
  expect((await (await request('?offset=999')).json()).models).toEqual([])
  for (const offset of ['-1', '1.5', 'no', '9007199254740992', '']) await expectError(await request(`?offset=${offset}`), 400)
})

test('validates tags before creating or replacing a model', async () => {
  for (const tags of [null, 'stone', {}, [null], [1], [true], [{}], ['x'.repeat(41)], ['a,b'], ['a\nb'], ['\t'], ['\u0000'], ['\u007f'], ['\u0085'], Array.from({ length: 21 }, (_, i) => `tag${i}`)]) {
    await expectError(await save({ snapshot, tags }), 400)
  }
  const accepted = await save({ snapshot, tags: ['x'.repeat(40), ...Array(30).fill(' SAME '), '', ' '] })
  expect(accepted.status).toBe(201)
  const created = await accepted.json()
  expect(created.tags).toEqual(['x'.repeat(40), 'same'])
  await expectError(await save({ snapshot, tags: ['bad,tag'], version: 1 }, `/${created.id}`, 'PUT'), 400)
  expect((await (await request(`/${created.id}`)).json()).version).toBe(1)
  expect((await (await request()).json()).total).toBe(1)
})

test('rejects malformed bodies, invalid snapshots and update versions without writing', async () => {
  for (const invalid of [null, {}, { ...snapshot, version: 2 }, { ...snapshot, dimensions: { x: 15, y: 16, z: 16 } }, { ...snapshot, palette: [] }, { ...snapshot, paletteOccupied: [1] }, { ...snapshot, materials: [] }, { ...snapshot, layers: [] }, { ...snapshot, chunks: [{ ...snapshot.chunks[0], dataBase64: '?' }] }, { ...snapshot, chunks: [...snapshot.chunks, snapshot.chunks[0]] }]) {
    await expectError(await save({ snapshot: invalid, tags: [] }), 400)
  }
  for (const body of ['{broken', '[]', 'null', '']) await expectError(await request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), 400)
  await expectError(await save({ snapshot }), 400)
  await expectError(await save({ snapshot, tags: [] }, '', 'POST', { 'content-type': 'text/plain' }), 400)
  await expectError(await save({ snapshot, tags: [] }, '', 'POST', { 'content-encoding': 'gzip' }), 400)
  const id = crypto.randomUUID()
  for (const version of [undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) await expectError(await save({ snapshot, tags: [], version }, `/${id}`, 'PUT'), 400)
  expect(await (await request()).json()).toEqual({ models: [], tags: [], total: 0 })
})

test('bounds known-length and streamed request bodies, returning JSON 413', async () => {
  expect(MAX_REQUEST_BYTES).toBe(100 * 1024 * 1024)
  // Use the wire directly: Bun clients rewrite Content-Length and can reuse rejected upload sockets.
  const uploadBody = (headers: string, body = '') => new Promise<Response>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: library.server.port! }, () => {
      socket.write(`POST /api/models HTTP/1.1\r\nHost: ${library.server.url.host}\r\nContent-Type: application/json\r\n${headers}\r\nConnection: close\r\n\r\n${body}`)
    })
    let response = ''
    socket.on('data', chunk => { response += chunk.toString() })
    socket.on('end', () => {
      const boundary = response.indexOf('\r\n\r\n')
      const [status, ...headers] = response.slice(0, boundary).split('\r\n')
      resolve(new Response(response.slice(boundary + 4), { status: Number(status.split(' ')[1]), headers: headers.map<[string, string]>(line => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon), line.slice(colon + 1).trim()]
      }) }))
    })
    socket.on('error', reject)
    socket.setTimeout(4000, () => socket.destroy(new Error('Oversized upload was not rejected from headers.')))
  })
  expect(await expectError(await uploadBody(`Content-Length: ${MAX_REQUEST_BYTES + 1}`), 413)).toContain('100 MiB')
  library = start({ maxRequestBytes: 1024 })
  await expectError(await request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(1025) }), 413)
  await expectError(await request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(1024) }), 400)
  await expectError(await uploadBody('Transfer-Encoding: chunked', `200\r\n${' '.repeat(512)}\r\n`.repeat(3) + '0\r\n\r\n'), 413)
  const after = await request()
  expect({ status: after.status, text: await after.text() }).toEqual({ status: 200, text: JSON.stringify({ models: [], tags: [], total: 0 }) })
})

test('atomic optimistic updates across server connections cannot overwrite a winning version', async () => {
  const created = await (await save({ snapshot, tags: ['original'] })).json()
  const other = start()
  const proposals = [0, 1].map(i => ({ snapshot: { ...snapshot, name: `Writer ${i}` }, tags: [`writer-${i}`], version: 1 }))
  const responses = await Promise.all([save(proposals[0], `/${created.id}`, 'PUT'), fetch(new URL(`/api/models/${created.id}`, other.server.url), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proposals[1]) })])
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  const winningIndex = responses.findIndex(response => response.status === 200)
  const winner = await responses[winningIndex].json()
  expect(winner.version).toBe(2)
  expect(await expectError(responses[1 - winningIndex], 409)).toMatch(/reopen.*copy/i)
  await expectError(await save({ snapshot: { ...snapshot, name: 'Stale overwrite' }, tags: ['bad'], version: 1 }, `/${created.id}`, 'PUT'), 409)
  expect(await (await request(`/${created.id}`)).json()).toEqual({ ...winner, snapshot: proposals[winningIndex].snapshot })
  expect((await (await request()).json()).tags).toEqual(winner.tags)
})

test('missing models, invalid IDs and unsupported methods return helpful errors', async () => {
  const id = crypto.randomUUID()
  await expectError(await request(`/${id}`), 404)
  await expectError(await save({ snapshot, tags: [], version: 1 }, `/${id}`, 'PUT'), 404)
  for (const path of ['/bad', '/', `/${id}/extra`, '/%00', '/%2e%2e%2fmodels.sqlite']) expect([400, 404]).toContain((await request(path)).status)
  await expectError(await request(`/${id}`, { method: 'DELETE' }), 400)
  await expectError(await save({ snapshot, tags: [] }, `/${id}`), 400)
  expect((await request('', { method: 'HEAD' })).status).toBe(200)
  expect(await (await request('', { method: 'HEAD' })).text()).toBe('')
})

test('storage failures return a safe JSON 500 without changing the existing model', async () => {
  const created = await (await save({ snapshot, tags: ['original'] })).json()
  const db = new Database(resolve(directory, 'models.sqlite'))
  db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON models BEGIN SELECT RAISE(ABORT, 'private storage details'); END")
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const message = await expectError(await save({ snapshot: { ...snapshot, name: 'Rejected' }, tags: [], version: 1 }, `/${created.id}`, 'PUT'), 500)
    expect(message).not.toContain('private storage details')
    expect(log).toHaveBeenCalled()
    expect(await (await request(`/${created.id}`)).json()).toEqual({ ...created, snapshot })
  } finally { log.mockRestore(); db.close() }
})

test('rejects cross-origin/cross-site browser requests without enabling CORS', async () => {
  const origin = library.server.url.origin
  expect((await save({ snapshot, tags: [] }, '', 'POST', { origin, 'sec-fetch-site': 'same-origin' })).status).toBe(201)
  for (const headers of [
    { origin: 'https://attacker.test' }, { origin: 'null' }, { origin: origin.replace('http:', 'https:') },
    { referer: 'https://attacker.test/page' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { origin: 'https://attacker.test', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https' },
  ] as Record<string, string>[]) {
    await expectError(await request('', { headers }), 400)
    await expectError(await save({ snapshot, tags: [] }, '', 'POST', headers), 400)
  }
  await expectError(await request('', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT' } }), 400)
  expect((await request('', { headers: { referer: `${origin}/app` } })).status).toBe(200)
  expect((await (await request()).json()).total).toBe(1)
  library = start({ trustProxy: true, allowedHosts: ['studio.example'] })
  const forwarded = { origin: 'https://studio.example', 'x-forwarded-host': 'studio.example', 'x-forwarded-proto': 'https' }
  expect((await save({ snapshot, tags: [] }, '', 'POST', forwarded)).status).toBe(201)
  await expectError(await request('', { headers: { ...forwarded, origin: 'https://attacker.test' } }), 400)
  await expectError(await request('', { headers: { ...forwarded, 'sec-fetch-site': 'cross-site' } }), 400)
})

test('standalone rejects rebinding hosts and forged forwarding without reading or changing models', async () => {
  for (const trustProxy of [false, true]) {
    library = start({ trustProxy, allowedHosts: ['studio.example'] })
    const created = await (await save({ snapshot, tags: [] })).json()
    const total = (await (await request()).json()).total
    for (const headers of [
      { host: 'attacker.test' },
      { host: 'attacker.test', origin: 'http://attacker.test' },
      { host: 'studio.example.attacker.test', origin: 'http://studio.example.attacker.test' },
      { host: 'attacker.test', origin: 'https://attacker.test', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https' },
      { host: 'attacker.test', origin: 'https://studio.example', 'x-forwarded-host': 'studio.example', 'x-forwarded-proto': 'https' },
      { host: 'studio.example', origin: 'https://attacker.test', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https' },
      { host: library.server.url.host, origin: 'https://attacker.test', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https' },
      { host: 'localhost@attacker.test', origin: 'http://attacker.test' },
    ] as Record<string, string>[]) {
      headers['sec-fetch-site'] = 'same-origin'
      await expectError(await request('', { headers }), 400)
      await expectError(await request(`/${created.id}`, { headers }), 400)
      await expectError(await save({ snapshot, tags: [] }, '', 'POST', headers), 400)
      await expectError(await save({ snapshot, tags: [], version: 1 }, `/${created.id}`, 'PUT', headers), 400)
    }
    expect((await (await request()).json()).total).toBe(total)
    expect(await (await request(`/${created.id}`)).json()).toEqual({ ...created, snapshot })
  }
})

test('accepts exact deployment names and IPs from VOXEL_ALLOWED_HOSTS, not wildcard binds', async () => {
  const previous = process.env.VOXEL_ALLOWED_HOSTS
  try {
    process.env.VOXEL_ALLOWED_HOSTS = ' Studio.Example , 192.168.1.20, fd00::1234, [fd00::5678], '
    library = start({ hostname: '0.0.0.0', trustProxy: true })
    for (const name of ['localhost', '127.0.0.1', '[::1]', 'STUDIO.EXAMPLE', 'studio.example.', '192.168.1.20', '[fd00::1234]', '[fd00::5678]']) {
      const host = `${name}:${library.server.port}`
      const headers = { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }
      expect((await save({ snapshot, tags: [] }, '', 'POST', headers)).status).toBe(201)
      expect((await request('', { headers })).status).toBe(200)
    }
    const forwarded = { host: library.server.url.host.replace('0.0.0.0', '127.0.0.1'), origin: 'https://studio.example', 'x-forwarded-host': 'studio.example', 'x-forwarded-proto': 'https' }
    expect((await save({ snapshot, tags: [] }, '', 'POST', forwarded)).status).toBe(201)
    for (const host of ['0.0.0.0', '[::]', 'sub.studio.example', 'studio.example.attacker.test']) {
      await expectError(await request('', { headers: { host, origin: `http://${host}` } }), 400)
    }
    for (const invalid of ['*', '*.example', '.exe.xyz', 'https://studio.example', 'studio.example:80', 'user@localhost', 'localhost/path']) {
      process.env.VOXEL_ALLOWED_HOSTS = invalid
      expect(() => start()).toThrow('VOXEL_ALLOWED_HOSTS')
    }
    library = start({ hostname: '127.0.0.2', allowedHosts: [] })
    expect((await request('', { headers: { origin: library.server.url.origin } })).status).toBe(200)
  } finally {
    if (previous === undefined) delete process.env.VOXEL_ALLOWED_HOSTS
    else process.env.VOXEL_ALLOWED_HOSTS = previous
  }
})

test('serves only existing dist files with safe GET/HEAD, not traversal or symlink escapes', async () => {
  const distDir = resolve(directory, 'dist')
  mkdirSync(distDir)
  await Bun.write(resolve(distDir, 'index.html'), '<!doctype html><title>Fixture</title>')
  await Bun.write(resolve(distDir, 'app.js'), 'console.log("fixture")')
  await Bun.write(resolve(directory, 'secret.txt'), 'private data')
  symlinkSync(resolve(directory, 'secret.txt'), resolve(distDir, 'leak.txt'))
  symlinkSync(directory, resolve(distDir, 'outside'))
  expect(() => start({ distDir, databasePath: resolve(distDir, 'models.sqlite') })).toThrow('outside dist')
  library = start({ distDir })
  for (const path of ['/', '/app.js']) {
    await expectError(await fetch(new URL(path, library.server.url), { headers: { host: 'attacker.test', origin: 'http://attacker.test', 'sec-fetch-site': 'same-origin' } }), 400)
  }
  const asset = await fetch(new URL('/app.js', library.server.url))
  expect(asset.status).toBe(200)
  expect(asset.headers.get('content-type')).toContain('javascript')
  expect(await asset.text()).toBe('console.log("fixture")')
  const head = await fetch(library.server.url, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0)
  expect(await head.text()).toBe('')
  for (const path of ['/missing.js', '/missing-route', '/src/protocol.ts', '/scripts/model-server.ts', '/package.json', '/data/models.sqlite', '/.env', '/leak.txt', '/outside/secret.txt', '/%2e%2e%2fsecret.txt', '/%252e%252e%252fsecret.txt', '/%5c..%5csecret.txt', '//secret.txt']) await expectError(await fetch(`${library.server.url.origin}${path}`), 404)
  await expectError(await fetch(library.server.url, { method: 'POST' }), 404)
  await expectError(await fetch(new URL('/bad%zz', library.server.url)), 400)
  expect(await (await request()).json()).toEqual({ models: [], tags: [], total: 0 })
})

test('resolves relative data overrides from the project root, independent of cwd', async () => {
  const cwd = process.cwd()
  const previous = process.env.VOXEL_DATA_DIR
  process.env.VOXEL_DATA_DIR = relative(PROJECT_ROOT, resolve(directory, 'overridden'))
  try {
    process.chdir(directory)
    const service = createModelServer({ port: 0 })
    services.push(service)
    expect(existsSync(resolve(directory, 'overridden/models.sqlite'))).toBe(true)
  } finally {
    process.chdir(cwd)
    if (previous === undefined) delete process.env.VOXEL_DATA_DIR
    else process.env.VOXEL_DATA_DIR = previous
  }
})

test('dev and preview launchers proxy the API and shut down their children and SQLite', async () => {
  const distDir = resolve(directory, 'preview-dist')
  mkdirSync(distDir)
  await Bun.write(resolve(distDir, 'index.html'), '<!doctype html><title>Preview</title>')
  for (const mode of ['dev', 'preview']) {
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
    const url = reservation.url.origin
    const port = String(reservation.port)
    await reservation.stop(true)
    const dataDir = resolve(directory, mode)
    const child = Bun.spawn([process.execPath, 'run', mode, ...(mode === 'preview' ? ['--outDir', distDir] : []), '--host', '127.0.0.1', '--port', port, '--strictPort'], {
      cwd: PROJECT_ROOT, env: { ...process.env, VOXEL_DATA_DIR: dataDir }, stdout: 'ignore', stderr: 'pipe',
    })
    try {
      let ready = false
      for (let i = 0; i < 200; i++) {
        if (child.exitCode != null) throw new Error(await new Response(child.stderr).text())
        const response = await fetch(`${url}/api/models`, { signal: AbortSignal.timeout(250) }).catch(() => undefined)
        if (response?.status === 200) { expect((await response.json()).total).toBe(0); ready = true; break }
        await Bun.sleep(25)
      }
      expect(ready).toBe(true)
      const saved = await fetch(`${url}/api/models`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ snapshot, tags: ['launcher'] }) })
      expect(saved.status).toBe(201)
      const created = await saved.json()
      const image = await fetch(`${url}/api/models/${created.id}/thumbnail.png?v=${created.version}`, { headers: { referer: `${url}/app`, 'sec-fetch-site': 'same-origin' } })
      expect(image.status).toBe(200)
      expect(image.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await image.arrayBuffer())).toEqual(renderModelThumbnail(document))
      expect((await (await fetch(`${url}/api/models`)).json()).total).toBe(1)
      await expectError(await fetch(`${url}/api/models`, { headers: { origin: 'https://attacker.test' } }), 400)
      expect((await fetch(`${url}/api/models`, { headers: { host: 'studio.exe.xyz', origin: 'http://studio.exe.xyz' } })).status).toBe(200)
      expect((await fetch(`${url}/api/models`, { headers: { origin: 'https://studio.exe.xyz', 'x-forwarded-host': 'studio.exe.xyz', 'x-forwarded-proto': 'https' } })).status).toBe(200)
      if (mode === 'preview') expect(await (await fetch(url)).text()).toContain('<title>Preview</title>')
    } finally {
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 7000)
      try { expect(await child.exited).toBe(143) } finally { clearTimeout(timeout) }
    }
    expect(await fetch(`${url}/api/models`).then(() => true, () => false)).toBe(false)
    expect(existsSync(resolve(dataDir, 'models.sqlite-wal'))).toBe(false)
    const db = new Database(resolve(dataDir, 'models.sqlite'), { readonly: true })
    expect(db.query('SELECT count(*) AS count FROM models').get()).toEqual({ count: 1 })
    db.close()
  }
}, 30_000)

test('launcher failures exit nonzero and close the database; failed binds release SQLite', async () => {
  expect(() => start({ port: library.server.port })).toThrow()
  await library.close()
  expect(existsSync(resolve(directory, 'models.sqlite-wal'))).toBe(false)
  const dataDir = resolve(directory, 'failed-start')
  const child = Bun.spawn([process.execPath, resolve(PROJECT_ROOT, 'scripts/dev.ts'), '--not-a-vite-option'], {
    env: { ...process.env, VOXEL_DATA_DIR: dataDir }, stdout: 'ignore', stderr: 'ignore',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 7000)
  try { expect(await child.exited).toBe(1) } finally { clearTimeout(timeout) }
  expect(existsSync(resolve(dataDir, 'models.sqlite-wal'))).toBe(false)
}, 10_000)

if (process.env.VOXEL_THUMBNAIL_BENCHMARK === '1') test.each(['two-corners', 'sparse-4096-chunks', 'dense-noisy'])('thumbnail benchmark: %s', async kind => {
  const model = new VoxelDocument({ x: 256, y: 256, z: 256 })
  for (let i = 1; i < 256; i++) model.palette[i] = ((i * 53 & 255) << 16) | ((i * 97 & 255) << 8) | (i * 193 & 255)
  if (kind === 'two-corners') {
    model.setVoxel(0, 0, 0, 1)
  } else {
    let random = 123456789
    for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (kind === 'sparse-4096-chunks') model.setVoxel(x * 16, y * 16, z * 16, 1 + (x + y + z) % 255)
      else {
        const data = new Uint8Array(4096)
        for (let i = 0; i < data.length; i++) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0
          data[i] = 1 + (random >>> 24) % 255
        }
        model.replaceChunk(chunkId(x, y, z), [{ layerId: 1, data }])
      }
    }
  }
  model.setVoxel(255, 255, 255, 2)
  const input = { snapshot: encodeProjectSnapshot(model, snapshot.settings), tags: [] }
  const snapshotMiB = +(JSON.stringify(input).length / 1024 / 1024).toFixed(2)
  const saved = await save(input)
  expect(saved.status).toBe(201)
  const created = await saved.json()
  const path = `/${created.id}/thumbnail.png?v=1`
  Bun.gc(true)
  const start = performance.now()
  const image = await request(path, { signal: AbortSignal.timeout(30_000) })
  expect(image.status).toBe(200)
  const png = await image.arrayBuffer()
  const coldGetMs = +(performance.now() - start).toFixed(1)
  const cacheGetMs = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    const hit = await request(path)
    expect(hit.status).toBe(200)
    expect(await hit.arrayBuffer()).toEqual(png)
    cacheGetMs.push(+(performance.now() - start).toFixed(2))
  }
  expect(png.byteLength).toBeLessThan(264 * 1024)
  console.log(JSON.stringify({ kind, voxels: model.voxelCount, chunks: model.chunks.size, snapshotMiB, coldGetMs, cacheGetMs, pngBytes: png.byteLength, processRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) }))
}, 30_000)
