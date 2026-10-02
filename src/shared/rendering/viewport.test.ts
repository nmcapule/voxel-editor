import { expect, mock, spyOn, test } from 'bun:test'
import * as THREE from 'three'
import { Viewport } from './viewport'
import { DEFAULT_SETTINGS, type ViewSettings } from './settings'
import { TiltShift } from './tilt-shift'
import { FogVolumeMaterial } from 'three-gpu-pathtracer/src/index.js'
import { volumetricRegion } from './volumetric-lighting'
import { createSkyTexture, skyColor, SKY_LIGHTING } from './sky'

test('canceling a focus tween preserves the current camera and orbit target, including reduced motion', () => {
  const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame, media = globalThis.matchMedia
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0, reduced = false
  globalThis.requestAnimationFrame = callback => { frames.set(++next, callback); return next }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  globalThis.matchMedia = (() => ({ matches: reduced })) as unknown as typeof matchMedia
  const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(1, 2, 3)
  camera.position.set(20, 30, 40)
  const activity = mock(), start = mock(), update = mock()
  const probe = Object.assign(Object.create(Viewport.prototype), {
    camera, controls: { target, update }, callbacks: { onViewStart: start }, setRasterInteraction: activity, render() {},
  })
  try {
    probe.moveFocus(new THREE.Vector3(10, 10, 10))
    const [id, frame] = frames.entries().next().value!
    frames.delete(id); frame(performance.now() + 80)
    expect(frames.size).toBe(1)
    const position = camera.position.clone(), pivot = target.clone(), updates = update.mock.calls.length
    probe.cancelFocusAnimation()
    expect(frames.size).toBe(0)
    expect(probe.focusAnimation).toBeUndefined()
    expect(camera.position).toEqual(position)
    expect(target).toEqual(pivot)
    expect(update).toHaveBeenCalledTimes(updates)
    expect(activity).toHaveBeenLastCalledWith('focus', false)
    expect(start).toHaveBeenCalledTimes(1)
    probe.moveFocus(pivot.clone())
    expect(frames.size).toBe(0)
    reduced = true
    const offset = camera.position.clone().sub(target)
    probe.moveFocus(new THREE.Vector3(-4, 5, 6))
    expect(target.toArray()).toEqual([-4, 5, 6])
    expect(camera.position.clone().sub(target).distanceTo(offset)).toBeLessThan(1e-10)
    expect(frames.size).toBe(0)
    const immediate = camera.position.clone()
    probe.cancelFocusAnimation()
    expect(camera.position).toEqual(immediate)
  } finally {
    globalThis.requestAnimationFrame = request; globalThis.cancelAnimationFrame = cancel; globalThis.matchMedia = media
  }
})

test('content handoff resets only primary controls mappings, preserving right orbit, middle pan and two-finger navigation', () => {
  const controls = { enabled: false, mouseButtons: { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE },
    touches: { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE } }
  const probe = Object.assign(Object.create(Viewport.prototype), {
    controls, camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
    renderer: { domElement: { setAttribute() {} }, shadowMap: {} },
    clearRasterInteractions() {}, disposePathTracer() {}, releaseSceneDetail() {}, cancelFocusAnimation() {}, rebuildStage() {}, requestPathTraceRebuild() {},
  })
  for (const stage of ['bounded', 'world', undefined]) {
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN
    controls.touches.ONE = THREE.TOUCH.PAN
    probe.setSceneContent(stage ? { root: new THREE.Group(), stage } : undefined)
    expect(controls.mouseButtons).toEqual({ LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE })
    expect(controls.touches).toEqual({ ONE: -1 as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_ROTATE })
    expect(controls.enabled).toBe(true)
  }
})

test('projection switches resolve the retained or selected pivot before replacing controls', () => {
  const pivot = new THREE.Vector3(7, 8, 9), selected = new THREE.Vector3(2, 3, 4)
  const controls = () => ({ target: new THREE.Vector3(), dispose: mock(), update() {} })
  const probe = Object.assign(Object.create(Viewport.prototype), {
    camera: new THREE.PerspectiveCamera(), controls: controls(), cancelFocusAnimation() {}, setRasterInteraction() {}, resize() {}, createControls: controls,
  })
  for (const hasSelection of [false, true]) {
    probe.camera.position.set(30, 40, 50)
    probe.controls.target.copy(pivot)
    const previous = probe.controls
    probe.sceneContent = { stage: 'bounded', focusTarget: () => hasSelection ? selected.clone() : probe.controls.target.clone() }
    probe.switchProjection(hasSelection ? 'perspective' : 'orthographic')
    expect(previous.dispose).toHaveBeenCalledTimes(1)
    expect(probe.controls).not.toBe(previous)
    expect(probe.controls.target).toEqual(hasSelection ? selected : pivot)
    expect(probe.camera.position.toArray()).toEqual([30, 40, 50])
  }
})

test('viewport teardown cancels owned work, detaches borrowed content and disposes each GPU resource once', async () => {
  const cancel = globalThis.cancelAnimationFrame, cancelled: number[] = []
  globalThis.cancelAnimationFrame = id => { cancelled.push(id) }
  const scene = new THREE.Scene(), root = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial())
  root.add(mesh); scene.add(root)
  const grid = new THREE.Group(), lines = new THREE.LineSegments(new THREE.BoxGeometry(), new THREE.LineBasicMaterial())
  grid.add(lines); scene.add(grid)
  const light = new THREE.DirectionalLight()
  const resources = { raster: 0, tiltShift: 0, renderer: 0, controls: 0, environment: 0, ambient: 0, sky: 0, observer: 0, canvas: 0, worker: 0, tracer: 0, grid: 0, gridMaterial: 0, borrowed: 0, detail: 0 }
  lines.geometry.addEventListener('dispose', () => { resources.grid++ })
  ;(lines.material as THREE.Material).addEventListener('dispose', () => { resources.gridMaterial++ })
  mesh.geometry.addEventListener('dispose', () => { resources.borrowed++ })
  const listeners = new AbortController()
  let finish!: (detail: object) => void
  const probe = Object.assign(Object.create(Viewport.prototype), {
    scene, grid, sunlight: light, listeners, fullEpoch: 0, pathTracingRevision: 0,
    rasterInteractions: new Set(['controls']), captures: 0,
    rasterRestoreTimer: setTimeout(() => { throw new Error('Disposed restore timer fired') }, 1000),
    sceneContent: { root, prepareFullDetail: () => new Promise(resolve => { finish = resolve }) },
    focusAnimation: 11, rasterFrame: 12, pathTracingFrame: 13,
    callbacks: {}, resizeObserver: { disconnect() { resources.observer++ } },
    renderer: { dispose() { resources.renderer++ }, domElement: { width: 100, height: 100, remove() { resources.canvas++ } } },
    raster: { dispose() { resources.raster++ } }, controls: { dispose() { resources.controls++ } },
    tiltShift: { dispose() { resources.tiltShift++ } },
    environmentTarget: { dispose() { resources.environment++ } }, ambientEnvironment: { dispose() { resources.ambient++ } },
    skyTexture: { dispose() { resources.sky++ } },
    pathTracingWorker: { dispose() { resources.worker++ } }, pathTracer: { dispose() { resources.tracer++ } }, traceSky: { value: true },
  })
  try {
    const preparing = probe.prepareSceneContent()
    probe.dispose(); probe.dispose()
    expect(listeners.signal.aborted).toBe(true)
    expect(probe.rasterInteractions.size).toBe(0)
    expect(probe.rasterRestoreTimer).toBeUndefined()
    expect(probe.fullAbort).toBeUndefined()
    expect(root.parent).toBeNull()
    expect(root.children).toEqual([mesh])
    expect(cancelled.sort()).toEqual([11, 12, 13])
    finish({ dispose() { resources.detail++ } })
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
    expect(resources).toEqual({ raster: 1, tiltShift: 1, renderer: 1, controls: 1, environment: 1, ambient: 1, sky: 1, observer: 1, canvas: 1, worker: 1, tracer: 1, grid: 1, gridMaterial: 1, borrowed: 0, detail: 1 })
    expect(probe.pathTracer).toBeUndefined()
    expect(probe.traceSky).toBeUndefined()
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
  const settings = { ...DEFAULT_SETTINGS, grid: true, background: '#dfe7ec', lightAzimuth: 42 }
  const root = new THREE.Group(), bounds = new THREE.Box3(new THREE.Vector3(-32, 0, -16), new THREE.Vector3(32, 48, 16))
  const probe = Object.assign(Object.create(Viewport.prototype), {
    scene: new THREE.Scene(), sceneContent: { root, bounds, stage: 'bounded' }, settings, host: { clientWidth: 1280, clientHeight: 800 },
    environmentTarget: { texture: new THREE.Texture() }, sunlightTarget: new THREE.Object3D(),
    camera: new THREE.OrthographicCamera(), controls: { target: new THREE.Vector3() },
    setSettings() {},
    setView(view: unknown) { Reflect.set(this, 'view', view) },
  })
  probe.rebuildStage()
  try {
    expect(probe.grid.children).toHaveLength(5)
    expect(probe.grid.children[0].userData.normal).toEqual({ x: 0, y: 1, z: 0 })
    expect(probe.limits.visible).toBe(false)
    expect(probe.limits.box.equals(bounds)).toBe(true)
    expect(probe.scene.children.some((object: THREE.Object3D) => object instanceof THREE.Mesh)).toBe(false)
    expect(probe.sunlightTarget.position.toArray()).toEqual([0, 16, 0])
    expect(probe.createCamera('perspective')).toMatchObject({ near: 0.1, far: 2000, fov: 34 })
    expect(probe.createCamera('orthographic')).toMatchObject({ near: -1000, far: 2000 })
    probe.frameLocalBounds(new THREE.Vector3(1, 2, 3), 8)
    expect(probe.view.orthographicSpan).toBe(13.2)
    expect(probe.view.position.distanceTo(probe.view.target)).toBeCloseTo(20.8)
    probe.host.clientWidth = 320
    probe.frameLocalBounds(new THREE.Vector3(1, 2, 3), 8)
    expect(probe.view.orthographicSpan).toBeCloseTo(33)
    expect(probe.view.up).toEqual({ x: 0, y: 1, z: 0 })
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

function photoProbe() {
  const calls: string[] = []
  const pathTracer = {
    samples: 128, pausePathTracing: false,
    reset: mock(function (this: { samples: number }) { this.samples = 0 }),
    setCamera: mock(), updateMaterials: mock(), updateLights: mock(), updateEnvironment: mock(),
    setSceneAsync: mock(async (_scene: THREE.Scene, _camera: THREE.Camera, _options: unknown) => {}), dispose: mock(),
    renderSample: mock(function (this: { samples: number; pausePathTracing: boolean }) {
      calls.push(this.pausePathTracing ? 'present trace' : 'sample trace')
      if (!this.pausePathTracing) this.samples++
    }),
  }
  const probe = Object.assign(Object.create(Viewport.prototype), {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    sceneContent: { root: new THREE.Group(), stage: 'bounded', bounds: new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)), onViewportChange() {}, whenReady: async () => {} },
    settings: { ...DEFAULT_SETTINGS, tiltShift: true }, renderMode: true,
    captures: 0, autoSimplifyRendering: false, editGeneration: 0, rasterInteractions: new Set(),
    sceneInteraction: false, traceHidden: false, syncRasterResolution() { return false },
    pathTracingBuildRunning: false, pathTracingBuildRequested: false, pathTracingFailed: false,
    pathTracingReady: true, presentationDirty: false, tiltShiftDirty: false, fullEpoch: 0, pathTracingRevision: 0,
    hemisphere: new THREE.HemisphereLight(), sunlight: Object.assign(new THREE.DirectionalLight(), { castShadow: true }), sunlightTarget: new THREE.Object3D(),
    callbacks: {}, resetFps() {}, recordFrame() {},
    renderer: { shadowMap: { enabled: true, needsUpdate: false }, getContext: () => ({ isContextLost: () => false }),
      domElement: { width: 160, height: 80, setAttribute() {}, toBlob(callback: (blob: Blob) => void) { calls.push('encode'); callback(new Blob(['png'])) } } },
    raster: { pbrMaterials: true, ambientOcclusion: { enabled: true }, readBuffer: { width: 160, height: 80 }, render() { calls.push('raster') } },
    tiltShift: { render: mock((_renderer: unknown, settings: ViewSettings) => { calls.push(`effect ${settings.tiltShiftFocus}`) }) },
    pathTracer, getView: () => ({ name: 'stable' }),
  })
  return { probe, calls, pathTracer }
}

test('key-light indicator refreshes even when progressive rendering is already converged', () => {
  const { probe, pathTracer } = photoProbe()
  probe.keyLightIndicator = { update: mock() }
  probe.settings.skybox = 'night'
  probe.settings.showSun = true
  probe.render()
  expect(probe.keyLightIndicator.update).toHaveBeenCalledWith(probe.camera, probe.sunlight, 'night', true)
  expect(pathTracer.reset).not.toHaveBeenCalled()
  expect(pathTracer.renderSample).not.toHaveBeenCalled()
})

test('volumetrics rebuild tracing, preserve preview shadows, and stay out of inspection', () => {
  const { probe } = photoProbe()
  probe.render = mock()
  probe.updatePathTracing = mock()
  probe.requestPathTraceRebuild = mock()
  probe.setSettings({ ...probe.settings, volumetricLighting: true })
  expect(probe.requestPathTraceRebuild).toHaveBeenCalledTimes(1)
  expect(probe.renderer.shadowMap.needsUpdate).toBe(true)
  probe.setSettings({ ...probe.settings })
  expect(probe.requestPathTraceRebuild).toHaveBeenCalledTimes(1)
  probe.raster.render = () => expect(probe.renderer.shadowMap.enabled).toBe(true)
  probe.renderRaster(undefined, undefined, false)
  expect(probe.raster.volumetricLighting).toMatchObject(volumetricRegion(probe.sceneContent.bounds))
  const inspection = { pbrMaterials: true, ambientOcclusion: { enabled: false }, render() {} }
  probe.renderRaster(probe.camera, inspection, true)
  expect(Reflect.get(inspection, 'volumetricLighting')).toBeUndefined()
  probe.setSettings({ ...probe.settings, shadows: false })
  probe.raster.render = () => expect(probe.renderer.shadowMap.enabled).toBe(false)
  probe.renderRaster()
  expect(probe.raster.volumetricLighting).toBeDefined()
  probe.autoSimplifyRendering = true
  probe.rasterInteractions.add('controls')
  probe.renderRaster(undefined, undefined, undefined, true)
  expect(probe.raster.volumetricLighting).toBeUndefined()
  probe.captures = 1
  probe.renderRaster(undefined, undefined, undefined, true)
  expect(probe.raster.volumetricLighting).toBeDefined()
  probe.captures = 0
  probe.autoSimplifyRendering = false
  probe.setSettings({ ...probe.settings, volumetricLighting: false })
  probe.renderRaster()
  expect(probe.raster.volumetricLighting).toBeUndefined()
  expect(probe.requestPathTraceRebuild).toHaveBeenCalledTimes(2)
})

test('tracer atmosphere detaches before worker completion and releases only owned resources', async () => {
  const { probe, pathTracer } = photoProbe()
  probe.settings.volumetricLighting = true
  probe.pathTracingReady = false
  probe.pathTracingBuildRequested = true
  const fog = new THREE.Mesh(new THREE.BoxGeometry(), new FogVolumeMaterial())
  probe.traceFog = fog
  probe.ensurePathTracer = async () => pathTracer
  probe.startPathTracingSamples = mock()
  const geometryDispose = spyOn(fog.geometry, 'dispose'), materialDispose = spyOn(fog.material, 'dispose')
  const pending = Promise.withResolvers<void>()
  pathTracer.setSceneAsync.mockImplementation(scene => {
    expect(scene.children).toContain(fog)
    expect(Reflect.get(pathTracer, 'transmissiveBounces')).toBe(18)
    expect(fog.material.density).toBe(volumetricRegion(probe.sceneContent.bounds).density)
    return pending.promise
  })
  const building = probe.buildPathTrace()
  await Promise.resolve()
  expect(pathTracer.setSceneAsync).toHaveBeenCalledTimes(1)
  expect(fog.parent).toBeNull()
  expect(probe.pathTracingReady).toBe(false)
  pending.resolve()
  await building
  expect(probe.pathTracingReady).toBe(true)
  expect(probe.startPathTracingSamples).toHaveBeenCalledTimes(1)
  probe.settings.volumetricLighting = false
  probe.pathTracingBuildRequested = true
  pathTracer.setSceneAsync.mockImplementation(async scene => {
    expect(scene.children).not.toContain(fog)
    expect(Reflect.get(pathTracer, 'transmissiveBounces')).toBe(10)
  })
  await probe.buildPathTrace()
  probe.disposePathTracer()
  probe.disposePathTracer()
  expect(geometryDispose).toHaveBeenCalledTimes(1)
  expect(materialDispose).toHaveBeenCalledTimes(1)
  expect(probe.traceFog).toBeUndefined()
})

test('visible air retains offscreen shadow casters even without visible surface receivers', () => {
  const { probe } = photoProbe()
  probe.sceneContent.stage = 'world'
  probe.sceneContent.bounds = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10))
  probe.camera = new THREE.OrthographicCamera(-4, 4, 4, -4, -100, 100)
  probe.camera.position.set(0, 8, 30); probe.camera.lookAt(0, 8, 0)
  probe.render = mock()
  probe.invalidateSceneContent = mock()
  probe.setSettings({ ...probe.settings, volumetricLighting: false })
  expect(probe.getSceneShadowVolume([], probe.sceneContent.bounds)).toBeUndefined()
  probe.setSettings({ ...probe.settings, volumetricLighting: true })
  expect(probe.getSceneShadowVolume([], probe.sceneContent.bounds)).toBeInstanceOf(THREE.Frustum)
})

test('opaque culling is passed only to live primary frames outside captures and progressive previews', () => {
  const { probe } = photoProbe(), cullOpaque = mock(() => new Set<THREE.Mesh>())
  const render = mock(), secondary = { ambientOcclusion: { enabled: true }, render: mock() }
  probe.sceneContent.cullOpaque = cullOpaque
  probe.raster.render = render
  probe.settings.pathTracing = false
  const draw = (live = true) => probe.renderRaster(undefined, undefined, undefined, live)
  draw(false)
  expect(render).toHaveBeenLastCalledWith(probe.camera, undefined, undefined)
  draw()
  expect(render).toHaveBeenLastCalledWith(probe.camera, undefined, cullOpaque)
  for (const state of [{ captures: 1 }, { pathTracingBuildRunning: true }, { contextLost: true }]) {
    Object.assign(probe, { captures: 0, pathTracingBuildRunning: false, contextLost: false }, state)
    render.mockClear(); draw()
    if (state.contextLost) expect(render).not.toHaveBeenCalled()
    else expect(render).toHaveBeenLastCalledWith(probe.camera, undefined, undefined)
  }
  Object.assign(probe, { captures: 0, pathTracingBuildRunning: false, contextLost: false })
  probe.renderRaster(new THREE.OrthographicCamera(), undefined, true, true)
  expect(render.mock.calls.at(-1)?.[2]).toBeUndefined()
  probe.renderRaster(probe.camera, secondary, true, true)
  expect(secondary.render).toHaveBeenLastCalledWith(probe.camera, undefined, undefined)
  probe.settings.pathTracing = true; draw()
  expect(render.mock.calls.at(-1)?.[2]).toBeUndefined()
  probe.settings.pathTracing = false; probe.previewSelected = () => true; draw()
  expect(render.mock.calls.at(-1)?.[2]).toBeUndefined()
  probe.previewSelected = () => false
  const request = globalThis.requestAnimationFrame
  let frame: FrameRequestCallback | undefined
  globalThis.requestAnimationFrame = callback => { frame = callback; return 1 }
  try {
    probe.render()
    expect(frame).toBeDefined()
    frame!(0)
    expect(render).toHaveBeenLastCalledWith(probe.camera, undefined, cullOpaque)
    probe.sceneContent.cullOpaque = undefined
    draw()
    expect(render.mock.calls.at(-1)?.[2]).toBeUndefined()
  } finally { globalThis.requestAnimationFrame = request }
})

test('performance monitoring times live render work without extra frames and counts full PBR samples', async () => {
  const { probe, pathTracer } = photoProbe()
  const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0, now = 0
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  const onFps = mock(), onRender = mock(), status = mock()
  const frame = () => {
    const [id, callback] = frames.entries().next().value!
    frames.delete(id); callback(now)
  }
  Object.assign(probe, {
    performanceMonitor: { onFps, onRender }, callbacks: { onFps: status }, fpsFrames: 0, fpsStarted: 0,
    resetFps: Reflect.get(Viewport.prototype, 'resetFps'), recordFrame: Reflect.get(Viewport.prototype, 'recordFrame'),
    settings: { ...DEFAULT_SETTINGS, pathTracing: false, tiltShift: true },
  })
  probe.raster.render = () => { now += 3 }
  probe.tiltShift.render = () => { now += 2 }
  try {
    for (let i = 0; i < 20; i++) probe.render()
    expect(frames.size).toBe(1)
    frame()
    expect(onRender.mock.calls).toEqual([[5]])
    expect(frames.size).toBe(0)
    now = 500; probe.render(); frame()
    expect(onFps.mock.calls).toEqual(status.mock.calls)
    expect(onFps).toHaveBeenLastCalledWith(4)
    await probe.capture()
    expect(onRender).toHaveBeenCalledTimes(2)
    probe.resetFps()
    expect(onFps).toHaveBeenLastCalledWith()

    onFps.mockClear(); onRender.mockClear()
    probe.settings.pathTracing = true
    pathTracer.reset.mockImplementation(() => { pathTracer.samples = 0 })
    pathTracer.renderSample.mockImplementation(() => { pathTracer.samples += 0.25; now += 4 })
    now = 1000; probe.startPathTracingSamples()
    onFps.mockClear()
    for (let tile = 1; tile <= 4; tile++) {
      now = 1000 + tile * 250; frame()
      expect(onFps).toHaveBeenCalledTimes(tile === 4 ? 1 : 0)
    }
    expect(onFps).toHaveBeenLastCalledWith(0.99)
    expect(onRender.mock.calls).toEqual([[6], [6], [6], [6]])
    pathTracer.samples = 127.75; frame()
    expect(frames.size).toBe(0)
    expect(onFps).toHaveBeenLastCalledWith()

    probe.performanceMonitor = undefined
    probe.settings.pathTracing = false
    probe.render(); frame()
    expect(onRender).toHaveBeenCalledTimes(5)
    expect(frames.size).toBe(0)
  } finally {
    clearTimeout(probe.fpsIdleTimer)
    clock.mockRestore()
    globalThis.requestAnimationFrame = request; globalThis.cancelAnimationFrame = cancel
  }
})

test('render mode, stage rebuilds and captures never add a floor to either workspace', async () => {
  const { probe } = photoProbe()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
  mesh.castShadow = mesh.receiveShadow = true
  probe.sceneContent.root.add(mesh); probe.scene.add(probe.sceneContent.root)
  Object.assign(probe, { settings: { ...DEFAULT_SETTINGS, pathTracing: false, tiltShift: false }, render() {} })
  try {
    for (const stage of ['bounded', 'world']) {
      probe.sceneContent.stage = stage
      for (const enabled of [false, true, false, true]) {
        probe.setRenderMode(enabled)
        probe.rebuildStage()
        probe.setSettings({ ...probe.settings, background: '#abcdef', grid: true, gridWalls: true })
        expect(probe.grid.visible).toBe(!enabled)
        expect(probe.limits.visible).toBe(!enabled)
        expect(probe.scene.children).toEqual([probe.sceneContent.root, probe.grid, probe.limits])
        expect(mesh.castShadow && mesh.receiveShadow).toBe(true)
        await expect(probe.capture()).resolves.toHaveProperty('blob')
        const traceRoot = probe.sceneContent.root.clone()
        const trace = probe.createTraceScene({ root: traceRoot })
        expect(trace.children.filter((object: THREE.Object3D) => object instanceof THREE.Mesh)).toEqual([])
        expect(traceRoot.children).toHaveLength(1)
        probe.disposePathTracer()
      }
    }
  } finally {
    probe.scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose(); (object.material as THREE.Material).dispose()
      }
    })
  }
})

function resolutionProbe(dpr = 2) {
  const { probe, pathTracer } = photoProbe()
  const originalDpr = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio')
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, writable: true, value: dpr })
  const frames = new Map<number, FrameRequestCallback>(), timers = new Map<number, () => void>()
  let next = 0, ratio = Math.min(dpr, 2)
  const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = callback => { frames.set(++next, callback); return next }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(150)
    timers.set(++next, callback)
    return next
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(id => { timers.delete(Number(id)) })
  const size = new THREE.Vector2(161, 81), canvas = probe.renderer.domElement
  const updateCanvas = () => { canvas.width = Math.floor(size.x * ratio); canvas.height = Math.floor(size.y * ratio) }
  updateCanvas()
  Object.assign(probe, {
    renderMode: false, settings: { ...DEFAULT_SETTINGS, pathTracing: false, tiltShift: false },
    rasterInteractions: new Set(), normalPixelRatio: ratio, host: { clientWidth: size.x, clientHeight: size.y },
    controls: { target: new THREE.Vector3(), mouseButtons: {}, touches: {} }, cameraChanged: mock(), invalidateSceneContent: mock(),
    syncRasterResolution: Reflect.get(Viewport.prototype, 'syncRasterResolution'), getView: Viewport.prototype.getView,
  })
  Object.assign(probe.renderer, {
    getPixelRatio: () => ratio,
    setPixelRatio: mock((value: number) => { ratio = value; updateCanvas() }),
    getSize: (target: THREE.Vector2) => target.copy(size),
    setSize: mock((width: number, height: number) => { size.set(width, height); updateCanvas() }),
    getDrawingBufferSize: (target: THREE.Vector2) => target.set(canvas.width, canvas.height),
  })
  probe.raster.readBuffer = { width: canvas.width, height: canvas.height }
  probe.raster.setSize = mock((width: number, height: number) => { Object.assign(probe.raster.readBuffer, { width, height }) })
  const draws: boolean[][] = []
  probe.raster.render = mock(() => { draws.push([probe.raster.pbrMaterials, probe.raster.ambientOcclusion.enabled, probe.renderer.shadowMap.enabled, probe.sunlight.castShadow]) })
  probe.sceneContent.onViewportChange = mock()
  return {
    probe, pathTracer, frames, timers, draws,
    frame() { const entry = frames.entries().next().value; if (entry) { frames.delete(entry[0]); entry[1](0) } },
    settle() { for (const [id, callback] of [...timers]) { timers.delete(id); callback() } },
    async microtasks() { for (let i = 0; i < 4; i++) await Promise.resolve() },
    restore() {
      globalThis.requestAnimationFrame = request; globalThis.cancelAnimationFrame = cancel
      timeout.mockRestore(); clear.mockRestore()
      if (originalDpr) Object.defineProperty(globalThis, 'devicePixelRatio', originalDpr)
      else Reflect.deleteProperty(globalThis, 'devicePixelRatio')
    },
  }
}

test('auto simplify opt-out leaves raster quality and progressive sampling unchanged during gestures', async () => {
  const h = resolutionProbe(), { probe, pathTracer } = h
  probe.renderMode = probe.settings.tiltShift = true
  probe.sceneContent.whenReady = mock(async () => {})
  try {
    probe.setAutoSimplifyRendering(false)
    probe.trackEdit()
    await h.microtasks()
    probe.setRasterInteraction('controls', true)
    h.frame()
    expect(probe.simplifyRendering).toBe(false)
    expect(probe.pathTracingPaused).toBe(false)
    expect(probe.sceneContent.whenReady).not.toHaveBeenCalled()
    expect(probe.renderer.getPixelRatio()).toBe(1)
    expect(h.draws).toEqual([[true, true, true, true]])
    expect(probe.tiltShift.render).toHaveBeenCalledTimes(1)
    probe.settings.pathTracing = true
    pathTracer.samples = 127
    probe.startPathTracingSamples(false)
    h.frame()
    expect(pathTracer.renderSample).toHaveBeenCalledTimes(1)
    expect(pathTracer.samples).toBe(128)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(probe.renderer.getPixelRatio()).toBe(2)
  } finally { h.restore() }
})

test('auto simplify reduces only live shading and restores latest settings or mid-drag opt-out at DPR 1', () => {
  const h = resolutionProbe(1), { probe } = h
  probe.renderMode = probe.settings.tiltShift = true
  const saved = { ...probe.settings }, canonical = probe.settings
  const prepare = mock()
  probe.sceneContent.prepareRaster = prepare
  try {
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('model', true)
    h.frame()
    expect(probe.simplifyRendering).toBe(true)
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    expect(probe.tiltShift.render).not.toHaveBeenCalled()
    expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({ reducedQuality: true, width: 161, height: 81,
      settings: { ...saved, shadows: false, ambientOcclusion: false } })
    expect(probe.settings).toBe(canonical)
    expect(probe.settings).toEqual(saved)
    expect(probe.raster.pbrMaterials && probe.raster.ambientOcclusion.enabled && probe.renderer.shadowMap.enabled && probe.sunlight.castShadow).toBe(true)

    probe.setSettings({ ...saved, pbrMaterials: false, ambientOcclusion: false, shadows: false, tiltShiftFocus: 0.8 })
    h.frame()
    probe.setRasterInteraction('model', false)
    h.frame()
    expect(probe.tiltShift.render).not.toHaveBeenCalled()
    h.settle(); h.frame()
    expect(probe.simplifyRendering).toBe(false)
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    expect(prepare.mock.calls.at(-1)?.[0].settings).toBe(probe.settings)
    expect(probe.tiltShift.render).toHaveBeenLastCalledWith(probe.renderer, probe.settings)
    expect(probe.settings.tiltShiftFocus).toBe(0.8)

    probe.setRasterInteraction('model', true)
    probe.setSettings({ ...probe.settings, pbrMaterials: true, ambientOcclusion: true, shadows: true })
    h.frame()
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    probe.setAutoSimplifyRendering(false)
    h.frame()
    expect(probe.rasterInteractions.has('model')).toBe(true)
    expect(probe.simplifyRendering).toBe(false)
    expect(h.draws.at(-1)).toEqual([true, true, true, true])
    expect(probe.tiltShift.render).toHaveBeenCalledTimes(2)
    expect(probe.renderer.setPixelRatio).not.toHaveBeenCalled()
  } finally { h.restore() }
})

test('auto simplify retains overlapping owners and restarts the single wheel settle timer', () => {
  const h = resolutionProbe(), { probe } = h
  try {
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('model', true)
    probe.setRasterInteraction('model', true)
    probe.setRasterInteraction('focus', true)
    probe.setRasterInteraction('controls', true)
    probe.setRasterInteraction('controls', false)
    probe.setRasterInteraction('model', false)
    expect(h.timers.size).toBe(0)
    expect(probe.rasterInteractions).toEqual(new Set(['focus']))
    h.frame()
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    probe.setRasterInteraction('focus', false)
    const previous = probe.rasterRestoreTimer
    probe.setRasterInteraction('controls', true)
    expect(h.timers.has(previous)).toBe(false)
    probe.setRasterInteraction('controls', false)
    expect(h.timers.size).toBe(1)
    expect(probe.rasterRestoreTimer).not.toBe(previous)
    h.frame()
    expect(probe.simplifyRendering).toBe(true)
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    h.settle(); h.frame()
    expect(h.timers.size).toBe(0)
    expect(probe.simplifyRendering).toBe(false)
    expect(h.draws.at(-1)).toEqual([true, true, true, true])
    expect(probe.sceneContent.onViewportChange).not.toHaveBeenCalled()
    expect(probe.invalidateSceneContent).not.toHaveBeenCalled()
  } finally { h.restore() }
})

test('simplified frames retain shadow invalidation raised during preview preparation', () => {
  const h = resolutionProbe(), { probe } = h
  probe.sceneContent.prepareRaster = () => { probe.renderer.shadowMap.needsUpdate = true }
  probe.raster.render = () => { probe.renderer.shadowMap.needsUpdate = false }
  try {
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('model', true)
    h.frame()
    expect(probe.renderer.shadowMap.needsUpdate).toBe(true)
    probe.setRasterInteraction('model', false)
    h.settle(); h.frame()
    expect(probe.renderer.shadowMap.needsUpdate).toBe(false)
  } finally { h.restore() }
})

test('trackEdit checks readiness after synchronous mutation and only the latest edit releases quality', async () => {
  const h = resolutionProbe(), { probe } = h
  const first = Promise.withResolvers<void>(), latest = Promise.withResolvers<void>()
  let ready = Promise.resolve()
  probe.sceneContent.whenReady = mock(() => ready)
  try {
    probe.setAutoSimplifyRendering(true)
    probe.trackEdit()
    expect(probe.sceneContent.whenReady).not.toHaveBeenCalled()
    ready = first.promise
    await h.microtasks()
    expect(probe.sceneContent.whenReady.mock.results[0].value).toBe(first.promise)
    probe.trackEdit()
    probe.trackEdit()
    ready = latest.promise
    await h.microtasks()
    expect(probe.sceneContent.whenReady).toHaveBeenCalledTimes(2)
    expect(probe.sceneContent.whenReady.mock.results[1].value).toBe(latest.promise)
    first.resolve()
    await h.microtasks()
    h.frame()
    expect(probe.rasterInteractions.has('edit')).toBe(true)
    expect(h.timers.size).toBe(0)
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    latest.resolve()
    await h.microtasks()
    expect(probe.rasterInteractions.has('edit')).toBe(false)
    expect(h.timers.size).toBe(1)
    h.frame()
    expect(probe.simplifyRendering).toBe(true)
    h.settle(); h.frame()
    expect(h.draws.at(-1)).toEqual([true, true, true, true])
  } finally { h.restore() }
})

test('trackEdit releases failed readiness and ignores completion after the editor is cleared', async () => {
  const h = resolutionProbe(), { probe } = h
  const failed = Promise.withResolvers<void>(), abandoned = Promise.withResolvers<void>()
  probe.sceneContent.whenReady = mock(() => failed.promise)
  probe.rebuildStage = mock()
  try {
    probe.setAutoSimplifyRendering(true)
    probe.trackEdit()
    await h.microtasks()
    failed.reject(new Error('mesh failed'))
    await h.microtasks()
    expect(probe.rasterInteractions.size).toBe(0)
    expect(h.timers.size).toBe(1)
    h.settle(); h.frame()
    expect(probe.simplifyRendering).toBe(false)
    probe.sceneContent.whenReady = () => abandoned.promise
    probe.trackEdit()
    await h.microtasks()
    probe.setSceneContent(undefined)
    h.frame()
    expect(probe.content).toBeUndefined()
    expect(probe.simplifyRendering).toBe(false)
    expect(probe.rasterInteractions.size).toBe(0)
    expect(h.timers.size).toBe(0)
    abandoned.resolve()
    await h.microtasks()
    probe.trackEdit()
    expect(probe.rasterInteractions.size).toBe(0)
    expect(h.timers.size).toBe(0)
    expect(h.frames.size).toBe(0)
  } finally { h.restore() }
})

test('camera changes pulse auto simplify but hover-style render requests neither start nor prolong it', () => {
  const h = resolutionProbe(), { probe } = h
  probe.cameraChanged = Reflect.get(Viewport.prototype, 'cameraChanged')
  try {
    probe.setAutoSimplifyRendering(true)
    probe.render(); h.frame()
    expect(probe.simplifyRendering).toBe(false)
    expect(h.timers.size).toBe(0)
    probe.cameraChanged(); h.frame()
    expect(probe.simplifyRendering).toBe(true)
    expect(probe.rasterInteractions.size).toBe(0)
    const timer = probe.rasterRestoreTimer
    probe.render(); probe.render(); h.frame()
    expect(probe.rasterRestoreTimer).toBe(timer)
    expect(h.timers.size).toBe(1)
    expect(probe.sceneContent.onViewportChange).toHaveBeenCalledTimes(1)
    h.settle(); h.frame()
    probe.render(); h.frame()
    expect(probe.simplifyRendering).toBe(false)
    expect(h.timers.size).toBe(0)
    expect(h.draws.at(-1)).toEqual([true, true, true, true])
  } finally { h.restore() }
})

test('auto simplify preserves a converged tracer and BVH, then re-presents without sample 129 after all pauses end', () => {
  const h = resolutionProbe(), { probe, pathTracer } = h
  const worker = { dispose: mock() }
  probe.pathTracingWorker = worker
  probe.renderMode = probe.settings.pathTracing = true
  try {
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('model', true)
    h.frame()
    expect(probe.traceHidden).toBe(true)
    expect(probe.pathTracingPaused).toBe(true)
    expect(probe.pathTracingReady).toBe(true)
    expect(probe.renderer.getPixelRatio()).toBe(2)
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    probe.setSceneInteraction(true)
    probe.setRasterInteraction('model', false)
    h.frame()
    expect(pathTracer.renderSample).not.toHaveBeenCalled()
    h.settle(); h.frame()
    expect(probe.simplifyRendering).toBe(false)
    expect(probe.pathTracingPaused).toBe(true)
    expect(pathTracer.renderSample).not.toHaveBeenCalled()
    probe.setSceneInteraction(false)
    h.frame()
    expect(probe.traceHidden).toBe(false)
    expect(pathTracer.renderSample).toHaveBeenCalledTimes(1)
    expect(pathTracer.samples).toBe(128)
    expect(pathTracer.pausePathTracing).toBe(false)
    expect(h.frames.size).toBe(0)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(pathTracer.setSceneAsync).not.toHaveBeenCalled()
    expect(pathTracer.dispose).not.toHaveBeenCalled()
    expect(worker.dispose).not.toHaveBeenCalled()
    expect(probe.pathTracer).toBe(pathTracer)
    expect(probe.pathTracingWorker).toBe(worker)
    expect(probe.pathTracingRevision).toBe(0)
  } finally { h.restore() }
})

test('paused progressive rendering cancels sampling but still uploads and resets before resuming at final settle', () => {
  const h = resolutionProbe(), { probe, pathTracer } = h
  probe.renderMode = probe.settings.pathTracing = true
  pathTracer.samples = 64
  try {
    probe.setAutoSimplifyRendering(true)
    probe.startPathTracingSamples(false)
    const scheduled = probe.pathTracingFrame, staleFrame = h.frames.get(scheduled)!
    probe.setRasterInteraction('controls', true)
    expect(h.frames.has(scheduled)).toBe(false)
    expect(probe.pathTracingFrame).toBeUndefined()
    staleFrame(0)
    h.frame()
    probe.updatePathTracing('materials', 'lights', 'environment', 'camera')
    expect(pathTracer.updateMaterials).toHaveBeenCalledTimes(1)
    expect(pathTracer.updateLights).toHaveBeenCalledTimes(1)
    expect(pathTracer.updateEnvironment).toHaveBeenCalledTimes(1)
    expect(pathTracer.setCamera).toHaveBeenCalledWith(probe.camera)
    expect(pathTracer.reset).toHaveBeenCalledTimes(1)
    expect(pathTracer.samples).toBe(0)
    expect(probe.pathTracingReady).toBe(true)
    expect(probe.pathTracingFrame).toBeUndefined()
    probe.render(); h.frame()
    probe.setRasterInteraction('controls', false)
    h.frame()
    expect(pathTracer.renderSample).not.toHaveBeenCalled()
    h.settle(); h.frame(); h.frame()
    expect(pathTracer.samples).toBe(1)
    expect(pathTracer.reset).toHaveBeenCalledTimes(1)
    expect(pathTracer.setSceneAsync).not.toHaveBeenCalled()
    expect(pathTracer.dispose).not.toHaveBeenCalled()
    expect(probe.traceHidden).toBe(false)
  } finally { h.restore() }
})

test('opting out before the queued simplified frame restores a converged trace at DPR 1 without another event', () => {
  const h = resolutionProbe(1), { probe, pathTracer } = h
  probe.renderMode = probe.settings.pathTracing = true
  try {
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('model', true)
    expect(probe.pathTracingPaused).toBe(true)
    expect(pathTracer.renderSample).not.toHaveBeenCalled()
    probe.setAutoSimplifyRendering(false)
    h.frame()
    expect(probe.pathTracingPaused).toBe(false)
    expect(probe.traceHidden).toBe(false)
    expect(pathTracer.renderSample).toHaveBeenCalledTimes(1)
    expect(pathTracer.samples).toBe(128)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(h.frames.size).toBe(0)
    expect(probe.renderer.setPixelRatio).not.toHaveBeenCalled()
  } finally { h.restore() }
})

test('an in-flight BVH build completing while simplified stays ready without starting a sample', async () => {
  const h = resolutionProbe(), { probe, pathTracer } = h
  const ready = Promise.withResolvers<void>()
  probe.renderMode = probe.settings.pathTracing = true
  probe.pathTracingReady = false
  probe.pathTracingBuildRequested = true
  pathTracer.setSceneAsync.mockImplementationOnce(() => ready.promise)
  try {
    const building = probe.buildPathTrace()
    await h.microtasks()
    expect(pathTracer.setSceneAsync).toHaveBeenCalledTimes(1)
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('controls', true)
    ready.resolve()
    await building
    expect(probe.pathTracingReady).toBe(true)
    expect(probe.pathTracingBuildRunning).toBe(false)
    expect(probe.pathTracingBuildRequested).toBe(false)
    expect(probe.pathTracingFrame).toBeUndefined()
    expect(probe.pathTracer).toBe(pathTracer)
    expect(pathTracer.setCamera).toHaveBeenCalledWith(probe.camera)
    h.frame()
    probe.setRasterInteraction('controls', false)
    h.frame()
    expect(pathTracer.renderSample).not.toHaveBeenCalled()
    h.settle(); h.frame(); h.frame()
    expect(pathTracer.samples).toBe(1)
    expect(pathTracer.setSceneAsync).toHaveBeenCalledTimes(1)
    expect(pathTracer.dispose).not.toHaveBeenCalled()
  } finally { h.restore() }
})

test('final capture release resumes deferred builds and hidden converged traces even with simplification off', async () => {
  for (const pendingBuild of [false, true]) {
    const h = resolutionProbe(1), { probe, pathTracer } = h
    const ready = Promise.withResolvers<void>()
    probe.renderMode = probe.settings.pathTracing = true
    probe.sceneContent.whenReady = () => ready.promise
    try {
      if (!pendingBuild) {
        probe.setAutoSimplifyRendering(true)
        probe.setRasterInteraction('controls', true)
        probe.setAutoSimplifyRendering(false)
      }
      const capturing = probe.capture()
      if (pendingBuild) probe.requestPathTraceRebuild()
      probe.contentBecameReady()
      expect(pathTracer.setSceneAsync).not.toHaveBeenCalled()
      ready.resolve()
      await capturing
      expect(probe.captures).toBe(0)
      expect(h.frames.size).toBeGreaterThan(0)
      h.frame()
      await h.microtasks()
      if (pendingBuild) {
        expect(pathTracer.setSceneAsync).toHaveBeenCalledTimes(1)
        expect(probe.pathTracingReady).toBe(true)
        h.frame()
        expect(pathTracer.samples).toBe(1)
      } else {
        expect(probe.traceHidden).toBe(false)
        expect(pathTracer.samples).toBe(128)
        expect(pathTracer.reset).not.toHaveBeenCalled()
        expect(h.frames.size).toBe(0)
      }
    } finally { h.restore() }
  }
})

test('superseded builds wait for both interaction settle and mesh readiness, then build only the latest state', async () => {
  const h = resolutionProbe(), { probe, pathTracer } = h
  const first = Promise.withResolvers<void>(), versions: number[] = []
  let ready = true
  probe.renderMode = probe.settings.pathTracing = true
  probe.pathTracingReady = false
  probe.pathTracingBuildRequested = true
  probe.sceneContent.isReady = () => ready
  probe.scene.userData.version = 0
  pathTracer.setSceneAsync.mockImplementation(async scene => {
    versions.push(scene.userData.version)
    if (versions.length === 1) await first.promise
  })
  const build = spyOn(probe, 'buildPathTrace')
  try {
    const building = probe.buildPathTrace()
    await h.microtasks()
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('model', true)
    probe.scene.userData.version = 1
    probe.requestPathTraceRebuild()
    probe.scene.userData.version = 2
    probe.requestPathTraceRebuild()
    first.resolve()
    await building
    probe.contentBecameReady(); h.frame()
    expect(versions).toEqual([0])
    expect(probe.pathTracingBuildRequested).toBe(true)
    expect(probe.pathTracingReady).toBe(false)
    expect(pathTracer.renderSample).not.toHaveBeenCalled()
    ready = false
    probe.setRasterInteraction('model', false)
    h.settle(); h.frame()
    expect(versions).toEqual([0])
    ready = true
    probe.contentBecameReady()
    await build.mock.results.at(-1)?.value
    expect(versions).toEqual([0, 2])
    expect(build).toHaveBeenCalledTimes(2)
    expect(probe.pathTracingReady).toBe(true)
    expect(probe.pathTracingBuildRequested).toBe(false)
    expect(probe.pathTracingFailed).toBe(false)
    expect(pathTracer.reset).toHaveBeenCalledTimes(1)
    h.frame()
    expect(pathTracer.samples).toBe(1)
  } finally { build.mockRestore(); h.restore() }
})

test('overlapping captures render requested quality at full DPR and restore simplification after encoding failure', async () => {
  const h = resolutionProbe(), { probe } = h
  const encodes: ((blob: Blob | null) => void)[] = [], prepare = mock()
  probe.renderMode = probe.settings.tiltShift = true
  const settings = { ...probe.settings }
  probe.sceneContent.prepareRaster = prepare
  probe.renderer.domElement.toBlob = (callback: (blob: Blob | null) => void) => encodes.push(callback)
  try {
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('model', true)
    h.frame()
    expect(h.draws).toEqual([[false, false, false, false]])
    expect(probe.renderer.getPixelRatio()).toBe(1)
    const first = probe.capture(), second = probe.capture().catch((error: Error) => error)
    await h.microtasks()
    expect(encodes).toHaveLength(2)
    expect(probe.captures).toBe(2)
    expect(h.draws.slice(1)).toEqual([[true, true, true, true], [true, true, true, true]])
    expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({ reducedQuality: false, settings, width: 322, height: 162 })
    expect(probe.tiltShift.render).toHaveBeenCalledTimes(2)
    encodes[0](new Blob(['png']))
    expect((await first).view.viewport).toEqual({ width: 322, height: 162 })
    expect(probe.captures).toBe(1)
    expect(probe.renderer.getPixelRatio()).toBe(2)
    probe.render(); h.frame()
    expect(h.draws.at(-1)).toEqual([true, true, true, true])
    encodes[1](null)
    expect((await second).message).toContain('Could not capture')
    expect(probe.captures).toBe(0)
    expect(probe.renderer.getPixelRatio()).toBe(1)
    h.frame()
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    expect(probe.tiltShift.render).toHaveBeenCalledTimes(3)
    expect(probe.settings).toEqual(settings)
  } finally { h.restore() }
})

test('capture effect failure at DPR 1 restores live simplification without losing requested quality on retry', async () => {
  const h = resolutionProbe(1), { probe } = h
  probe.renderMode = probe.settings.tiltShift = true
  try {
    probe.setAutoSimplifyRendering(true)
    probe.setRasterInteraction('model', true)
    h.frame()
    probe.tiltShift.render.mockImplementationOnce(() => { throw new Error('effect failed') })
    await expect(probe.capture()).rejects.toThrow('effect failed')
    expect(probe.captures).toBe(0)
    expect(h.draws.at(-1)).toEqual([true, true, true, true])
    h.frame()
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    expect(probe.simplifyRendering).toBe(true)
    await expect(probe.capture()).resolves.toHaveProperty('blob')
    expect(h.draws.at(-1)).toEqual([true, true, true, true])
    h.frame()
    expect(h.draws.at(-1)).toEqual([false, false, false, false])
    expect(probe.tiltShift.render).toHaveBeenCalledTimes(2)
    expect(probe.renderer.setPixelRatio).not.toHaveBeenCalled()
  } finally { h.restore() }
})

test('raster gestures coalesce, overlap, settle once, and never notify camera or scene dependencies', () => {
  for (const dpr of [0.75, 1, 1.5, 2, 3]) {
    const h = resolutionProbe(dpr), { probe } = h, renderer = probe.renderer
    const camera = probe.camera.toJSON()
    try {
      probe.setRasterInteraction('controls', true)
      probe.setRasterInteraction('controls', true)
      probe.setRasterInteraction('focus', true)
      expect(renderer.getPixelRatio()).toBe(Math.min(dpr, 1))
      expect(renderer.setPixelRatio).toHaveBeenCalledTimes(dpr > 1 ? 1 : 0)
      expect(h.frames.size).toBe(1)
      h.frame()
      probe.setRasterInteraction('controls', false)
      expect(h.timers.size).toBe(0)
      probe.setRasterInteraction('focus', false)
      expect(h.timers.size).toBe(1)
      expect(renderer.getPixelRatio()).toBe(Math.min(dpr, 1))
      probe.setRasterInteraction('scene', true)
      expect(h.timers.size).toBe(0)
      probe.setRasterInteraction('scene', false)
      h.settle(); h.frame()
      expect(renderer.getPixelRatio()).toBe(Math.min(dpr, 2))
      expect(renderer.setPixelRatio).toHaveBeenCalledTimes(dpr > 1 ? 2 : 0)
      expect(probe.raster.render).toHaveBeenCalledTimes(2)
      expect(probe.camera.toJSON()).toEqual(camera)
      expect(probe.cameraChanged).not.toHaveBeenCalled()
      expect(probe.sceneContent.onViewportChange).not.toHaveBeenCalled()
      expect(probe.invalidateSceneContent).not.toHaveBeenCalled()
      expect(renderer.shadowMap.needsUpdate).toBe(false)
    } finally { h.restore() }
  }
})

test('wheel bursts retain a reduced frame; abandonment restores the current display DPR without later timer work', () => {
  const h = resolutionProbe(), { probe } = h
  try {
    for (let i = 0; i < 3; i++) {
      probe.setRasterInteraction('controls', true)
      probe.setRasterInteraction('controls', false)
    }
    expect(h.timers.size).toBe(1)
    expect(probe.renderer.getPixelRatio()).toBe(1)
    h.frame()
    expect(probe.raster.render).toHaveBeenCalledTimes(1)
    globalThis.devicePixelRatio = 1.5
    probe.clearRasterInteractions()
    expect(probe.renderer.getPixelRatio()).toBe(1.5)
    expect(h.timers.size).toBe(0)
    h.frame()
    expect(probe.raster.render).toHaveBeenCalledTimes(2)
    probe.setRasterInteraction('model', true)
    probe.contextLost = true
    probe.clearRasterInteractions()
    probe.setRasterInteraction('model', true)
    expect(probe.rasterInteractions.size).toBe(0)
    expect(probe.renderer.getPixelRatio()).toBe(1)
    probe.contextLost = false
    probe.render()
    expect(probe.renderer.getPixelRatio()).toBe(1.5)
  } finally { h.restore() }
})

test('PBR preparation, paused scene interaction and converged sampling retain normal DPR without an accumulation reset', () => {
  const h = resolutionProbe(), { probe, pathTracer } = h
  try {
    probe.setRasterInteraction('controls', true)
    expect(probe.renderer.getPixelRatio()).toBe(1)
    probe.renderMode = probe.settings.pathTracing = true
    probe.pathTracingReady = false
    probe.render()
    expect(probe.renderer.getPixelRatio()).toBe(2)
    probe.pathTracingReady = true
    probe.sceneInteraction = true
    probe.render()
    expect(probe.renderer.getPixelRatio()).toBe(2)
    probe.sceneInteraction = false
    probe.startPathTracingSamples(false)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(pathTracer.samples).toBe(128)
    probe.pathTracingFailed = true
    probe.render()
    expect(probe.renderer.getPixelRatio()).toBe(1)
    probe.pathTracingFailed = false
    probe.sceneContent.stage = 'world'
    probe.render()
    expect(probe.renderer.getPixelRatio()).toBe(1)
    probe.sceneContent.prepareFullDetail = mock()
    probe.render()
    expect(probe.renderer.getPixelRatio()).toBe(2)
    expect(probe.sceneContent.prepareFullDetail).not.toHaveBeenCalled()
  } finally { h.restore() }
})

test('ordinary resize honors gesture DPR but checks scene budgets at normal pixel dimensions', () => {
  const h = resolutionProbe(), { probe } = h
  try {
    probe.fullContent = {}
    probe.fullViewportPixels = 322 * 162
    probe.setRasterInteraction('model', true)
    probe.resize()
    expect(probe.renderer.getPixelRatio()).toBe(1)
    expect(probe.raster.setSize).toHaveBeenLastCalledWith(161, 81)
    expect(probe.invalidateSceneContent).not.toHaveBeenCalled()
    probe.host.clientWidth = 200
    probe.resize()
    expect(probe.raster.setSize).toHaveBeenLastCalledWith(200, 81)
    expect(probe.invalidateSceneContent).toHaveBeenCalledTimes(1)
    expect(probe.camera.aspect).toBe(200 / 81)
    probe.setRasterInteraction('model', false)
    h.settle()
    expect(probe.raster.setSize).toHaveBeenLastCalledWith(400, 162)
  } finally { h.restore() }
})

test('a display DPR change repaints converged PBR through the genuine resize path', () => {
  const h = resolutionProbe(), { probe, pathTracer } = h
  try {
    probe.renderMode = probe.settings.pathTracing = true
    probe.cameraChanged = Reflect.get(Viewport.prototype, 'cameraChanged')
    pathTracer.setCamera = mock()
    pathTracer.reset.mockImplementation(() => { pathTracer.samples = 0 })
    globalThis.devicePixelRatio = 1.5
    probe.render()
    expect(probe.renderer.getPixelRatio()).toBe(1.5)
    expect(pathTracer.reset).toHaveBeenCalledTimes(1)
    expect(pathTracer.setCamera).toHaveBeenCalledTimes(1)
    expect(h.frames.size).toBe(1)
    h.frame()
    expect(pathTracer.renderSample).toHaveBeenCalledTimes(1)
    expect(pathTracer.samples).toBe(1)
  } finally { h.restore() }
})

test('capture schedules a full-resolution presentation before asynchronous mesh readiness', async () => {
  const h = resolutionProbe(), { probe } = h
  let ready!: () => void
  probe.sceneContent.whenReady = () => new Promise<void>(resolve => { ready = resolve })
  try {
    probe.setRasterInteraction('model', true)
    h.frame()
    expect(probe.raster.render).toHaveBeenCalledTimes(1)
    const capture = probe.capture()
    expect(probe.renderer.getPixelRatio()).toBe(2)
    expect(h.frames.size).toBe(1)
    h.frame()
    expect(probe.raster.render).toHaveBeenCalledTimes(2)
    expect(probe.captures).toBe(1)
    ready()
    await capture
    expect(probe.captures).toBe(0)
    expect(probe.renderer.getPixelRatio()).toBe(1)
  } finally { h.restore() }
})

test('native DPR budget invalidation can dispose a world tracer before sampling starts', () => {
  const h = resolutionProbe(), { probe, pathTracer } = h
  try {
    probe.renderMode = probe.settings.pathTracing = true
    probe.sceneContent.stage = 'world'
    probe.sceneContent.prepareFullDetail = mock()
    probe.fullContent = { dispose: mock() }
    probe.fullViewportPixels = 322 * 162
    pathTracer.dispose = mock()
    probe.invalidateSceneContent = Viewport.prototype.invalidateSceneContent
    probe.requestPathTraceRebuild = mock(() => { probe.pathTracingReady = false })
    globalThis.devicePixelRatio = 1.5
    expect(() => probe.startPathTracingSamples()).not.toThrow()
    expect(pathTracer.dispose).toHaveBeenCalledTimes(1)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(probe.requestPathTraceRebuild).toHaveBeenCalledTimes(1)
    expect(probe.pathTracer).toBeUndefined()
  } finally { h.restore() }
})

test('overlapping captures hold full DPR through encoding and release it even on failure', async () => {
  const h = resolutionProbe(), { probe } = h
  const encodes: ((blob: Blob | null) => void)[] = []
  probe.renderer.domElement.toBlob = (callback: (blob: Blob | null) => void) => encodes.push(callback)
  try {
    probe.setRasterInteraction('controls', true)
    probe.setRasterInteraction('controls', false)
    const first = probe.capture(), second = probe.capture().catch((error: Error) => error)
    expect(probe.captures).toBe(2)
    expect(probe.renderer.getPixelRatio()).toBe(2)
    h.settle()
    probe.setRasterInteraction('model', true)
    await Promise.resolve()
    expect(encodes).toHaveLength(2)
    encodes[0](new Blob(['png']))
    const result = await first
    expect(result.view.viewport).toEqual({ width: 322, height: 162 })
    expect(probe.captures).toBe(1)
    expect(probe.renderer.getPixelRatio()).toBe(2)
    encodes[1](null)
    expect((await second).message).toContain('Could not capture')
    expect(probe.captures).toBe(0)
    expect(probe.renderer.getPixelRatio()).toBe(1)
    probe.setRasterInteraction('model', false)
    h.settle(); h.frame()
    expect(probe.renderer.getPixelRatio()).toBe(2)
  } finally { h.restore() }
})

test('exact capture preflights at full DPR and rejects genuine camera changes without leaking its override', async () => {
  const h = resolutionProbe(), { probe } = h
  let finish!: (value: object) => void
  probe.sceneContent.stage = 'world'
  probe.sceneContent.prepareFullDetail = () => {
    expect(probe.renderer.getPixelRatio()).toBe(2)
    expect(probe.fullViewportPixels).toBe(322 * 162)
    return new Promise(resolve => { finish = resolve })
  }
  const detail = { root: new THREE.Group(), scope: 'full-scene', triangles: 2, peakBytes: 1024, dispose() {} }
  try {
    probe.setRasterInteraction('scene', true)
    const capture = probe.capture(true).catch((error: Error) => error)
    probe.camera.position.x++
    finish(detail)
    expect((await capture).message).toContain('Scene or camera changed')
    expect(probe.captures).toBe(0)
    expect(probe.renderer.getPixelRatio()).toBe(1)
    probe.setRasterInteraction('scene', false)
    const next = probe.capture(true)
    h.settle()
    const result = await next
    expect(result.view.viewport).toEqual({ width: 322, height: 162 })
    expect(probe.renderer.getPixelRatio()).toBe(2)
  } finally { h.restore() }
})

test('Edit, disabled miniature and zero strength do not allocate the effect; Render allocates it once', () => {
  const { probe } = photoProbe()
  probe.tiltShift = undefined
  const render = spyOn(TiltShift.prototype, 'render').mockImplementation(() => {})
  try {
    for (const state of [
      { renderMode: false, tiltShift: true, tiltShiftStrength: 0.5 },
      { renderMode: true, tiltShift: false, tiltShiftStrength: 0.5 },
      { renderMode: true, tiltShift: true, tiltShiftStrength: 0 },
    ]) {
      probe.renderMode = state.renderMode
      Object.assign(probe.settings, { tiltShift: state.tiltShift, tiltShiftStrength: state.tiltShiftStrength })
      probe.tiltShiftDirty = true
      probe.applyTiltShift()
      expect(probe.tiltShift).toBeUndefined()
      expect(probe.tiltShiftDirty).toBe(false)
    }
    expect(render).not.toHaveBeenCalled()
    probe.settings.tiltShiftStrength = 0.5
    probe.applyTiltShift()
    const effect = probe.tiltShift
    expect(effect).toBeInstanceOf(TiltShift)
    probe.applyTiltShift()
    expect(probe.tiltShift).toBe(effect)
    expect(render).toHaveBeenCalledTimes(2)
    expect(render).toHaveBeenLastCalledWith(probe.renderer, probe.settings)
  } finally { render.mockRestore(); probe.tiltShift?.dispose() }
})

test('raster frames and progressive samples present fresh output before applying miniature once', () => {
  const request = globalThis.requestAnimationFrame
  let frame!: FrameRequestCallback
  globalThis.requestAnimationFrame = callback => { frame = callback; return 1 }
  const { probe, calls, pathTracer } = photoProbe()
  try {
    probe.settings.pathTracing = false
    probe.render(); probe.render()
    expect(calls).toEqual([])
    frame(0)
    expect(calls).toEqual(['raster', 'effect 0.5'])
    expect(probe.presentationDirty).toBe(false)
    probe.render(); frame(1)
    expect(calls).toEqual(['raster', 'effect 0.5', 'raster', 'effect 0.5'])
    calls.length = 0
    probe.settings.pathTracing = true
    pathTracer.samples = 127
    probe.startPathTracingSamples(false)
    frame(2)
    expect(calls).toEqual(['sample trace', 'effect 0.5'])
    expect(pathTracer.samples).toBe(128)
    expect(pathTracer.pausePathTracing).toBe(false)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(probe.pathTracingFrame).toBeUndefined()
  } finally { globalThis.requestAnimationFrame = request }
})

test('miniature-only settings re-present a converged tracer paused without resetting or consuming samples', () => {
  const request = globalThis.requestAnimationFrame
  const frames: FrameRequestCallback[] = []
  globalThis.requestAnimationFrame = callback => frames.push(callback)
  const { probe, calls, pathTracer } = photoProbe()
  const rebuild = spyOn(probe, 'requestPathTraceRebuild'), update = spyOn(probe, 'updatePathTracing')
  try {
    for (const patch of [
      { tiltShiftFocus: 0.25 }, { tiltShiftWidth: 0.6 }, { tiltShiftStrength: 0.8 }, { tiltShift: false },
    ]) {
      calls.length = 0
      probe.setSettings({ ...probe.settings, ...patch })
      expect(probe.tiltShiftDirty).toBe(true)
      expect(probe.presentationDirty).toBe(false)
      expect(frames).toHaveLength(1)
      frames.shift()!(0)
      expect(calls).toEqual(probe.settings.tiltShift ? ['present trace', 'effect 0.25'] : ['present trace'])
      expect(probe.tiltShiftDirty).toBe(false)
      expect(pathTracer.samples).toBe(128)
      expect(pathTracer.pausePathTracing).toBe(false)
      expect(probe.pathTracingReady).toBe(true)
      expect(probe.pathTracingFrame).toBeUndefined()
    }
    probe.setSettings({ ...probe.settings })
    expect(frames).toHaveLength(0)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(rebuild).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  } finally {
    globalThis.requestAnimationFrame = request
    rebuild.mockRestore(); update.mockRestore()
  }
})

test('immediate capture flushes the latest miniature settings and never filters an already presented canvas twice', async () => {
  const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame
  let frame!: FrameRequestCallback
  globalThis.requestAnimationFrame = callback => { frame = callback; return 41 }
  const cancelled = mock((_id: number) => {})
  globalThis.cancelAnimationFrame = cancelled
  const { probe, calls, pathTracer } = photoProbe()
  try {
    probe.setSettings({ ...probe.settings, tiltShiftFocus: 0.2 })
    const capture = probe.capture()
    probe.setSettings({ ...probe.settings, tiltShiftFocus: 0.75 })
    await capture
    expect(calls).toEqual(['present trace', 'effect 0.75', 'encode'])
    expect(cancelled).toHaveBeenCalledWith(41)
    expect(probe.rasterFrame).toBeUndefined()
    expect(probe.tiltShiftDirty).toBe(false)
    frame(0)
    await probe.capture()
    expect(calls).toEqual(['present trace', 'effect 0.75', 'encode', 'encode'])
    calls.length = 0
    probe.setSettings({ ...probe.settings, tiltShift: false })
    await probe.capture()
    expect(calls).toEqual(['present trace', 'encode'])
    expect(pathTracer.samples).toBe(128)
    expect(pathTracer.pausePathTracing).toBe(false)
    expect(pathTracer.reset).not.toHaveBeenCalled()
  } finally {
    globalThis.requestAnimationFrame = request
    globalThis.cancelAnimationFrame = cancel
  }
})

test('capture rejects tracer and effect failures while restoring pause and keeping miniature dirty for retry', async () => {
  const { probe, calls, pathTracer } = photoProbe()
  probe.tiltShiftDirty = true
  pathTracer.renderSample.mockImplementationOnce(() => { throw new Error('sample failed') })
  await expect(probe.capture()).rejects.toThrow('sample failed')
  expect(pathTracer.pausePathTracing).toBe(false)
  expect(probe.tiltShiftDirty).toBe(true)
  expect(probe.tiltShift.render).not.toHaveBeenCalled()
  probe.tiltShift.render.mockImplementationOnce(() => { throw new Error('effect failed') })
  await expect(probe.capture()).rejects.toThrow('effect failed')
  expect(pathTracer.pausePathTracing).toBe(false)
  expect(probe.tiltShiftDirty).toBe(true)
  expect(calls).not.toContain('encode')
  pathTracer.pausePathTracing = true
  pathTracer.renderSample.mockImplementationOnce(() => { throw new Error('paused sample failed') })
  await expect(probe.capture()).rejects.toThrow('paused sample failed')
  expect(pathTracer.pausePathTracing).toBe(true)
  await probe.capture()
  expect(pathTracer.pausePathTracing).toBe(true)
  expect(probe.tiltShiftDirty).toBe(false)
  expect(pathTracer.samples).toBe(128)
  expect(pathTracer.reset).not.toHaveBeenCalled()
  expect(calls).toEqual(['present trace', 'present trace', 'effect 0.5', 'encode'])
})

test('exact full-scene capture filters the raster snapshot then restores and filters the accumulated trace paused', async () => {
  const { probe, calls, pathTracer } = photoProbe()
  probe.render = mock()
  const geometry = new THREE.BoxGeometry(), environment = new THREE.Texture(), savedEnvironment = new THREE.Texture()
  const material = new THREE.MeshStandardMaterial({ envMap: savedEnvironment, envMapIntensity: 0.7, envMapRotation: new THREE.Euler(0, 0.3, 0) })
  const full = new THREE.Group(), parent = new THREE.Scene(), root = probe.sceneContent.root
  full.add(new THREE.Mesh(geometry, material)); parent.add(full); probe.scene.add(root)
  probe.sceneContent.stage = 'world'
  probe.sceneContent.prepareFullDetail = async () => ({ root: full, scope: 'full-scene', triangles: 14, peakBytes: 1024, dispose() {} })
  probe.environmentTarget = { texture: environment }
  probe.settings.skybox = 'sunset'
  probe.scene.environmentRotation.y = -0.8
  probe.raster.render = () => {
    calls.push('raster')
    expect(root.visible).toBe(false)
    expect(full.parent).toBe(probe.scene)
    expect(material.envMap).toBe(environment)
    expect(material.envMapIntensity).toBeCloseTo(probe.settings.ambient / Math.PI)
    expect(material.envMapRotation.y).toBe(-0.8)
    expect(probe.renderer.shadowMap.enabled).toBe(true)
    expect(probe.renderer.shadowMap.needsUpdate).toBe(true)
  }
  pathTracer.renderSample.mockImplementation(function () {
    calls.push('present trace')
    expect(pathTracer.pausePathTracing).toBe(true)
    expect(root.visible).toBe(true)
    expect(full.parent).toBe(parent)
    expect(material.envMap).toBe(savedEnvironment)
    expect(material.envMapIntensity).toBe(0.7)
    expect(material.envMapRotation.y).toBe(0.3)
  })
  try {
    await probe.capture(true)
    expect(calls).toEqual(['raster', 'effect 0.5', 'encode', 'present trace', 'effect 0.5'])
    expect(root.visible).toBe(true)
    expect(full.parent).toBe(parent)
    expect(material.envMap).toBe(savedEnvironment)
    expect(pathTracer.samples).toBe(128)
    expect(pathTracer.pausePathTracing).toBe(false)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(probe.presentationDirty || probe.tiltShiftDirty).toBe(false)
    pathTracer.renderSample.mockImplementationOnce(() => { throw new Error('trace restore failed') })
    await expect(probe.capture(true)).rejects.toThrow('trace restore failed')
    expect(pathTracer.pausePathTracing).toBe(false)
    expect(root.visible).toBe(true)
    expect(full.parent).toBe(parent)
    expect(material.envMap).toBe(savedEnvironment)
    calls.length = 0
    probe.renderer.domElement.toBlob = (callback: (blob: Blob | null) => void) => { calls.push('encode'); callback(null) }
    await expect(probe.capture(true)).rejects.toThrow('Could not capture the viewport.')
    expect(calls).toEqual(['raster', 'effect 0.5', 'encode', 'present trace', 'effect 0.5'])
    expect(pathTracer.pausePathTracing).toBe(false)
    expect(pathTracer.samples).toBe(128)
    expect(pathTracer.reset).not.toHaveBeenCalled()
  } finally { probe.releaseSceneDetail(); geometry.dispose(); material.dispose(); environment.dispose(); savedEnvironment.dispose() }
})

test('procedural skies are deterministic, linear, seam-safe and oriented +Y toward the top', () => {
  for (const preset of Object.keys(SKY_LIGHTING) as (keyof typeof SKY_LIGHTING)[]) {
    const texture = createSkyTexture(preset), duplicate = createSkyTexture(preset)
    try {
      expect(texture.image.data).toEqual(duplicate.image.data)
      expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping)
      expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace)
      expect(texture.type).toBe(THREE.HalfFloatType)
      const { width, height } = texture.image
      const data = Float32Array.from(texture.image.data!, THREE.DataUtils.fromHalfFloat)
      expect(data.every(value => Number.isFinite(value) && value >= 0)).toBe(true)
      const north = skyColor(preset, new THREE.Vector3(0, 1, 0))
      expect(data[(height - 1) * width * 4]).toBeCloseTo(north.r, 2)
      const south = skyColor(preset, new THREE.Vector3(0, -1, 0))
      expect(data[0]).toBeCloseTo(south.r, 2)
      expect(texture.wrapS).toBe(THREE.RepeatWrapping)
      for (let y = 0; y < height; y++) {
        const theta = (y + 0.5) / height * Math.PI
        const a = skyColor(preset, new THREE.Vector3(-Math.sin(theta), -Math.cos(theta), 1e-10))
        const b = skyColor(preset, new THREE.Vector3(-Math.sin(theta), -Math.cos(theta), -1e-10))
        expect(a.r).toBeCloseTo(b.r, 5)
        expect(a.g).toBeCloseTo(b.g, 5)
        expect(a.b).toBeCloseTo(b.b, 5)
      }
    } finally { texture.dispose(); duplicate.dispose() }
  }
})

test('sky changes own resources, update tracing and preserve maps on intensity/rotation changes', () => {
  const { probe } = photoProbe()
  const material = new THREE.MeshStandardMaterial()
  probe.sceneContent.onViewportChange = () => probe.applyEnvironment(material)
  const changes: string[][] = [], targets: THREE.WebGLRenderTarget[] = []
  Object.assign(probe, {
    render() {}, updatePathTracing(...values: string[]) { changes.push(values) },
    createEnvironment() { const target = new THREE.WebGLRenderTarget(16, 16); targets.push(target); return target },
    ambientEnvironment: new THREE.Texture(),
  })
  probe.replaceEnvironment('solid')
  const room = probe.environmentTarget, roomDisposed = mock()
  room.addEventListener('dispose', roomDisposed)
  try {
    probe.setSettings({ ...probe.settings, skybox: 'sunset' })
    const source = probe.skyTexture, target = probe.environmentTarget
    const sourceDisposed = mock(), targetDisposed = mock()
    source.addEventListener('dispose', sourceDisposed); target.addEventListener('dispose', targetDisposed)
    expect(roomDisposed).toHaveBeenCalledTimes(1)
    expect(probe.scene.background).toBe(source)
    expect(probe.scene.environment).toBe(source)
    expect(probe.hemisphere.intensity).toBe(0)
    expect(probe.sunlight.color.getHexString()).toBe('ffb66e')
    const direction = probe.sunlight.position.clone().sub(probe.sunlightTarget.position).normalize()
    expect(THREE.MathUtils.radToDeg(Math.asin(direction.y))).toBeCloseTo(10)
    expect(changes.at(-1)).toEqual(['materials', 'environment', 'lights'])
    probe.setSettings({ ...probe.settings, ambient: 0.5, lightAzimuth: 90 })
    expect(probe.skyTexture).toBe(source)
    expect(probe.environmentTarget).toBe(target)
    expect(changes.at(-1)).toEqual(['environment', 'lights'])
    expect(probe.scene.backgroundRotation.y).toBeCloseTo(-Math.PI / 2)
    expect(material.envMapIntensity).toBeCloseTo(0.5 / Math.PI)
    expect(material.envMapRotation.equals(probe.scene.environmentRotation)).toBe(true)
    const trace = probe.createTraceScene({ root: new THREE.Group() })
    expect(trace.background).toBe(source)
    expect(trace.environmentRotation.equals(probe.scene.environmentRotation)).toBe(true)
    expect(trace.backgroundRotation.equals(probe.scene.backgroundRotation)).toBe(true)
    probe.setSettings({ ...probe.settings, skybox: 'solid' })
    expect(sourceDisposed).toHaveBeenCalledTimes(1); expect(targetDisposed).toHaveBeenCalledTimes(1)
    expect(probe.skyTexture).toBeUndefined()
    expect(probe.scene.environment).toBe(probe.ambientEnvironment)
    expect(probe.scene.background).toEqual(new THREE.Color(probe.settings.background))
    expect(probe.hemisphere.intensity).toBe(0.5)
    expect(probe.sunlight.color.getHex()).toBe(0xffffff)
    expect(material.envMapIntensity).toBe(0.2)
    expect(probe.scene.environmentRotation.y).toBe(0)
    probe.contextLost = true
    probe.setSettings({ ...probe.settings, skybox: 'night' })
    expect(targets).toHaveLength(3)
    expect(probe.skyTexture.name).toBe('night')
    probe.contextLost = false
    probe.replaceEnvironment(probe.settings.skybox)
    probe.setSettings(probe.settings)
    expect(targets).toHaveLength(4)
    expect(material.envMap).toBe(probe.environment)
    probe.sceneContent.stage = 'world'
    probe.invalidateSceneContent = mock()
    probe.setSettings({ ...probe.settings, skybox: 'daylight' })
    expect(probe.invalidateSceneContent).toHaveBeenCalledTimes(1)
  } finally {
    probe.skyTexture?.dispose(); probe.environmentTarget.dispose(); probe.ambientEnvironment.dispose()
    material.dispose()
  }
})

test('realtime PBR toggles invalidate shadows without changing progressive tracing or its lighting', () => {
  const { probe, pathTracer } = photoProbe()
  probe.render = () => {}
  probe.settings.skybox = 'daylight'
  for (const pbrMaterials of [false, true, false]) {
    probe.renderer.shadowMap.needsUpdate = false
    probe.setSettings({ ...probe.settings, pbrMaterials })
    expect(probe.renderer.shadowMap.needsUpdate).toBe(true)
    expect(probe.settings.pathTracing && probe.pathTracingEnabled() && probe.pathTracingReady).toBe(true)
    expect(probe.pathTracingRevision).toBe(0)
    expect(pathTracer.reset).not.toHaveBeenCalled()
    expect(probe.hemisphere.intensity).toBe(0)
    const raster = { pbrMaterials: true, ambientOcclusion: { enabled: true }, render() {
      expect(raster.pbrMaterials).toBe(pbrMaterials)
      expect(probe.hemisphere.intensity).toBe(pbrMaterials ? 0 : probe.settings.ambient)
    } }
    probe.renderRaster(undefined, raster, true)
    expect(probe.hemisphere.intensity).toBe(0)
  }
})

test('orthographic non-PBR raster passes the sky texture to the panorama pipeline and restores ambient lighting on failure', () => {
  const { probe } = photoProbe()
  probe.settings = { ...probe.settings, skybox: 'sunset', pathTracing: false, pbrMaterials: false }
  probe.hemisphere.intensity = 0
  probe.skyTexture = createSkyTexture('sunset')
  probe.scene.background = probe.skyTexture
  probe.scene.backgroundRotation.y = -Math.PI / 2
  probe.camera = new THREE.OrthographicCamera()
  probe.camera.lookAt(0, 0, 1)
  probe.raster.render = () => {
    expect(probe.raster.pbrMaterials).toBe(false)
    expect(probe.hemisphere.intensity).toBe(probe.settings.ambient)
    expect(probe.scene.background).toBe(probe.skyTexture)
    throw new Error('raster failed')
  }
  try {
    expect(() => probe.renderRaster()).toThrow('raster failed')
    expect(probe.scene.background).toBe(probe.skyTexture)
    expect(probe.hemisphere.intensity).toBe(0)
    expect(probe.scene.backgroundRotation.y).toBe(-Math.PI / 2)
  } finally { probe.skyTexture.dispose() }
})

test('failed sky filtering disposes the tentative texture and preserves the previous environment and settings', () => {
  const { probe } = photoProbe()
  const environment = new THREE.WebGLRenderTarget(16, 16), source = createSkyTexture('daylight')
  probe.settings.skybox = 'daylight'
  probe.skyTexture = probe.scene.background = probe.scene.environment = source
  probe.environmentTarget = environment
  probe.createEnvironment = () => { throw new Error('PMREM failed') }
  const dispose = spyOn(THREE.DataTexture.prototype, 'dispose')
  try {
    expect(() => probe.setSettings({ ...probe.settings, skybox: 'night' })).toThrow('PMREM failed')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(probe.settings.skybox).toBe('daylight')
    expect(probe.skyTexture).toBe(source)
    expect(probe.scene.background).toBe(source)
    expect(probe.scene.environment).toBe(source)
    expect(probe.environmentTarget).toBe(environment)
  } finally { dispose.mockRestore(); environment.dispose(); source.dispose() }
})

test('fog density and tint update native tracing materials without rebuilding geometry in either workspace', () => {
  for (const stage of ['bounded', 'world']) {
    const { probe, pathTracer } = photoProbe()
    probe.sceneContent.stage = stage
    probe.sceneContent.prepareFullDetail = mock()
    probe.settings.volumetricLighting = true
    probe.traceFog = new THREE.Mesh(new THREE.BoxGeometry(), new FogVolumeMaterial())
    probe.render = mock()
    probe.startPathTracingSamples = mock()
    probe.invalidateSceneContent = mock()
    probe.requestPathTraceRebuild = mock()
    try {
      probe.setSettings({ ...probe.settings, fogDensity: 2.5, fogColor: '#4080ff' })
      const region = volumetricRegion(probe.sceneContent.bounds, 2.5, probe.settings.fogSpread)
      expect(probe.traceFog.material.density).toBe(region.density)
      expect(probe.traceFog.material.color.equals(new THREE.Color('#4080ff'))).toBe(true)
      expect(probe.traceFog.position.equals(region.bounds.getCenter(new THREE.Vector3()))).toBe(true)
      expect(probe.traceFog.scale.equals(region.bounds.getSize(new THREE.Vector3()))).toBe(true)
      expect(pathTracer.updateMaterials).toHaveBeenCalledTimes(1)
      expect(probe.startPathTracingSamples).toHaveBeenCalledTimes(1)
      expect(probe.requestPathTraceRebuild).not.toHaveBeenCalled()
      expect(probe.invalidateSceneContent).not.toHaveBeenCalled()
      expect(pathTracer.setSceneAsync).not.toHaveBeenCalled()
      probe.renderRaster()
      expect(probe.raster.volumetricLighting).toMatchObject({ ...region, color: new THREE.Color('#4080ff') })
      probe.setSettings({ ...probe.settings })
      expect(pathTracer.updateMaterials).toHaveBeenCalledTimes(1)
    } finally { probe.disposePathTracer() }
  }
})

test('fog spread changes rebuild tracing and shadow residency, including capture preparation epochs', () => {
  for (const stage of ['bounded', 'world']) {
    const { probe } = photoProbe()
    probe.sceneContent.stage = stage
    probe.sceneContent.prepareFullDetail = mock()
    probe.settings.volumetricLighting = true
    probe.render = mock()
    probe.requestPathTraceRebuild = mock()
    probe.setSettings(probe.settings)
    const width = probe.sunlight.shadow.camera.right - probe.sunlight.shadow.camera.left
    probe.renderer.shadowMap.needsUpdate = false
    probe.setSettings({ ...probe.settings, fogSpread: 1 })
    expect(probe.renderer.shadowMap.needsUpdate).toBe(true)
    expect(probe.requestPathTraceRebuild).toHaveBeenCalledTimes(1)
    if (stage === 'world') {
      expect(probe.fullEpoch).toBe(1)
      expect(probe.pathTracer).toBeUndefined()
      expect(probe.sunlight.shadow.camera.right - probe.sunlight.shadow.camera.left).toBeGreaterThan(width)
    }
    probe.renderRaster()
    expect(probe.raster.volumetricLighting.bounds.equals(volumetricRegion(probe.sceneContent.bounds, 1, 1).bounds)).toBe(true)
  }
})

test('zero fog skips raster atmosphere and hiding the sun changes neither illumination nor tracing', () => {
  const { probe, pathTracer } = photoProbe()
  probe.render = mock()
  probe.startPathTracingSamples = mock()
  probe.settings.volumetricLighting = true
  probe.traceFog = new THREE.Mesh(new THREE.BoxGeometry(), new FogVolumeMaterial())
  probe.setSettings(probe.settings)
  const light = probe.sunlight.intensity, ambient = probe.hemisphere.intensity, environment = probe.scene.environmentIntensity
  try {
    probe.setSettings({ ...probe.settings, fogDensity: 0 })
    expect(probe.traceFog.material.density).toBe(0)
    expect(pathTracer.updateMaterials).toHaveBeenCalledTimes(1)
    probe.renderRaster()
    expect(probe.raster.volumetricLighting).toBeUndefined()
    probe.keyLightIndicator = { update: mock() }
    probe.setSettings({ ...probe.settings, showSun: false })
    probe.traceHidden = false
    Reflect.get(Viewport.prototype, 'render').call(probe)
    expect(probe.keyLightIndicator.update).toHaveBeenLastCalledWith(probe.camera, probe.sunlight, probe.settings.skybox, false)
    expect([probe.sunlight.intensity, probe.hemisphere.intensity, probe.scene.environmentIntensity]).toEqual([light, ambient, environment])
    expect(pathTracer.updateMaterials).toHaveBeenCalledTimes(1)
    expect(pathTracer.updateLights).not.toHaveBeenCalled()
    expect(pathTracer.setSceneAsync).not.toHaveBeenCalled()
  } finally { probe.disposePathTracer() }
})

test('fog material changes invalidate an in-flight build and reject exact captures before encoding', async () => {
  const { probe, calls } = photoProbe()
  probe.render = mock()
  probe.settings.volumetricLighting = true
  probe.pathTracingBuildRunning = true
  probe.setSettings({ ...probe.settings, fogDensity: 2 })
  expect(probe.pathTracingBuildRequested).toBe(true)
  expect(probe.pathTracingRevision).toBe(1)
  const ready = Promise.withResolvers<void>()
  probe.sceneContent.whenReady = () => ready.promise
  const capture = probe.capture(true)
  probe.setSettings({ ...probe.settings, fogColor: '#abcdef' })
  ready.resolve()
  await expect(capture).rejects.toThrow('changed during exact capture')
  expect(calls).not.toContain('encode')
  expect(probe.captures).toBe(0)
  expect(probe.pathTracingRevision).toBe(2)
})

test('sun indicator visibility changes neither exact captures nor the panorama enable uniform', async () => {
  const { probe } = photoProbe()
  probe.render = mock()
  probe.traceSky = { value: true }
  probe.settings.skybox = 'daylight'
  const ready = Promise.withResolvers<void>()
  probe.sceneContent.whenReady = () => ready.promise
  const capture = probe.capture(true)
  probe.setSettings({ ...probe.settings, showSun: false })
  ready.resolve()
  await expect(capture).resolves.toHaveProperty('blob')
  expect(probe.traceSky.value).toBe(true)
  probe.replaceEnvironment = mock()
  probe.updatePathTracing = mock()
  probe.setSettings({ ...probe.settings, skybox: 'solid' })
  expect(probe.traceSky.value).toBe(false)
})
