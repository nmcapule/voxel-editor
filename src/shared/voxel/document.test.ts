import { describe, expect, test } from 'bun:test'
import { CHUNK_SIZE, DEFAULT_PALETTE, EditSession, History, PADDED_SIZE, VoxelDocument, chunkCoords, chunkId, connectedBodyVoxels, connectedSurfaceVoxels, fillShapeVoxels, moveRange, moveVoxels, occupiedVoxels, pushPull, pushPullRange, resizeVoxelDocument, surfaceVoxels, voxelLine } from './document'
import { meshChunk } from './mesher'
import { castsRealtimeShadow, realtimeEnvironmentIntensity, workspaceGridPlaneVisible, workspaceGridPositions } from '../rendering/stage'
import { isTouchTap, pushPullGhostVoxels, shouldOrbitTouch, traceGridRay, tracePlaneRay } from '../../editors/model/renderer'
import { exportVox, importVox } from './vox'

describe('voxel document', () => {
  test('reserves one-finger orbit for positions the active tool cannot edit', () => {
    expect(shouldOrbitTouch(false, 0)).toBe(true)
    expect(shouldOrbitTouch(true, 0)).toBe(false)
    expect(shouldOrbitTouch(false, 1)).toBe(false)
    expect(isTouchTap(10, 10, 15, 15)).toBe(true)
    expect(isTouchTap(10, 10, 18, 10)).toBe(false)
  })

  test('records and restores chunk edits across boundaries', () => {
    const document = new VoxelDocument({ x: 32, y: 32, z: 32 })
    const history = new History()
    const session = new EditSession(document)
    session.fill({ x: 15, y: 0, z: 0 }, { x: 16, y: 1, z: 0 }, 5)
    history.push(session.commit())

    expect(document.voxelCount).toBe(4)
    expect(document.chunks.size).toBe(2)
    history.undo(document)
    expect(document.voxelCount).toBe(0)
    history.redo(document)
    expect(document.getVoxel(16, 1, 0)).toBe(5)
  })

  test('resizes from the origin or center while preserving layer ownership', () => {
    const source = new VoxelDocument({ x: 18, y: 18, z: 18 })
    source.setVoxel(0, 0, 0, 5)
    source.setVoxel(1, 1, 1, 5)
    const secondLayer = source.createLayer()
    source.setVoxel(16, 16, 16, 6)

    const origin = resizeVoxelDocument(source, { x: 20, y: 20, z: 20 }, 'origin').document
    expect(origin.getVoxel(1, 1, 1)).toBe(5)
    const centered = resizeVoxelDocument(source, { x: 20, y: 20, z: 20 }, 'center').document
    expect(centered.getVoxel(2, 2, 2)).toBe(5)
    expect(centered.getVoxelLayer(17, 17, 17)).toBe(secondLayer.id)

    const shrunk = resizeVoxelDocument(source, { x: 16, y: 16, z: 16 }, 'center')
    expect(shrunk.cropped).toBe(1)
    expect(shrunk.document.getVoxel(0, 0, 0)).toBe(5)
    expect(shrunk.document.getVoxel(15, 15, 15)).toBe(6)
  })

  test('fills sphere and cylinder volumes as undoable edits', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    const sphere = new EditSession(document)
    sphere.fillShape({ x: 1, y: 1, z: 1 }, { x: 5, y: 5, z: 5 }, 5, 'sphere')
    const history = new History()
    history.push(sphere.commit())

    expect(document.getVoxel(3, 3, 3)).toBe(5)
    expect(document.getVoxel(1, 1, 1)).toBe(0)
    expect([...fillShapeVoxels({ x: 1, y: 1, z: 1 }, { x: 5, y: 5, z: 5 }, 'sphere', 'y', document.dimensions)]).toHaveLength(document.voxelCount)
    history.undo(document)
    expect(document.voxelCount).toBe(0)

    const cylinder = new EditSession(document)
    cylinder.fillShape({ x: 1, y: 1, z: 1 }, { x: 5, y: 5, z: 5 }, 6, 'cylinder', 'x')
    expect(document.getVoxel(1, 3, 3)).toBe(6)
    expect(document.getVoxel(5, 3, 3)).toBe(6)
    expect(document.getVoxel(3, 1, 1)).toBe(0)
    expect([...fillShapeVoxels({ x: 1, y: 1, z: 1 }, { x: 5, y: 5, z: 5 }, 'cylinder', 'x', document.dimensions)]).toHaveLength(document.voxelCount)
  })

  test('interpolates continuous voxel strokes', () => {
    expect(voxelLine({ x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 0 })).toEqual([
      { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 },
      { x: 3, y: 2, z: 0 }, { x: 4, y: 2, z: 0 },
    ])
  })

  test('pulls through occupied voxels and pushes into contiguous solid voxels', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    document.setVoxel(2, 0, 2, 5)
    document.setVoxel(3, 0, 2, 5)
    document.setVoxel(4, 0, 2, 6)
    document.setVoxel(2, 3, 2, 7)
    const normal = { x: 0, y: 1, z: 0 }
    const cells = [{ x: 2, y: 0, z: 2 }, { x: 3, y: 0, z: 2 }]

    expect(pushPullRange(document, cells, normal)).toEqual({ pull: 15, push: 1 })
    expect(pushPullGhostVoxels(cells, normal, 2, false)).toEqual([
      { x: 2, y: 1, z: 2 }, { x: 2, y: 2, z: 2 },
      { x: 3, y: 1, z: 2 }, { x: 3, y: 2, z: 2 },
    ])
    expect(pushPullGhostVoxels([{ x: 2, y: 2, z: 2 }], normal, -2, false)).toEqual([
      { x: 2, y: 2, z: 2 }, { x: 2, y: 1, z: 2 },
    ])
    const session = new EditSession(document)
    expect(pushPull(document, session, cells, normal, 8)).toBe(8)
    expect(document.getVoxel(3, 8, 2)).toBe(5)
    expect(document.getVoxel(2, 3, 2)).toBe(5)

    const top = [{ x: 3, y: 8, z: 2 }]
    const pushSession = new EditSession(document)
    expect(pushPull(document, pushSession, top, normal, -2)).toBe(-2)
    expect(document.getVoxel(3, 8, 2)).toBe(0)
    expect(document.getVoxel(3, 6, 2)).toBe(5)
  })

  test('snapshots extrusion colors at different depths and restores overwritten chunks without changing other layers', () => {
    const document = new VoxelDocument()
    const layerId = document.activeLayerId
    for (const [x, color] of [[14, 5], [16, 6], [17, 7], [18, 8]]) document.setVoxel(x, 1, 1, color)
    const other = document.createLayer()
    for (const x of [14, 16, 17, 18, 19, 31]) document.setVoxel(x, 1, 1, 9)
    const before = [0, 1].map(id => document.copyChunk(id))
    const cells = [14, 16, 15, 31].map(x => ({ x, y: 1, z: 1 }))
    const normal = { x: 1, y: 0, z: 0 }
    const session = new EditSession(document, layerId)

    expect(pushPull(document, session, cells, normal, 3, layerId)).toBe(3)
    expect([14, 15, 16, 17, 18, 19, 20].map(x => document.getLayerVoxel(x, 1, 1, layerId))).toEqual([5, 5, 6, 6, 6, 6, 0])
    expect(pushPullGhostVoxels([cells[0], cells[1], cells[0]], normal, 3, false)).toEqual(
      [15, 17, 18, 19].map(x => ({ x, y: 1, z: 1 })),
    )
    expect([14, 16, 17, 18, 19, 31].map(x => document.getLayerVoxel(x, 1, 1, other.id))).toEqual([9, 9, 9, 9, 9, 9])
    expect(document.voxelCount).toBe(12)
    const after = [0, 1].map(id => document.copyChunk(id))
    const history = new History()
    history.push(session.commit())
    history.undo(document)
    expect([0, 1].map(id => document.copyChunk(id))).toEqual(before)
    expect(document.voxelCount).toBe(10)
    const reversed = new EditSession(document, layerId)
    pushPull(document, reversed, [...cells].reverse().concat(cells[0]), normal, 3, layerId)
    expect([0, 1].map(id => document.copyChunk(id))).toEqual(after)
    reversed.cancel()
    history.redo(document)
    expect([0, 1].map(id => document.copyChunk(id))).toEqual(after)
    expect(document.voxelCount).toBe(12)

    const empty = new EditSession(document, layerId)
    expect(pushPull(document, empty, [{ x: 31, y: 1, z: 1 }], { x: -1, y: 0, z: 0 }, 3, layerId)).toBe(0)
    expect(pushPull(document, empty, [], normal, -3, layerId)).toBe(0)
    expect(empty.commit()).toBeUndefined()
  })

  test('clamps extrusion to every signed axis bound and inward removal to same-layer solid depth', () => {
    for (const axis of ['x', 'y', 'z'] as const) for (const direction of [-1, 1]) {
      const document = new VoxelDocument({ x: 17, y: 19, z: 21 })
      const layerId = document.activeLayerId
      const origin = direction > 0 ? document.dimensions[axis] - 4 : 3
      const at = (offset: number) => ({ x: 4, y: 4, z: 4, [axis]: origin + direction * offset })
      const normal = { x: 0, y: 0, z: 0, [axis]: direction }
      for (const offset of [-3, -1, 0, 1, 2, 3]) {
        const cell = at(offset)
        document.setVoxel(cell.x, cell.y, cell.z, offset <= 0 ? 5 : 6)
      }
      const other = document.createLayer()
      const gap = at(-2)
      document.setVoxel(gap.x, gap.y, gap.z, 7)
      expect(pushPullRange(document, [at(0)], normal, layerId)).toEqual({ pull: 3, push: 2 })
      expect(pushPullRange(document, [at(0), at(3)], normal, layerId)).toEqual({ pull: 0, push: 2 })
      const pull = new EditSession(document, layerId)
      expect(pushPull(document, pull, [at(0)], normal, 100, layerId)).toBe(3)
      for (const offset of [1, 2, 3, 4]) {
        const cell = at(offset)
        expect(document.getLayerVoxel(cell.x, cell.y, cell.z, layerId)).toBe(offset === 4 ? 0 : 5)
      }
      pull.cancel()
      const push = new EditSession(document, layerId)
      expect(pushPull(document, push, [at(0)], normal, -100, layerId)).toBe(-2)
      for (const offset of [-3, -2, -1, 0, 1]) {
        const cell = at(offset)
        expect(document.getLayerVoxel(cell.x, cell.y, cell.z, layerId)).toBe(offset === -3 ? 5 : offset === 1 ? 6 : 0)
      }
      expect(document.getLayerVoxel(gap.x, gap.y, gap.z, other.id)).toBe(7)
    }
  })

  test('pushes and pulls all selected steps from their own fronts on every signed axis', () => {
    for (const axis of ['x', 'y', 'z'] as const) for (const sign of [-1, 1]) {
      const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
      const tangent = axis === 'x' ? 'z' : 'x'
      const normal = { x: 0, y: 0, z: 0, [axis]: sign }
      const at = (column: number, depth: number) => ({ x: 2, y: 2, z: 2, [axis]: sign > 0 ? depth : 15 - depth, [tangent]: column + 2 })
      const cells = []
      for (const [column, top] of [[0, 2], [1, 4]]) for (let depth = 0; depth <= top; depth++) {
        const cell = at(column, depth)
        document.setVoxel(cell.x, cell.y, cell.z, column + 5)
        cells.push(cell)
      }
      expect(pushPullRange(document, cells, normal)).toEqual({ pull: 11, push: 3 })
      const added = [at(0, 3), at(0, 4), at(1, 5), at(1, 6)]
      expect(pushPullGhostVoxels(cells, normal, 2, false)).toEqual(added)
      const pull = new EditSession(document)
      expect(pushPull(document, pull, cells, normal, 2)).toBe(2)
      added.forEach((cell, index) => expect(document.getVoxel(cell.x, cell.y, cell.z)).toBe(index < 2 ? 5 : 6))
      pull.cancel()

      const removed = [at(0, 2), at(0, 1), at(1, 4), at(1, 3)]
      expect(pushPullGhostVoxels(cells, normal, -2, false)).toEqual(removed)
      const push = new EditSession(document)
      expect(pushPull(document, push, cells, normal, -2)).toBe(-2)
      removed.forEach(cell => expect(document.getVoxel(cell.x, cell.y, cell.z)).toBe(0))
      for (const [column, depth] of [[0, 0], [1, 2]]) {
        const cell = at(column, depth)
        expect(document.getVoxel(cell.x, cell.y, cell.z)).toBe(column + 5)
      }
    }
    const cells = [2, 4].map(y => ({ x: 1, y, z: 1 }))
    expect(pushPullGhostVoxels(cells, { x: 0, y: 1, z: 0 }, -3, false)).toEqual(
      [2, 1, 0, 4, 3].map(y => ({ x: 1, y, z: 1 })),
    )
  })

  test('moves selected voxels without cloning them', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    const cells = [{ x: 2, y: 0, z: 2 }, { x: 3, y: 0, z: 2 }]
    const normal = { x: 1, y: 0, z: 0 }
    document.setVoxel(2, 0, 2, 5)
    document.setVoxel(3, 0, 2, 6)
    document.setVoxel(4, 0, 2, 7)

    expect(moveRange(document, cells, normal)).toEqual({ pull: 12, push: 2 })
    const session = new EditSession(document)
    expect(moveVoxels(document, session, cells, normal, 2)).toBe(2)
    expect([document.getVoxel(2, 0, 2), document.getVoxel(3, 0, 2)]).toEqual([0, 0])
    expect([document.getVoxel(4, 0, 2), document.getVoxel(5, 0, 2)]).toEqual([5, 6])

    const emptySession = new EditSession(document)
    expect(moveVoxels(document, emptySession, [{ x: 3, y: 0, z: 2 }], normal, 1)).toBe(0)
    expect(document.getVoxel(4, 0, 2)).toBe(5)
  })

  test('erases a selected region as one undoable edit', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    const history = new History()
    const session = new EditSession(document)
    const selected = [{ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }]
    session.fill(selected[0], selected[1], 5)
    history.push(session.commit())

    const erase = new EditSession(document)
    erase.fill(selected[0], selected[1], 0)
    history.push(erase.commit(), selected, [])
    expect(document.voxelCount).toBe(0)
    expect(history.undo(document)?.selection).toEqual(selected)
    expect(document.voxelCount).toBe(2)
    expect(history.canRedo).toBe(true)
    expect(history.redo(document)?.selection).toEqual([])
    expect(document.voxelCount).toBe(0)
  })

  test('tracks layer ownership, visibility, locking, and history', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    const firstLayer = document.activeLayer
    document.setVoxel(1, 1, 1, 5)
    const secondLayer = document.createLayer()
    const session = new EditSession(document)
    expect(session.set(1, 1, 1, 6)).toBe(true)
    expect(session.set(2, 1, 1, 6)).toBe(true)
    const history = new History()
    history.push(session.commit(), [], [], secondLayer.id)

    expect(document.getVoxelLayer(1, 1, 1)).toBe(secondLayer.id)
    expect(document.getLayerVoxel(1, 1, 1, firstLayer.id)).toBe(5)
    expect(document.voxelCount).toBe(3)
    secondLayer.visible = false
    expect(document.getVisibleVoxel(1, 1, 1)).toBe(5)
    expect(document.getVisibleVoxelLayer(1, 1, 1)).toBe(firstLayer.id)
    secondLayer.visible = true
    expect(document.getVisibleVoxel(2, 1, 1)).toBe(6)
    secondLayer.locked = true
    expect(new EditSession(document).set(3, 1, 1, 7)).toBe(false)

    expect(history.undo(document)?.layerId).toBe(secondLayer.id)
    expect(document.getVoxel(1, 1, 1)).toBe(5)
    expect(document.getVoxel(2, 1, 1)).toBe(0)
    history.redo(document)
    expect(document.getVoxelLayer(2, 1, 1)).toBe(secondLayer.id)
  })

  test('provides named PBR presets and fills fields missing from older saves', () => {
    const document = new VoxelDocument()
    expect([3, 9, 12, 14, 19, 31, 32, 33].map(index => document.materials[index].name)).toEqual(['Concrete', 'Organic', 'Water', 'Grass', 'Oak', 'Blue glass', 'Warm light', 'Cool light'])
    expect(document.materials[12]).toMatchObject({ roughness: 0.08, transmission: 0.75, opacity: 1, ior: 1.333 })
    expect(document.materials[32]).toMatchObject({ emissiveIntensity: 2.5, roughness: 0.3 })
    expect(castsRealtimeShadow(document.materials[5])).toBe(true)
    expect(castsRealtimeShadow(document.materials[12])).toBe(false)
    expect(castsRealtimeShadow({ opacity: 0.5, transmission: 0 })).toBe(false)
    expect(realtimeEnvironmentIntensity(0)).toBe(0.2)
    expect(realtimeEnvironmentIntensity(1)).toBe(0.7)

    const legacyMaterials: { roughness?: number; metalness?: number }[] = []
    legacyMaterials[12] = { roughness: 0.22, metalness: 0.1 }
    const restored = new VoxelDocument(document.dimensions, document.name, document.palette, legacyMaterials)
    expect(restored.materials[12]).toEqual({ name: 'Water', roughness: 0.22, metalness: 0.1, emissiveIntensity: 0, opacity: 1, transmission: 0.75, ior: 1.333 })

    const upgraded = new VoxelDocument(document.dimensions, document.name, DEFAULT_PALETTE.slice(0, -2), Array.from({ length: 256 }, () => ({ roughness: 0.68, metalness: 0.02 })))
    expect([...upgraded.palette.slice(32, 34)]).toEqual([0xffb45e, 0x63d8ff])
    expect(upgraded.materials.slice(32, 34).map(material => material.name)).toEqual(['Warm light', 'Cool light'])
  })
})

describe('surface meshing and picking', () => {
  test('composes named layer scopes in document order across chunk halos and partial bounds', () => {
    const document = new VoxelDocument({ x: 33, y: 34, z: 35 })
    const active = document.activeLayer
    const other = document.createLayer()
    const hidden = document.createLayer()
    hidden.visible = false
    active.locked = true
    for (const z of [15, 16, 31, 32, 34]) for (const y of [15, 16, 31, 32, 33]) for (const x of [15, 16, 31, 32]) {
      document.setVoxel(x, y, z, 5, active.id)
      if ((x + y + z) % 2 === 0) document.setVoxel(x, y, z, 6, other.id)
      if ((x + y + z) % 3 === 0) document.setVoxel(x, y, z, 7, hidden.id)
    }
    const scopes: (readonly number[] | undefined)[] = [undefined, [], [active.id], [other.id, hidden.id], [hidden.id], [other.id, active.id, other.id], [65535]]
    for (const id of [0, chunkId(1, 1, 1), chunkId(2, 2, 2)]) for (const visibleOnly of [false, true]) for (const scope of scopes) {
      const origin = chunkCoords(id)
      const layers = document.layers.filter(layer => (!visibleOnly || layer.visible) && (scope === undefined || scope.includes(layer.id))).reverse()
      const expected = new Uint8Array(PADDED_SIZE ** 3)
      let index = 0
      for (let z = -1; z <= CHUNK_SIZE; z++) for (let y = -1; y <= CHUNK_SIZE; y++) for (let x = -1; x <= CHUNK_SIZE; x++) {
        for (const layer of layers) {
          const color = document.getLayerVoxel(origin.x * CHUNK_SIZE + x, origin.y * CHUNK_SIZE + y, origin.z * CHUNK_SIZE + z, layer.id)
          if (color) { expected[index] = color; break }
        }
        index++
      }
      expect(document.paddedChunk(id, visibleOnly, scope)).toEqual(expected)
    }
  })

  test('greedily merges a solid chunk and hides a neighboring face', () => {
    const document = new VoxelDocument({ x: 32, y: 16, z: 16 })
    const first = new EditSession(document)
    first.fill({ x: 0, y: 0, z: 0 }, { x: 15, y: 15, z: 15 }, 5)
    first.fill({ x: 16, y: 0, z: 0 }, { x: 31, y: 15, z: 15 }, 5)
    const mesh = meshChunk(document.paddedChunk(chunkId(0, 0, 0)), document.palette)

    expect(document.voxelCount).toBe(CHUNK_SIZE ** 3 * 2)
    expect(mesh.quads).toBe(5)
    expect(mesh.indices.length).toBe(30)
    expect(mesh.uvs.length).toBe(mesh.positions.length / 3 * 2)
    expect('colors' in mesh).toBe(false)
    expect(mesh.groups).toEqual([{ start: 0, count: 30, materialIndex: 5, vertexStart: 0, vertexCount: 20, bounds: [0, 0, 0, 16, 16, 16] }])
    expect(document.materials[5]).toEqual({ name: 'Gold', roughness: 0.2, metalness: 1, emissiveIntensity: 0, opacity: 1, transmission: 0, ior: 1.5 })

    const mixed = new VoxelDocument()
    mixed.setVoxel(0, 0, 0, 5)
    mixed.setVoxel(1, 0, 0, 6)
    expect(meshChunk(mixed.paddedChunk(0), mixed.palette).groups.map(group => group.materialIndex).sort()).toEqual([5, 6])

    const outlined = new VoxelDocument()
    outlined.setVoxel(0, 0, 0, 5)
    expect(meshChunk(outlined.paddedChunk(0), outlined.palette).faceLines.length).toBe(0)
    expect(meshChunk(outlined.paddedChunk(0), outlined.palette, true).faceLines.length).toBe(144)
  })

  test('returns the first occupied cell and outward face normal', () => {
    const document = new VoxelDocument()
    document.setVoxel(2, 3, 4, 7)
    expect(traceGridRay(document, { x: 2.5, y: 3.5, z: -10 }, { x: 0, y: 0, z: 1 })).toEqual({
      cell: { x: 2, y: 3, z: 4 },
      normal: { x: 0, y: 0, z: -1 },
      occupied: true,
      color: 7,
    })
  })

  test('targets the floor and visible guide sides after an empty ray', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 24 })
    expect(traceGridRay(document, { x: 1.5, y: 30, z: 2.5 }, { x: 0, y: -1, z: 0 })).toMatchObject({ cell: { x: 1, y: 0, z: 2 }, normal: { x: 0, y: 1, z: 0 }, occupied: false })
    expect(traceGridRay(document, { x: 30, y: 1.5, z: 2.5 }, { x: -1, y: 0, z: 0 })).toMatchObject({ cell: { x: 0, y: 1, z: 2 }, normal: { x: 1, y: 0, z: 0 }, occupied: false })
    expect(traceGridRay(document, { x: -10, y: 1.5, z: 2.5 }, { x: 1, y: 0, z: 0 })).toMatchObject({ cell: { x: 15, y: 1, z: 2 }, normal: { x: -1, y: 0, z: 0 }, occupied: false })
    expect(traceGridRay(document, { x: 1.5, y: 1.5, z: 30 }, { x: 0, y: 0, z: -1 })).toMatchObject({ cell: { x: 1, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 }, occupied: false })
    expect(traceGridRay(document, { x: 1.5, y: 1.5, z: -10 }, { x: 0, y: 0, z: 1 })).toMatchObject({ cell: { x: 1, y: 1, z: 23 }, normal: { x: 0, y: 0, z: -1 }, occupied: false })
    expect(traceGridRay(document, { x: 1.5, y: -10, z: 2.5 }, { x: 0, y: 1, z: 0 })).toBeUndefined()
  })

  test('keeps only the opaque interface behind a transparent voxel', () => {
    const document = new VoxelDocument()
    document.setVoxel(0, 0, 0, 12)
    document.setVoxel(1, 0, 0, 5)
    const transparent = new Uint8Array(256)
    transparent[12] = 1
    const mesh = meshChunk(document.paddedChunk(0), document.palette, false, transparent)

    expect(mesh.quads).toBe(11)
    expect(mesh.groups.find(group => group.materialIndex === 12)?.count).toBe(30)
    expect(mesh.groups.find(group => group.materialIndex === 5)?.count).toBe(36)

    const split = new VoxelDocument({ x: 32, y: 16, z: 16 })
    split.setVoxel(15, 0, 0, 12)
    split.setVoxel(16, 0, 0, 5)
    const left = meshChunk(split.paddedChunk(chunkId(0, 0, 0)), split.palette, false, transparent)
    const right = meshChunk(split.paddedChunk(chunkId(1, 0, 0)), split.palette, false, transparent)
    expect(left.quads + right.quads).toBe(11)
    expect(left.groups.find(group => group.materialIndex === 12)?.count).toBe(30)
    expect(right.groups.find(group => group.materialIndex === 5)?.count).toBe(36)
  })

  test('keeps both sides of an interface between different transparent materials', () => {
    const transparent = new Uint8Array(256)
    transparent[12] = transparent[31] = 1
    const document = new VoxelDocument()
    document.setVoxel(0, 0, 0, 12)
    document.setVoxel(1, 0, 0, 31)

    const mesh = meshChunk(document.paddedChunk(0), document.palette, false, transparent)
    expect(mesh.quads).toBe(12)
    expect(mesh.groups.map(group => [group.materialIndex, group.count])).toEqual([[12, 36], [31, 36]])
    document.setVoxel(1, 0, 0, 12)
    expect(meshChunk(document.paddedChunk(0), document.palette, false, transparent).quads).toBe(6)

    const split = new VoxelDocument({ x: 32, y: 16, z: 16 })
    split.setVoxel(15, 0, 0, 12)
    split.setVoxel(16, 0, 0, 31)
    const left = meshChunk(split.paddedChunk(chunkId(0, 0, 0)), split.palette, false, transparent)
    const right = meshChunk(split.paddedChunk(chunkId(1, 0, 0)), split.palette, false, transparent)
    expect(left.quads + right.quads).toBe(12)
  })

  test('projects a locked gesture onto its starting plane', () => {
    const document = new VoxelDocument()
    expect(tracePlaneRay(document, { x: 1.2, y: 10, z: 2.8 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 4, z: 0 }, { x: 0, y: 1, z: 0 })).toEqual({ x: 1, y: 4, z: 2 })
  })

  test('extends zoomed-out orthographic drags and clamps them to the canvas', () => {
    const document = new VoxelDocument({ x: 255, y: 255, z: 255 })
    expect(tracePlaneRay(document, { x: 127, y: -10, z: 127 }, { x: 1, y: -1, z: 1 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, true)).toEqual({ x: 116, y: 0, z: 116 })
    expect(tracePlaneRay(document, { x: -20, y: 10, z: 300 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, true)).toEqual({ x: 0, y: 0, z: 254 })
  })

  test('keeps marquee selection on the exposed starting surface', () => {
    const document = new VoxelDocument()
    document.setVoxel(2, 0, 2, 5)
    document.setVoxel(3, 0, 2, 5)
    document.setVoxel(3, 1, 2, 5)

    expect(surfaceVoxels(document, { x: 2, y: 0, z: 2 }, { x: 3, y: 0, z: 2 }, { x: 0, y: 1, z: 0 })).toEqual([{ x: 2, y: 0, z: 2 }])
  })

  test('selects a visible layer through overlaps and exposes faces only against that layer', () => {
    const document = new VoxelDocument()
    const layer = document.activeLayer
    for (const [x, color] of [[14, 5], [15, 5], [16, 6]]) document.setVoxel(x, 1, 1, color)
    document.setVoxel(16, 2, 1, 6)
    document.createLayer()
    document.setVoxel(14, 1, 1, 7)
    document.setVoxel(15, 2, 1, 7)
    document.setVoxel(17, 1, 1, 5)
    const hidden = document.createLayer()
    document.setVoxel(15, 1, 1, 8)
    hidden.visible = false
    layer.locked = true
    const at = (x: number) => ({ x, y: 1, z: 1 })
    const normal = { x: 0, y: 1, z: 0 }

    expect(occupiedVoxels(document, at(14), at(17), layer.id)).toEqual([14, 15, 16].map(at))
    expect(occupiedVoxels(document, at(14), at(17))).toEqual([14, 15, 16, 17].map(at))
    expect(surfaceVoxels(document, at(14), at(17), normal, layer.id)).toEqual([14, 15].map(at))
    expect(surfaceVoxels(document, at(14), at(17), normal)).toEqual([14, 17].map(at))
    expect(connectedSurfaceVoxels(document, at(14), normal, undefined, layer.id)).toEqual([14, 15].map(at))
    expect(connectedSurfaceVoxels(document, at(14), normal, 5, layer.id)).toEqual([14, 15].map(at))
    expect(connectedSurfaceVoxels(document, at(14), normal, 7, layer.id)).toEqual([])
    expect(connectedSurfaceVoxels(document, at(14), normal)).toEqual([at(14)])
    expect(connectedSurfaceVoxels(document, at(14), normal, 5)).toEqual([])
    expect(connectedSurfaceVoxels(document, at(15), normal)).toEqual([])
    document.setVoxel(16, 2, 1, 0, layer.id)
    expect(connectedSurfaceVoxels(document, at(14), normal, undefined, layer.id)).toEqual([14, 15, 16].map(at))
    expect(connectedSurfaceVoxels(document, at(14), normal, 5, layer.id)).toEqual([14, 15].map(at))

    layer.visible = false
    for (const layerId of [layer.id, hidden.id, 0, 65535]) {
      expect(occupiedVoxels(document, at(14), at(17), layerId)).toEqual([])
      expect(surfaceVoxels(document, at(14), at(17), normal, layerId)).toEqual([])
      expect(connectedSurfaceVoxels(document, at(15), normal, undefined, layerId)).toEqual([])
    }
  })

  test('selects occupied voxels throughout a 3D point-drag box', () => {
    const document = new VoxelDocument()
    document.setVoxel(2, 1, 2, 5)
    document.setVoxel(3, 2, 3, 6)
    document.setVoxel(4, 3, 4, 7)

    expect(occupiedVoxels(document, { x: 2, y: 1, z: 2 }, { x: 3, y: 2, z: 3 })).toEqual([
      { x: 2, y: 1, z: 2 },
      { x: 3, y: 2, z: 3 },
    ])
  })

  test('finds the connected surface under the push-pull cursor', () => {
    const document = new VoxelDocument()
    document.setVoxel(2, 0, 2, 5)
    document.setVoxel(3, 0, 2, 5)
    document.setVoxel(3, 0, 3, 5)
    document.setVoxel(5, 0, 2, 5)
    document.setVoxel(2, 1, 2, 5)

    expect(connectedSurfaceVoxels(document, { x: 3, y: 0, z: 2 }, { x: 0, y: 1, z: 0 })).toEqual([
      { x: 3, y: 0, z: 2 },
      { x: 3, y: 0, z: 3 },
    ])
  })

  test('distinguishes surfaces, same-texture bodies, and contiguous bodies', () => {
    const document = new VoxelDocument()
    document.setVoxel(2, 0, 1, 5)
    document.setVoxel(2, 0, 2, 5)
    document.setVoxel(2, 1, 2, 5)
    document.setVoxel(1, 0, 1, 6)
    document.setVoxel(1, 1, 1, 6)
    document.setVoxel(5, 0, 1, 5)
    const key = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`

    expect(connectedSurfaceVoxels(document, { x: 2, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 5).map(key).sort()).toEqual(['2,0,1'])
    expect(connectedBodyVoxels(document, { x: 2, y: 0, z: 1 }, 5).map(key).sort()).toEqual(['2,0,1', '2,0,2', '2,1,2'])
    expect(connectedBodyVoxels(document, { x: 2, y: 0, z: 1 }).map(key).sort()).toEqual(['1,0,1', '1,1,1', '2,0,1', '2,0,2', '2,1,2'])
  })

  test('keeps scoped body and texture connectivity layer-local through overlaps', () => {
    const document = new VoxelDocument()
    const layer = document.activeLayer
    for (const [x, color] of [[14, 5], [15, 5], [16, 6], [17, 5], [19, 5]]) document.setVoxel(x, 1, 1, color)
    document.setVoxel(17, 2, 1, 5)
    document.createLayer()
    document.setVoxel(14, 1, 1, 7)
    document.setVoxel(18, 1, 1, 5)
    const hidden = document.createLayer()
    document.setVoxel(15, 1, 1, 8)
    hidden.visible = false
    layer.locked = true
    const at = (x: number) => ({ x, y: 1, z: 1 })
    const top = { x: 17, y: 2, z: 1 }

    expect(connectedBodyVoxels(document, at(14), undefined, layer.id)).toEqual([...[14, 15, 16, 17].map(at), top])
    expect(connectedBodyVoxels(document, at(14), 5, layer.id)).toEqual([14, 15].map(at))
    expect(connectedBodyVoxels(document, at(17), 5, layer.id)).toEqual([at(17), top])
    expect(connectedBodyVoxels(document, at(14), 7, layer.id)).toEqual([])
    expect(connectedBodyVoxels(document, at(18), undefined, layer.id)).toEqual([])
    expect(connectedBodyVoxels(document, at(14))).toEqual([at(14)])
    expect(connectedBodyVoxels(document, at(14), 5)).toEqual([])
    expect(connectedBodyVoxels(document, at(15))).toEqual([...[15, 16, 17].map(at), top])
    expect(connectedBodyVoxels(document, at(15), 5)).toEqual([at(15)])

    layer.visible = false
    for (const layerId of [layer.id, hidden.id, 0, 65535]) {
      expect(connectedBodyVoxels(document, at(15), undefined, layerId)).toEqual([])
      expect(connectedBodyVoxels(document, at(15), layerId === hidden.id ? 8 : 5, layerId)).toEqual([])
    }
  })

  test('builds the editing grid at the exact X and Z limits', () => {
    const dimensions = { x: 16, y: 32, z: 24 }
    const positions = workspaceGridPositions(dimensions)
    const x = positions.filter((_, index) => index % 3 === 0)
    const z = positions.filter((_, index) => index % 3 === 2)

    expect(positions.length).toBe((16 + 24 + 2) * 6)
    expect([Math.min(...x), Math.max(...x)]).toEqual([-8, 8])
    expect([Math.min(...z), Math.max(...z)]).toEqual([-12, 12])

    const side = workspaceGridPositions(dimensions, { x: 1, y: 0, z: 0 })
    const sideX = side.filter((_, index) => index % 3 === 0)
    const sideY = side.filter((_, index) => index % 3 === 1)
    expect(side.length).toBe((32 + 24 + 2) * 6)
    expect([Math.min(...sideX), Math.max(...sideX)]).toEqual([-8, -8])
    expect([Math.min(...sideY), Math.max(...sideY)]).toEqual([0, 32])
    expect(workspaceGridPlaneVisible(dimensions, { x: 1, y: 0, z: 0 }, { x: 40, y: 20, z: 0 })).toBe(true)
    expect(workspaceGridPlaneVisible(dimensions, { x: -1, y: 0, z: 0 }, { x: 40, y: 20, z: 0 })).toBe(false)
  })
})

describe('MagicaVoxel exchange', () => {
  test('round-trips palette and coordinates at the 256-cubed boundary', () => {
    const document = new VoxelDocument({ x: 256, y: 256, z: 256 }, 'Boundary')
    document.palette[42] = 0x12abef
    document.setVoxel(0, 0, 0, 1)
    document.setVoxel(255, 255, 255, 42)

    const imported = importVox(exportVox(document), 'Boundary.vox').document
    expect(imported.dimensions).toEqual({ x: 256, y: 256, z: 256 })
    expect(imported.voxelCount).toBe(2)
    expect(imported.getVoxel(255, 255, 255)).toBe(42)
    expect(imported.palette[42]).toBe(0x12abef)
  })

  test('flattens the highest visible layer on export', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    document.setVoxel(1, 1, 1, 5)
    const upper = document.createLayer()
    document.setVoxel(1, 1, 1, 7)
    document.setVoxel(2, 1, 1, 6)

    const imported = importVox(exportVox(document)).document
    expect(imported.voxelCount).toBe(2)
    expect(imported.getVoxel(1, 1, 1)).toBe(7)
    expect(imported.getVoxel(2, 1, 1)).toBe(6)
    upper.visible = false
    expect(importVox(exportVox(document)).document.getVoxel(1, 1, 1)).toBe(5)
  })
})
