import type { SceneSummary } from '../../shared/library/types'
import { base64ToBytes, bytesToBase64 } from '../../shared/voxel/snapshot'
import { parseSceneManifest } from './document'
import type { SceneChunk, SceneManifest } from './types'
import { describeSceneChunk, validateSceneChunkDescriptor } from './chunks'
import { loadSceneChunk, putSceneBlob } from './storage'
import type { LibraryLink } from '../../shared/library/types'

export type { SceneSummary }

const MAX_MANIFEST_BYTES = 100 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const MAX_CHUNK_LINE_BYTES = 8192
const MAX_CHUNKS = 262_144
const encoder = new TextEncoder()
const hashPattern = /^[0-9a-f]{64}$/

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(`/api/scenes${path}`, { ...options, signal: AbortSignal.timeout(60_000) }) }
  catch { throw new Error('Cannot reach the scene library. Check your connection and that the server is running, then retry.') }
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new Error(result?.error ?? 'The scene library is unavailable. Check that the server is running, then retry.')
  return result as T
}

function chunkReferences(snapshot: SceneManifest) {
  const chunks = new Map<string, SceneChunk[]>()
  let references = 0
  for (const asset of snapshot.assets) {
    references += asset.chunks.length
    if (references > MAX_CHUNKS) throw new Error('Use at most 262144 scene chunk references.')
    for (const chunk of asset.chunks) {
      const descriptors = chunks.get(chunk.blob) ?? []
      descriptors.push(chunk)
      chunks.set(chunk.blob, descriptors)
    }
  }
  return chunks
}

async function validateChunk(hash: string, bytes: Uint8Array, descriptors?: SceneChunk[]) {
  if (bytes.byteLength !== 4096) throw new Error(`Scene chunk ${hash} must contain exactly 4096 bytes.`)
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  if (Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') !== hash) throw new Error(`Scene chunk ${hash} does not match its SHA256 hash.`)
  if (descriptors) {
    const actual = describeSceneChunk(0, 1, bytes, hash)
    for (const chunk of descriptors) validateSceneChunkDescriptor(chunk, actual)
  }
}

export function listSceneLibrary(query = '', tag = '', offset = 0): Promise<{ scenes: SceneSummary[]; tags: string[]; total: number }> {
  return request(`?${new URLSearchParams({ q: query, tag, offset: String(offset) })}`)
}

export async function openLibraryScene(id: string): Promise<{ snapshot: SceneManifest; library: LibraryLink }> {
  const result = await request<SceneSummary & { snapshot: SceneManifest }>(`/${encodeURIComponent(id)}`)
  return { snapshot: parseSceneManifest(result.snapshot), library: { id: result.id, version: result.version, tags: result.tags, dirty: false } }
}

export async function saveLibraryScene(snapshot: SceneManifest, tags: string[], library?: LibraryLink): Promise<LibraryLink> {
  // Capture metadata before asynchronous uploads; callers decide whether subsequent edits make the link dirty.
  const captured = parseSceneManifest(snapshot)
  const body = JSON.stringify({ snapshot: captured, tags, version: library?.version })
  if (encoder.encode(body).byteLength > MAX_MANIFEST_BYTES) throw new Error('Scene metadata exceeds the 100 MiB library request limit.')
  const path = library ? `/${encodeURIComponent(library.id)}` : '', method = library ? 'PUT' : 'POST'
  const hashes = [...chunkReferences(captured).keys()]
  for (let offset = 0; offset < hashes.length; offset += 1000) {
    const batch = hashes.slice(offset, offset + 1000)
    const { missing } = await request<{ missing: string[] }>('/blobs/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: batch }),
    })
    const expected = new Set(batch)
    if (!Array.isArray(missing) || missing.length > batch.length || missing.some(hash => !expected.has(hash)) || new Set(missing).size !== missing.length) throw new Error('The scene library returned an invalid missing-chunk list.')
    for (let start = 0; start < missing.length; start += 8) {
      await Promise.all(missing.slice(start, start + 8).map(async hash => {
        const bytes = await loadSceneChunk(hash)
        await validateChunk(hash, bytes)
        await request(`/blobs/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Uint8Array.from(bytes) })
      }))
    }
  }
  const result = await request<SceneSummary>(path, { method, headers: { 'Content-Type': 'application/json' }, body })
  return { id: result.id, version: result.version, tags: result.tags, dirty: false }
}

type SceneFileWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
    createWritable(): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>
  }>
}

/** Resolves only after export succeeds; picker cancellation rejects with AbortError. */
export async function exportSceneFile(snapshot: SceneManifest): Promise<void> {
  const name = `${snapshot.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').trim().slice(0, 100) || 'Scene'}.vscene`
  const picker = (window as SceneFileWindow).showSaveFilePicker
  const handle = picker ? await picker.call(window, { suggestedName: name, types: [{ description: 'Voxel Studio scene', accept: { 'application/x-ndjson': ['.vscene'] } }] }) : undefined
  const captured = parseSceneManifest(snapshot), chunks = chunkReferences(captured)
  const header = encoder.encode(`${JSON.stringify({ schema: 'voxel-studio/scene-file', version: 1, snapshot: captured })}\n`)
  if (header.byteLength > MAX_MANIFEST_BYTES) throw new Error('Scene metadata exceeds the 100 MiB file header limit.')
  // Each record has a fixed SHA256 and a fixed 4096-byte payload, so the fallback can be bounded before loading any chunks.
  const chunkLineBytes = encoder.encode(`${JSON.stringify({ type: 'chunk', hash: '0'.repeat(64), dataBase64: 'A'.repeat(5464) })}\n`).byteLength
  if (!handle && header.byteLength + chunks.size * chunkLineBytes > MAX_DOWNLOAD_BYTES) throw new Error('This .vscene file exceeds the safe 64 MiB download limit. Use a browser with writable file support (such as desktop Chrome or Edge), or save to the scene library.')
  const writable = await handle?.createWritable()
  const parts: Uint8Array<ArrayBuffer>[] = []
  try {
    if (writable) await writable.write(header)
    else parts.push(header)
    for (const [hash, descriptors] of chunks) {
      const bytes = await loadSceneChunk(hash, { persist: false })
      await validateChunk(hash, bytes, descriptors)
      const line = encoder.encode(`${JSON.stringify({ type: 'chunk', hash, dataBase64: bytesToBase64(bytes) })}\n`)
      if (writable) await writable.write(line)
      else parts.push(line)
    }
    if (writable) await writable.close()
    else {
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/x-ndjson' }))
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = name
        link.click()
      } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000) }
    }
  } catch (error) {
    await writable?.abort().catch(() => {})
    throw error
  }
}

export async function importSceneFile(file: File): Promise<SceneManifest> {
  if (file.size > MAX_MANIFEST_BYTES + MAX_CHUNKS * MAX_CHUNK_LINE_BYTES) throw new Error('This scene file exceeds the supported metadata and chunk limits.')
  const reader = file.stream().getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let snapshot: SceneManifest | undefined
  let missing = new Map<string, SceneChunk[]>()
  let fragments: Uint8Array[] = [], length = 0
  async function consumeLine() {
    if (!length) throw new Error('Scene files cannot contain empty records.')
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const fragment of fragments) { bytes.set(fragment, offset); offset += fragment.length }
    fragments = []
    length = 0
    let record: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(decoder.decode(bytes))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      record = value as Record<string, unknown>
    } catch { throw new Error('The scene file contains an invalid UTF-8 JSON record.') }
    if (!snapshot) {
      if (record.schema !== 'voxel-studio/scene-file' || record.version !== 1) throw new Error('The file must start with a supported Voxel Studio scene header.')
      snapshot = parseSceneManifest(record.snapshot)
      missing = chunkReferences(snapshot)
      return
    }
    if (record.type !== 'chunk' || typeof record.hash !== 'string' || !hashPattern.test(record.hash) || !missing.has(record.hash)) throw new Error('The scene file contains an unexpected or duplicate chunk record.')
    if (typeof record.dataBase64 !== 'string' || record.dataBase64.length !== 5464 || !/^[A-Za-z0-9+/]{5462}==$/.test(record.dataBase64)) throw new Error('Scene chunk records must contain exactly 4096 bytes of base64 data.')
    const data = base64ToBytes(record.dataBase64)
    if (bytesToBase64(data) !== record.dataBase64) throw new Error('The scene chunk base64 encoding is invalid.')
    await validateChunk(record.hash, data, missing.get(record.hash)!)
    await putSceneBlob(record.hash, data)
    missing.delete(record.hash)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      let start = 0
      while (start < value.length) {
        const newline = value.indexOf(10, start), end = newline < 0 ? value.length : newline
        length += end - start
        if (length > (snapshot ? MAX_CHUNK_LINE_BYTES : MAX_MANIFEST_BYTES)) throw new Error('A scene file record exceeds its size limit.')
        fragments.push(value.slice(start, end))
        if (newline >= 0) await consumeLine()
        start = newline < 0 ? value.length : newline + 1
      }
    }
    if (length) await consumeLine()
    if (!snapshot) throw new Error('The scene file is empty.')
    // Portable files must be self-contained, even when the local cache already contains their chunks.
    if (missing.size) throw new Error(`The scene file is incomplete: ${missing.size} chunk record(s) are missing.`)
    return snapshot
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
