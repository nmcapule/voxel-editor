import { describe, expect, test } from 'bun:test'
import { CHUNK_SIZE, PADDED_SIZE, VoxelDocument, chunkCoords } from './document'
import { meshChunk, meshFaceGrid, type MeshData } from './mesher'

const transparent = new Uint8Array(256)
transparent[12] = transparent[31] = transparent[255] = 1

function checkLayout(mesh: MeshData) {
  expect('colors' in mesh).toBe(false)
  expect(mesh.positions.length).toBe(mesh.quads * 12)
  expect(mesh.normals.length).toBe(mesh.positions.length)
  expect(mesh.uvs.length).toBe(mesh.quads * 8)
  expect(mesh.indices.length).toBe(mesh.quads * 6)
  let vertexStart = 0
  let start = 0
  for (const group of mesh.groups) {
    expect(group.vertexStart).toBe(vertexStart)
    expect(group.start).toBe(start)
    expect(group.vertexCount).toBe(group.count / 6 * 4)
    const indices = mesh.indices.subarray(group.start, group.start + group.count)
    expect(indices.every(index => index >= vertexStart && index < vertexStart + group.vertexCount)).toBe(true)
    expect(new Set(indices).size).toBe(group.vertexCount)
    const bounds: MeshData['groups'][number]['bounds'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let vertex = vertexStart; vertex < vertexStart + group.vertexCount; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        bounds[axis] = Math.min(bounds[axis], mesh.positions[vertex * 3 + axis])
        bounds[axis + 3] = Math.max(bounds[axis + 3], mesh.positions[vertex * 3 + axis])
      }
    }
    expect(group.bounds).toEqual(bounds)
    vertexStart += group.vertexCount
    start += group.count
  }
  expect(vertexStart).toBe(mesh.positions.length / 3)
  expect(start).toBe(mesh.indices.length)

  let windingCorrect = true
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = mesh.indices[index] * 3
    const b = mesh.indices[index + 1] * 3
    const c = mesh.indices[index + 2] * 3
    const ab = [0, 1, 2].map(axis => mesh.positions[b + axis] - mesh.positions[a + axis])
    const ac = [0, 1, 2].map(axis => mesh.positions[c + axis] - mesh.positions[a + axis])
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
    windingCorrect &&= cross.reduce((dot, value, axis) => dot + value * mesh.normals[a + axis], 0) > 0
  }
  expect(windingCorrect).toBe(true)
}

// Expand greedy quads into unit faces and compare to an independent voxel
// oracle. A missing lip, duplicate face, inset or L/T-junction hole must fail.
function checkCoverage(document: VoxelDocument) {
  const expectedFaces: string[] = []
  const expectedLines = new Set<string>()
  document.forEachVisibleVoxel((x, y, z, material) => {
    const cell = [x, y, z]
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const neighbor = [...cell]
      neighbor[axis] += sign
      const other = document.getVisibleVoxel(neighbor[0], neighbor[1], neighbor[2])
      if (other && (other === material || !transparent[other])) continue
      const u = (axis + 1) % 3
      const v = (axis + 2) % 3
      const plane = cell[axis] + (sign > 0 ? 1 : 0)
      expectedFaces.push([axis, plane, cell[u], cell[v], sign, material].join(','))
      for (const edgeAxis of [u, v]) for (const side of [0, 1]) {
        const a = [...cell]
        a[axis] = plane
        a[edgeAxis === u ? v : u] += side
        const b = [...a]
        b[edgeAxis]++
        expectedLines.add([...a, ...b].join(','))
      }
    }
  })

  const actualFaces: string[] = []
  const actualLines = new Set<string>()
  for (const id of document.chunks.keys()) {
    const chunk = chunkCoords(id)
    const origin = [chunk.x * CHUNK_SIZE, chunk.y * CHUNK_SIZE, chunk.z * CHUNK_SIZE]
    const voxels = document.paddedChunk(id, true)
    const before = voxels.slice()
    const mesh = meshChunk(voxels, document.palette, true, transparent)
    expect(meshFaceGrid(voxels, transparent)).toEqual(mesh.faceLines)
    expect(voxels).toEqual(before)
    checkLayout(mesh)
    expect(mesh.positions.every(Number.isInteger)).toBe(true)
    expect(mesh.faceLines.every(Number.isInteger)).toBe(true)
    for (const group of mesh.groups) {
      for (let index = group.start; index < group.start + group.count; index += 6) {
        const vertices = [0, 1, 2, 5].map(offset => mesh.indices[index + offset])
        const normal = mesh.normals.subarray(vertices[0] * 3, vertices[0] * 3 + 3)
        const axis = normal.findIndex(value => value !== 0)
        const u = (axis + 1) % 3
        const v = (axis + 2) % 3
        const corners = vertices.map(vertex => [0, 1, 2].map(d => mesh.positions[vertex * 3 + d] + origin[d]))
        const plane = corners[0][axis]
        expect(corners.every(corner => corner[axis] === plane)).toBe(true)
        for (const vertex of vertices) {
          // Adding the integer chunk origin gives a continuous world anchor;
          // local UVs preserve the same repeating texture phase at chunk seams.
          expect(mesh.uvs[vertex * 2]).toBe(mesh.positions[vertex * 3 + u])
          expect(mesh.uvs[vertex * 2 + 1]).toBe(mesh.positions[vertex * 3 + v])
        }
        const minU = Math.min(...corners.map(corner => corner[u]))
        const maxU = Math.max(...corners.map(corner => corner[u]))
        const minV = Math.min(...corners.map(corner => corner[v]))
        const maxV = Math.max(...corners.map(corner => corner[v]))
        for (let uu = minU; uu < maxU; uu++) for (let vv = minV; vv < maxV; vv++) {
          actualFaces.push([axis, plane, uu, vv, normal[axis], group.materialIndex].join(','))
        }
      }
    }
    for (let index = 0; index < mesh.faceLines.length; index += 6) {
      const a = [0, 1, 2].map(axis => mesh.faceLines[index + axis] + origin[axis])
      const b = [0, 1, 2].map(axis => mesh.faceLines[index + 3 + axis] + origin[axis])
      expect(b.reduce((length, value, axis) => length + value - a[axis], 0)).toBe(1)
      actualLines.add([...a, ...b].join(','))
    }
  }
  expect(actualFaces.sort()).toEqual(expectedFaces.sort())
  expect([...actualLines].sort()).toEqual([...expectedLines].sort())
}

describe.each([0, 1, 2])('axis %i integer coverage, grid and UV anchors', axis => {
  test.each([
    ['rectangle', ['AAA', 'AAA']],
    ['transparent interface', ['AB']],
    ['L junction', ['AB', 'B.']],
    ['T junction', ['ABA', '.B.']],
    ['mixed opaque boundary', ['ABC', 'BA.', 'C..']],
    ['high material index', ['AD', 'DA']],
  ] as const)('%s within chunks, across seams and near workspace limits', (_name, rows) => {
    for (const origin of [[7, 8, 9], [15, 15, 15], [239, 253, 239]]) {
      const document = new VoxelDocument({ x: 256, y: 256, z: 256 })
      const materials: Record<string, number> = { A: 12, B: 31, C: 3, D: 255, '.': 0 }
      for (let v = 0; v < rows.length; v++) for (let u = 0; u < rows[v].length; u++) {
        const cell = [...origin]
        cell[(axis + 1) % 3] += u
        cell[(axis + 2) % 3] += v
        document.setVoxel(cell[0], cell[1], cell[2], materials[rows[v][u]])
      }
      checkCoverage(document)
    }
  })
})

test('material-local ranges have exact bounds, global indices and no palette dependency', () => {
  const document = new VoxelDocument()
  document.setVoxel(2, 3, 4, 12)
  document.setVoxel(3, 3, 4, 31)
  document.setVoxel(10, 11, 12, 3)
  const voxels = document.paddedChunk(0)
  const mesh = meshChunk(voxels, document.palette, false, transparent)
  checkLayout(mesh)
  expect(mesh.indices).toBeInstanceOf(Uint16Array)
  expect(mesh.groups.map(group => [group.materialIndex, group.bounds])).toEqual([
    [12, [2, 3, 4, 3, 4, 5]], [31, [3, 3, 4, 4, 4, 5]], [3, [10, 11, 12, 11, 12, 13]],
  ])
  expect(mesh.faceLines.length).toBe(0)
  expect(meshChunk(voxels, new Uint32Array(256).fill(0xffffff), false, transparent)).toEqual(mesh)
})

test('dense transparent interfaces use 32-bit global indices without duplicating group buffers', () => {
  const voxels = new Uint8Array(PADDED_SIZE ** 3)
  for (let z = 0; z < CHUNK_SIZE; z++) for (let y = 0; y < CHUNK_SIZE; y++) for (let x = 0; x < CHUNK_SIZE; x++) {
    voxels[(x + 1) + (y + 1) * PADDED_SIZE + (z + 1) * PADDED_SIZE ** 2] = (x + y + z) & 1 ? 12 : 31
  }
  const mesh = meshChunk(voxels, undefined, false, transparent)
  expect(mesh.quads).toBe(CHUNK_SIZE ** 3 * 6)
  expect(mesh.indices).toBeInstanceOf(Uint32Array)
  checkLayout(mesh)
})

test('grid-only output deduplicates opposing interface faces and keeps unit-cell divisions', () => {
  const document = new VoxelDocument()
  document.setVoxel(0, 0, 0, 12)
  expect(meshFaceGrid(document.paddedChunk(0), transparent).length).toBe(24 * 6)
  document.setVoxel(1, 0, 0, 31)
  const voxels = document.paddedChunk(0)
  const before = meshChunk(voxels, undefined, false, transparent)
  expect(meshFaceGrid(voxels, transparent).length).toBe(40 * 6)
  expect(meshChunk(voxels, undefined, false, transparent)).toEqual(before)
  document.setVoxel(1, 0, 0, 12)
  expect(meshFaceGrid(document.paddedChunk(0), transparent).length).toBe(36 * 6)
})

test('empty and fully occluded chunks have no geometry, groups or grid', () => {
  for (const material of [0, 12]) {
    const voxels = new Uint8Array(PADDED_SIZE ** 3).fill(material)
    const mesh = meshChunk(voxels, undefined, true, transparent)
    checkLayout(mesh)
    expect(mesh.quads).toBe(0)
    expect(mesh.groups).toEqual([])
    expect(mesh.faceLines.length).toBe(0)
    expect(meshFaceGrid(voxels, transparent).length).toBe(0)
  }
  expect(() => meshChunk(new Uint8Array(1))).toThrow(RangeError)
  expect(() => meshFaceGrid(new Uint8Array(PADDED_SIZE ** 3), new Uint8Array(1))).toThrow(RangeError)
})

test('worker handles one surface or grid job per message with versioned transferable results', async () => {
  type Reply = { type: 'ready' }
    | { type: 'meshed'; results: { id: number; version: number; normal: MeshData }[] }
    | { type: 'gridded'; results: { id: number; version: number; faceLines: Float32Array }[] }
  const worker = new Worker(new URL('../../editors/model/mesher.worker.ts', import.meta.url), { type: 'module' })
  const receive = () => new Promise<Reply>((resolve, reject) => {
    worker.onmessage = event => resolve(event.data)
    worker.onerror = reject
  })
  try {
    expect(await receive()).toEqual({ type: 'ready' })
    const document = new VoxelDocument()
    document.setVoxel(0, 0, 0, 12)
    document.setVoxel(1, 0, 0, 31)
    const table = transparent.slice().buffer
    worker.postMessage({ type: 'palette', transparent: table }, [table])
    const voxels = document.paddedChunk(0).buffer
    worker.postMessage({ type: 'mesh', jobs: [{ id: 0, version: 7, voxels }], faceGrid: false }, [voxels])
    const meshed = await receive()
    expect(meshed.type).toBe('meshed')
    if (meshed.type !== 'meshed') throw new Error('Expected surface result')
    expect(meshed.results).toHaveLength(1)
    expect(meshed.results[0]).toEqual({ id: 0, version: 7, normal: meshChunk(document.paddedChunk(0), undefined, false, transparent) })
    checkLayout(meshed.results[0].normal)
    const gridVoxels = document.paddedChunk(0).buffer
    worker.postMessage({ type: 'grid', jobs: [{ id: 0, version: 8, voxels: gridVoxels }] }, [gridVoxels])
    expect(await receive()).toEqual({ type: 'gridded', results: [{ id: 0, version: 8, faceLines: meshFaceGrid(document.paddedChunk(0), transparent) }] })
    expect(voxels.byteLength).toBe(0)
    expect(gridVoxels.byteLength).toBe(0)
  } finally {
    worker.terminate()
  }
})

test('worker isolation-only jobs remove overlaps in all six face halos and leave active grids independent', async () => {
  const worker = new Worker(new URL('../../editors/model/mesher.worker.ts', import.meta.url), { type: 'module' })
  const receive = () => new Promise<any>((resolve, reject) => {
    worker.onmessage = event => resolve(event.data)
    worker.onerror = reject
  })
  try {
    expect(await receive()).toEqual({ type: 'ready' })
    const table = transparent.slice().buffer
    worker.postMessage({ type: 'palette', transparent: table }, [table])
    for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
      const document = new VoxelDocument({ x: 48, y: 48, z: 48 })
      const active = document.activeLayerId
      const interior = [20, 20, 20], halo = [...interior]
      interior[axis] = sign < 0 ? 16 : 31
      halo[axis] = interior[axis] + sign
      document.setVoxel(halo[0], halo[1], halo[2], 12)
      const context = document.createLayer().id
      document.setVoxel(halo[0], halo[1], halo[2], 31)
      document.setVoxel(interior[0], interior[1], interior[2], 31)
      const id = document.idAt(20, 20, 20)
      const expected = new VoxelDocument(document.dimensions)
      expected.setVoxel(interior[0], interior[1], interior[2], 1)
      const selected = document.paddedChunk(id, true, [active]).buffer
      const background = document.paddedChunk(id, true, [context]).buffer
      worker.postMessage({ type: 'mesh', jobs: [{ id, version: 9, layerId: active, active: selected, context: background }], faceGrid: true }, [selected, background])
      const reply = await receive()
      expect(reply.type).toBe('meshed')
      expect(reply.results).toHaveLength(1)
      const result = reply.results[0]
      expect(result).toMatchObject({ id, version: 9, layerId: active })
      expect(result.normal).toBeUndefined()
      expect(result.active).toEqual(meshChunk(document.paddedChunk(id, true, [active]), undefined, true, transparent))
      expect(result.active.quads).toBe(0) // Halo voxels never own faces in this chunk.
      expect(result.context).toEqual(meshChunk(expected.paddedChunk(id)))
      expect(result.context.quads).toBe(6) // Removing the overlapping halo exposes the boundary face.
      expect(result.context.groups.map((group: MeshData['groups'][number]) => group.materialIndex)).toEqual([1])
      checkLayout(result.context)
      expect([selected.byteLength, background.byteLength]).toEqual([0, 0])

      const haloId = document.idAt(halo[0], halo[1], halo[2])
      const gridVoxels = document.paddedChunk(haloId, true, [active])
      const expectedGrid = meshFaceGrid(gridVoxels, transparent)
      const buffer = gridVoxels.buffer
      worker.postMessage({ type: 'grid', jobs: [{ id: haloId, version: 10, layerId: active, active: buffer }] }, [buffer])
      expect(await receive()).toEqual({ type: 'gridded', results: [{ id: haloId, version: 10, layerId: active, activeFaceLines: expectedGrid }] })
      expect(expectedGrid.length).toBeGreaterThan(0)
      expect(buffer.byteLength).toBe(0)

      const empty = new Uint8Array(PADDED_SIZE ** 3).buffer, all = document.paddedChunk(id, true).buffer
      worker.postMessage({ type: 'mesh', jobs: [{ id, version: 11, layerId: 0, active: empty, context: all }], faceGrid: true }, [empty, all])
      expected.setVoxel(halo[0], halo[1], halo[2], 1)
      expect(await receive()).toEqual({ type: 'meshed', results: [{ id, version: 11, layerId: 0,
        active: meshChunk(new Uint8Array(PADDED_SIZE ** 3), undefined, true, transparent),
        context: meshChunk(expected.paddedChunk(id)) }] })
      expect(meshChunk(expected.paddedChunk(id)).quads).toBe(5)
      expect([empty.byteLength, all.byteLength]).toEqual([0, 0])
    }
  } finally { worker.terminate() }
})
