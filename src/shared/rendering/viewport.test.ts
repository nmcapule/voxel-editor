import { expect, mock, spyOn, test } from 'bun:test'
import * as THREE from 'three'
import { Viewport } from './viewport'
import { DEFAULT_SETTINGS, type ViewSettings } from './settings'
import { TiltShift } from './tilt-shift'

test('viewport teardown cancels owned work, detaches borrowed content and disposes each GPU resource once', async () => {
  const cancel = globalThis.cancelAnimationFrame, cancelled: number[] = []
  globalThis.cancelAnimationFrame = id => { cancelled.push(id) }
  const scene = new THREE.Scene(), root = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial())
  root.add(mesh); scene.add(root)
  const grid = new THREE.Group(), lines = new THREE.LineSegments(new THREE.BoxGeometry(), new THREE.LineBasicMaterial())
  grid.add(lines); scene.add(grid)
  const light = new THREE.DirectionalLight()
  const resources = { raster: 0, tiltShift: 0, renderer: 0, controls: 0, environment: 0, ambient: 0, observer: 0, canvas: 0, worker: 0, tracer: 0, grid: 0, gridMaterial: 0, borrowed: 0, detail: 0 }
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
    tiltShift: { dispose() { resources.tiltShift++ } },
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
    expect(resources).toEqual({ raster: 1, tiltShift: 1, renderer: 1, controls: 1, environment: 1, ambient: 1, observer: 1, canvas: 1, worker: 1, tracer: 1, grid: 1, gridMaterial: 1, borrowed: 0, detail: 1 })
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

function photoProbe() {
  const calls: string[] = []
  const pathTracer = {
    samples: 128, pausePathTracing: false, reset: mock(),
    renderSample: mock(function (this: { samples: number; pausePathTracing: boolean }) {
      calls.push(this.pausePathTracing ? 'present trace' : 'sample trace')
      if (!this.pausePathTracing) this.samples++
    }),
  }
  const probe = Object.assign(Object.create(Viewport.prototype), {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    sceneContent: { root: new THREE.Group(), stage: 'bounded', bounds: new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)), onViewportChange() {}, whenReady: async () => {} },
    settings: { ...DEFAULT_SETTINGS, tiltShift: true }, renderMode: true,
    pathTracingReady: true, presentationDirty: false, tiltShiftDirty: false, fullEpoch: 0, pathTracingRevision: 0,
    hemisphere: new THREE.HemisphereLight(), sunlight: new THREE.DirectionalLight(), sunlightTarget: new THREE.Object3D(),
    callbacks: {}, resetFps() {}, recordFrame() {},
    renderer: { shadowMap: { enabled: true, needsUpdate: false }, getContext: () => ({ isContextLost: () => false }),
      domElement: { width: 160, height: 80, toBlob(callback: (blob: Blob) => void) { calls.push('encode'); callback(new Blob(['png'])) } } },
    raster: { ambientOcclusion: { enabled: true }, render() { calls.push('raster') } },
    tiltShift: { render: mock((_renderer: unknown, settings: ViewSettings) => { calls.push(`effect ${settings.tiltShiftFocus}`) }) },
    pathTracer, getView: () => ({ name: 'stable' }),
  })
  return { probe, calls, pathTracer }
}

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
  const geometry = new THREE.BoxGeometry(), environment = new THREE.Texture(), savedEnvironment = new THREE.Texture()
  const material = new THREE.MeshStandardMaterial({ envMap: savedEnvironment })
  const full = new THREE.Group(), parent = new THREE.Scene(), root = probe.sceneContent.root
  full.add(new THREE.Mesh(geometry, material)); parent.add(full); probe.scene.add(root)
  probe.sceneContent.stage = 'world'
  probe.sceneContent.prepareFullDetail = async () => ({ root: full, scope: 'full-scene', triangles: 14, peakBytes: 1024, dispose() {} })
  probe.environmentTarget = { texture: environment }
  probe.raster.render = () => {
    calls.push('raster')
    expect(root.visible).toBe(false)
    expect(full.parent).toBe(probe.scene)
    expect(material.envMap).toBe(environment)
    expect(probe.renderer.shadowMap.enabled).toBe(true)
    expect(probe.renderer.shadowMap.needsUpdate).toBe(true)
  }
  pathTracer.renderSample.mockImplementation(function () {
    calls.push('present trace')
    expect(pathTracer.pausePathTracing).toBe(true)
    expect(root.visible).toBe(true)
    expect(full.parent).toBe(parent)
    expect(material.envMap).toBe(savedEnvironment)
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
