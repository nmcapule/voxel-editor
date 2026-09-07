import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { Viewport } from './viewport'

test('viewport teardown cancels owned work, detaches borrowed content and disposes each GPU resource once', async () => {
  const cancel = globalThis.cancelAnimationFrame, cancelled: number[] = []
  globalThis.cancelAnimationFrame = id => { cancelled.push(id) }
  const scene = new THREE.Scene(), root = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial())
  root.add(mesh); scene.add(root)
  const grid = new THREE.Group(), lines = new THREE.LineSegments(new THREE.BoxGeometry(), new THREE.LineBasicMaterial())
  grid.add(lines); scene.add(grid)
  const light = new THREE.DirectionalLight()
  const resources = { raster: 0, renderer: 0, controls: 0, environment: 0, ambient: 0, observer: 0, canvas: 0, worker: 0, tracer: 0, grid: 0, gridMaterial: 0, borrowed: 0, detail: 0 }
  lines.geometry.addEventListener('dispose', () => { resources.grid++ })
  ;(lines.material as THREE.Material).addEventListener('dispose', () => { resources.gridMaterial++ })
  mesh.geometry.addEventListener('dispose', () => { resources.borrowed++ })
  const listeners = new AbortController()
  let finish!: (detail: object) => void
  const probe = Object.assign(Object.create(Viewport.prototype), {
    scene, grid, sunlight: light, listeners, fullEpoch: 0, pathTracingRevision: 0,
    sceneContent: { root, prepareFullDetail: () => new Promise(resolve => { finish = resolve }) },
    focusAnimation: 11, rasterFrame: 12, pathTracingFrame: 13,
    callbacks: {}, resizeObserver: { disconnect() { resources.observer++ } },
    renderer: { dispose() { resources.renderer++ }, domElement: { width: 100, height: 100, remove() { resources.canvas++ } } },
    raster: { dispose() { resources.raster++ } }, controls: { dispose() { resources.controls++ } },
    environmentTarget: { dispose() { resources.environment++ } }, ambientEnvironment: { dispose() { resources.ambient++ } },
    pathTracingWorker: { dispose() { resources.worker++ } }, pathTracer: { dispose() { resources.tracer++ } },
  })
  try {
    const preparing = probe.prepareSceneContent()
    probe.dispose(); probe.dispose()
    expect(listeners.signal.aborted).toBe(true)
    expect(probe.fullAbort).toBeUndefined()
    expect(root.parent).toBeNull()
    expect(root.children).toEqual([mesh])
    expect(cancelled.sort()).toEqual([11, 12, 13])
    finish({ dispose() { resources.detail++ } })
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
    expect(resources).toEqual({ raster: 1, renderer: 1, controls: 1, environment: 1, ambient: 1, observer: 1, canvas: 1, worker: 1, tracer: 1, grid: 1, gridMaterial: 1, borrowed: 0, detail: 1 })
    expect(probe.pathTracer).toBeUndefined()
    expect(probe.content).toBeUndefined()
    await expect(probe.capture()).rejects.toThrow('disposed')
    expect(() => probe.setSceneContent({ root })).toThrow('disposed')
    probe.render(); probe.resize()
  } finally {
    globalThis.cancelAnimationFrame = cancel
    mesh.geometry.dispose(); mesh.material.dispose()
  }
})

test('bounded stage fitting preserves local cameras, light position and guide geometry without a model', () => {
  const settings = { grid: true, background: '#dfe7ec', lightAzimuth: 42 }
  const root = new THREE.Group(), bounds = new THREE.Box3(new THREE.Vector3(-32, 0, -16), new THREE.Vector3(32, 48, 16))
  const probe = Object.assign(Object.create(Viewport.prototype), {
    scene: new THREE.Scene(), sceneContent: { root, bounds, stage: 'bounded' }, settings,
    environmentTarget: { texture: new THREE.Texture() }, sunlightTarget: new THREE.Object3D(),
    camera: new THREE.OrthographicCamera(), controls: { target: new THREE.Vector3() },
    setSettings() {},
    setView(view: unknown) { Reflect.set(this, 'view', view) },
  })
  probe.rebuildStage()
  try {
    expect(probe.grid.children).toHaveLength(5)
    expect(probe.limits.box.equals(bounds)).toBe(true)
    expect(probe.ground.geometry.parameters).toMatchObject({ width: 128, height: 128 })
    expect(probe.ground.position.toArray()).toEqual([0, -0.03, 0])
    expect(probe.sunlightTarget.position.toArray()).toEqual([0, 16, 0])
    expect(probe.createCamera('perspective')).toMatchObject({ near: 0.1, far: 2000, fov: 34 })
    expect(probe.createCamera('orthographic')).toMatchObject({ near: -1000, far: 2000 })
    probe.frameLocalBounds(new THREE.Vector3(1, 2, 3), 8)
    expect(probe.view.orthographicSpan).toBe(13.2)
    expect(probe.view.position.distanceTo(probe.view.target)).toBeCloseTo(20.8)
    probe.sceneContent.stage = 'world'
    expect(probe.createCamera('perspective')).toMatchObject({ near: 0.5, far: 131072, fov: 34 })
    expect(probe.createCamera('orthographic')).toMatchObject({ near: -65536, far: 131072 })
  } finally {
    probe.scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose(); (object.material as THREE.Material).dispose()
      }
    })
    probe.environmentTarget.texture.dispose()
  }
})
