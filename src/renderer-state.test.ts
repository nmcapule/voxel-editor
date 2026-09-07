import { expect, test } from 'bun:test'
import { Color, Group, LineBasicMaterial, LineSegments, Mesh, MeshPhysicalMaterial, OrthographicCamera, PerspectiveCamera, Points, PointsMaterial, Raycaster, Vector2, Vector3 } from 'three'
import { PathTracingSceneGenerator } from 'three-gpu-pathtracer'
import { VoxelDocument, chunkId } from './editor'
import { VoxelRenderer, traceGridRay } from './renderer'
import { meshChunk } from './mesher'

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
    document, camera, pointer: new Vector2(), raycaster: new Raycaster(),
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
  })
  expect(probe.targetAt({ clientX: 50, clientY: 50 })).toMatchObject({ cell: { x: 16, y: 8, z: 30 }, normal: { x: 0, y: 0, z: 1 } })
})

test('deletion-only mesh queues resume the requested trace build', () => {
  let builds = 0
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document: new VoxelDocument(), queued: new Set(), queuedGrids: new Set(), versions: new Map(),
    chunkMeshes: new Map(), chunkQuads: new Map(), meshWaiters: [], inFlight: 0, workerReady: true,
    nextVersion: 0, pathTracingRevision: 0, renderMode: true, settings: { pathTracing: true },
    pathTracingReady: true, pathTracingBuildRequested: false, pathTracingFailed: false,
    render() {}, stopPathTracingSamples() {}, buildPathTrace() { builds++ },
    callbacks: { onMeshStats() {}, onPathTracingStatus() {} },
    worker: { postMessage() { throw new Error('Deleted chunks must not enter the worker') } },
  })
  probe.markDirty([0])
  expect(probe.meshState()).toMatchObject({ pending: 0 })
  expect(builds).toBe(1)
})

test('captures flush current camera/material pixels without waiting for RAF', async () => {
  const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  let state = 'old', pixels = 'old'
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    camera: new PerspectiveCamera(), settings: { pathTracing: true }, renderMode: true,
    pathTracingReady: true, pathTracingBuildRunning: false, pathTracingFailed: false,
    queued: new Set(), queuedGrids: new Set(), inFlight: 0, presentationDirty: false,
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

test('ambient environment follows the path tracer +Y => V=1 convention', () => {
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
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
    settings: { faceGrid: false, meshVertices: false, meshTriangles: false }, renderMode: false, versions: new Map([[id, 1]]),
    chunkMeshes: new Map(), chunkQuads: new Map(), queuedGrids: new Set(),
    renderer: { shadowMap: { needsUpdate: false } }, pump() {}, requestPathTraceRebuild() {}, render() {},
  })
  let disposed = 0, materialDisposed = 0
  meshVerticesMaterial.addEventListener('dispose', () => { materialDisposed++ })
  try {
    probe.receiveMeshes({ type: 'meshed', results: [{ ...data, id, version: 1 }] })
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
      probe.renderMode = renderMode
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
    probe.receiveMeshes({ type: 'meshed', results: [{ ...replacement, id, version: 2 }] })
    expect(disposed).toBe(1)
    expect(trianglesDisposed).toBe(1)
    expect(chunk.parent).toBeNull()
    expect(model.children).toHaveLength(1)
    const nextOverlays = model.children[0].children.filter(child => child instanceof Points)
    expect(nextOverlays).toHaveLength(1)
    const next = nextOverlays[0]!
    expect(next.geometry).not.toBe(geometry)
    expect(next.geometry.attributes.position.array).toBe(replacement.positions)
    expect(next.material).toBe(meshVerticesMaterial)
    expect(next.visible).toBe(false)
    probe.renderMode = false
    probe.updateMeshOverlayVisibility()
    const nextSurface = model.children[0].children.find(child => child instanceof Mesh)!
    const nextTriangles = nextSurface.children[0] as LineSegments
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
    document, materials, model, meshVerticesMaterial, meshTrianglesMaterial, settings: { faceGrid: false, meshVertices: true, meshTriangles: true }, renderMode: false, versions: new Map([[0, 1]]),
    chunkMeshes: new Map(), chunkQuads: new Map(), queuedGrids: new Set(),
    renderer: { shadowMap: { needsUpdate: false } }, pump() {}, requestPathTraceRebuild() {}, render() {},
  })
  probe.receiveMeshes({ type: 'meshed', results: [{ ...data, id: 0, version: 1 }] })
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
