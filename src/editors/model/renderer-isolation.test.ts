import { expect, mock, spyOn, test } from 'bun:test'
import { Box3, BufferGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, OrthographicCamera, Points, PointsMaterial, type Object3D } from 'three'
import { EditSession, History, VoxelDocument, dirtyChunks } from '../../shared/voxel/document'
import { meshChunk, meshFaceGrid, type MeshData } from '../../shared/voxel/mesher'
import { VoxelRenderer, traceGridRay } from './renderer'
import { DEFAULT_SETTINGS } from '../../shared/rendering/settings'

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

// Hold real CPU mesh results until explicitly delivered, including across scope/content changes.
function meshProbe(document: VoxelDocument, faceGrid = true) {
  let transparent = Uint8Array.from(document.materials, material => Number(material.opacity < 1 || material.transmission > 0))
  const pending: any[] = []
  const postMessage = mock((message: any, _transfers: ArrayBuffer[]) => {
    if (message.type === 'palette') { transparent = new Uint8Array(message.transparent); return }
    expect(message.jobs).toHaveLength(1)
    const { id, version, layerId, voxels, active, context } = structuredClone(message.jobs[0])
    if (message.type === 'grid') {
      pending.push({ type: 'gridded', results: [{ id, version, layerId,
        faceLines: voxels ? meshFaceGrid(new Uint8Array(voxels), transparent) : undefined,
        activeFaceLines: active ? meshFaceGrid(new Uint8Array(active), transparent) : undefined }] })
    } else {
      const background = context ? new Uint8Array(context) : undefined, selected = active ? new Uint8Array(active) : undefined
      if (background && selected) for (let i = 0; i < background.length; i++) background[i] = selected[i] ? 0 : Number(background[i] !== 0)
      pending.push({ type: 'meshed', results: [{ id, version, layerId,
        normal: voxels ? meshChunk(new Uint8Array(voxels), undefined, message.faceGrid, transparent) : undefined,
        active: selected ? meshChunk(selected, undefined, message.faceGrid, transparent) : undefined,
        context: background ? meshChunk(background) : undefined }] })
    }
  })
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, modelSuspended: false, tool: 'layer', paintMode: 'paint', layerState: '', nextVersion: 0, inFlight: 0, workerReady: true,
    queued: new Set(), queuedGrids: new Set(), versions: new Map(), chunkMeshes: new Map(), chunkQuads: new Map(), meshWaiters: [],
    model: new Group(), root: new Group(), selection: new Map(), textureLoads: new Map(), hover: { visible: false }, marqueePreview: { visible: false },
    settings: { faceGrid, meshVertices: true, meshTriangles: true }, worker: { postMessage, terminate() {} },
    callbacks: { onMeshStats() {}, onPushPullPreview() {} },
    contextMaterial: new MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false }),
    meshVerticesMaterial: new PointsMaterial(), faceGridMaterial: new LineBasicMaterial(), meshTrianglesMaterial: new LineBasicMaterial(),
    viewport: { renderMode: false, renderer: { shadowMap: {} }, requestPathTraceRebuild() {}, contentBecameReady() {}, render() {},
      setRasterInteraction() {}, applyEnvironment() {}, updatePathTracing() {}, invalidateSceneContent() {}, frameLocalBounds() {} },
  })
  probe.materials = probe.createMaterials()
  probe.bindWorker()
  const deliver = (reply = pending.shift()) => {
    expect(reply).toBeDefined()
    probe.worker.onmessage({ data: structuredClone(reply) })
    return reply
  }
  return { probe, postMessage, pending, deliver,
    async flush() {
      await Promise.resolve()
      let count = 0
      while (pending.length) { expect(++count).toBeLessThan(100); deliver() }
      expect(probe.meshState().pending).toBe(0)
    },
    dispose() {
      probe.modelSuspended = true
      probe.worker.terminate()
      for (const id of [...probe.chunkMeshes.keys()]) probe.removeChunk(id)
      probe.disposeMaterials()
      for (const material of [probe.contextMaterial, probe.meshVerticesMaterial, probe.faceGridMaterial, probe.meshTrianglesMaterial]) material.dispose()
    },
  }
}

const isolation = (chunk: Object3D) => chunk.children.find(child => child.userData.layerIsolation)!
const grid = (surface: Object3D) => surface.children.find(child => child.userData.faceGrid) as LineSegments | undefined

test('live sprite scope retains fresh context and diagnostics without drawing the physical surfaces', async () => {
  const { document, active, context } = layeredDocument()
  const harness = meshProbe(document), { probe } = harness
  const preview = { root: new Group(), setLayerScope: mock((_id?: number) => {}), markDirty: mock((_ids: Iterable<number>) => {}) }
  preview.root.visible = false
  Object.assign(probe, { preview, previewPlugin: { id: 'cube-sprites' }, modelRenderMode: false })
  probe.viewport.settings = { ...DEFAULT_SETTINGS, ...probe.settings, previewRenderer: 'cube-sprites' }
  try {
    probe.markDirty(document.chunks.keys())
    await harness.flush()
    probe.syncViewport()
    expect(preview.root.visible).toBe(true)
    expect(probe.model.visible).toBe(true)
    expect(probe.materials.every((material: MeshPhysicalMaterial) => !material.visible)).toBe(true)
    const chunk = probe.chunkMeshes.get(0) as Group
    probe.setToolState('select', 'paint')
    expect(preview.setLayerScope).toHaveBeenLastCalledWith(active.id)
    expect(chunk.visible).toBe(false)
    await harness.flush()
    const scoped = isolation(chunk)
    expect(chunk.visible && scoped.visible).toBe(true)
    expect(scoped.children.some(child => child.userData.layerContext && child.visible)).toBe(true)
    expect(grid(scoped)?.visible).toBe(true)
    expect(scoped.children.some(child => child instanceof Points && child.visible)).toBe(true)
    expect(scoped.children.some(child => child instanceof Mesh && child.children.some(overlay => overlay.userData.meshTriangles && overlay.visible))).toBe(true)

    document.setVoxel(2, 2, 2, 7)
    probe.markDirty(document.chunks.keys())
    expect(chunk.visible).toBe(false)
    expect(preview.markDirty).toHaveBeenLastCalledWith([0])
    await harness.flush()
    expect(chunk.visible).toBe(true)
    document.setActiveLayer(context.id)
    probe.refreshLayerScope()
    expect(preview.setLayerScope).toHaveBeenLastCalledWith(context.id)
    expect(chunk.visible).toBe(false)
    await harness.flush()
    expect(chunk.visible).toBe(true)

    probe.viewport.renderViews = () => {
      expect(preview.setLayerScope).toHaveBeenLastCalledWith(undefined)
      throw new Error('Inspection draw failed')
    }
    await expect(probe.inspect(['iso-front-left'])).rejects.toThrow('Inspection draw failed')
    expect(preview.setLayerScope).toHaveBeenLastCalledWith(context.id)
    probe.viewport.settings.previewRenderer = 'standard'
    probe.syncViewport()
    expect(preview.root.visible).toBe(false)
    expect(probe.materials.every((material: MeshPhysicalMaterial) => material.visible)).toBe(true)
    expect(chunk.visible).toBe(true)
  } finally { harness.dispose() }
})

test('normal bootstrap, cold isolation, exit and warm reentry retain roots with zero warm jobs, allocations or disposal', async () => {
  const { document, active } = layeredDocument()
  const harness = meshProbe(document), { probe, postMessage } = harness
  try {
    probe.markDirty(document.chunks.keys())
    expect(postMessage).not.toHaveBeenCalled()
    await harness.flush()
    const chunk = probe.chunkMeshes.get(0) as Group, normal = [...chunk.children]
    const version = probe.versions.get(0)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage.mock.calls[0][0].jobs[0].active).toBeUndefined()
    probe.setToolState('select', 'paint')
    await harness.flush()
    expect(postMessage).toHaveBeenCalledTimes(2)
    const [request, transfers] = postMessage.mock.calls[1], job = request.jobs[0]
    expect(job).toMatchObject({ id: 0, version, layerId: active.id })
    expect(job.voxels).toBeUndefined()
    expect(transfers).toEqual([job.active, job.context])
    const cached = isolation(chunk), children = [...chunk.children]
    expect(chunk.children.filter(child => !child.userData.layerIsolation)).toEqual(normal)
    const allocations = spyOn(BufferGeometry.prototype, 'setAttribute'), disposals = spyOn(BufferGeometry.prototype, 'dispose')
    postMessage.mockClear()
    try {
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const exit of [() => probe.setTool('layer'), () => probe.setToolState('paint', 'fill'), () => probe.setAuxiliary('pick'),
          () => { probe.viewport.renderMode = true; probe.refreshLayerScope() }]) {
          exit()
          await harness.flush()
          expect(cached.visible).toBe(false)
          expect(normal.filter(child => child instanceof Mesh).every(child => child.visible)).toBe(true)
          probe.viewport.renderMode = false
          probe.setToolState('select', 'paint')
          probe.setTool('sculpt'); probe.setPaintMode('paint')
          await harness.flush()
          expect(cached.visible).toBe(true)
          expect(probe.chunkMeshes.get(0)).toBe(chunk)
          expect(chunk.children).toEqual(children)
          expect(probe.versions.get(0)).toBe(version)
        }
      }
      expect(postMessage).not.toHaveBeenCalled()
      expect(allocations).not.toHaveBeenCalled()
      expect(disposals).not.toHaveBeenCalled()
    } finally { allocations.mockRestore(); disposals.mockRestore() }
  } finally { harness.dispose() }
})

test('distant A/B switches rebuild face neighbors but retain unrelated context and every normal surface', async () => {
  const document = new VoxelDocument({ x: 160, y: 16, z: 16 }), a = document.activeLayerId
  document.setVoxel(15, 2, 2, 5)
  const b = document.createLayer().id
  document.setVoxel(95, 2, 2, 6)
  document.createLayer()
  for (const x of [15, 16, 95, 96, 145]) document.setVoxel(x, 2, 2, 9)
  document.setActiveLayer(a)
  const harness = meshProbe(document), { probe, postMessage } = harness
  try {
    probe.markDirty(document.chunks.keys())
    await harness.flush()
    const roots = new Map<number, Group>(probe.chunkMeshes)
    const normals = new Map([...roots].map(([id, root]) => [id, [...root.children]]))
    const versions = new Map(probe.versions)
    probe.setToolState('select', 'paint')
    await harness.flush()
    expect(isolation(roots.get(1)!).userData.layerId).toBe(a)
    const ghost = isolation(roots.get(1)!).children.find(child => child.userData.layerContext) as Mesh
    expect(ghost.geometry.index!.count / 6).toBe(6)
    const unrelated = isolation(roots.get(9)!)
    expect(unrelated.userData.layerId).toBe(0)
    let unrelatedDisposals = 0, normalDisposals = 0
    unrelated.traverse(child => { if (child instanceof Mesh || child instanceof Points || child instanceof LineSegments) child.geometry.addEventListener('dispose', () => unrelatedDisposals++) })
    for (const children of normals.values()) for (const child of children) child.traverse(object => {
      if (object instanceof Mesh || object instanceof Points || object instanceof LineSegments) object.geometry.addEventListener('dispose', () => normalDisposals++)
    })
    for (const layerId of [b, a, b]) {
      const previous = [0, 1, 5, 6].map(id => isolation(roots.get(id)!))
      let geometries = 0, disposed = 0
      for (const surface of previous) surface.traverse(child => {
        if (child instanceof Mesh || child instanceof Points || child instanceof LineSegments) {
          geometries++; child.geometry.addEventListener('dispose', () => disposed++)
        }
      })
      postMessage.mockClear()
      document.setActiveLayer(layerId); probe.refreshLayerScope()
      await harness.flush()
      const jobs = postMessage.mock.calls.map(([message]) => message.jobs[0])
      expect(jobs.map(job => job.id).sort((a, b) => a - b)).toEqual([0, 1, 5, 6])
      expect(jobs.every(job => job.voxels === undefined)).toBe(true)
      expect(jobs.find(job => job.id === 1).layerId).toBe(layerId === a ? a : 0)
      expect(jobs.find(job => job.id === 6).layerId).toBe(layerId === b ? b : 0)
      for (const [id, owner] of [[1, a], [6, b]]) {
        const ghost = isolation(roots.get(id)!).children.find(child => child.userData.layerContext) as Mesh
        expect(ghost.geometry.index!.count / 6).toBe(layerId === owner ? 6 : 5)
      }
      expect(disposed).toBe(geometries)
      expect(previous.every(surface => surface.parent === null)).toBe(true)
      expect(isolation(roots.get(9)!)).toBe(unrelated)
      for (const [id, root] of roots) {
        expect(probe.chunkMeshes.get(id)).toBe(root)
        expect(root.children.filter(child => !child.userData.layerIsolation)).toEqual(normals.get(id)!)
        expect(root.children.filter(child => child.userData.layerIsolation)).toHaveLength(1)
        expect(isolation(root).visible).toBe(true)
      }
      expect(probe.versions).toEqual(versions)
      expect([normalDisposals, unrelatedDisposals]).toEqual([0, 0])
    }
  } finally { harness.dispose() }
})

test('edits while isolation is off invalidate cached geometry, undo restores it, and empty surfaces stay cached', async () => {
  const document = new VoxelDocument({ x: 16, y: 16, z: 16 }), active = document.activeLayerId
  document.setVoxel(2, 2, 2, 5)
  const context = document.createLayer()
  document.setVoxel(2, 2, 2, 9)
  document.setActiveLayer(active)
  const history = new History(), harness = meshProbe(document), { probe, postMessage } = harness
  try {
    probe.setToolState('select', 'paint')
    await harness.flush()
    const root = probe.chunkMeshes.get(0) as Group
    const session = new EditSession(document)
    probe.setTool('layer')
    session.set(2, 2, 2, 0); history.push(session.commit())
    for (const change of [() => [0], () => history.undo(document)!.ids, () => history.redo(document)!.ids]) {
      probe.setTool('layer')
      const changed = change()
      const cached = isolation(root), oldVersion = cached.userData.version
      probe.markDirty(dirtyChunks(document, changed))
      await harness.flush()
      expect(probe.chunkMeshes.get(0)).toBe(root)
      expect(root.userData.version).toBeGreaterThan(oldVersion)
      expect(cached.visible).toBe(false)
      postMessage.mockClear()
      probe.setToolState('select', 'paint')
      await harness.flush()
      expect(postMessage).toHaveBeenCalledTimes(1)
      expect(postMessage.mock.calls[0][0].jobs[0].voxels).toBeUndefined()
      expect(isolation(root)).not.toBe(cached)
      const focused = isolation(root).children.filter(child => child instanceof Mesh && !child.userData.layerContext)
      expect(focused).toHaveLength(document.getLayerVoxel(2, 2, 2, active) ? 1 : 0)
      expect(isolation(root).visible).toBe(true)
    }
    context.visible = false
    // Keep isolation enabled while the only stored voxels belong to a hidden layer.
    document.createLayer(); document.setActiveLayer(active)
    probe.refreshLayerScope(); probe.markDirty([0])
    await harness.flush()
    const empty = isolation(root)
    expect(empty.children).toHaveLength(0)
    expect(empty.userData.faceGridReady).toBe(true)
    expect(root.children.filter(child => !child.userData.layerIsolation)).toHaveLength(0)
    postMessage.mockClear()
    probe.setTool('layer'); await harness.flush()
    probe.setToolState('select', 'paint'); await harness.flush()
    expect(isolation(root)).toBe(empty)
    expect(postMessage).not.toHaveBeenCalled()
  } finally { harness.dispose() }
})

test('rapid atomic scope switches reject stale meshes and grids without losing current-version normal work', async () => {
  const { document, active, context } = layeredDocument()
  const harness = meshProbe(document, false), { probe, postMessage, pending, deliver } = harness
  try {
    probe.setToolState('select', 'paint')
    probe.setToolState('paint', 'fill')
    probe.setToolState('paint', 'paint', 'pick')
    probe.setToolState('sculpt', 'paint')
    await Promise.resolve()
    expect(postMessage).toHaveBeenCalledTimes(1)
    const oldScope = pending.shift()
    document.setActiveLayer(context.id); probe.refreshLayerScope()
    deliver(oldScope)
    const root = probe.chunkMeshes.get(0) as Group
    expect(root.children.some(child => child instanceof Mesh)).toBe(true)
    expect(isolation(root)).toBeUndefined()
    const normal = [...root.children]
    await harness.flush()
    expect(root.children.filter(child => !child.userData.layerIsolation)).toEqual(normal)
    const b = isolation(root)
    expect(b.userData.layerId).toBe(context.id)

    probe.settings.faceGrid = true
    probe.queuedGrids.add(0); probe.scheduleMesh()
    await Promise.resolve()
    const oldGrid = pending.shift()
    expect(oldGrid.type).toBe('gridded')
    expect(oldGrid.results[0].faceLines.length).toBeGreaterThan(0)
    document.setActiveLayer(active.id); probe.refreshLayerScope()
    deliver(oldGrid)
    const normalGrid = grid(root)!
    expect(normalGrid.geometry.attributes.position.array).toEqual(oldGrid.results[0].faceLines)
    expect(grid(b)).toBeUndefined()
    expect(b.visible).toBe(false)
    const next = pending.shift()
    expect(next.results[0].layerId).toBe(active.id)
    document.setVoxel(7, 2, 2, 5)
    probe.markDirty([0])
    deliver(next)
    expect(isolation(root)).toBe(b)
    await harness.flush()
    const current = isolation(root), currentGrid = grid(current)!, currentNormalGrid = grid(root)!
    expect(current.userData.layerId).toBe(active.id)
    expect(current.userData.version).toBe(probe.versions.get(0))
    const allocations = spyOn(BufferGeometry.prototype, 'setAttribute')
    try {
      deliver(oldScope); deliver(oldGrid)
      expect(isolation(root)).toBe(current)
      expect(grid(current)).toBe(currentGrid)
      expect(grid(root)).toBe(currentNormalGrid)
      expect(allocations).not.toHaveBeenCalled()
    } finally { allocations.mockRestore() }

    // A -> B (in flight) -> A must keep the warm A cache, even when B finishes.
    document.setActiveLayer(context.id); probe.refreshLayerScope()
    await Promise.resolve()
    const staleIsolation = pending.shift()
    expect(staleIsolation.results[0].normal).toBeUndefined()
    document.setActiveLayer(active.id); probe.refreshLayerScope()
    postMessage.mockClear()
    const skipped = spyOn(BufferGeometry.prototype, 'setAttribute')
    try {
      deliver(staleIsolation); await harness.flush()
      expect(isolation(root)).toBe(current)
      expect(current.visible).toBe(true)
      expect(grid(current)).toBe(currentGrid)
      expect(postMessage).not.toHaveBeenCalled()
      expect(skipped).not.toHaveBeenCalled()
    } finally { skipped.mockRestore() }
  } finally { harness.dispose() }
})

test('transparency topology changes invalidate both surfaces while color and roughness preserve warm isolation', async () => {
  const { document, active } = layeredDocument()
  const harness = meshProbe(document), { probe, postMessage } = harness
  try {
    probe.setToolState('select', 'paint'); await harness.flush()
    const root = probe.chunkMeshes.get(0) as Group
    for (const preset of [{ opacity: 0.5, transmission: 0 }, { opacity: 1, transmission: 0 }, { opacity: 1, transmission: 0.8 }]) {
      const cached = isolation(root), version = root.userData.version
      probe.setTool('layer')
      Object.assign(document.materials[6], preset)
      probe.updatePaletteMaterial(6)
      await harness.flush()
      expect(root.userData.version).toBeGreaterThan(version)
      expect(cached.visible).toBe(false)
      probe.setToolState('select', 'paint'); await harness.flush()
      const focused = isolation(root)
      expect(focused).not.toBe(cached)
      const transparent = Uint8Array.from(document.materials, material => Number(material.opacity < 1 || material.transmission > 0))
      const expected = meshChunk(document.paddedChunk(0, true, [active.id]), undefined, true, transparent)
      expect((focused.children.find(child => child instanceof Points) as Points).geometry.attributes.position.array).toEqual(expected.positions)
      expect(grid(focused)!.geometry.attributes.position.array).toEqual(expected.faceLines)
      expect(grid(root)!.geometry.attributes.position.array).toEqual(meshFaceGrid(document.paddedChunk(0, true), transparent))
    }
    const children = [...root.children], versions = new Map(probe.versions)
    postMessage.mockClear()
    document.materials[6].roughness = 0.9; probe.updatePaletteMaterial(6)
    document.palette[6] = 0xff0000; probe.updatePalette()
    probe.setTool('layer'); await harness.flush()
    probe.setToolState('select', 'paint'); await harness.flush()
    expect(postMessage).not.toHaveBeenCalled()
    expect(root.children).toEqual(children)
    expect(probe.versions).toEqual(versions)
  } finally { harness.dispose() }
})

test('document replacement disposes isolation and ignores replies from the previous worker even with reused chunk and layer IDs', async () => {
  const { document } = layeredDocument(), harness = meshProbe(document), { probe } = harness
  try {
    probe.setToolState('select', 'paint'); await harness.flush()
    const root = probe.chunkMeshes.get(0) as Group
    let geometries = 0, disposed = 0
    root.traverse(child => {
      if (child instanceof Mesh || child instanceof Points || child instanceof LineSegments) {
        geometries++; child.geometry.addEventListener('dispose', () => disposed++)
      }
    })
    probe.markDirty([0]); await Promise.resolve()
    const oldWorker = probe.worker, late = oldWorker.onmessage, stale = harness.pending.shift()
    const replacement = layeredDocument().document
    replacement.setVoxel(10, 10, 10, 5)
    probe.content = { bounds: new Box3() }
    probe.viewport.setSceneContent = () => probe.refreshLayerScope()
    probe.setDocument(replacement, true)
    expect(disposed).toBe(geometries)
    expect(root.parent).toBeNull()
    late({ data: stale }); late({ data: { type: 'ready' } })
    expect(probe.model.children).toHaveLength(0)
    await probe.whenMeshIdle()
    const current = probe.chunkMeshes.get(0) as Group
    expect(current).not.toBe(root)
    expect(current.children.filter(child => child.userData.layerIsolation)).toHaveLength(1)
    expect(isolation(current).visible).toBe(true)
    expect((current.children.find(child => child instanceof Points) as Points).geometry.attributes.position.array)
      .toEqual(meshChunk(replacement.paddedChunk(0, true)).positions)
    late({ data: stale })
    expect(probe.chunkMeshes.get(0)).toBe(current)
  } finally { harness.dispose() }
})

test('scope refresh cancels gestures without changing content versions and accepts normal results independently of stale scope', async () => {
  const { document, active, context } = layeredDocument()
  const harness = meshProbe(document), { probe, postMessage } = harness
  try {
    probe.setToolState('select', 'paint')
    expect(postMessage).not.toHaveBeenCalled()
    await Promise.resolve()
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
    await Promise.resolve()
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(probe.versions.get(0) ?? 0).toBe(first.version)
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
    expect(probe.versions.get(0) ?? 0).toBe(first.version)
    // Restore visibility before delivery: this reply has stale scope, not stale content.
    context.visible = true
    probe.refreshLayerScope()
    harness.deliver()
    const chunk = probe.chunkMeshes.get(0) as Group
    expect(chunk.userData.version).toBe(first.version)
    expect(chunk.children.some(child => child instanceof Mesh)).toBe(true)
    expect(isolation(chunk)).toBeUndefined()
    expect(postMessage).toHaveBeenCalledTimes(2)
    const current = postMessage.mock.calls[1][0].jobs[0]
    expect(current).toMatchObject({ layerId: context.id, version: first.version })
    expect(current.voxels).toBeUndefined()
    expect(new Uint8Array(current.active)).toEqual(document.paddedChunk(0, true, [context.id]))
    await harness.flush()
    expect(probe.chunkMeshes.get(0)).toBe(chunk)
    expect(isolation(chunk).userData.layerId).toBe(context.id)
  } finally { harness.dispose() }
})

test('installed isolation uses ghost context and shared physical surfaces, restores normal inspection, and disposes superseded geometry', async () => {
  const { document, active, context } = layeredDocument()
  const result = () => ({
    normal: meshChunk(document.paddedChunk(0, true), undefined, true), id: 0, version: 1, layerId: active.id,
    active: meshChunk(document.paddedChunk(0, true, [active.id]), undefined, true),
    context: meshChunk(document.paddedChunk(0, true, [context.id])),
  })
  const materials = document.materials.map(() => new MeshPhysicalMaterial())
  const contextMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false })
  const meshVerticesMaterial = new PointsMaterial(), faceGridMaterial = new LineBasicMaterial()
  const model = new Group()
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, model, modelSuspended: false, tool: 'select', meshLayerId: active.id, materials, contextMaterial, meshVerticesMaterial, faceGridMaterial, meshTrianglesMaterial: faceGridMaterial,
    settings: { faceGrid: true, meshVertices: true, meshTriangles: true }, versions: new Map([[0, 1]]),
    chunkMeshes: new Map(), chunkQuads: new Map(), queued: new Set(), queuedGrids: new Set(), inFlight: 0, pump() { this.queuedGrids.clear() },
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
    expect(normal.map(mesh => mesh.material)).toEqual(data.normal.groups.map(group => materials[group.materialIndex]))
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
    expect(model.children[0]).toBe(chunk)
    expect(chunk.parent).toBe(model)
    expect(chunk.children.filter(child => child.userData.layerIsolation)).toHaveLength(1)
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
  type Reply = { type: 'ready' } | { type: 'meshed'; results: { id: number; version: number; normal?: MeshData; layerId: number; active: MeshData; context: MeshData }[] }
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
      id: 0, version: 7, layerId: active.id, normal: meshChunk(document.paddedChunk(0, true), undefined, true),
      active: meshChunk(document.paddedChunk(0, true, [active.id]), undefined, true),
      context: meshChunk(expectedContext.paddedChunk(0)),
    }])
    expect([voxels.byteLength, selected.byteLength, background.byteLength]).toEqual([0, 0, 0])
  } finally { worker.terminate() }
})
