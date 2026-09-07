// Dedicated /tests/transparency.html session only; no main application or autosave.
// Start without awaiting CDP: import('/tests/recovery.ts').then(m =>
//   m.runRecoveryChecks(transparencyTest.renderer, transparencyTest.settings)).
// Poll window.recoveryChecks (finite waits, incremental results).
import type { DirectionalLight, MeshPhysicalMaterial, Object3D, WebGLRenderTarget } from 'three'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import type { RasterPipeline } from '../src/shared/rendering/raster-pipeline'
import type { VoxelRenderer } from '../src/editors/model/renderer'
import type { ViewSettings } from '../src/shared/rendering/settings'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function until(condition: () => boolean, message: string, timeout = 15000) {
  const deadline = performance.now() + timeout
  while (!condition()) {
    check(performance.now() < deadline, `Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function bounded<T>(promise: Promise<T>, message: string, timeout = 15000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${message}`)), timeout)
    })])
  } finally { clearTimeout(timer) }
}

function difference(a: ArrayLike<number>, b: ArrayLike<number>) {
  check(a.length > 0 && a.length === b.length, 'Pixel probes must have matching nonzero sizes')
  let sum = 0, max = 0
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i])
    sum += delta
    max = Math.max(max, delta)
  }
  return { mean: sum / a.length, max }
}

export async function runRecoveryChecks(renderer: VoxelRenderer, settings: ViewSettings) {
  const viewport = renderer.viewport
  const [{ VoxelDocument }, THREE] = await Promise.all([import('../src/shared/voxel/document'), import('three')])
  const report = {
    running: true, current: 'setup', ok: false,
    checks: [] as { name: string; ok: boolean; milliseconds: number; details?: unknown; error?: string }[],
    errors: [] as string[],
  }
  Object.assign(window, { recoveryChecks: report })
  const webgl = viewport.renderer
  const host = Reflect.get(viewport, 'host') as HTMLElement
  const canvas = webgl.domElement
  const saved = {
    document: Reflect.get(renderer, 'document') as InstanceType<typeof VoxelDocument>,
    settings: { ...viewport.settings },
    view: renderer.getView(), renderMode: viewport.renderMode,
    width: host.style.width, height: host.style.height,
    selection: [...(Reflect.get(renderer, 'selection') as Map<number, { x: number; y: number; z: number }>).values()],
    floating: Reflect.get(renderer, 'floatingSelection') as boolean,
  }
  const restores: (() => void)[] = []
  const counters = { raster: 0, environments: 0, meshJobs: 0, gridJobs: 0, builds: 0 }
  let errorStart = 0
  const watch = (target: object, key: string, wrapper: (original: (...args: unknown[]) => unknown, args: unknown[]) => unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    const original = Reflect.get(target, key)
    check(typeof original === 'function', `Missing integration method: ${key}`)
    Reflect.set(target, key, function (this: object, ...args: unknown[]) {
      return wrapper((...values) => Reflect.apply(original, this, values), args)
    })
    restores.push(() => descriptor ? Object.defineProperty(target, key, descriptor) : Reflect.deleteProperty(target, key))
  }
  const onError = (event: ErrorEvent) => report.errors.push(`uncaught: ${event.error?.stack ?? event.message}`)
  const onRejection = (event: PromiseRejectionEvent) => report.errors.push(`unhandled rejection: ${event.reason?.stack ?? event.reason}`)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  for (const callbacks of new Set([Reflect.get(renderer, 'callbacks'), Reflect.get(viewport, 'callbacks')])) watch(callbacks, 'onError', (original, args) => {
    report.errors.push(String(args[0]))
    return original(...args)
  })
  watch(viewport, 'renderRaster', (original, args) => { const value = original(...args); counters.raster++; return value })
  watch(viewport, 'createEnvironment', (original, args) => { const value = original(...args); counters.environments++; return value })
  watch(Worker.prototype, 'postMessage', (original, args) => {
    const message = args[0] as { type?: string; jobs?: unknown[] }
    if (message.type === 'mesh') counters.meshJobs += message.jobs?.length ?? 0
    if (message.type === 'grid') counters.gridJobs += message.jobs?.length ?? 0
    return original(...args)
  })
  const healthy = () => {
    check(report.errors.length === errorStart, report.errors.slice(errorStart).join('\n'))
    check(!Reflect.get(viewport, 'pathTracingFailed'), 'Renderer entered path-tracing fallback')
    check(!renderer.meshState().failed, 'Mesher failed')
  }
  const idle = (timeout = 15000) => until(() => {
    healthy()
    return !Reflect.get(viewport, 'contextLost') && renderer.meshState().pending === 0
      && Reflect.get(viewport, 'rasterFrame') === undefined && !Reflect.get(viewport, 'presentationDirty')
  }, 'idle raster frame', timeout)
  // Reading the preserved canvas never calls capture()/render(): recovery must draw itself.
  const pixels = () => {
    const copy = new OffscreenCanvas(canvas.width, canvas.height)
    const context = copy.getContext('2d')!
    context.drawImage(canvas, 0, 0)
    return context.getImageData(0, 0, copy.width, copy.height)
  }
  const roi = (image: ImageData, world: [number, number, number], radius = 3) => {
    const camera = viewport.camera
    const point = new THREE.Vector3(...world).project(camera)
    const x = Math.floor((point.x + 1) * image.width / 2), y = Math.floor((1 - point.y) * image.height / 2)
    check(x >= radius && y >= radius && x + radius < image.width && y + radius < image.height, 'ROI outside viewport')
    const rgb: number[] = []
    for (let yy = y - radius; yy <= y + radius; yy++) for (let xx = x - radius; xx <= x + radius; xx++) {
      const offset = (yy * image.width + xx) * 4
      rgb.push(image.data[offset], image.data[offset + 1], image.data[offset + 2])
    }
    return rgb
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const run = async (name: string, action: () => Promise<unknown>) => {
    report.current = name
    const started = performance.now()
    errorStart = report.errors.length
    try {
      const details = await action()
      check(report.errors.length === errorStart, report.errors.slice(errorStart).join('\n'))
      report.checks.push({ name, ok: true, milliseconds: Math.round(performance.now() - started), details })
    } catch (error) {
      report.checks.push({ name, ok: false, milliseconds: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) })
    }
  }
  const fill = (document: InstanceType<typeof VoxelDocument>, material: number, min: number[], max: number[]) => {
    for (let z = min[2]; z < max[2]; z++) for (let y = min[1]; y < max[1]; y++) for (let x = min[0]; x < max[0]; x++) document.setVoxel(x, y, z, material)
  }
  const options: ViewSettings = { ...settings, projection: 'orthographic', pathTracing: false, ambientOcclusion: false, grid: false, faceGrid: false, shadows: true, background: '#b8b8b8', ambient: 0.2, light: 3, lightAzimuth: 0 }
  const load = async (document: InstanceType<typeof VoxelDocument>) => {
    renderer.setRenderMode(false)
    renderer.setSettings(options)
    renderer.setDocument(document)
    await bounded(renderer.whenMeshIdle(), 'fixture meshes')
    renderer.setView({ position: { x: 0, y: 40, z: 0 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: -1 }, zoom: 1, orthographicSpan: 24 })
    await idle()
  }
  let contextControl = webgl.getContext().getExtension('WEBGL_lose_context')
  const extension = () => {
    // WebGL returns null from getExtension while lost; retain the pre-loss handle.
    if (!webgl.getContext().isContextLost()) contextControl = webgl.getContext().getExtension('WEBGL_lose_context')
    check(contextControl, 'WEBGL_lose_context is required for recovery checks')
    return contextControl
  }
  const lostCapture = async () => {
    await until(() => Reflect.get(viewport, 'contextLost') && webgl.getContext().isContextLost(), 'context loss event')
    const error = await bounded(renderer.capture().then(() => '', error => String(error)), 'capture rejection while lost', 3000)
    check(/context.*lost/i.test(error), `Capture must reject while lost, got: ${error || 'resolved'}`)
    // Let outstanding compile/BVH cancellation timers run before restoration.
    await new Promise(resolve => setTimeout(resolve, 120))
    return error
  }
  const restoreContext = async () => {
    extension().restoreContext()
    await until(() => !Reflect.get(viewport, 'contextLost') && !webgl.getContext().isContextLost(), 'context restoration')
  }
  let sampleGoal = 1
  let loseDuringBuild = false, loseDuringCompile = false
  let loss: { tracer: WebGLPathTracer; worker: object; phase: string; compiling?: boolean } | undefined
  const configured = new Set<WebGLPathTracer>()
  watch(viewport, 'ensurePathTracer', async (original, args) => {
    const tracer = await original(...args) as WebGLPathTracer | undefined
    if (!tracer || configured.has(tracer)) return tracer
    configured.add(tracer)
    const previous = {
      stableNoise: Reflect.get(tracer, 'stableNoise'), dynamicLowRes: tracer.dynamicLowRes,
      fadeDuration: tracer.fadeDuration, renderScale: tracer.renderScale, pausePathTracing: tracer.pausePathTracing,
      tiles: tracer.tiles.clone(),
    }
    Object.assign(tracer, { stableNoise: true, dynamicLowRes: false, fadeDuration: 0, renderScale: 1 })
    tracer.tiles.set(1, 1)
    restores.push(() => { const { tiles, ...values } = previous; Object.assign(tracer, values); tracer.tiles.copy(tiles) })
    watch(tracer, 'renderSample', (original, args) => {
      const value = original(...args)
      if (tracer.samples >= sampleGoal) tracer.pausePathTracing = true
      return value
    })
    watch(tracer, 'setSceneAsync', (original, args) => {
      counters.builds++
      const result = original(...args)
      if (loseDuringBuild) {
        loseDuringBuild = false
        loss = { tracer, worker: Reflect.get(viewport, 'pathTracingWorker'), phase: 'BVH preparing' }
        extension().loseContext()
      }
      return result
    })
    return tracer
  })
  watch(webgl, 'compileAsync', (original, args) => {
    const result = original(...args)
    const tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer | undefined
    if (loseDuringCompile && tracer) {
      loseDuringCompile = false
      // Interrupt the pending compiler, not the synchronous renderSample call stack.
      queueMicrotask(() => {
        loss = { tracer, worker: Reflect.get(viewport, 'pathTracingWorker'), phase: 'shader compilation', compiling: Reflect.get(tracer, 'isCompiling') }
        extension().loseContext()
      })
    }
    return result
  })
  const ready = async (samples = 1) => {
    await until(() => {
      healthy()
      return Reflect.get(viewport, 'pathTracingReady') && !Reflect.get(viewport, 'pathTracingBuildRunning')
        && (Reflect.get(viewport, 'pathTracer') as WebGLPathTracer | undefined)?.samples! >= samples
    }, `${samples} automatic path-traced samples`, 180000)
    return Reflect.get(viewport, 'pathTracer') as WebGLPathTracer
  }
  const tracedImage = async () => {
    await until(() => { healthy(); return Reflect.get(viewport, 'pathTracingReady') && !Reflect.get(viewport, 'pathTracingBuildRunning') }, 'path tracer ready', 180000)
    const tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer
    sampleGoal = 8
    tracer.pausePathTracing = false
    Reflect.get(viewport, 'startPathTracingSamples').call(viewport)
    await ready(8)
    Reflect.get(viewport, 'stopPathTracingSamples').call(viewport)
    check(tracer.samples === 8 && !Reflect.get(viewport, 'presentationDirty'), 'Must read exactly eight presented real samples, not raster fallback')
    check(tracer.target.width === 128 && tracer.target.height === 128, 'Path-traced target must be 128x128')
    check(Reflect.get(Reflect.get(tracer, '_pathTracer').material, 'seed') === 8, 'Stable noise must restart the sample seed at zero')
    return pixels()
  }
  try {
    renderer.setRenderMode(false)
    host.style.width = host.style.height = `${128 / Math.min(devicePixelRatio, 2)}px`
    renderer.resize()
    check(canvas.width === 128 && canvas.height === 128, 'Recovery viewport must be 128x128')

    await run('idle raster loss restores environment and pixels without input', async () => {
      const document = new VoxelDocument()
      document.palette[40] = 0xe5aa35
      Object.assign(document.materials[40], { metalness: 1, roughness: 0.15, opacity: 1, transmission: 0, emissiveIntensity: 0 })
      document.palette[41] = 0x56c4f0
      Object.assign(document.materials[41], { metalness: 0, roughness: 0.05, opacity: 1, transmission: 0.85, ior: 1.45, emissiveIntensity: 0 })
      fill(document, 40, [10, 1, 12], [14, 7, 18])
      fill(document, 41, [17, 1, 12], [21, 7, 18])
      await load(document)
      renderer.setView({ position: { x: 18, y: 18, z: 26 }, target: { x: 0, y: 4, z: 0 }, up: { x: 0, y: 1, z: 0 }, orthographicSpan: 20 })
      await idle()
      const before = pixels(), counts = { ...counters }
      const environment = Reflect.get(viewport, 'environmentTarget') as WebGLRenderTarget
      await new Promise(resolve => setTimeout(resolve, 120))
      check(counters.raster === counts.raster, 'Fixture must be truly idle before loss')
      const metal = roi(before, [-4, 7, -1], 1), glass = roi(before, [3, 7, -1], 1)
      check(difference(metal, glass).mean > 5, 'Metal and transmission fixtures must be visibly distinct')
      extension().loseContext()
      const captureError = await lostCapture()
      await restoreContext()
      await idle()
      const delta = difference(before.data, pixels().data)
      check(counters.environments - counts.environments === 1 && Reflect.get(viewport, 'environmentTarget') !== environment, 'Restore must regenerate the PMREM environment')
      const materials = Reflect.get(renderer, 'materials') as MeshPhysicalMaterial[]
      const texture = viewport.environment
      check(materials[40].envMap === texture && materials[41].envMap === texture, 'Metal and transmission must bind the regenerated environment')
      check(counters.raster > counts.raster, 'Restoration must schedule a raster draw without capture or input')
      check(delta.mean <= 0.5 && delta.max <= 2, `Restored raster pixels differ: ${JSON.stringify(delta)}`)
      return { delta, automaticDraws: counters.raster - counts.raster, regeneratedEnvironments: counters.environments - counts.environments, captureError }
    })

    const suspended = new VoxelDocument()
    suspended.palette[42] = 0xc8c8c8
    Object.assign(suspended.materials[42], { metalness: 0, roughness: 1, opacity: 1, transmission: 0, emissiveIntensity: 0 })
    fill(suspended, 42, [14, 6, 14], [18, 8, 18])
    await load(suspended)
    await run('shadow cache skips camera and hover; light geometry and toggle invalidate', async () => {
      let shadowDraws = 0
      // onBeforeShadow is an actual depth draw, unlike shadowMap.render's early-return calls.
      watch(THREE.Mesh.prototype, 'onBeforeShadow', (original, args) => { shadowDraws++; return original(...args) })
      webgl.shadowMap.needsUpdate = true
      renderer.render()
      await idle()
      check(shadowDraws > 0, 'Positive control must render a caster into the shadow map')
      const baseline = shadowDraws
      renderer.setView({ position: { x: 2, y: 40, z: 1 }, target: { x: 0, y: 0, z: 0 } })
      await idle()
      const camera = shadowDraws - baseline
      const rect = canvas.getBoundingClientRect()
      const point = new THREE.Vector3(0, 8, 0).project(viewport.camera)
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + (point.x + 1) * rect.width / 2, clientY: rect.top + (1 - point.y) * rect.height / 2, pointerType: 'mouse' }))
      await idle()
      check((Reflect.get(renderer, 'hover') as Object3D).visible, 'Hover positive control must show a real editor overlay')
      const hover = shadowDraws - baseline - camera
      check(camera === 0 && hover === 0, `Unchanged shadows were redrawn: camera=${camera}, hover=${hover}`)
      canvas.dispatchEvent(new PointerEvent('pointerleave'))
      const invalidations: Record<string, number> = {}
      let start = shadowDraws
      renderer.setSettings({ ...options, lightAzimuth: 60 })
      await idle()
      invalidations.light = shadowDraws - start
      start = shadowDraws
      suspended.setVoxel(18, 6, 16, 42)
      renderer.markDirty(suspended.chunks.keys())
      await idle()
      invalidations.geometry = shadowDraws - start
      start = shadowDraws
      renderer.setSettings({ ...options, shadows: false })
      await idle()
      check(shadowDraws === start, 'Disabled shadows must not draw')
      renderer.setSettings(options)
      await idle()
      invalidations.toggle = shadowDraws - start
      check(Object.values(invalidations).every(count => count > 0), `Missing shadow invalidation: ${JSON.stringify(invalidations)}`)
      return { camera, hover, invalidations }
    })

    await run('context loss cancels a preparing BVH and replaces tracer plus worker', async () => {
      suspended.setVoxel(18, 6, 16, 0)
      renderer.markDirty(suspended.chunks.keys())
      await idle()
      renderer.setView({ position: { x: 0, y: 40, z: 0 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: -1 }, orthographicSpan: 24 })
      renderer.setSettings({ ...options, pathTracing: true })
      loseDuringBuild = true
      renderer.setRenderMode(true)
      const captureError = await lostCapture()
      check(loss?.phase === 'BVH preparing', 'Loss must interrupt a real async BVH build')
      const previous = loss
      await restoreContext()
      const tracer = await ready()
      check(tracer !== previous.tracer && Reflect.get(viewport, 'pathTracingWorker') !== previous.worker, 'Restored tracing must create a different tracer and worker')
      return { phase: previous.phase, replacedTracer: true, replacedWorker: true, samples: tracer.samples, captureError }
    })

    await run('active trace loss and pending shader compilation recover automatically', async () => {
      const previous = await ready(), previousWorker = Reflect.get(viewport, 'pathTracingWorker')
      extension().loseContext()
      const activeCaptureError = await lostCapture()
      loseDuringCompile = true
      loss = undefined
      await restoreContext()
      await until(() => loss?.phase === 'shader compilation', 'real pending shader compilation', 180000)
      const compiling = loss!
      const compilationCaptureError = await lostCapture()
      check(compiling.compiling, 'Loss must interrupt a pending shader compilation promise')
      check(compiling.tracer !== previous && compiling.worker !== previousWorker, 'Active loss must replace both resources before compilation')
      await restoreContext()
      const tracer = await ready()
      check(tracer !== compiling.tracer && Reflect.get(viewport, 'pathTracingWorker') !== compiling.worker, 'Compilation loss must replace tracer and worker again')
      await new Promise(resolve => setTimeout(resolve, 250))
      healthy()
      return { activeSamples: previous.samples, restoredSamples: tracer.samples, interruptedCompilation: compiling.compiling, activeCaptureError, compilationCaptureError, uncaughtErrors: report.errors.length - errorStart }
    })

    await run('progressive preparation and compilation previews neither draw nor sample shadow maps', async () => {
      const tracer = await ready()
      const raster = Reflect.get(viewport, 'raster') as RasterPipeline
      const sunlight = Reflect.get(viewport, 'sunlight') as DirectionalLight
      const previous = { dynamicLowRes: tracer.dynamicLowRes, pausePathTracing: tracer.pausePathTracing }
      const restoreStart = restores.length
      let releasePreparation!: () => void, releaseCompilation!: () => void
      const preparation = new Promise<void>(resolve => { releasePreparation = resolve })
      const compilation = new Promise<void>(resolve => { releaseCompilation = resolve })
      let shadowDraws = 0, builds = 0, compiles = 0, compilationCallbacks = 0, observing = false
      const previews: {
        phase: 'preparing' | 'compiling'; shadowDraws: number; enabled: boolean; castShadow: boolean
        dirty: boolean; complete: boolean; delta: ReturnType<typeof difference>
      }[] = []
      try {
        watch(THREE.Mesh.prototype, 'onBeforeShadow', (original, args) => { shadowDraws++; return original(...args) })
        renderer.setSettings({ ...options, shadows: false })
        // Software GPU recovery can delay compositor RAFs behind pending shader work.
        await idle(180000)
        const reference = pixels()
        check(shadowDraws === 0, 'Shadow-disabled reference must not issue depth draws')
        renderer.setSettings(options)
        webgl.shadowMap.needsUpdate = true
        await idle(180000)
        const shadowed = pixels(), warmDraws = shadowDraws, cachedMap = sunlight.shadow.map
        const effect = mean(roi(reference, [-5.2, -0.03, 0])) - mean(roi(shadowed, [-5.2, -0.03, 0]))
        check(warmDraws > 0 && cachedMap && !webgl.shadowMap.needsUpdate, 'Positive control must populate a clean real shadow map')
        check(effect > 25, `Cached shadow must visibly darken the ground probe: ${effect}`)

        // Hold real async results, not scene data or shader output, until each RAF preview is observed.
        watch(tracer, 'setSceneAsync', (original, args) => {
          builds++
          return Promise.all([original(...args), preparation]).then(([result]) => result)
        })
        watch(raster, 'render', (original, args) => {
          const phase = !Reflect.get(viewport, 'pathTracingReady') && Reflect.get(viewport, 'pathTracingBuildRunning') ? 'preparing'
            : Reflect.get(viewport, 'pathTracingReady') && !Reflect.get(viewport, 'pathTracingBuildRunning')
              && tracer.dynamicLowRes && Reflect.get(tracer, 'isCompiling') ? 'compiling' : undefined
          if (!observing || !phase) return original(...args)
          const start = shadowDraws
          const flags = { enabled: webgl.shadowMap.enabled, castShadow: sunlight.castShadow, dirty: webgl.shadowMap.needsUpdate }
          const result = original(...args)
          previews.push({ phase, ...flags, shadowDraws: shadowDraws - start, complete: raster.lastFrame.complete, delta: difference(reference.data, pixels().data) })
          return result
        })
        watch(tracer, 'rasterizeSceneCallback', (original, args) => {
          if (tracer.dynamicLowRes && Reflect.get(tracer, 'isCompiling')) compilationCallbacks++
          return original(...args)
        })
        Object.assign(tracer, { dynamicLowRes: true, pausePathTracing: false })
        observing = true
        webgl.shadowMap.needsUpdate = true
        renderer.setSettings({ ...options, pathTracing: true })
        await until(() => { healthy(); return builds > 0 && previews.some(frame => frame.phase === 'preparing') }, 'automatic preparing raster preview', 180000)
        check(webgl.shadowMap.enabled && sunlight.castShadow && webgl.shadowMap.needsUpdate, 'Preparing preview must restore both shadow flags and retain pending invalidation')

        watch(webgl, 'compileAsync', (original, args) => {
          compiles++
          return Promise.all([original(...args), compilation]).then(([result]) => result)
        })
        // Exercise the real compiler/fallback even when this tracer already has a cached program.
        Reflect.get(tracer, '_pathTracer').material.needsUpdate = true
        releasePreparation()
        await until(() => { healthy(); return compiles > 0 && compilationCallbacks > 0 && previews.some(frame => frame.phase === 'compiling') }, 'automatic dynamic-low-res compilation raster preview', 180000)
        check(webgl.shadowMap.enabled && sunlight.castShadow && webgl.shadowMap.needsUpdate, 'Compiling preview must restore both shadow flags and retain pending invalidation')
        for (const phase of ['preparing', 'compiling'] as const) {
          const frames = previews.filter(frame => frame.phase === phase)
          check(frames.length > 0 && frames.every(frame => frame.complete && frame.dirty), `${phase}: must complete real previews with a dirty cached map`)
          check(frames.every(frame => !frame.enabled && !frame.castShadow && frame.shadowDraws === 0), `${phase}: shadow maps must be scoped off without depth draws: ${JSON.stringify(frames)}`)
          check(frames.every(frame => frame.delta.mean <= 0.5 && frame.delta.max <= 2), `${phase}: cached shadows must not be sampled: ${JSON.stringify(frames)}`)
        }
        releaseCompilation()
        await ready()
        observing = false
        check(shadowDraws === warmDraws && sunlight.shadow.map === cachedMap && webgl.shadowMap.needsUpdate, 'Preparation, compilation and real traced samples must leave the dirty cached map undrawn')

        renderer.setSettings(options)
        await idle(180000)
        const restoredDraws = shadowDraws - warmDraws
        const repeat = difference(shadowed.data, pixels().data)
        check(restoredDraws > 0 && !webgl.shadowMap.needsUpdate && webgl.shadowMap.enabled && sunlight.castShadow, 'Switching only path tracing off must consume the pending shadow update')
        check(repeat.mean <= 0.5 && repeat.max <= 2, `Raster must upgrade back to the shadowed pixels: ${JSON.stringify(repeat)}`)

        tracer.pausePathTracing = false
        renderer.setSettings({ ...options, pathTracing: true })
        await ready()
        Reflect.get(viewport, 'stopPathTracingSamples').call(viewport)
        const beforeInspection = shadowDraws
        webgl.shadowMap.needsUpdate = true
        const images = await bounded(renderer.inspect(['iso-front-right']), 'shadowed inspection while tracing')
        const inspectionDraws = shadowDraws - beforeInspection
        check(inspectionDraws > 0 && images[0]?.blob.size > 0, 'Explicit isometric inspection must draw real shadows in PT mode')
        check(Reflect.get(viewport, 'pathTracingEnabled').call(viewport) && webgl.shadowMap.enabled && sunlight.castShadow, 'Inspection must preserve PT mode and shadow flags')
        return { warmDraws, effect, builds, compiles, compilationCallbacks, previews, restoredDraws, repeat, inspectionDraws }
      } finally {
        observing = false
        releasePreparation()
        releaseCompilation()
        for (const restore of restores.splice(restoreStart).reverse()) restore()
        tracer.dynamicLowRes = previous.dynamicLowRes
        tracer.pausePathTracing = false
        renderer.setSettings({ ...options, pathTracing: true })
        try { await ready() }
        finally { tracer.pausePathTracing = previous.pausePathTracing }
      }
    })

    await run('shadows control changes fixed-seed actual traced ground samples', async () => {
      renderer.setSettings({ ...options, pathTracing: true })
      if (!viewport.renderMode) renderer.setRenderMode(true)
      const tracer = await ready()
      const start = { ...counters }
      const measurements = []
      const images: ImageData[] = []
      // At azimuth 0 the suspended block's direct shadow is x=[-7.88,-2.41].
      // The fixed 7x7 probes lie well inside its umbra and a distant lit control.
      const shadow: [number, number, number] = [-5.2, -0.03, 0]
      const lit: [number, number, number] = [5.2, -0.03, 0]
      for (const shadows of [true, false, true]) {
        renderer.setSettings({ ...options, pathTracing: true, shadows })
        const image = await tracedImage()
        images.push(image)
        const materials = Reflect.get(renderer, 'materials') as MeshPhysicalMaterial[]
        const pathCastShadow = Reflect.get(materials[42], 'castShadow') as boolean
        const sourceMaterials = Reflect.get(tracer, '_materials') as MeshPhysicalMaterial[]
        const materialIndex = sourceMaterials.indexOf(materials[42])
        check(materialIndex >= 0, 'Opaque caster must be present in the path-traced scene')
        // three-gpu-pathtracer MaterialsTexture: 47 RGBA texels/material, shadow at texel 14.g.
        const uploadedCastShadow = Reflect.get(tracer, '_pathTracer').material.materials.image.data[materialIndex * 47 * 4 + 14 * 4 + 1]
        check(pathCastShadow === shadows && uploadedCastShadow === Number(shadows), 'Shadows control must update the source and GPU material flag')
        measurements.push({ shadows, samples: tracer.samples, seed: 8, ambient: options.ambient, pathCastShadow, uploadedCastShadow, shadow: mean(roi(image, shadow)), lit: mean(roi(image, lit)) })
      }
      const effect = measurements[1].shadow - measurements[0].shadow
      const litDelta = difference(roi(images[0], lit), roi(images[1], lit))
      const repeat = difference(images[0].data, images[2].data)
      check(effect > 25, `Shadows toggle must brighten the umbra, not just noise: ${JSON.stringify(measurements)}`)
      check(litDelta.mean < 8 && effect > litDelta.mean * 4, `Shadow effect must be localized: ${JSON.stringify({ effect, litDelta })}`)
      check(repeat.max <= 1, `Fixed-seed on/off/on must reproduce the initial image: ${JSON.stringify(repeat)}`)
      check(counters.meshJobs === start.meshJobs && counters.gridJobs === start.gridJobs && counters.builds === start.builds, 'Shadow toggles must update materials without geometry jobs or BVH rebuilds')
      return { viewport: [128, 128], shadowWorld: shadow, litWorld: lit, measurements, effect, litDelta, repeat, geometryJobs: 0, bvhBuilds: 0 }
    })

    await run('normal and color PBR maps update both modes without geometry jobs', async () => {
      const texture = async (color: string) => {
        const canvas = new OffscreenCanvas(4, 4), context = canvas.getContext('2d')!
        context.fillStyle = color
        context.fillRect(0, 0, 4, 4)
        return bounded(canvas.convertToBlob({ type: 'image/png' }), 'PBR texture encode')
      }
      const colorMap = await texture('#e02020'), normalMap = await texture('rgb(250,128,160)')
      const measurements = []
      for (const pathTracing of [false, true]) {
        renderer.setRenderMode(false)
        renderer.setSettings({ ...options, pathTracing })
        renderer.clearPbrMaps(42)
        renderer.setRenderMode(true)
        const read = async () => pathTracing ? tracedImage() : (await idle(), pixels())
        const before = await read(), start = { ...counters }
        const model = Reflect.get(renderer, 'model') as Object3D
        const geometries: unknown[] = []
        model.traverse(object => { if (object instanceof THREE.Mesh) geometries.push(object.geometry) })
        const imageProbe: [number, number, number] = [0, 8, 0]
        await bounded(renderer.setPbrMap(42, 'map', colorMap), 'incremental color map')
        const colored = await read()
        const colorDelta = difference(roi(before, imageProbe), roi(colored, imageProbe))
        await bounded(renderer.setPbrMap(42, 'normalMap', normalMap), 'incremental normal map')
        const normal = await read()
        const normalDelta = difference(roi(colored, imageProbe), roi(normal, imageProbe))
        renderer.clearPbrMaps(42)
        const cleared = await read()
        const clearDelta = difference(roi(before, imageProbe), roi(cleared, imageProbe))
        let geometryIndex = 0
        model.traverse(object => { if (object instanceof THREE.Mesh) check(object.geometry === geometries[geometryIndex++], 'PBR updates must retain mesh buffers') })
        const jobs = { mesh: counters.meshJobs - start.meshJobs, grid: counters.gridJobs - start.gridJobs, bvh: counters.builds - start.builds }
        measurements.push({ pathTracing, samples: pathTracing ? 8 : 0, colorDelta, normalDelta, clearDelta, jobs })
        check(colorDelta.mean > 10 && normalDelta.mean > 3, `Maps must visibly affect real ${pathTracing ? 'traced' : 'raster'} samples: ${JSON.stringify(measurements)}`)
        check(clearDelta.max <= 1 && Object.values(jobs).every(count => count === 0), `PBR maps must clear reproducibly without geometry work: ${JSON.stringify(measurements)}`)
      }
      return measurements
    })
  } catch (error) {
    report.errors.push(`suite: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    report.current = 'restoring dedicated fixture'
    loseDuringBuild = loseDuringCompile = false
    try {
      renderer.setRenderMode(false)
      if (webgl.getContext().isContextLost()) await restoreContext()
      for (const restore of restores.splice(0).reverse()) restore()
      renderer.setDocument(saved.document)
      renderer.setSettings(saved.settings)
      renderer.applySelection({ cells: saved.selection, count: saved.selection.length, floating: saved.floating }, false)
      host.style.width = saved.width
      host.style.height = saved.height
      renderer.setView(saved.view)
      await bounded(renderer.whenMeshIdle(), 'restored fixture meshes')
      if (saved.renderMode) renderer.setRenderMode(true)
      await new Promise(resolve => setTimeout(resolve, 250))
    } catch (error) {
      report.errors.push(`cleanup: ${error instanceof Error ? error.message : String(error)}`)
      for (const restore of restores.splice(0).reverse()) restore()
    }
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    report.ok = report.checks.length === 7 && report.checks.every(result => result.ok) && !report.errors.length
    report.current = 'complete'
    report.running = false
  }
  return report
}
