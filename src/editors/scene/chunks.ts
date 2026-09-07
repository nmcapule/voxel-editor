import { CHUNK_VOLUME, chunkCoords } from '../../shared/voxel/document'
import type { SceneChunk } from './types'

/** Model-space, exclusive bounds; LOD offset is x + 4*y + 16*z. Empty chunks have no descriptor. */
export function describeSceneChunk(id: number, layerId: number, bytes: Uint8Array, blob: string): SceneChunk | undefined {
  if (!Number.isInteger(id) || id < 0 || id > 4095 || !Number.isInteger(layerId) || layerId < 1 || layerId > 65535 || bytes.byteLength !== CHUNK_VOLUME) throw new Error('Invalid scene chunk coordinates or bytes.')
  if (typeof blob !== 'string' || !/^[a-f0-9]{64}$/.test(blob)) throw new Error('Scene blob id must be a lowercase SHA-256 hash.')
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
