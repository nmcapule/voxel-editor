import { describe, expect, test } from 'bun:test'
import { CHUNK_SIZE, EditSession, History, VoxelDocument, chunkId, moveRange, moveVoxels, pushPull, pushPullRange, voxelLine } from './editor'
import { meshChunk } from './mesher'
import { connectedBodyVoxels, connectedSurfaceVoxels, occupiedVoxels, pushPullGhostVoxels, surfaceVoxels, traceGridRay, tracePlaneRay, workspaceGridPositions } from './renderer'
import { exportVox, importVox } from './vox'

describe('voxel document', () => {
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

  test('fills sphere and cylinder volumes as undoable edits', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    const sphere = new EditSession(document)
    sphere.fillShape({ x: 1, y: 1, z: 1 }, { x: 5, y: 5, z: 5 }, 5, 'sphere')
    const history = new History()
    history.push(sphere.commit())

    expect(document.getVoxel(3, 3, 3)).toBe(5)
    expect(document.getVoxel(1, 1, 1)).toBe(0)
    history.undo(document)
    expect(document.voxelCount).toBe(0)

    const cylinder = new EditSession(document)
    cylinder.fillShape({ x: 1, y: 1, z: 1 }, { x: 5, y: 5, z: 5 }, 6, 'cylinder', 'x')
    expect(document.getVoxel(1, 3, 3)).toBe(6)
    expect(document.getVoxel(5, 3, 3)).toBe(6)
    expect(document.getVoxel(3, 1, 1)).toBe(0)
  })

  test('interpolates continuous voxel strokes', () => {
    expect(voxelLine({ x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 0 })).toEqual([
      { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 },
      { x: 3, y: 2, z: 0 }, { x: 4, y: 2, z: 0 },
    ])
  })

  test('pushes and pulls selected voxels without crossing a collision', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    document.setVoxel(2, 0, 2, 5)
    document.setVoxel(3, 0, 2, 5)
    document.setVoxel(4, 0, 2, 6)
    document.setVoxel(2, 3, 2, 7)
    const normal = { x: 0, y: 1, z: 0 }
    const cells = [{ x: 2, y: 0, z: 2 }, { x: 3, y: 0, z: 2 }]

    expect(pushPullRange(document, cells, normal)).toEqual({ pull: 2, push: 1 })
    expect(pushPullGhostVoxels(cells, normal, 2, false)).toEqual([
      { x: 2, y: 1, z: 2 }, { x: 2, y: 2, z: 2 },
      { x: 3, y: 1, z: 2 }, { x: 3, y: 2, z: 2 },
    ])
    expect(pushPullGhostVoxels([{ x: 2, y: 2, z: 2 }], normal, -2, false)).toEqual([
      { x: 2, y: 2, z: 2 }, { x: 2, y: 1, z: 2 },
    ])
    const session = new EditSession(document)
    expect(pushPull(document, session, cells, normal, 8)).toBe(2)
    expect(document.getVoxel(3, 2, 2)).toBe(5)
    expect(document.getVoxel(2, 3, 2)).toBe(7)

    const top = [{ x: 3, y: 2, z: 2 }]
    const pushSession = new EditSession(document)
    expect(pushPull(document, pushSession, top, normal, -2)).toBe(-2)
    expect(document.getVoxel(3, 2, 2)).toBe(0)
    expect(document.getVoxel(3, 0, 2)).toBe(5)
  })

  test('moves selected voxels without cloning them', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    const cells = [{ x: 2, y: 0, z: 2 }, { x: 3, y: 0, z: 2 }]
    const normal = { x: 1, y: 0, z: 0 }
    document.setVoxel(2, 0, 2, 5)
    document.setVoxel(3, 0, 2, 6)
    document.setVoxel(6, 0, 2, 7)

    expect(moveRange(document, cells, normal)).toEqual({ pull: 2, push: 2 })
    const session = new EditSession(document)
    expect(moveVoxels(document, session, cells, normal, 8)).toBe(2)
    expect([document.getVoxel(2, 0, 2), document.getVoxel(3, 0, 2)]).toEqual([0, 0])
    expect([document.getVoxel(4, 0, 2), document.getVoxel(5, 0, 2), document.getVoxel(6, 0, 2)]).toEqual([5, 6, 7])
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
    expect(session.set(2, 1, 1, 6)).toBe(true)
    const history = new History()
    history.push(session.commit(), [], [], secondLayer.id)

    expect(document.getVoxelLayer(1, 1, 1)).toBe(firstLayer.id)
    expect(document.getVoxelLayer(2, 1, 1)).toBe(secondLayer.id)
    firstLayer.visible = false
    expect(document.getVisibleVoxel(1, 1, 1)).toBe(0)
    expect(document.getVisibleVoxel(2, 1, 1)).toBe(6)
    secondLayer.locked = true
    expect(new EditSession(document).set(3, 1, 1, 7)).toBe(false)

    expect(history.undo(document)?.layerId).toBe(secondLayer.id)
    expect(document.getVoxel(2, 1, 1)).toBe(0)
    history.redo(document)
    expect(document.getVoxelLayer(2, 1, 1)).toBe(secondLayer.id)
  })

  test('provides named PBR presets and fills fields missing from older saves', () => {
    const document = new VoxelDocument()
    expect([3, 9, 12, 14, 19, 31].map(index => document.materials[index].name)).toEqual(['Concrete', 'Organic', 'Water', 'Grass', 'Oak', 'Blue glass'])
    expect(document.materials[12]).toMatchObject({ roughness: 0.08, transmission: 0.75, opacity: 1, ior: 1.333 })

    const legacyMaterials: { roughness?: number; metalness?: number }[] = []
    legacyMaterials[12] = { roughness: 0.22, metalness: 0.1 }
    const restored = new VoxelDocument(document.dimensions, document.name, document.palette, legacyMaterials)
    expect(restored.materials[12]).toEqual({ name: 'Water', roughness: 0.22, metalness: 0.1, opacity: 1, transmission: 0.75, ior: 1.333 })
  })
})

describe('surface meshing and picking', () => {
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
    expect(mesh.colors.length).toBe(mesh.positions.length / 3 * 4)
    expect(mesh.colors.filter((_, index) => index % 4 === 3).every(alpha => alpha === 1)).toBe(true)
    expect(mesh.groups).toEqual([{ start: 0, count: 30, materialIndex: 5 }])
    expect(document.materials[5]).toEqual({ name: 'Gold', roughness: 0.2, metalness: 1, opacity: 1, transmission: 0, ior: 1.5 })

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

  test('keeps an opaque interface visible behind a transparent voxel', () => {
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
    expect(left.groups.some(group => group.materialIndex === 5)).toBe(false)
    expect(right.groups.find(group => group.materialIndex === 5)?.count).toBe(36)
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

  test('distinguishes same-color surfaces from contiguous bodies', () => {
    const document = new VoxelDocument()
    document.setVoxel(2, 0, 1, 5)
    document.setVoxel(2, 0, 2, 5)
    document.setVoxel(1, 0, 1, 6)
    document.setVoxel(1, 1, 1, 6)
    document.setVoxel(5, 0, 1, 5)
    const key = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`

    expect(connectedSurfaceVoxels(document, { x: 2, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 5).map(key).sort()).toEqual(['2,0,1', '2,0,2'])
    expect(connectedBodyVoxels(document, { x: 2, y: 0, z: 1 }).map(key).sort()).toEqual(['1,0,1', '1,1,1', '2,0,1', '2,0,2'])
  })

  test('builds the editing grid at the exact X and Z limits', () => {
    const positions = workspaceGridPositions({ x: 16, y: 32, z: 24 })
    const x = positions.filter((_, index) => index % 3 === 0)
    const z = positions.filter((_, index) => index % 3 === 2)

    expect(positions.length).toBe((16 + 24 + 2) * 6)
    expect([Math.min(...x), Math.max(...x)]).toEqual([-8, 8])
    expect([Math.min(...z), Math.max(...z)]).toEqual([-12, 12])
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

  test('flattens only visible layers on export', () => {
    const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
    document.setVoxel(1, 1, 1, 5)
    document.activeLayer.visible = false
    document.createLayer()
    document.setVoxel(2, 1, 1, 6)

    const imported = importVox(exportVox(document)).document
    expect(imported.voxelCount).toBe(1)
    expect(imported.getVoxel(1, 1, 1)).toBe(0)
    expect(imported.getVoxel(2, 1, 1)).toBe(6)
  })
})
