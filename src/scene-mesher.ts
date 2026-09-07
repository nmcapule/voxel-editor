import { chunkCoords, chunkId, PADDED_SIZE } from './editor'
import { meshChunk } from './mesher'
import type { SceneAsset, SceneChunk } from './scene-types'

export type SceneLod = 1 | 4 | 8
export interface SceneMeshJob {
  key: string
  generation: number
  id: number
  step: SceneLod
  /** Composited visible layers: center and its six face neighbors. */
  chunks: { id: number; voxels: Uint8Array }[]
  transparent: Uint8Array<ArrayBuffer>
}

export function sceneChunkNeighbors(id: number) {
  const c = chunkCoords(id), ids = [id]
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const x = c.x + dx, y = c.y + dy, z = c.z + dz
    if (x >= 0 && y >= 0 && z >= 0 && x < 16 && y < 16 && z < 16) ids.push(chunkId(x, y, z))
  }
  return ids
}

/** Exact (collision-free) dependency key. Layer order owns overlaps; only materials
 * used in this neighborhood affect face classification. RGB/PBR values do not. */
export function sceneChunkFingerprint(asset: SceneAsset, chunks: Map<number, SceneChunk[]>, id: number) {
  const colors = new Set<number>()
  const neighborhood = sceneChunkNeighbors(id).map(id => [id, (chunks.get(id) ?? []).map(chunk => {
    for (const color of chunk.colors) colors.add(color)
    return [chunk.layerId, chunk.blob, chunk.count, chunk.bounds, chunk.colors, chunk.lod]
  })])
  return JSON.stringify([neighborhood, [...colors].sort((a, b) => a - b).map(color => [color, Number(asset.model.materials[color].opacity < 1 || asset.model.materials[color].transmission > 0)])])
}

export function sceneLod(pixels: number, previous: SceneLod = 8, selected = false): SceneLod {
  if (selected || pixels >= (previous === 1 ? 48 : 64)) return 1
  return pixels >= (previous === 4 ? 6 : 10) ? 4 : 8
}

/** Majority nonempty material keeps thin features represented in the preview. */
export function coarse8(lod: ArrayLike<number>) {
  if (lod.length !== 64) throw new RangeError('Scene preview must have 64 cells')
  const result = new Uint8Array(8)
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const counts = new Map<number, number>()
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const color = lod[x * 2 + dx + (y * 2 + dy) * 4 + (z * 2 + dz) * 16]
      if (color) counts.set(color, (counts.get(color) ?? 0) + 1)
    }
    let best = 0, count = 0
    for (const [color, n] of counts) if (n > count) { best = color; count = n }
    result[x + y * 2 + z * 4] = best
  }
  return result
}

export function meshSceneChunk(job: SceneMeshJob) {
  const n = 16 / job.step
  if (![1, 4, 8].includes(job.step)) throw new RangeError('Invalid scene LOD')
  const chunks = new Map(job.chunks.map(chunk => {
    if (chunk.voxels.length !== n ** 3) throw new RangeError('Invalid scene chunk size')
    return [chunk.id, chunk.voxels] as const
  }))
  if (!chunks.has(job.id)) throw new Error('Missing center chunk is not empty space')
  const origin = chunkCoords(job.id)
  const padded = new Uint8Array(PADDED_SIZE ** 3)
  // Expand coarse cells into the existing fixed-16 mesher. Greedy merging removes
  // the subdivisions, while the real halo prevents false faces at either boundary.
  for (let z = -1; z <= 16; z++) for (let y = -1; y <= 16; y++) for (let x = -1; x <= 16; x++) {
    const cx = origin.x + Math.floor(x / 16), cy = origin.y + Math.floor(y / 16), cz = origin.z + Math.floor(z / 16)
    if (cx < 0 || cy < 0 || cz < 0 || cx > 15 || cy > 15 || cz > 15) continue
    const data = chunks.get(chunkId(cx, cy, cz))
    if (!data) continue // Caller supplies every nonempty face neighbor from metadata.
    const ix = Math.floor((x + 16) % 16 / job.step), iy = Math.floor((y + 16) % 16 / job.step), iz = Math.floor((z + 16) % 16 / job.step)
    padded[x + 1 + (y + 1) * PADDED_SIZE + (z + 1) * PADDED_SIZE ** 2] = data[ix + iy * n + iz * n * n]
  }
  return meshChunk(padded, undefined, false, job.transparent)
}
