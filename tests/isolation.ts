// Dedicated /tests/transparency.html only; run suites sequentially.
// import('/tests/isolation.ts').then(m => m.runIsolationChecks(transparencyTest.renderer, transparencyTest.settings))
import type { BufferGeometry, Object3D } from 'three'
import type { VoxelRenderer } from '../src/editors/model/renderer'
import type { ViewSettings } from '../src/shared/rendering/settings'

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

export async function runIsolationChecks(renderer: VoxelRenderer, settings: ViewSettings) {
  const { VoxelDocument } = await import('../src/shared/voxel/document')
  const viewport = renderer.viewport, webgl = viewport.renderer
  const host = Reflect.get(viewport, 'host') as HTMLElement
  const saved = {
    document: Reflect.get(renderer, 'document') as InstanceType<typeof VoxelDocument>, settings: { ...viewport.settings },
    view: renderer.getView(), renderMode: viewport.renderMode, width: host.style.width, height: host.style.height,
    tool: Reflect.get(renderer, 'tool') as Parameters<VoxelRenderer['setToolState']>[0],
    paintMode: Reflect.get(renderer, 'paintMode') as Parameters<VoxelRenderer['setToolState']>[1],
    auxiliary: Reflect.get(renderer, 'auxiliary') as Parameters<VoxelRenderer['setToolState']>[2],
    cells: [...(Reflect.get(renderer, 'selection') as Map<number, { x: number; y: number; z: number }>).values()],
    floating: Reflect.get(renderer, 'floatingSelection') as boolean,
  }
  const counters = { workerMessages: 0, meshJobs: 0, gridJobs: 0, rasterFrames: 0 }
  const restores: (() => void)[] = []
  let presentedAt = 0
  const watch = (target: object, key: string, after: (args: unknown[]) => void) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key), original = Reflect.get(target, key)
    check(typeof original === 'function', `Missing integration method: ${key}`)
    Reflect.set(target, key, function (this: object, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args)
      after(args)
      return result
    })
    restores.push(() => descriptor ? Object.defineProperty(target, key, descriptor) : Reflect.deleteProperty(target, key))
  }
  const presented = async () => {
    await renderer.whenMeshIdle()
    await new Promise(requestAnimationFrame)
    check(!renderer.meshState().failed && Reflect.get(viewport, 'rasterFrame') === undefined
      && !Reflect.get(viewport, 'presentationDirty'), 'Expected a completed automatic RAF render after meshing')
  }
  const pixels = async () => {
    const bitmap = await createImageBitmap((await renderer.capture()).blob)
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      return context.getImageData(0, 0, canvas.width, canvas.height).data
    } finally { bitmap.close() }
  }
  const changedBytes = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    check(a.length > 0 && a.length === b.length, 'Pixel buffers must have matching nonzero sizes')
    return a.reduce((count, value, index) => count + Number(value !== b[index]), 0)
  }
  const geometries = () => {
    const result = new Set<BufferGeometry>()
    ;(Reflect.get(renderer, 'model') as Object3D).traverse(object => {
      const geometry = Reflect.get(object, 'geometry') as BufferGeometry | undefined
      if (geometry) result.add(geometry)
    })
    return result
  }
  try {
    renderer.setRenderMode(false)
    renderer.setToolState('layer', 'paint')
    renderer.setSettings({ ...settings, skybox: 'solid', background: '#b8c4ce', ambient: 1.2, light: 2.4, lightAzimuth: 42,
      projection: 'orthographic', pathTracing: false, ambientOcclusion: false, shadows: false, tiltShift: false,
      grid: false, faceGrid: false, meshVertices: false, meshTriangles: false })
    await renderer.whenMeshIdle()
    host.style.width = host.style.height = `${256 / Math.min(devicePixelRatio, 2)}px`
    renderer.resize()
    const document = new VoxelDocument({ x: 48, y: 16, z: 32 }), active = document.activeLayerId
    for (const color of [7, 11]) Object.assign(document.materials[color], { opacity: 1, transmission: 0, roughness: 1, metalness: 0, emissiveIntensity: 0 })
    // Sparse bars cross x/z chunk seams; the upper layer overlaps and roofs the lower one.
    for (let x = 13; x < 35; x++) for (let y = 2; y < 5; y++) for (let z = 14; z < 18; z++) document.setVoxel(x, y, z, 7)
    document.createLayer()
    for (let x = 15; x < 33; x++) for (let y = 4; y < 7; y++) for (let z = 15; z < 20; z++) document.setVoxel(x, y, z, 11)
    document.setActiveLayer(active)
    renderer.setDocument(document)
    renderer.setView({ position: { x: 36, y: 32, z: 42 }, target: { x: 0, y: 4, z: 0 }, up: { x: 0, y: 1, z: 0 }, zoom: 1, orthographicSpan: 38 })
    await presented()
    const normal = await pixels()
    watch(Worker.prototype, 'postMessage', ([data]) => {
      counters.workerMessages++
      const message = data as { type?: string; jobs?: unknown[] }
      if (message.type === 'mesh') counters.meshJobs += message.jobs?.length ?? 0
      if (message.type === 'grid') counters.gridJobs += message.jobs?.length ?? 0
    })
    watch(viewport, 'renderRaster', () => { counters.rasterFrames++; presentedAt = performance.now() })
    const timings: { state: string; toggleToRafRenderMs: number; meshJobs: number }[] = []
    const toggle = async (state: 'cold' | 'off' | 'warm') => {
      const before = { ...counters }, started = performance.now()
      renderer.setToolState(state === 'off' ? 'layer' : 'select', 'paint')
      await presented()
      check(counters.rasterFrames > before.rasterFrames, `${state}: toggle must draw without capture or explicit render()`)
      timings.push({ state, toggleToRafRenderMs: presentedAt - started, meshJobs: counters.meshJobs - before.meshJobs })
    }
    await toggle('cold')
    const cold = await pixels(), normalDifference = changedBytes(normal, cold)
    check(normalDifference > 100 && counters.meshJobs > 0, 'Cold isolation must visibly change pixels and issue real mesh jobs')
    const cached = geometries(), gpuGeometries = webgl.info.memory.geometries, coldCounters = { ...counters }
    check(document.chunks.size > 1 && cached.size > 0, 'Fixture must allocate real multi-chunk geometry')
    for (let repeat = 0; repeat < 4; repeat++) for (const state of ['off', 'warm'] as const) {
      await toggle(state)
      // Capture verifies pixels only, after the measured spontaneous RAF render has finished.
      check(changedBytes(state === 'off' ? normal : cold, await pixels()) === 0, `${state}: pixels must be byte-identical to the reference`)
      const current = geometries()
      check(current.size === cached.size && [...current].every(geometry => cached.has(geometry))
        && webgl.info.memory.geometries === gpuGeometries, `${state}: warm toggles must retain geometry identities and bounded GPU resources`)
      check(counters.workerMessages === coldCounters.workerMessages, `${state}: warm toggles must send zero worker messages`)
    }
    const gl = webgl.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info')
    return { timings, counters: { ...counters }, warmWorkerMessages: counters.workerMessages - coldCounters.workerMessages,
      warmMeshJobs: counters.meshJobs - coldCounters.meshJobs, geometries: cached.size, gpuGeometries, normalDifference,
      gpu: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      timingNote: 'Toggle to automatic RAF render completion, excluding capture; SwiftShader timings are software-rendered, not native GPU latency.' }
  } finally {
    for (const restore of restores.reverse()) restore()
    renderer.setRenderMode(false)
    renderer.setDocument(saved.document)
    renderer.setSettings(saved.settings)
    renderer.setToolState(saved.tool, saved.paintMode, saved.auxiliary)
    renderer.applySelection({ cells: saved.cells, count: saved.cells.length, floating: saved.floating }, false)
    host.style.width = saved.width; host.style.height = saved.height
    renderer.resize()
    renderer.setView(saved.view)
    await renderer.whenMeshIdle()
    if (saved.renderMode) renderer.setRenderMode(true)
  }
}
