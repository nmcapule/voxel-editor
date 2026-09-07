import { Database } from 'bun:sqlite'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeProjectSnapshot, parseProjectSnapshot, type ProjectSnapshot } from '../src/protocol'
import { StudioCommandError } from '../src/studio'
import { renderModelThumbnail } from './model-thumbnail'
import { createSceneRoutes } from './scene-server'

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
export const MAX_REQUEST_BYTES = 100 * 1024 * 1024

export interface ModelSummary {
  id: string
  name: string
  tags: string[]
  version: number
  createdAt: string
  updatedAt: string
  dimensions: ProjectSnapshot['dimensions']
  voxelCount: number
}

interface ModelServerOptions {
  databasePath?: string
  hostname?: string
  port?: number
  distDir?: string
  trustProxy?: boolean
  allowedHosts?: string[]
  // Only for the private loopback API behind Vite's host validation.
  hostsValidatedByProxy?: boolean
  maxRequestBytes?: number
}

type ModelRow = Omit<ModelSummary, 'tags' | 'dimensions'> & { tags: string; dimensions: string }
const summaryColumns = 'id, name, tags, version, createdAt, updatedAt, dimensions, voxelCount'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

function summary(row: ModelRow): ModelSummary {
  return { ...row, tags: JSON.parse(row.tags), dimensions: JSON.parse(row.dimensions) }
}

export function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'Tags must be an array of strings.')
  const tags = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || /[\p{Cc},]/u.test(entry)) throw new HttpError(400, 'Each tag must be text without commas or control characters.')
    const tag = entry.trim().toLowerCase()
    if (tag.length > 40) throw new HttpError(400, 'Each tag must be at most 40 characters.')
    if (tag) tags.add(tag)
    if (tags.size > 20) throw new HttpError(400, 'Use at most 20 distinct tags.')
  }
  return [...tags]
}

export async function readBody(request: Request, limit: number, subject = 'model') {
  const tooLarge = () => new HttpError(413, `The ${subject} request is too large. The limit is ${limit / 1024 / 1024} MiB.`)
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw tooLarge()
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(400, `Send the ${subject} as application/json.`)
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw new HttpError(400, 'Send uncompressed JSON; encoded request bodies are not supported.')
  if (!request.body) throw new HttpError(400, 'A JSON body containing snapshot and tags is required.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        void reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  let input: unknown
  try { input = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
  catch { throw new HttpError(400, 'The request body must be valid JSON.') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'The request body must be an object containing snapshot and tags.')
  return input as Record<string, unknown>
}

function parseHostname(value: string, allowPort = false) {
  const authority = isIP(value) === 6 ? `[${value}]` : value
  const match = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[[a-f0-9:.]+\])(?::(\d+))?$/i.exec(authority)
  if (!match || !allowPort && match[1] !== undefined) throw new Error('VOXEL_ALLOWED_HOSTS requires exact hostnames or IP addresses without schemes, ports or wildcards.')
  return new URL(`http://${authority}`).hostname.replace(/\.$/, '')
}

function checkOrigin(request: Request, trustProxy: boolean) {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(400, 'Cross-site library requests are not allowed. Open the app on this server.')
  const url = new URL(request.url)
  const host = (trustProxy ? request.headers.get('x-forwarded-host') : null) ?? request.headers.get('host') ?? url.host
  const protocol = (trustProxy ? request.headers.get('x-forwarded-proto') : null) ?? url.protocol.slice(0, -1)
  const source = request.headers.get('origin') ?? request.headers.get('referer')
  if (source !== null) {
    let origin: URL
    let expected: URL
    try { origin = new URL(source); expected = new URL(`${protocol}://${host}`) } catch { throw new HttpError(400, 'The request origin is invalid.') }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== expected.origin) throw new HttpError(400, 'Cross-origin library requests are not allowed. Open the app on this server.')
  }
}

export function createModelServer(options: ModelServerOptions = {}) {
  const hostname = options.hostname ?? '127.0.0.1'
  const allowedHosts = options.hostsValidatedByProxy ? undefined : new Set([
    'localhost', '127.0.0.1', '::1', hostname,
    ...(options.allowedHosts ?? (process.env.VOXEL_ALLOWED_HOSTS ?? '').split(',')),
  ].map(host => host.trim()).filter(Boolean).map(host => parseHostname(host))
    .filter(host => host !== '0.0.0.0' && host !== '[::]'))
  const port = options.port ?? 4173
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.')
  const limit = options.maxRequestBytes ?? MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REQUEST_BYTES) throw new Error('The request limit must be between 1 byte and 100 MiB.')
  const distDir = options.distDir === undefined ? undefined : realpathSync(resolve(PROJECT_ROOT, options.distDir))
  if (distDir && !statSync(resolve(distDir, 'index.html')).isFile()) throw new Error('Build the app with bun run build before starting the production server.')
  const databasePath = options.databasePath === undefined
    ? resolve(PROJECT_ROOT, process.env.VOXEL_DATA_DIR ?? 'data', 'models.sqlite')
    : resolve(PROJECT_ROOT, options.databasePath)
  mkdirSync(dirname(databasePath), { recursive: true })
  const dataDir = realpathSync(dirname(databasePath))
  if (distDir && (dataDir === distDir || dataDir.startsWith(distDir + sep))) throw new Error('VOXEL_DATA_DIR must be outside dist so the database cannot be downloaded.')
  const db = new Database(databasePath, { create: true, strict: true })
  // Bun 1.3 only finalizes cached queries on close; this service exceeds its 20-query cache.
  const statements: ReturnType<Database['prepare']>[] = []
  const query = ((sql: string) => {
    const statement = db.prepare(sql)
    statements.push(statement)
    return statement
  }) as Database['query']
  const closeDatabase = () => { for (const statement of statements) statement.finalize(); db.close() }
  let closing: Promise<void> | undefined
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, nameSearch TEXT NOT NULL,
        tags TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, dimensions TEXT NOT NULL,
        voxelCount INTEGER NOT NULL, snapshot TEXT NOT NULL, thumbnail BLOB
      );
      CREATE INDEX IF NOT EXISTS models_updated ON models(updatedAt DESC, id);
    `)
    db.transaction(() => {
      if (!query<{ name: string }, []>('PRAGMA table_info(models)').all().some(column => column.name === 'thumbnail')) {
        db.exec('ALTER TABLE models ADD COLUMN thumbnail BLOB')
      }
    }).immediate()
    const getSummary = query<ModelRow, [string]>(`SELECT ${summaryColumns} FROM models WHERE id = ?`)
    const getModel = query<ModelRow & { snapshot: string }, [string]>(`SELECT ${summaryColumns}, snapshot FROM models WHERE id = ?`)
    const getThumbnail = query<{ version: number; thumbnail: Uint8Array<ArrayBuffer> | null }, [string]>('SELECT version, thumbnail FROM models WHERE id = ?')
    const cacheThumbnail = query('UPDATE models SET thumbnail = ? WHERE id = ?')
    // ponytail: synchronous cold renders hold the writer lock; move to a worker with version-CAS if contention matters.
    const generateThumbnail = db.transaction((id: string) => {
      const row = getThumbnail.get(id)
      if (!row) throw new HttpError(404, 'This model was not found in the shared library.')
      if (!row.thumbnail) {
        row.thumbnail = renderModelThumbnail(decodeProjectSnapshot(JSON.parse(getModel.get(id)!.snapshot)).document)
        cacheThumbnail.run(row.thumbnail, id)
      }
      return row
    })
    const filter = `(? = '' OR instr(nameSearch, ?) > 0 OR EXISTS (SELECT 1 FROM json_each(models.tags) WHERE instr(value, ?) > 0))
      AND (? = '' OR EXISTS (SELECT 1 FROM json_each(models.tags) WHERE value = ?))`
    const browse = query<ModelRow, [string, string, string, string, string, number]>(`SELECT ${summaryColumns} FROM models WHERE ${filter} ORDER BY updatedAt DESC, id LIMIT 50 OFFSET ?`)
    const count = query<{ total: number }, [string, string, string, string, string]>(`SELECT count(*) AS total FROM models WHERE ${filter}`)
    const allTags = query<{ tag: string }, []>('SELECT DISTINCT value AS tag FROM models, json_each(models.tags) ORDER BY tag')
    // Keep the list, count and global tags in one read transaction, including with other server processes.
    const list = db.transaction((q: string, tag: string, offset: number) => ({
      models: browse.all(q, q, q, tag, tag, offset).map(summary),
      tags: allTags.all().map(row => row.tag),
      total: count.get(q, q, q, tag, tag)!.total,
    }))
    const insert = query(`INSERT INTO models (id, name, nameSearch, tags, version, createdAt, updatedAt, dimensions, voxelCount, snapshot)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    const update = query<ModelRow, [string, string, string, string, string, string, number, string, string, number]>(`UPDATE models
      SET name = ?, nameSearch = ?, tags = ?, version = version + 1,
        updatedAt = CASE WHEN updatedAt >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt, '+0.001 seconds') ELSE ? END,
        dimensions = ?, voxelCount = ?, snapshot = ?, thumbnail = NULL
      WHERE id = ? AND version = ? RETURNING ${summaryColumns}`)
    const sceneRoutes = createSceneRoutes(db, { maxRequestBytes: limit, isClosing: () => closing !== undefined }, query)
    const server = Bun.serve({
      hostname, port, development: false, reusePort: false,
      // Enforce the bounded streaming read ourselves so even oversized requests receive JSON errors.
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      async fetch(request) {
        try {
          const url = new URL(request.url)
          if (allowedHosts) {
            const hosts = [request.headers.get('host') ?? url.host]
            if (options.trustProxy && request.headers.has('x-forwarded-host')) hosts.push(request.headers.get('x-forwarded-host')!)
            for (const host of hosts) {
              let name: string
              try { name = parseHostname(host, true) } catch { throw new HttpError(400, 'The request host is invalid.') }
              if (!allowedHosts.has(name)) throw new HttpError(400, 'This host is not allowed. Configure VOXEL_ALLOWED_HOSTS for this deployment.')
            }
          }
          let path: string
          try { path = decodeURIComponent(url.pathname) } catch { throw new HttpError(400, 'The request path is invalid.') }
          if (/[\p{Cc}\\%]/u.test(path) || path.split('/').some(part => part.startsWith('.'))) throw new HttpError(404, 'Not found.')
          if (path === '/api/scenes' || path.startsWith('/api/scenes/')) {
            checkOrigin(request, options.trustProxy ?? false)
            return await sceneRoutes(request, path)
          }
          if (path === '/api/models' || path.startsWith('/api/models/')) {
            checkOrigin(request, options.trustProxy ?? false)
            const parts = path === '/api/models' ? [] : path.slice('/api/models/'.length).split('/')
            const id = parts[0]?.toLowerCase()
            if (id !== undefined && !uuid.test(id)) throw new HttpError(400, 'The model ID must be a valid UUID.')
            if (parts.length > 1) {
              if (parts.length !== 2 || parts[1] !== 'thumbnail.png') throw new HttpError(404, 'Not found.')
              if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(400, 'Use GET or HEAD to read a model thumbnail.')
              let row = getThumbnail.get(id!)
              if (!row) throw new HttpError(404, 'This model was not found in the shared library.')
              const etag = (version: number) => `"${id}-thumbnail-1-v${version}"`
              const matches = (version: number) => request.headers.get('if-none-match')?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag(version))
              if (request.method === 'GET' && !row.thumbnail && !matches(row.version)) row = generateThumbnail.immediate(id!)
              const headers = {
                ...responseHeaders, 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', ETag: `W/${etag(row.version)}`,
                ...(row.thumbnail ? { 'Content-Length': String(row.thumbnail.byteLength) } : {}),
              }
              if (matches(row.version)) return new Response(null, { status: 304, headers })
              return new Response(request.method === 'HEAD' ? null : row.thumbnail, { headers })
            }
            if (request.method === 'GET' || request.method === 'HEAD') {
              let result: unknown
              if (id === undefined) {
                const offset = url.searchParams.get('offset') ?? '0'
                if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) throw new HttpError(400, 'Offset must be a non-negative integer.')
                result = list(url.searchParams.get('q')?.toLowerCase() ?? '', url.searchParams.get('tag')?.trim().toLowerCase() ?? '', Number(offset))
              } else {
                const row = getModel.get(id.toLowerCase())
                if (!row) throw new HttpError(404, 'This model was not found in the shared library.')
                const { snapshot, ...metadata } = row
                result = { ...summary(metadata), snapshot: JSON.parse(snapshot) }
              }
              return request.method === 'HEAD' ? new Response(null, { headers: responseHeaders }) : Response.json(result, { headers: responseHeaders })
            }
            if (!(request.method === 'POST' && id === undefined || request.method === 'PUT' && id !== undefined)) throw new HttpError(400, 'Use GET to browse or open, POST to create, or PUT with a version to update a model.')
            const input = await readBody(request, limit)
            if (closing) throw new HttpError(500, 'The library server is stopping. Please retry after it restarts.')
            const tags = parseTags(input.tags)
            if (id !== undefined && (typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1)) throw new HttpError(400, 'An update requires the positive integer version returned when opening the model.')
            const snapshot = parseProjectSnapshot(input.snapshot)
            let voxelCount = 0
            for (const chunk of snapshot.chunks) for (const color of Buffer.from(chunk.dataBase64, 'base64')) if (color) voxelCount++
            const now = new Date().toISOString()
            const tagsJson = JSON.stringify(tags)
            const dimensionsJson = JSON.stringify(snapshot.dimensions)
            const snapshotJson = JSON.stringify(snapshot)
            if (id === undefined) {
              const newId = crypto.randomUUID()
              insert.run(newId, snapshot.name, snapshot.name.toLowerCase(), tagsJson, now, now, dimensionsJson, voxelCount, snapshotJson)
              return Response.json({ id: newId, name: snapshot.name, tags, version: 1, createdAt: now, updatedAt: now, dimensions: snapshot.dimensions, voxelCount } satisfies ModelSummary, { status: 201, headers: responseHeaders })
            }
            const row = update.get(snapshot.name, snapshot.name.toLowerCase(), tagsJson, now, now, dimensionsJson, voxelCount, snapshotJson, id.toLowerCase(), input.version as number)
            if (row) return Response.json(summary(row), { headers: responseHeaders })
            if (!getSummary.get(id.toLowerCase())) throw new HttpError(404, 'This model was not found in the shared library.')
            throw new HttpError(409, 'Someone saved a newer version of this model. Reopen it before editing, or save your changes as a copy.')
          }
          if (!distDir || request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(404, 'Not found.')
          let filePath: string
          try {
            filePath = await realpath(resolve(distDir, path === '/' ? 'index.html' : path.slice(1)))
            if (!filePath.startsWith(distDir + sep) || !(await stat(filePath)).isFile()) throw new HttpError(404, 'Not found.')
          } catch (error) {
            if (error instanceof HttpError) throw error
            if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new HttpError(404, 'Not found.')
            throw error
          }
          const file = Bun.file(filePath)
          return new Response(request.method === 'HEAD' ? null : file, { headers: { ...responseHeaders, 'Content-Type': file.type, 'Content-Length': String(file.size) } })
        } catch (error) {
          const status = error instanceof HttpError ? error.status : error instanceof StudioCommandError ? 400 : 500
          if (status === 500) console.error('Model library request failed:', error)
          const response = Response.json({ error: status === 500 ? 'The model library could not complete the request. Please retry; if it continues, check the server logs and disk space.' : (error as Error).message }, { status, headers: { ...responseHeaders, ...(status === 413 ? { Connection: 'close' } : {}) } })
          return request.method === 'HEAD' ? new Response(null, { status, headers: response.headers }) : response
        }
      },
    })
    return {
      server,
      close() {
        closing ??= (async () => { try { await server.stop(true) } finally { closeDatabase() } })()
        return closing
      },
    }
  } catch (error) { closeDatabase(); throw error }
}

if (import.meta.main) {
  try {
    const library = createModelServer({ hostname: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 4173), distDir: 'dist', trustProxy: process.env.VOXEL_TRUST_PROXY === '1' })
    const stop = () => { void library.close().catch(error => { console.error(error); process.exitCode = 1 }) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    console.log(`Voxel Studio and shared model library: ${library.server.url}`)
  } catch (error) {
    console.error('Could not start the model library:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
