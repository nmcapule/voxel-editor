import { expect, mock, test } from 'bun:test'
import { Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, OrthographicCamera, Points, PointsMaterial } from 'three'
import { VoxelDocument } from '../../shared/voxel/document'
import { meshChunk, type MeshData } from '../../shared/voxel/mesher'
import { VoxelRenderer, traceGridRay } from './renderer'

function layeredDocument() {
  const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
  const active = document.activeLayer
  const cells = [{ x: 2, y: 2, z: 2 }, { x: 3, y: 2, z: 2 }, { x: 4, y: 2, z: 2 }, { x: 4, y: 1, z: 2 }]
  cells.forEach((cell, index) => document.setVoxel(cell.x, cell.y, cell.z, index < 2 ? 5 : 6))
  const context = document.createLayer()
  // Exact overlap, touching roofs, a front blocker, and an unrelated connected voxel.
  document.setVoxel(2, 2, 2, 9)
  document.setVoxel(2, 3, 2, 9)
  document.setVoxel(3, 3, 2, 9)
  document.setVoxel(2, 5, 2, 9)
  document.setVoxel(5, 2, 2, 5)
  document.setActiveLayer(active.id)
  return { document, active, context, cells }
}

test('scoped grid rays ignore front and touching blockers and resolve exact overlaps on the requested layer', () => {
  const { document, active, context, cells } = layeredDocument()
  const origin = { x: 2.5, y: 8, z: 2.5 }, down = { x: 0, y: -1, z: 0 }
  const hit = { cell: cells[0], normal: { x: 0, y: 1, z: 0 }, occupied: true, color: 5 }
  document.setActiveLayer(context.id)
  expect(traceGridRay(document, origin, down)).toMatchObject({ cell: { x: 2, y: 5, z: 2 }, color: 9 })
  expect(traceGridRay(document, origin, down, Infinity, active.id)).toEqual(hit)
  expect(traceGridRay(document, { ...origin, y: 3.5 }, down, Infinity, active.id)).toEqual(hit)
  expect(traceGridRay(document, origin, down, 4, active.id)).toBeUndefined()

  const side = { x: 2.5, y: 2.5, z: -1 }, forward = { x: 0, y: 0, z: 1 }
  expect(traceGridRay(document, side, forward)).toMatchObject({ cell: cells[0], color: 9 })
  expect(traceGridRay(document, side, forward, Infinity, active.id)).toEqual({ ...hit, normal: { x: 0, y: 0, z: -1 } })
  active.visible = false
  expect(traceGridRay(document, origin, down, Infinity, active.id)).toMatchObject({ occupied: false, color: 0 })
})

test('isolation is derived from the editing tool and targetAt uses that scope', () => {
  const { document, active, context, cells } = layeredDocument()
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, modelSuspended: false, paintMode: 'paint', viewport: { renderMode: false }, raycaster: { far: Infinity },
    gridRay: () => ({ origin: { x: 2.5, y: 8, z: 2.5 }, direction: { x: 0, y: -1, z: 0 } }),
  })
  for (const tool of ['select', 'paint', 'sculpt']) {
    probe.tool = tool
    expect(probe.isolatedLayerId()).toBe(active.id)
    expect(probe.targetAt({})).toMatchObject({ cell: cells[0], color: 5 })
  }
  for (const state of [
    { auxiliary: 'pick' }, { tool: 'paint', paintMode: 'fill' }, { tool: 'layer' },
    { viewport: { renderMode: true } }, { modelSuspended: true },
  ]) {
    Object.assign(probe, { tool: 'select', paintMode: 'paint', auxiliary: undefined, modelSuspended: false, viewport: { renderMode: false } }, state)
    expect(probe.isolatedLayerId()).toBeUndefined()
    expect(probe.targetAt({})).toMatchObject({ cell: { x: 2, y: 5, z: 2 }, color: 9 })
  }
  probe.modelSuspended = false
  document.setActiveLayer(context.id)
  expect(probe.isolatedLayerId()).toBe(context.id)
})

test('keyboard Point, Surface, Texture and Body selections and touch actions use covered active-layer voxels', () => {
  const { document, active, cells } = layeredDocument()
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, modelSuspended: false, tool: 'select', paintMode: 'paint', sculptMode: 'erase', keyboardCell: cells[0],
    selection: new Map(), root: new Group(), viewport: { renderMode: false, render() {}, moveFocus() {} },
    callbacks: { onSelectionChange() {} },
  })
  const space = { key: ' ', shiftKey: false, preventDefault() {} }
  const target = traceGridRay(document, { x: 2.5, y: 8, z: 2.5 }, { x: 0, y: -1, z: 0 }, Infinity, active.id)!
  try {
    for (const [mode, count] of [['point', 1], ['surface', 3], ['texture', 2], ['body', 4]] as const) {
      probe.setSelectionMode(mode)
      probe.keyboard(space)
      expect(new Set(probe.selection.values())).toEqual(new Set(cells.slice(0, count)))
    }
    expect(probe.pushPullCells(target)).toEqual(cells)
    for (const tool of ['select', 'paint', 'sculpt']) {
      probe.tool = tool
      expect(probe.touchTargetActionable(target)).toBe(true)
    }
    active.locked = true
    for (const tool of ['paint', 'sculpt']) {
      probe.tool = tool
      expect(probe.touchTargetActionable(target)).toBe(false)
    }
    probe.tool = 'select'
    expect(probe.touchTargetActionable(target)).toBe(true)
    probe.keyboardCell = { x: 5, y: 2, z: 2 }
    probe.keyboard(space)
    expect(probe.selection.size).toBe(0)
    active.visible = false
    probe.keyboardCell = cells[0]
    probe.keyboard(space)
    expect(probe.selection.size).toBe(0)
    expect(probe.touchTargetActionable(target)).toBe(false)
    probe.setSelection(cells)
    expect(probe.selection.size).toBe(0)
  } finally { probe.clearSelectionPreview() }
})

test('either staggered face previews and keyboard push-pulls the whole selection, with an inverse one-step key', () => {
  const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
  const cells = [2, 4].flatMap((height, index) => Array.from({ length: height }, (_, y) => ({ x: index + 1, y: y + 1, z: 1 })))
  cells.forEach(cell => document.setVoxel(cell.x, cell.y, cell.z, 5))
  const fronts = [cells[1], cells[5]], normal = { x: 0, y: 1, z: 0 }
  const onPushPullCommit = mock(() => {}), updateGhostPreview = mock((_preview: unknown, _cells: unknown) => {})
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, modelSuspended: false, tool: 'sculpt', sculptMode: 'push', selectionMode: 'body', selection: new Map(), root: new Group(),
    viewport: { renderMode: false, camera: new OrthographicCamera(), render() {}, moveFocus() {}, setRasterInteraction() {},
      renderer: { domElement: { getBoundingClientRect: () => ({ width: 320, height: 240 }) } } },
    callbacks: { onSelectionChange() {}, onPushPullPreview() {}, onPushPullCommit }, updateGhostPreview,
  })
  try {
    probe.setSelection(cells)
    for (const cell of fronts) {
      const target = { cell, normal, occupied: true, color: 5 }
      expect(probe.pushPullCells(target)).toEqual(cells)
      expect(probe.startPushPull({ clientX: 0, clientY: 0 }, target)).toBe(true)
      expect(probe.pushPullDrag).toMatchObject({ cells, min: -2, max: 11 })
      expect(probe.pushPullPreview.instanceMatrix.count).toBe(fronts.length)
      expect(updateGhostPreview).toHaveBeenLastCalledWith(probe.pushPullPreview, fronts)
      for (const distance of [2, -2]) {
        probe.movePushPull({ clientX: probe.pushPullDrag.screenX * distance, clientY: probe.pushPullDrag.screenY * distance })
        const ghosts = fronts.flatMap(front => [0, 1].map(step => ({ ...front, y: front.y + (distance > 0 ? step + 1 : -step) })))
        expect(updateGhostPreview).toHaveBeenLastCalledWith(probe.pushPullPreview, ghosts)
      }
      probe.cancelPushPull()
      probe.keyboardCell = cell
      for (const shiftKey of [false, true]) {
        probe.keyboard({ key: ' ', shiftKey, preventDefault() {} })
        expect(onPushPullCommit).toHaveBeenLastCalledWith(cells, normal, shiftKey ? -1 : 1, false, false)
      }
    }
    expect(onPushPullCommit).toHaveBeenCalledTimes(4)
  } finally { probe.cancelPushPull(); probe.clearSelectionPreview() }
})

test('scope refresh cancels layer, lock and visibility changes, versions stale work, and does not remesh Select to Sculpt', () => {
  const { document, active, context } = layeredDocument()
  const postMessage = mock((_message: any, _transfers: ArrayBuffer[]) => {})
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, modelSuspended: false, tool: 'select', layerState: '', nextVersion: 0, inFlight: 0, workerReady: true,
    queued: new Set(), queuedGrids: new Set(), versions: new Map(), chunkMeshes: new Map(), chunkQuads: new Map(), meshWaiters: [],
    model: new Group(), hover: { visible: true }, marqueePreview: { visible: false }, settings: {},
    worker: { postMessage }, callbacks: { onMeshStats() {}, onPushPullPreview() {} }, createSurface: mock(() => new Group()),
    viewport: { renderMode: false, renderer: { shadowMap: {} }, requestPathTraceRebuild() {}, contentBecameReady() {}, render() {}, setRasterInteraction() {} },
  })
  probe.refreshLayerScope()
  const [request, transfers] = postMessage.mock.calls[0]
  const first = request.jobs[0]
  expect(request.type).toBe('mesh')
  expect(first.layerId).toBe(active.id)
  expect(new Uint8Array(first.voxels)).toEqual(document.paddedChunk(0, true))
  expect(new Uint8Array(first.active)).toEqual(document.paddedChunk(0, true, [active.id]))
  expect(new Uint8Array(first.context)).toEqual(document.paddedChunk(0, true, [context.id]))
  expect(transfers).toEqual([first.voxels, first.active, first.context])
  probe.setTool('sculpt')
  probe.setTool('select')
  probe.refreshLayerScope()
  expect(postMessage).toHaveBeenCalledTimes(1)
  expect(probe.versions.get(0)).toBe(first.version)
  expect(probe.queued.size).toBe(0)

  for (const change of [() => document.setActiveLayer(context.id), () => { context.locked = true }, () => { context.visible = false }]) {
    Object.assign(probe, { paintPointer: 1, activePointer: 2, pushPullDrag: {}, marqueeDrag: {} })
    probe.hover.visible = probe.marqueePreview.visible = true
    change()
    probe.refreshLayerScope()
    expect([probe.paintPointer, probe.activePointer, probe.pushPullDrag, probe.marqueeDrag]).toEqual([undefined, undefined, undefined, undefined])
    expect(probe.hover.visible).toBe(false)
    expect(probe.marqueePreview.visible).toBe(false)
  }
  expect(probe.versions.get(0)).toBeGreaterThan(first.version)
  const stale = meshChunk(new Uint8Array(first.voxels))
  probe.receiveMeshes({ type: 'meshed', results: [{ ...stale, active: stale, id: 0, layerId: active.id, version: first.version }] })
  expect(probe.createSurface).not.toHaveBeenCalled()
  expect(probe.model.children).toHaveLength(0)
  expect(postMessage).toHaveBeenCalledTimes(2)
  const current = postMessage.mock.calls[1][0].jobs[0]
  expect(current).toMatchObject({ layerId: context.id, version: probe.versions.get(0) })
  expect(new Uint8Array(current.active)).toEqual(document.paddedChunk(0, true, [context.id]))
})

test('installed isolation uses ghost context and shared physical surfaces, restores normal inspection, and disposes superseded geometry', async () => {
  const { document, active, context } = layeredDocument()
  const result = () => ({
    ...meshChunk(document.paddedChunk(0, true), undefined, true), id: 0, version: 1, layerId: active.id,
    active: meshChunk(document.paddedChunk(0, true, [active.id]), undefined, true),
    context: meshChunk(document.paddedChunk(0, true, [context.id])),
  })
  const materials = document.materials.map(() => new MeshPhysicalMaterial())
  const contextMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false })
  const meshVerticesMaterial = new PointsMaterial(), faceGridMaterial = new LineBasicMaterial()
  const model = new Group()
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, model, modelSuspended: false, tool: 'select', materials, contextMaterial, meshVerticesMaterial, faceGridMaterial, meshTrianglesMaterial: faceGridMaterial,
    settings: { faceGrid: true, meshVertices: true, meshTriangles: true }, versions: new Map([[0, 1]]),
    chunkMeshes: new Map(), chunkQuads: new Map(), queued: new Set(), queuedGrids: new Set(), inFlight: 0, pump() {},
    viewport: { renderMode: false, renderer: { shadowMap: {} }, requestPathTraceRebuild() {}, render() {} },
  })
  const visibleMeshes = () => {
    const meshes: Mesh[] = []
    model.traverseVisible(child => { if (child instanceof Mesh) meshes.push(child) })
    return meshes
  }
  let geometries = 0, disposed = 0, materialsDisposed = 0
  const watchGeometry = () => model.traverse(child => {
    if (child instanceof Mesh || child instanceof Points || child instanceof LineSegments) {
      geometries++
      child.geometry.addEventListener('dispose', () => { disposed++ })
    }
  })
  const shared = [...materials, contextMaterial, meshVerticesMaterial, faceGridMaterial]
  shared.forEach(material => material.addEventListener('dispose', () => { materialsDisposed++ }))
  try {
    const data = result()
    probe.receiveMeshes({ type: 'meshed', results: [data] })
    const chunk = model.children[0]
    const isolated = chunk.children.find(child => child.userData.layerIsolation)!
    const normal = chunk.children.filter(child => child instanceof Mesh)
    const focused = isolated.children.filter((child): child is Mesh => child instanceof Mesh && !child.userData.layerContext)
    const ghost = isolated.children.find(child => child.userData.layerContext) as Mesh
    expect(normal.map(mesh => mesh.material)).toEqual(data.groups.map(group => materials[group.materialIndex]))
    expect(focused.map(mesh => mesh.material)).toEqual(data.active.groups.map(group => materials[group.materialIndex]))
    expect(ghost.material).toBe(contextMaterial)
    expect(ghost.userData.editorOverlay).toBe(true)
    expect(ghost.geometry.attributes.position.array).toBe(data.context.positions)
    expect(ghost.children).toHaveLength(0)
    expect(visibleMeshes()).toEqual([...focused, ghost])
    expect(chunk.children.find(child => child.userData.faceGrid)?.visible).toBe(false)
    expect(chunk.children.find(child => child.userData.meshVertices)?.visible).toBe(false)
    expect(isolated.children.find(child => child.userData.faceGrid)?.visible).toBe(true)
    expect(isolated.children.find(child => child.userData.meshVertices)?.visible).toBe(true)

    probe.tool = 'layer'
    probe.updateMeshOverlayVisibility()
    expect(visibleMeshes()).toEqual(normal)
    probe.tool = 'select'
    probe.viewport.renderMode = true
    probe.updateMeshOverlayVisibility()
    expect(visibleMeshes()).toEqual(normal)
    model.traverseVisible(child => { if (child instanceof Points || child instanceof LineSegments) throw new Error('Render mode exposed an editor overlay') })
    probe.viewport.renderMode = false
    probe.updateMeshOverlayVisibility()
    const blob = new Blob(['inspection'])
    probe.viewport.renderViews = () => {
      expect(visibleMeshes()).toEqual(normal)
      return [{ convertToBlob: async () => blob }]
    }
    expect(await probe.inspect(['iso-front-right'])).toMatchObject([{ name: 'iso-front-right', blob }])
    expect(visibleMeshes()).toEqual([...focused, ghost])
    probe.viewport.renderViews = () => {
      expect(visibleMeshes()).toEqual(normal)
      throw new Error('inspection failed')
    }
    await expect(probe.inspect(['iso-front-right'])).rejects.toThrow('inspection failed')
    expect(visibleMeshes()).toEqual([...focused, ghost])
    expect(materials.every(material => material.opacity === 1 && !material.transparent && material.depthWrite)).toBe(true)

    watchGeometry()
    probe.receiveMeshes({ type: 'meshed', results: [{ ...result(), version: 0 }] })
    expect(model.children[0]).toBe(chunk)
    expect(disposed).toBe(0)
    probe.versions.set(0, 2)
    probe.receiveMeshes({ type: 'meshed', results: [{ ...result(), version: 2 }] })
    expect(disposed).toBe(geometries)
    expect(chunk.parent).toBeNull()
    expect(model.children).toHaveLength(1)
    watchGeometry()
    probe.removeChunk(0)
    expect(disposed).toBe(geometries)
    expect(model.children).toHaveLength(0)
    expect(materialsDisposed).toBe(0)
  } finally {
    probe.removeChunk(0)
    shared.forEach(material => material.dispose())
  }
})

test('the mesher worker returns normal and active surfaces but removes exact overlaps from binary context', async () => {
  type Reply = { type: 'ready' } | { type: 'meshed'; results: (MeshData & { id: number; version: number; layerId: number; active: MeshData; context: MeshData })[] }
  const worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })
  const receive = () => new Promise<Reply>((resolve, reject) => {
    worker.onmessage = event => resolve(event.data)
    worker.onerror = reject
  })
  try {
    expect(await receive()).toEqual({ type: 'ready' })
    const { document, active, context } = layeredDocument()
    const voxels = document.paddedChunk(0, true).buffer
    const selected = document.paddedChunk(0, true, [active.id]).buffer
    const background = document.paddedChunk(0, true, [context.id]).buffer
    worker.postMessage({ type: 'mesh', jobs: [{ id: 0, version: 7, layerId: active.id, voxels, active: selected, context: background }], faceGrid: true }, [voxels, selected, background])
    const reply = await receive()
    if (reply.type !== 'meshed') throw new Error('Expected isolated surface result')
    const expectedContext = new VoxelDocument()
    expectedContext.setVoxel(2, 3, 2, 1)
    expectedContext.setVoxel(3, 3, 2, 1)
    expectedContext.setVoxel(2, 5, 2, 1)
    expectedContext.setVoxel(5, 2, 2, 1)
    expect(reply.results).toEqual([{
      id: 0, version: 7, layerId: active.id, ...meshChunk(document.paddedChunk(0, true), undefined, true),
      active: meshChunk(document.paddedChunk(0, true, [active.id]), undefined, true),
      context: meshChunk(expectedContext.paddedChunk(0)),
    }])
    expect([voxels.byteLength, selected.byteLength, background.byteLength]).toEqual([0, 0, 0])
  } finally { worker.terminate() }
})
