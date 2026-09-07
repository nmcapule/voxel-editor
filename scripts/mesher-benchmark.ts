import { CHUNK_SIZE, PADDED_SIZE } from '../src/shared/voxel/document'
import { meshChunk, meshFaceGrid } from '../src/shared/voxel/mesher'

// Run with: bun scripts/mesher-benchmark.ts
// Measures meshing only: padding, transport, GPU upload and BVH build are excluded.
const transparent = new Uint8Array(256)
const materials = [12, 31, 29, 13]
for (const material of materials) transparent[material] = 1

function medianMs(run: () => unknown) {
  for (let i = 0; i < 10; i++) run()
  const times: number[] = []
  for (let i = 0; i < 25; i++) {
    const start = performance.now()
    run()
    times.push(performance.now() - start)
  }
  return Number(times.sort((a, b) => a - b)[12].toFixed(3))
}

const results = []
for (const name of ['filled', 'checkerboard', 'multimaterial']) {
  const voxels = new Uint8Array(PADDED_SIZE ** 3)
  for (let z = 0; z < CHUNK_SIZE; z++) for (let y = 0; y < CHUNK_SIZE; y++) for (let x = 0; x < CHUNK_SIZE; x++) {
    voxels[(x + 1) + (y + 1) * PADDED_SIZE + (z + 1) * PADDED_SIZE ** 2] = name === 'filled' ? 3
      : name === 'checkerboard' ? ((x + y + z) & 1 ? 3 : 0)
        : materials[(x + 3 * y + 5 * z) % materials.length]
  }
  const mesh = meshChunk(voxels, undefined, false, transparent)
  const faceLines = meshFaceGrid(voxels, transparent)
  results.push({
    chunk: name,
    quads: mesh.quads,
    vertices: mesh.positions.length / 3,
    groups: mesh.groups.length,
    indexBits: mesh.indices.BYTES_PER_ELEMENT * 8,
    surfaceBytes: mesh.positions.byteLength + mesh.normals.byteLength + mesh.uvs.byteLength + mesh.indices.byteLength,
    gridSegments: faceLines.length / 6,
    gridBytes: faceLines.byteLength,
    surfaceMs: medianMs(() => meshChunk(voxels, undefined, false, transparent)),
    gridOnlyMs: medianMs(() => meshFaceGrid(voxels, transparent)),
    combinedMs: medianMs(() => meshChunk(voxels, undefined, true, transparent)),
  })
}
console.log(`Bun ${Bun.version}; ${CHUNK_SIZE}^3 chunks; 10 warmups, median of 25 runs. Multimaterial uses four transparent media.`)
console.table(results)
