import { expect, mock, spyOn, test } from 'bun:test'
import { Color, DirectionalLight, Group, LineBasicMaterial, LineSegments, Mesh, MeshPhysicalMaterial, OrthographicCamera, PerspectiveCamera, Points, PointsMaterial, Raycaster, Scene, Texture, TextureLoader, Vector2, Vector3 } from 'three'
import { PathTracingSceneGenerator } from 'three-gpu-pathtracer/src/index.js'
import { VoxelDocument, chunkId } from '../../shared/voxel/document'
import { VoxelRenderer, traceGridRay, type RendererCallbacks } from './renderer'
import { Viewport } from '../../shared/rendering/viewport'
import { DEFAULT_SETTINGS } from '../../shared/rendering/settings'
import { realtimeEnvironmentIntensity } from '../../shared/rendering/stage'
import { meshChunk } from '../../shared/voxel/mesher'
import type { PreviewFrame } from '../../shared/rendering/contracts'

test('inside-solid rays never expose an invalid action normal', () => {
  const document = new VoxelDocument()
  document.setVoxel(2, 2, 2, 1)
  document.setVoxel(3, 2, 2, 1)
  document.setVoxel(5, 2, 2, 2)
  expect(traceGridRay(document, { x: 2.5, y: 2.5, z: 2.5 }, { x: 1, y: 0, z: 0 })).toMatchObject({ cell: { x: 5, y: 2, z: 2 }, normal: { x: -1, y: 0, z: 0 } })
  expect(traceGridRay(document, { x: 2.5, y: 2.5, z: 2.5 }, { x: 0, y: 0, z: 0 })).toBeUndefined()
  expect(traceGridRay(document, { x: -1, y: 2.5, z: 2.5 }, { x: 1, y: 0, z: 0 }, 2)).toBeUndefined()
})

test('orthographic picking starts at the rendered near plane', () => {
  const document = new VoxelDocument({ x: 32, y: 16, z: 32 })
  document.setVoxel(16, 8, 30, 1)
  const camera = new OrthographicCamera(-10, 10, 10, -10, -1000, 2000)
  camera.position.set(0, 8, 10)
  camera.lookAt(0, 8, 0)
  camera.updateMatrixWorld(true)
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, pointer: new Vector2(), raycaster: new Raycaster(),
    viewport: { camera, renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } } },
  })
  expect(probe.targetAt({ clientX: 50, clientY: 50 })).toMatchObject({ cell: { x: 16, y: 8, z: 30 }, normal: { x: 0, y: 0, z: 1 } })
})

test('deletion-only mesh queues resume the requested trace build', async () => {
  let builds = 0
  const viewport = Object.assign(Object.create(Viewport.prototype), {
    pathTracingRevision: 0, renderMode: true, settings: { pathTracing: true },
    pathTracingReady: true, pathTracingBuildRequested: false, pathTracingFailed: false,
    render() {}, stopPathTracingSamples() {}, buildPathTrace() { builds++ },
    callbacks: {},
  })
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document: new VoxelDocument(), queued: new Set(), queuedGrids: new Set(), versions: new Map(),
    chunkMeshes: new Map(), chunkQuads: new Map(), meshWaiters: [], inFlight: 0, workerReady: true,
    nextVersion: 0, viewport, callbacks: { onMeshStats() {} },
    worker: { postMessage() { throw new Error('Deleted chunks must not enter the worker') } },
  })
  viewport.sceneContent = { stage: 'bounded', isReady: () => !probe.inFlight && !probe.queued.size }
  probe.markDirty([0])
  await Promise.resolve()
  expect(probe.meshState()).toMatchObject({ pending: 0 })
  expect(builds).toBe(1)
})

test('captures flush current camera/material pixels without waiting for RAF', async () => {
  const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  let state = 'old', pixels = 'old'
  const probe = Object.assign(Object.create(Viewport.prototype), {
    camera: new PerspectiveCamera(), settings: { pathTracing: true }, renderMode: true,
    sceneContent: { root: new Group(), stage: 'bounded', whenReady: async () => {} },
    pathTracingReady: true, pathTracingBuildRunning: false, pathTracingFailed: false,
    queued: new Set(), queuedGrids: new Set(), inFlight: 0, presentationDirty: false,
    captures: 0, syncRasterResolution() { return false },
    pathTracer: { reset() {}, setCamera() {}, updateMaterials() {} },
    resetFps() {}, renderRaster() { pixels = state; this.presentationDirty = false },
    getView: () => ({ state }),
    renderer: { getContext: () => ({ isContextLost: () => false }), domElement: { toBlob: (callback: (blob: Blob) => void) => callback(new Blob([pixels])) } },
  })
  try {
    for (const change of ['camera', 'materials']) {
      state = change
      probe.updatePathTracing(change)
      const capture = await probe.capture()
      expect(await capture.blob.text()).toBe(change)
      expect(capture.view.state).toBe(change)
      expect(probe.presentationDirty).toBe(false)
    }
  } finally {
    globalThis.requestAnimationFrame = request
    globalThis.cancelAnimationFrame = cancel
  }
})

test('progressive raster previews suppress maps and preserve pending updates and renderer state', () => {
  const shadowMap = { enabled: true, needsUpdate: true }, sunlight = { castShadow: true }
  let expected = false, fail = false, frames = 0
  const raster = { render() {
    expect(shadowMap.enabled).toBe(expected)
    expect(sunlight.castShadow).toBe(expected)
    shadowMap.needsUpdate = false
    if (fail) throw new Error('draw failed')
  } }
  const probe = Object.assign(Object.create(Viewport.prototype), {
    renderer: { shadowMap }, scene: new Scene(), sunlight, raster, settings: { pathTracing: true, shadows: true }, renderMode: true,
    sceneContent: { stage: 'bounded' },
    recordFrame() { frames++ },
  })
  for (const ready of [false, true]) for (const dirty of [false, true]) for (const throws of [false, true]) {
    probe.pathTracingReady = ready
    shadowMap.needsUpdate = dirty
    fail = throws
    probe.presentationDirty = true
    if (throws) expect(() => probe.renderRaster()).toThrow('draw failed')
    else probe.renderRaster()
    expect(shadowMap).toEqual({ enabled: true, needsUpdate: dirty })
    expect(sunlight.castShadow).toBe(true)
    expect(probe.presentationDirty).toBe(throws)
  }
  expect(frames).toBe(0)
  fail = false
  expected = true
  probe.renderRaster(undefined, raster, true)
  expect(shadowMap.needsUpdate).toBe(false)
  for (const state of [{ renderMode: false }, { pathTracingFailed: true }, { sceneInteraction: true }, { sceneContent: {} }]) {
    Object.assign(probe, { renderMode: true, pathTracingFailed: false, sceneInteraction: false, sceneContent: { stage: 'bounded' } }, state)
    shadowMap.needsUpdate = true
    probe.renderRaster()
    expect(shadowMap.needsUpdate).toBe(false)
  }
  expect(frames).toBe(4)
  probe.settings.shadows = false
  shadowMap.enabled = false
  shadowMap.needsUpdate = true
  expected = false
  probe.renderRaster(undefined, raster, true)
  expect(shadowMap).toEqual({ enabled: false, needsUpdate: true })
  expect(sunlight.castShadow).toBe(true)
})

test('ambient environment follows the path tracer +Y => V=1 convention', () => {
  const probe = Object.assign(Object.create(Viewport.prototype), {
    hemisphere: { color: new Color(0xffffff), groundColor: new Color(0x8c91a0) },
  })
  const texture = probe.createAmbientEnvironment()
  const { data, width, height } = texture.image
  expect(data[(height - 1) * width * 4]).toBeGreaterThan(0.99)
  expect(data[0]).toBeCloseTo(probe.hemisphere.groundColor.r, 2)
  texture.dispose()
})

test('mesh overlays use merged geometry, follow chunk transforms and visibility, and dispose on replacement and removal', () => {
  const document = new VoxelDocument({ x: 64, y: 32, z: 64 })
  document.setVoxel(18, 19, 20, 1)
  document.setVoxel(19, 19, 20, 1)
  const id = chunkId(1, 1, 1)
  const data = meshChunk(document.paddedChunk(id), document.palette, true)
  const indices = data.indices.slice()
  const material = new MeshPhysicalMaterial(), meshVerticesMaterial = new PointsMaterial(), faceGridMaterial = new LineBasicMaterial()
  const model = new Group()
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, model, materials: [material, material], meshVerticesMaterial, faceGridMaterial, meshTrianglesMaterial: faceGridMaterial,
    settings: { faceGrid: false, meshVertices: false, meshTriangles: false }, versions: new Map([[id, 1]]),
    chunkMeshes: new Map(), chunkQuads: new Map(), queuedGrids: new Set(),
    viewport: { renderer: { shadowMap: { needsUpdate: false } }, renderMode: false, requestPathTraceRebuild() {}, render() {} }, pump() {},
  })
  let disposed = 0, materialDisposed = 0
  meshVerticesMaterial.addEventListener('dispose', () => { materialDisposed++ })
  try {
    probe.receiveMeshes({ type: 'meshed', results: [{ normal: data, id, version: 1 }] })
    const chunk = model.children[0]
    const overlays = chunk.children.filter(child => child instanceof Points)
    expect(overlays).toHaveLength(1)
    const points = overlays[0]!
    const surface = chunk.children.find(child => child instanceof Mesh)!
    const grid = chunk.children.find(child => child instanceof LineSegments)!
    const geometry = points.geometry, position = geometry.attributes.position
    geometry.addEventListener('dispose', () => { disposed++ })
    expect(points.parent).toBe(chunk)
    expect(points.userData).toMatchObject({ meshVertices: true, editorOverlay: true })
    expect(points.material).toBe(meshVerticesMaterial)
    expect(points.visible).toBe(false)
    expect(grid.visible).toBe(false)
    expect(Object.keys(geometry.attributes)).toEqual(['position'])
    expect(geometry.index).toBeNull()
    expect(position.itemSize).toBe(3)
    expect(position.array).toBe(data.positions)
    expect(position.count).toBe(24)
    const corners = new Set(Array.from({ length: position.count }, (_, index) =>
      new Vector3().fromBufferAttribute(position, index).applyMatrix4(points.matrixWorld).toArray().join(',')))
    expect(corners.size).toBe(8)
    expect(corners).toEqual(new Set([
      '-14,19,-12', '-14,19,-11', '-14,20,-12', '-14,20,-11',
      '-12,19,-12', '-12,19,-11', '-12,20,-12', '-12,20,-11',
    ]))
    const surfaceIndex = surface.geometry.index!
    expect(surfaceIndex.array).toEqual(indices)
    expect(surface.children).toHaveLength(0)
    for (const faceGrid of [false, true]) for (const meshVertices of [false, true]) for (const meshTriangles of [false, true]) for (const renderMode of [false, true]) {
      Object.assign(probe.settings, { faceGrid, meshVertices, meshTriangles })
      probe.viewport.renderMode = renderMode
      probe.updateMeshOverlayVisibility()
      expect(points.visible).toBe(meshVertices && !renderMode)
      expect(grid.visible).toBe(faceGrid && !renderMode)
      expect(surface.children.some(child => child.userData.meshTriangles && child.visible)).toBe(meshTriangles && !renderMode)
      expect(surface.visible).toBe(true)
      expect(points.geometry).toBe(geometry)
    }
    expect(surface.children).toHaveLength(1)
    const triangles = surface.children[0] as LineSegments
    const lines = triangles.geometry.attributes.position
    expect(triangles.userData.editorOverlay).toBe(true)
    expect(triangles.matrixWorld).toEqual(surface.matrixWorld)
    const expectedEdges = new Set<string>(), actualEdges = new Set<string>()
    const corner = (index: number) => new Vector3().fromBufferAttribute(position, index).toArray().join(',')
    for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
      expectedEdges.add([corner(indices[i + j]), corner(indices[i + (j + 1) % 3])].sort().join(';'))
    }
    for (let i = 0; i < lines.count; i += 2) {
      actualEdges.add([i, i + 1].map(index => new Vector3().fromBufferAttribute(lines, index).toArray().join(',')).sort().join(';'))
    }
    expect(actualEdges).toEqual(expectedEdges)
    expect(actualEdges.size).toBe(18) // Twelve box edges and six face diagonals.
    let trianglesDisposed = 0
    triangles.geometry.addEventListener('dispose', () => { trianglesDisposed++ })
    probe.updateMeshOverlayVisibility()
    expect(surface.children[0]).toBe(triangles)
    expect(surface.geometry.index).toBe(surfaceIndex)
    expect(surfaceIndex.array).toEqual(indices)
    expect(data.indices).toEqual(indices)

    document.setVoxel(19, 19, 20, 0)
    const replacement = meshChunk(document.paddedChunk(id), document.palette, true)
    probe.versions.set(id, 2)
    probe.receiveMeshes({ type: 'meshed', results: [{ normal: replacement, id, version: 2 }] })
    expect(disposed).toBe(1)
    expect(trianglesDisposed).toBe(1)
    expect(chunk.parent).toBe(model)
    expect(model.children).toHaveLength(1)
    const nextOverlays = model.children[0].children.filter(child => child instanceof Points)
    expect(nextOverlays).toHaveLength(1)
    const next = nextOverlays[0]!
    expect(next.geometry).not.toBe(geometry)
    expect(next.geometry.attributes.position.array).toBe(replacement.positions)
    expect(next.material).toBe(meshVerticesMaterial)
    expect(next.visible).toBe(false)
    probe.viewport.renderMode = false
    probe.updateMeshOverlayVisibility()
    const nextSurface = model.children[0].children.find(child => child instanceof Mesh)!
    const nextTriangles = nextSurface.children[0] as LineSegments
    expect(nextSurface.matrixWorld).toEqual(chunk.matrixWorld)
    expect(nextTriangles.matrixWorld).toEqual(chunk.matrixWorld)
    expect(nextTriangles.visible).toBe(true)
    expect(nextTriangles.geometry).not.toBe(triangles.geometry)
    nextTriangles.geometry.addEventListener('dispose', () => { trianglesDisposed++ })
    next.geometry.addEventListener('dispose', () => { disposed++ })
    probe.removeChunk(id)
    expect(disposed).toBe(2)
    expect(trianglesDisposed).toBe(2)
    expect(model.children).toHaveLength(0)
    expect(probe.chunkMeshes.has(id)).toBe(false)
    expect(materialDisposed).toBe(0)
  } finally {
    probe.removeChunk(id)
    material.dispose()
    meshVerticesMaterial.dispose()
    faceGridMaterial.dispose()
  }
})

test('installed material-local meshes and vertex overlays do not multiply path-tracer vertices', () => {
  const document = new VoxelDocument()
  for (let index = 1; index <= 5; index++) document.setVoxel(index * 2, 0, 0, index)
  const data = meshChunk(document.paddedChunk(0), document.palette)
  const materials = document.materials.map(() => new MeshPhysicalMaterial())
  const meshVerticesMaterial = new PointsMaterial()
  const meshTrianglesMaterial = new LineBasicMaterial()
  const model = new Group()
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, materials, model, meshVerticesMaterial, meshTrianglesMaterial, settings: { faceGrid: false, meshVertices: true, meshTriangles: true }, versions: new Map([[0, 1]]),
    chunkMeshes: new Map(), chunkQuads: new Map(), queuedGrids: new Set(),
    viewport: { renderer: { shadowMap: { needsUpdate: false } }, renderMode: false, requestPathTraceRebuild() {}, render() {} }, pump() {},
  })
  probe.receiveMeshes({ type: 'meshed', results: [{ normal: data, id: 0, version: 1 }] })
  let vertices = 0
  model.traverse(object => {
    if (!(object instanceof Mesh)) return
    const count = object.geometry.attributes.position.count
    vertices += count
    expect(object.geometry.index!.array.every((index: number) => index < count)).toBe(true)
  })
  expect(vertices).toBe(120)
  const points = model.children[0].children.filter(child => child instanceof Points)
  expect(points).toHaveLength(1)
  expect(points[0]!.visible).toBe(true)
  expect(points[0]!.geometry.attributes.position.count).toBe(vertices)
  expect(points[0]!.material).toBe(meshVerticesMaterial)
  const generator = new PathTracingSceneGenerator(model)
  try {
    expect(generator.generate().geometry.attributes.position.count).toBe(vertices)
  } finally {
    Reflect.get(generator, 'dispose').call(generator)
    probe.removeChunk(0)
    materials.forEach(material => material.dispose())
    meshVerticesMaterial.dispose()
    meshTrianglesMaterial.dispose()
  }
})

test('a model borrows one viewport, removes input hooks and jobs on unmount, and restores its own view on remount', () => {
  const ownerDocument = Object.assign(new EventTarget(), { defaultView: new EventTarget(), hidden: false })
  const captures = new Set<number>()
  const canvas = Object.assign(new EventTarget(), { width: 320, height: 240, ownerDocument,
    setPointerCapture(id: number) { captures.add(id) }, hasPointerCapture: (id: number) => captures.has(id), releasePointerCapture(id: number) { captures.delete(id) } })
  let viewportDisposals = 0, hovers = 0, materialDisposals = 0, interacting = false
  const settings = { ...DEFAULT_SETTINGS, pathTracing: false }
  const view = { projection: 'orthographic' as const, position: { x: 4, y: 8, z: 12 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, orthographicSpan: 24, viewport: { width: 320, height: 240 } }
  const viewport = Object.assign(Object.create(Viewport.prototype), {
    renderer: { domElement: canvas, shadowMap: {} }, scene: new Scene(), settings, renderMode: false,
    environmentTarget: { texture: new Texture() }, frameLocalBounds() {},
    getView: () => structuredClone(view), setView(value: unknown) { Reflect.set(this, 'savedView', value) },
    setSceneContent(content: any) { Reflect.set(this, 'sceneContent', content); content?.onViewportChange() },
    setSettings(value: unknown) { Reflect.set(this, 'settings', value); Reflect.get(this, 'sceneContent')?.onViewportChange() },
    setRenderMode(value: boolean) { this.renderMode = value; Reflect.get(this, 'sceneContent')?.onViewportChange() },
    render() {}, requestPathTraceRebuild() {}, contentBecameReady() {},
    setRasterInteraction(source: string, active: boolean) { expect(source).toBe('model'); interacting = active },
    dispose() { viewportDisposals++ },
  })
  const callbacks: RendererCallbacks = {
    onSelectionChange() {}, onPaint() {}, onErase() {}, onFillCommit() {}, onPushPullCommit() {}, onPushPullPreview() {},
    onPick() {}, onLayerSelect() {}, onViewStart() {}, onViewChange() {}, onHover() { hovers++ },
    onMeshStats() {}, onPathTracingStatus() {}, onFps() {}, onError(message) { throw new Error(message) },
  }
  const model = new VoxelRenderer(viewport, new VoxelDocument(), settings, callbacks)
  const worker = Reflect.get(model, 'worker') as Worker
  const late = worker.onmessage!
  const materials = Reflect.get(model, 'materials') as MeshPhysicalMaterial[]
  const restoredEnvironment = new Texture()
  materials.forEach(material => material.addEventListener('dispose', () => { materialDisposals++ }))
  try {
    expect(model.viewport).toBe(viewport)
    expect(viewport.content.stage).toBe('bounded')
    const preview = { root: new Group(), prepare: mock((_frame: PreviewFrame) => {}) }
    Reflect.set(model, 'preview', preview)
    const frame: PreviewFrame = { renderer: viewport.renderer, camera: new OrthographicCamera(), light: new DirectionalLight(), settings, width: 320, height: 240 }
    viewport.content.prepareRaster!(frame)
    expect(preview.prepare.mock.calls[0][0].materials).toBe(materials)
    materials[1].roughness = 0.17
    viewport.content.prepareRaster!(frame)
    expect(preview.prepare.mock.calls[1][0].materials![1].roughness).toBe(0.17)
    const replacement = new MeshPhysicalMaterial({ map: restoredEnvironment, envMap: restoredEnvironment, envMapIntensity: 0.7 })
    replacement.envMapRotation.y = 0.4
    Reflect.set(model, 'materials', [replacement])
    viewport.content.prepareRaster!(frame)
    const forwarded = preview.prepare.mock.calls[2][0].materials![0]
    expect(forwarded).toBe(replacement)
    expect(forwarded.map).toBe(restoredEnvironment)
    expect(forwarded.envMap).toBe(restoredEnvironment)
    expect(forwarded.envMapIntensity).toBe(0.7)
    expect(forwarded.envMapRotation.y).toBe(0.4)
    Reflect.set(model, 'materials', materials)
    replacement.dispose()
    preview.root.visible = false
    viewport.content.prepareRaster!(frame)
    expect(preview.prepare).toHaveBeenCalledTimes(3)
    Reflect.set(model, 'preview', undefined)
    canvas.dispatchEvent(new Event('pointerleave'))
    expect(hovers).toBe(1)
    const startDrag = () => Reflect.get(model, 'startMarquee').call(model, { pointerId: 0, clientX: 0, clientY: 0 }, { cell: { x: 0, y: 0, z: 0 } }, false)
    startDrag(); expect(interacting).toBe(true)
    model.setActive(false)
    expect(interacting).toBe(false)
    model.setActive(true)
    startDrag(); expect(interacting).toBe(true)
    viewport.setRenderMode(true)
    expect(interacting).toBe(false)
    model.setActive(false)
    expect(interacting).toBe(false)
    expect(viewport.content).toBeUndefined()
    expect(Reflect.get(model, 'listeners').signal.aborted).toBe(true)
    canvas.dispatchEvent(new Event('pointerleave'))
    expect(hovers).toBe(1)
    late.call(worker, { data: { type: 'ready' } } as MessageEvent)
    expect(Reflect.get(model, 'workerReady')).toBe(false)
    expect(model.meshState().pending).toBe(0)
    viewport.environment.dispose()
    viewport.environmentTarget.texture = restoredEnvironment
    viewport.scene.environmentRotation.y = 0.7
    model.setActive(true)
    expect(Reflect.get(model, 'worker')).not.toBe(worker)
    expect(viewport.savedView).toEqual(view)
    expect(viewport.renderMode).toBe(true)
    for (const material of materials) {
      expect(material.envMap).toBe(restoredEnvironment)
      expect(material.envMapIntensity).toBe(realtimeEnvironmentIntensity(material.metalness))
      expect(material.envMapRotation.equals(viewport.scene.environmentRotation)).toBe(true)
    }
    canvas.dispatchEvent(new Event('pointerleave'))
    expect(hovers).toBe(2)
    model.dispose(); model.dispose()
    expect(materialDisposals).toBe(materials.length)
    expect(viewportDisposals).toBe(0)
    expect(viewport.content).toBeUndefined()
    canvas.dispatchEvent(new Event('pointerleave'))
    expect(hovers).toBe(2)
  } finally { model.dispose(); viewport.environment.dispose() }
})

function modelGestureProbe(fail = false) {
  const events = new Map<string, ((event: any) => void)[]>()
  const listen = (type: string, listener: (event: any) => void) => events.set(type, [...events.get(type) ?? [], listener])
  const ownerDocument = { defaultView: { addEventListener: listen }, hidden: false, addEventListener: listen }
  const canvas = { ownerDocument, addEventListener: listen, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }
  const document = new VoxelDocument({ x: 16, y: 16, z: 16 }), cell = { x: 2, y: 2, z: 2 }
  document.setVoxel(2, 2, 2, 1)
  const target = { cell, normal: { x: 0, y: 1, z: 0 }, occupied: true, color: 1 }
  const raster: boolean[] = []
  let commits = 0
  const commit = () => { commits++; if (fail) throw new Error('commit failed') }
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, modelSuspended: false, listeners: new AbortController(), touchPointers: new Set(),
    root: new Group(), hover: new Mesh(), marqueePreview: new Mesh(), selection: new Map(), keyboardCell: cell,
    tool: 'select', selectionMode: 'point', paintMode: 'paint', sculptMode: 'push', fillShape: 'box', fillDepth: 1, activeColor: 1,
    viewport: { camera: new PerspectiveCamera(), renderer: { domElement: canvas }, controls: { touches: {} }, render() {}, moveFocus() {},
      setRasterInteraction(source: string, active: boolean) { expect(source).toBe('model'); raster.push(active) } },
    callbacks: { onSelectionChange: commit, onPaint: commit, onErase: commit, onFillCommit: commit, onPushPullCommit: commit, onPushPullPreview() {}, onHover() {} },
    targetAt: () => target, refreshLayerScope() {},
  })
  probe.selection.set(probe.selectionKey(cell), cell)
  probe.bindPointerEvents()
  const pointer = { pointerId: 0, pointerType: 'mouse', button: 0, clientX: 50, clientY: 50, preventDefault() {} }
  return { probe, raster, ownerDocument, target, pointer, commits: () => commits,
    emit(type: string, patch = {}) { for (const listener of events.get(type) ?? []) listener({ ...pointer, ...patch }) },
    dispose() { probe.cancelPaint(); probe.cancelPushPull(); probe.cancelMarquee(); probe.clearSelectionPreview(); probe.hover.geometry.dispose(); probe.hover.material.dispose(); probe.marqueePreview.geometry.dispose(); probe.marqueePreview.material.dispose() },
  }
}

test('model selection, paint, fill, erase and push/move drags release raster DPR even when commits throw', () => {
  for (const fail of [false, true]) for (const tool of [
    { tool: 'select' }, { tool: 'paint' }, { tool: 'paint', selectionMode: 'surface' }, { tool: 'paint', paintMode: 'fill' },
    { tool: 'sculpt', sculptMode: 'erase' }, { tool: 'sculpt' }, { tool: 'sculpt', sculptMode: 'move' },
  ]) {
    const gesture = modelGestureProbe(fail), { probe, raster, emit } = gesture
    Object.assign(probe, tool)
    try {
      emit('pointerdown')
      expect(raster.at(-1)).toBe(true)
      if (probe.pushPullDrag) probe.pushPullDrag.distance = 1
      if (fail) expect(() => emit('pointerup')).toThrow('commit failed')
      else emit('pointerup')
      expect(gesture.commits()).toBe(1)
      expect(raster.at(-1)).toBe(false)
      expect(probe.paintPointer).toBeUndefined()
      expect(probe.marqueeDrag).toBeUndefined()
      expect(probe.pushPullDrag).toBeUndefined()
    } finally { gesture.dispose() }
  }
})

test('model raster activity follows overlapping state and cancels abandoned drags without lowering hover or sidebar edits', () => {
  const gesture = modelGestureProbe(), { probe, raster, emit, ownerDocument, target, pointer } = gesture
  try {
    emit('pointermove')
    probe.setFillDepth(2); probe.setFillShape('sphere'); probe.setActiveColor(2)
    emit('keydown', { key: ' ' })
    expect(raster).toEqual([])
    probe.paintPointer = 0
    probe.startMarquee(pointer, target, false)
    probe.startPushPull(pointer, target)
    probe.cancelPaint(); expect(raster.at(-1)).toBe(true)
    probe.cancelPushPull(); expect(raster.at(-1)).toBe(true)
    probe.cancelMarquee(); expect(raster.at(-1)).toBe(false)
    for (const event of ['pointercancel', 'lostpointercapture', 'blur', 'visibilitychange', 'webglcontextlost']) {
      emit('pointerdown', { pointerType: 'touch' })
      expect(raster.at(-1)).toBe(true)
      emit('lostpointercapture', { pointerId: 99 })
      ownerDocument.hidden = false; emit('visibilitychange')
      expect(raster.at(-1)).toBe(true)
      ownerDocument.hidden = true; emit(event)
      expect(raster.at(-1)).toBe(false)
      expect(probe.marqueeDrag).toBeUndefined()
      expect(probe.touchPointers.size).toBe(0)
      const calls = raster.length
      emit(event)
      if (event !== 'pointercancel') expect(raster).toHaveLength(calls)
    }
    emit('pointerdown', { pointerType: 'touch' })
    emit('pointerdown', { pointerType: 'touch', pointerId: 1 })
    expect(raster.at(-1)).toBe(false)
    probe.touchPointers.clear()
    emit('pointerdown'); probe.setTool('paint')
    expect(raster.at(-1)).toBe(false)
    expect(probe.marqueeDrag).toBeUndefined()
  } finally { gesture.dispose() }
})

test('model material creation, property refreshes and viewport sync bind the current sky without remeshing', async () => {
  const document = new VoxelDocument(); document.setVoxel(0, 0, 0, 1)
  const settings = { ...DEFAULT_SETTINGS, skybox: 'daylight' as const, ambient: 1.8 }
  const environments = [new Texture()]
  const viewport = Object.assign(Object.create(Viewport.prototype), {
    settings, scene: new Scene(), environmentTarget: { texture: environments[0] }, renderMode: false,
    renderer: { capabilities: { getMaxAnisotropy: () => 1 } }, render() {}, updatePathTracing() {},
  })
  viewport.scene.environmentRotation.set(0, 0.4, 0)
  const faceGridMaterial = new LineBasicMaterial(), meshVerticesMaterial = new PointsMaterial()
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, viewport, settings, modelRenderMode: false, modelSuspended: false, tool: 'select',
    faceGridMaterial, meshVerticesMaterial, meshTrianglesMaterial: faceGridMaterial,
    chunkMeshes: new Map(), textureLoads: new Map(), hover: new Group(), model: new Group(),
    cancelPaint() {}, cancelPushPull() {}, cancelMarquee() {},
    markDirty() { throw new Error('Environment and non-topology material changes must not remesh') },
  })
  const texture = new Texture<HTMLImageElement>()
  const updatePalette = mock(() => {})
  probe.preview = { root: new Group(), updatePalette, setLayerScope() {} }
  probe.preview.root.visible = false
  probe.materials = probe.createMaterials()
  const materials = probe.materials as MeshPhysicalMaterial[], material = materials[1]
  const surface = probe.createSurface(meshChunk(document.paddedChunk(0))) as Group
  probe.chunkMeshes.set(0, surface)
  const mesh = surface.children.find(child => child instanceof Mesh)!, geometry = mesh.geometry
  const expectBound = () => {
    for (const material of materials) {
      expect(material.envMap).toBe(viewport.environment)
      expect(material.envMapIntensity).toBe(viewport.settings.skybox === 'solid' ? realtimeEnvironmentIntensity(material.metalness) : viewport.settings.ambient / Math.PI)
      expect(material.envMapRotation.equals(viewport.scene.environmentRotation)).toBe(true)
    }
    expect(probe.chunkMeshes.get(0)).toBe(surface)
    expect(mesh.geometry).toBe(geometry)
  }
  const load = spyOn(TextureLoader.prototype, 'loadAsync').mockResolvedValue(texture)
  try {
    expectBound()
    for (const skybox of ['solid', 'daylight', 'overcast', 'sunset', 'night', 'solid'] as const) {
      viewport.settings = { ...viewport.settings, skybox }
      environments.push(new Texture())
      viewport.environmentTarget.texture = environments.at(-1)
      const version = material.version
      probe.syncViewport(); expectBound()
      expect(material.version).toBeGreaterThan(version)
      const syncedVersion = material.version
      probe.syncViewport()
      expect(material.version).toBe(syncedVersion)
      document.materials[1].metalness = material.metalness === 0.8 ? 0.2 : 0.8
      probe.updatePaletteMaterial(1); expectBound()
      expect(updatePalette).toHaveBeenCalledTimes(environments.length - 1)
    }
    viewport.settings = { ...viewport.settings, skybox: 'night' }
    probe.syncViewport()
    const version = material.version
    viewport.settings = { ...viewport.settings, ambient: 0.3 }
    probe.syncViewport(); expectBound()
    expect(material.version).toBeGreaterThan(version)
    const ambientVersion = material.version
    viewport.scene.environmentRotation.y += 0.5
    probe.syncViewport(); expectBound()
    expect(material.version).toBeGreaterThan(ambientVersion)

    material.envMap = null
    probe.updatePalette(); expectBound()
    expect(updatePalette).toHaveBeenCalledTimes(7)
    material.envMap = null
    await probe.setPbrMap(1, 'metalnessMap', new Blob()); expectBound()
    expect(material.metalnessMap).toBe(texture)
    expect(updatePalette).toHaveBeenCalledTimes(8)
    material.envMap = null
    probe.clearPbrMaps(1); expectBound()
    expect(material.metalnessMap).toBeNull()
    expect(updatePalette).toHaveBeenCalledTimes(9)
  } finally {
    load.mockRestore(); probe.disposeMaterials()
    surface.traverse(child => { if (child instanceof Mesh || child instanceof Points) child.geometry.dispose() })
    faceGridMaterial.dispose(); meshVerticesMaterial.dispose(); texture.dispose()
    environments.forEach(environment => environment.dispose())
  }
})

test('late texture loads cannot attach to a replaced material or overwrite a newer map request', async () => {
  const material = new MeshPhysicalMaterial(), first = new Texture<HTMLImageElement>(), second = new Texture<HTMLImageElement>()
  let disposed = 0
  first.addEventListener('dispose', () => { disposed++ })
  const completions: ((texture: Texture<HTMLImageElement>) => void)[] = []
  const load = spyOn(TextureLoader.prototype, 'loadAsync').mockImplementation(() => new Promise(resolve => completions.push(resolve)))
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    materials: [material], textureLoads: new Map(), modelSuspended: true,
    viewport: { renderer: { capabilities: { getMaxAnisotropy: () => 1 } }, render() {}, applyEnvironment() {},
      updatePathTracing() { throw new Error('Inactive material edits must not reset scene tracing') } },
  })
  try {
    const old = probe.setPbrMap(0, 'map', new Blob())
    const current = probe.setPbrMap(0, 'map', new Blob())
    completions[1](second); await current
    completions[0](first)
    await expect(old).rejects.toMatchObject({ name: 'AbortError' })
    expect(disposed).toBe(1)
    expect(material.map).toBe(second)
    const late = probe.setPbrMap(0, 'normalMap', new Blob())
    probe.disposeMaterials()
    const texture = new Texture<HTMLImageElement>()
    texture.addEventListener('dispose', () => { disposed++ })
    completions[2](texture)
    await expect(late).rejects.toMatchObject({ name: 'AbortError' })
    expect(disposed).toBe(2)
    expect(material.normalMap).toBeNull()
  } finally { load.mockRestore(); first.dispose(); second.dispose(); material.dispose() }
})
