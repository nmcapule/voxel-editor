import { expect, test } from 'bun:test'
import { Color, Group, Mesh, MeshPhysicalMaterial, OrthographicCamera, PerspectiveCamera, Raycaster, Vector2 } from 'three'
import { PathTracingSceneGenerator } from 'three-gpu-pathtracer'
import { VoxelDocument } from './editor'
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

test('installed material-local meshes do not multiply path-tracer vertices', () => {
  const document = new VoxelDocument()
  for (let index = 1; index <= 5; index++) document.setVoxel(index * 2, 0, 0, index)
  const data = meshChunk(document.paddedChunk(0), document.palette)
  const materials = document.materials.map(() => new MeshPhysicalMaterial())
  const model = new Group()
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document, materials, model, settings: { faceGrid: false }, versions: new Map([[0, 1]]),
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
  const generator = new PathTracingSceneGenerator(model)
  try {
    expect(generator.generate().geometry.attributes.position.count).toBe(vertices)
  } finally {
    Reflect.get(generator, 'dispose').call(generator)
    probe.removeChunk(0)
    materials.forEach(material => material.dispose())
  }
})
