// Dedicated /tests/transparency.html session; run sequentially with the other GPU suites.
// Start transparencyTest.runSkyboxChecks() without holding CDP; poll window.skyboxChecks.
// Imports are deferred so loading the harness does not start GPU checks.
import type { DataTexture, DirectionalLight, HemisphereLight, Mesh, MeshPhysicalMaterial, WebGLRenderTarget } from 'three'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import type { VoxelRenderer } from '../src/editors/model/renderer'
import type { SkyboxPreset, ViewSettings } from '../src/shared/rendering/settings'

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

function patch(image: ImageData, x: number, y: number, radius = 3) {
  x = Math.floor(x); y = Math.floor(y)
  check(x >= radius && y >= radius && x + radius < image.width && y + radius < image.height, 'Skybox pixel probe outside viewport')
  const rgb: number[] = []
  for (let yy = y - radius; yy <= y + radius; yy++) for (let xx = x - radius; xx <= x + radius; xx++) {
    const offset = (yy * image.width + xx) * 4
    check(image.data[offset + 3] === 255, `Sky must cover pixel (${xx},${yy}) with opaque output`)
    rgb.push(image.data[offset], image.data[offset + 1], image.data[offset + 2])
  }
  return rgb
}

function difference(a: ArrayLike<number>, b: ArrayLike<number>) {
  check(a.length > 0 && a.length === b.length, 'Pixel probes must have matching nonzero sizes')
  let sum = 0, max = 0
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i])
    sum += delta; max = Math.max(max, delta)
  }
  return { mean: sum / a.length, max }
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

export async function runSkyboxChecks(renderer: VoxelRenderer, settings: ViewSettings, errors: string[], samples = 8) {
  check(Number.isInteger(samples) && samples >= 4 && samples <= 16, 'Use 4-16 actual skybox path-traced samples')
  const [{ VoxelDocument }, THREE, { SKY_LIGHTING }] = await Promise.all([
    import('../src/shared/voxel/document'), import('three'), import('../src/shared/rendering/sky'),
  ])
  const viewport = renderer.viewport, webgl = viewport.renderer, canvas = webgl.domElement
  const host = Reflect.get(viewport, 'host') as HTMLElement
  const report = { running: true, current: 'setup', ok: false, requestedSamples: samples,
    checks: [] as { name: string; milliseconds: number; details: unknown }[], errors: [] as string[] }
  Object.assign(window, { skyboxChecks: report })
  const saved = {
    document: Reflect.get(renderer, 'document') as InstanceType<typeof VoxelDocument>, settings: { ...viewport.settings },
    view: renderer.getView(), renderMode: viewport.renderMode, width: host.style.width, height: host.style.height,
    ratio: webgl.getPixelRatio(), groundVisible: (Reflect.get(viewport, 'ground') as Mesh).visible,
    selection: [...(Reflect.get(renderer, 'selection') as Map<number, { x: number; y: number; z: number }>).values()],
    floating: Reflect.get(renderer, 'floatingSelection') as boolean,
  }
  const restores: (() => void)[] = []
  const errorStart = errors.length
  const onError = (event: ErrorEvent) => report.errors.push(`uncaught: ${event.error?.stack ?? event.message}`)
  const onRejection = (event: PromiseRejectionEvent) => report.errors.push(`unhandled rejection: ${event.reason?.stack ?? event.reason}`)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  const healthy = () => {
    check(errors.length === errorStart && !report.errors.length, [...errors.slice(errorStart), ...report.errors].join('\n'))
    check(!Reflect.get(viewport, 'pathTracingFailed') && !renderer.meshState().failed, 'Skybox renderer entered fallback or mesher failed')
  }
  const watch = (target: object, key: string, wrapper: (original: (...args: unknown[]) => unknown, args: unknown[]) => unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key), original = Reflect.get(target, key)
    check(typeof original === 'function', `Missing integration method: ${key}`)
    Reflect.set(target, key, function (this: object, ...args: unknown[]) {
      return wrapper((...values) => Reflect.apply(original, this, values), args)
    })
    restores.push(() => descriptor ? Object.defineProperty(target, key, descriptor) : Reflect.deleteProperty(target, key))
  }
  let environments = 0
  const configured = new Set<WebGLPathTracer>()
  const probeMaterial = new THREE.MeshPhysicalMaterial({ metalness: 0.65 })
  const options: ViewSettings = { ...settings, skybox: 'solid', background: '#305070', ambient: 1.2, light: 2.4, lightAzimuth: 0,
    projection: 'orthographic', pathTracing: false, ambientOcclusion: false, shadows: false,
    grid: false, faceGrid: false, meshVertices: false, meshTriangles: false, tiltShift: false }
  const presets = ['solid', 'daylight', 'overcast', 'sunset', 'night'] as const
  const ground = () => Reflect.get(viewport, 'ground') as Mesh
  const sky = () => Reflect.get(viewport, 'skyTexture') as DataTexture | undefined
  const environment = () => Reflect.get(viewport, 'environmentTarget') as WebGLRenderTarget
  const materials = () => Reflect.get(renderer, 'materials') as MeshPhysicalMaterial[]
  let stage = 'setup'
  const traceState = () => {
    const tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer | undefined
    return JSON.stringify({ samples: tracer?.samples, paused: tracer?.pausePathTracing,
      resetQueued: tracer && Reflect.get(tracer, '_queueReset'), ready: Reflect.get(viewport, 'pathTracingReady'),
      building: Reflect.get(viewport, 'pathTracingBuildRunning') })
  }
  const set = (patch: Partial<ViewSettings>) => {
    const tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer | undefined
    if (tracer) tracer.pausePathTracing = true
    renderer.setSettings({ ...viewport.settings, ...patch })
    ground().visible = false
    const { skybox, projection, pathTracing, ambient, light, lightAzimuth } = viewport.settings
    report.current = `${stage}: ${skybox}/${projection}/${pathTracing ? 'PBR' : 'raster'}, ambient=${ambient}, light=${light}, angle=${lightAzimuth}`
  }
  const pixels = () => {
    const copy = new OffscreenCanvas(canvas.width, canvas.height), context = copy.getContext('2d')!
    context.drawImage(canvas, 0, 0)
    return context.getImageData(0, 0, copy.width, copy.height)
  }
  const png = async () => {
    const { blob, view } = await bounded(renderer.capture(), 'skybox PNG capture', 60000)
    check(blob.type === 'image/png' && blob.size > 0, 'Capture must return a nonempty PNG')
    const bitmap = await bounded(createImageBitmap(blob), 'decode skybox PNG')
    try {
      check(bitmap.width === 128 && bitmap.height === 128 && view.viewport.width === 128 && view.viewport.height === 128, 'Skybox PNG and view metadata must be 128x128')
      const copy = new OffscreenCanvas(bitmap.width, bitmap.height), context = copy.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      return context.getImageData(0, 0, copy.width, copy.height)
    } finally { bitmap.close() }
  }
  const idle = () => until(() => {
    healthy()
    return !Reflect.get(viewport, 'contextLost') && renderer.meshState().pending === 0
      && Reflect.get(viewport, 'rasterFrame') === undefined && !Reflect.get(viewport, 'presentationDirty')
  }, 'automatic raster presentation', 60000)
  const ready = () => until(() => {
    healthy()
    return Reflect.get(viewport, 'pathTracingReady') && !Reflect.get(viewport, 'pathTracingBuildRunning')
  }, 'skybox tracer ready', 180000)
  const traced = async () => {
    await ready()
    const tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer
    // reset() zeros the count synchronously; the application's paused RAF must also
    // consume _queueReset before sampling. Do not reset or restart its loop here.
    await until(() => {
      healthy()
      check(tracer.pausePathTracing, 'Sampling resumed before the settings reset was observed')
      return tracer.samples === 0 && !Reflect.get(tracer, '_queueReset')
    }, 'application must invalidate and clear the previous accumulation while paused')
    tracer.pausePathTracing = false
    try {
      await until(() => { healthy(); return tracer.samples >= samples }, `${samples} real skybox samples`, 180000)
    } finally {
      tracer.pausePathTracing = true
      Reflect.get(viewport, 'stopPathTracingSamples').call(viewport)
    }
    check(tracer.samples === samples && tracer.target.width === 128 && tracer.target.height === 128, 'Read only the bounded full-resolution trace, not a preview')
    check(!Reflect.get(viewport, 'presentationDirty'), 'Traced samples must have reached the canvas')
    const image = pixels(), captured = await png()
    check(difference(image.data, captured.data).max <= 1 && tracer.samples === samples, 'PNG must preserve the presented trace without sampling or raster fallback')
    return image
  }
  const run = async (name: string, action: () => Promise<unknown>) => {
    stage = report.current = name
    const started = performance.now(), details = await action()
    healthy()
    const glError = webgl.getContext().getError()
    check(glError === 0, `${name}: unexpected WebGL error ${glError}`)
    report.checks.push({ name, milliseconds: Math.round(performance.now() - started), details })
  }
  const bindings = () => {
    const { skybox, ambient, light, lightAzimuth } = viewport.settings
    const preset = skybox === 'solid' ? undefined : SKY_LIGHTING[skybox]
    const scene = viewport.scene, source = sky()
    const rotation = preset ? -THREE.MathUtils.degToRad(lightAzimuth) : 0
    check(viewport.environment === environment().texture && viewport.environment.mapping === THREE.CubeUVReflectionMapping, 'Raster environment must expose the PMREM target')
    if (preset) {
      check(source && source.name === skybox && source.mapping === THREE.EquirectangularReflectionMapping, 'Selected sky must own the source equirectangular texture')
      check(scene.background === source && scene.environment === source && viewport.environment !== source, 'Background and tracing must bind the source sky, not PMREM or a temporary orthographic color')
    } else {
      check(!source && scene.background instanceof THREE.Color && scene.background.equals(new THREE.Color(options.background)), 'Solid must release the sky and restore the authored background')
      check(scene.environment === Reflect.get(viewport, 'ambientEnvironment'), 'Solid must restore the baseline traced ambient texture')
    }
    check(Math.abs(scene.environmentIntensity - ambient / Math.PI) < 1e-10, 'Traced environment intensity must follow Ambient / pi')
    check(scene.environmentRotation.x === 0 && scene.environmentRotation.z === 0 && Math.abs(scene.environmentRotation.y - rotation) < 1e-10
      && scene.backgroundRotation.equals(scene.environmentRotation), 'Light angle must rotate sky and environment together')
    check((Reflect.get(viewport, 'hemisphere') as HemisphereLight).intensity === (preset ? 0 : ambient), 'Sky lighting must disable the hemisphere; solid must restore it')
    const sunlight = Reflect.get(viewport, 'sunlight') as DirectionalLight
    check(Math.abs(sunlight.intensity - light * (preset?.keyStrength ?? 1)) < 1e-10 && sunlight.color.equals(new THREE.Color(preset?.keyColor ?? '#ffffff')), 'Direct lighting must use the preset color and strength')
    if (preset) {
      const azimuth = THREE.MathUtils.degToRad(lightAzimuth), elevation = THREE.MathUtils.degToRad(preset.elevation)
      const expected = new THREE.Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation))
      check(sunlight.position.clone().sub(sunlight.target.position).normalize().distanceTo(expected) < 1e-8, 'Direct light must follow preset elevation and authored azimuth')
    }
    probeMaterial.envMap = null; probeMaterial.envMapIntensity = -1; probeMaterial.envMapRotation.set(1, 2, 3)
    viewport.applyEnvironment(probeMaterial)
    for (const material of [...[40, 41, 42].map(index => materials()[index]), probeMaterial, ground().material as MeshPhysicalMaterial]) {
      const intensity = preset ? ambient / Math.PI : material === ground().material ? 0 : 0.2 + material.metalness * 0.5
      check(material.envMap === viewport.environment && Math.abs(material.envMapIntensity - intensity) < 1e-10 && material.envMapRotation.equals(scene.environmentRotation), 'Live materials and applyEnvironment must update map, intensity and rotation')
    }
    const version = probeMaterial.version, count = environments
    viewport.applyEnvironment(probeMaterial)
    check(probeMaterial.version === version && environments === count, 'Applying unchanged environment state must be idempotent')
  }
  const probes = (image: ImageData) => [-10, 0, 10].map(x => {
    viewport.camera.updateMatrixWorld(true)
    const point = new THREE.Vector3(x, 10, 0).project(viewport.camera)
    return patch(image, (point.x + 1) * image.width / 2, (1 - point.y) * image.height / 2, 2)
  })
  const tracedRepeat = (before: ImageData, after: ImageData) => {
    const delta = difference(before.data, after.data)
    // This fixture's upper 16 rows miss both the blocks and the recovery ground.
    // Keep deterministic sky pixels strict rather than diluting a mismatch in noise.
    const background = difference(before.data.subarray(0, before.width * 16 * 4), after.data.subarray(0, after.width * 16 * 4))
    check(background.max <= 2, `Restored PBR background differs: ${JSON.stringify(background)}`)
    const average = (rgb: number[]) => [0, 1, 2].map(channel => mean(rgb.filter((_, index) => index % 3 === channel)))
    const previous = probes(before).map(average), next = probes(after).map(average)
    const surfaces = previous.map((rgb, index) => ({ material: ['matte', 'metal', 'glass'][index],
      before: rgb, after: next[index], delta: difference(rgb, next[index]) }))
    // A cold sampler initializes after its first reset; recovered tracers also get
    // new blue-noise offsets. stableNoise does not make these low-sample images exact.
    // At four samples allow 8 levels of image MAE and 12 per averaged material channel.
    const noiseScale = Math.sqrt(4 / samples)
    check(delta.mean <= 8 * noiseScale && surfaces.every(surface => surface.delta.max <= 12 * noiseScale),
      `Restored PBR surface averages differ: ${JSON.stringify({ delta, surfaces, noiseScale })}`)
    return { ...delta, background, surfaces, noiseScale }
  }
  const fixture = new VoxelDocument()
  for (const [index, x0, metalness, transmission, roughness] of [[40, 3, 0, 0, 1], [41, 13, 1, 0, 0.12], [42, 23, 0, 0.9, 0.03]]) {
    fixture.palette[index] = 0xd0d0d0
    Object.assign(fixture.materials[index], { metalness, transmission, roughness, opacity: 1, ior: 1.45, emissiveIntensity: 0 })
    for (let x = x0; x < x0 + 6; x++) for (let y = 3; y < 10; y++) for (let z = 13; z < 19; z++) fixture.setVoxel(x, y, z, index)
  }
  const load = async (document: InstanceType<typeof VoxelDocument>) => {
    renderer.setRenderMode(false)
    set(options)
    renderer.setDocument(document)
    await bounded(renderer.whenMeshIdle(), 'skybox fixture meshes')
    renderer.setView({ position: { x: 0, y: 22, z: 42 }, target: { x: 0, y: 6, z: 0 }, up: { x: 0, y: 1, z: 0 }, zoom: 1, orthographicSpan: 38, fov: 45 })
    renderer.setRenderMode(true)
    ground().visible = false
  }
  let contextControl = webgl.getContext().getExtension('WEBGL_lose_context')
  const restoreContext = async () => {
    check(contextControl, 'Missing context recovery extension')
    contextControl.restoreContext()
    await until(() => !Reflect.get(viewport, 'contextLost') && !webgl.getContext().isContextLost(), 'skybox context restoration', 30000)
  }
  try {
    watch(viewport, 'createEnvironment', (original, args) => { environments++; return original(...args) })
    // renderPathTrace restores pausePathTracing in finally. Cap outside that scope,
    // otherwise it undoes the pause and PNG encoding races the next accumulation.
    watch(viewport, 'renderPathTrace', (original, args) => {
      const value = original(...args)
      const tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer | undefined
      if (tracer && tracer.samples >= samples) tracer.pausePathTracing = true
      return value
    })
    watch(viewport, 'ensurePathTracer', async (original, args) => {
      const tracer = await original(...args) as WebGLPathTracer | undefined
      if (!tracer || configured.has(tracer)) return tracer
      configured.add(tracer)
      const previous = { stableNoise: Reflect.get(tracer, 'stableNoise'), dynamicLowRes: tracer.dynamicLowRes,
        fadeDuration: tracer.fadeDuration, renderDelay: tracer.renderDelay, renderScale: tracer.renderScale,
        pausePathTracing: tracer.pausePathTracing, tiles: tracer.tiles.clone() }
      Object.assign(tracer, { stableNoise: true, dynamicLowRes: false, fadeDuration: 0, renderDelay: 0, renderScale: 1, pausePathTracing: true })
      tracer.tiles.set(1, 1)
      restores.push(() => { const { tiles, ...values } = previous; Object.assign(tracer, values); tracer.tiles.copy(tiles) })
      return tracer
    })
    renderer.setRenderMode(false)
    await bounded(renderer.whenMeshIdle(), 'host meshes')
    host.style.width = host.style.height = `${128 / Math.min(devicePixelRatio, 2)}px`
    renderer.resize()
    check(canvas.width === 128 && canvas.height === 128, 'Skybox viewport must be 128x128')
    await load(fixture)
    const references = new Map<SkyboxPreset, ImageData>()
    for (const pathTracing of [false, true]) await run(`${pathTracing ? 'progressive PBR' : 'raster'} matte, metal, glass and immediate preset PNGs`, async () => {
      set({ ...options, pathTracing })
      const images: ImageData[] = [], measurements: { skybox: SkyboxPreset; brightness: number[] }[] = []
      for (const skybox of [...presets, 'solid'] as const) {
        const previousSky = sky(), previousMap = environment(), previousPreset = viewport.settings.skybox, count = environments
        set({ skybox })
        bindings()
        check(environments - count === Number(skybox !== previousPreset), 'Only preset changes may regenerate the environment')
        if (skybox !== previousPreset) check(environment() !== previousMap && sky() !== previousSky, 'Preset change must replace both source and filtered maps')
        // No RAF or convergence wait: a dirty capture must not export the old preset's trace.
        const immediate = await png()
        if (pathTracing) check(difference(immediate.data, references.get(skybox)!.data).max <= 2, `${skybox}: immediate PBR-mode PNG must show the new raster sky/materials, not stale samples`)
        const image = pathTracing ? await traced() : immediate
        bindings()
        if (!pathTracing && !references.has(skybox)) references.set(skybox, image)
        images.push(image)
        measurements.push({ skybox, brightness: probes(image).map(mean) })
      }
      const effects = ['matte', 'metal', 'glass'].map((material, index) => {
        const daylight = probes(images[1])[index]
        const deltas = images.slice(2, 5).map(image => difference(daylight, probes(image)[index]))
        check(deltas.every(delta => delta.mean > 3), `${material}: each sky preset must affect real surface pixels: ${JSON.stringify(deltas)}`)
        check(measurements[1].brightness[index] > measurements[4].brightness[index] + 8, `${material}: daylight must be visibly brighter than night`)
        return { material, deltas }
      })
      const restored = pathTracing ? tracedRepeat(images[0], images.at(-1)!) : difference(images[0].data, images.at(-1)!.data)
      check(pathTracing || restored.max <= 2, `Switching back to solid must reproduce the raster baseline: ${JSON.stringify(restored)}`)
      return { samples: pathTracing ? samples : 0, measurements, effects, restored }
    })

    await run('ambient and light angle reuse maps while changing real surface lighting', async () => {
      const results = []
      for (const pathTracing of [false, true]) {
        set({ skybox: 'daylight', light: 0, ambient: 1.2, pathTracing })
        const lit = pathTracing ? await traced() : await png()
        const source = sky()!, target = environment(), version = source.version, data = source.image.data, count = environments
        set({ ambient: 0 })
        bindings()
        const dark = pathTracing ? await traced() : await png()
        check(sky() === source && environment() === target && source.version === version && source.image.data === data && environments === count, 'Ambient changes must reuse sky texels and PMREM without regeneration')
        const brightness = probes(lit).map(mean), zero = probes(dark).map(mean)
        check(zero[0] < 8 && zero[1] < 8 && brightness[0] > zero[0] + 10 && brightness[1] > zero[1] + 10, `Ambient must light matte and metal without hidden hemisphere/direct energy: ${JSON.stringify({ brightness, zero })}`)
        check(difference(patch(lit, 8, 8), patch(dark, 8, 8)).max <= 2, 'Ambient must not dim or recolor the visible sky')
        set({ ambient: 1.2, light: 2.4, lightAzimuth: 0 })
        const sideLit = pathTracing ? await traced() : await png()
        set({ lightAzimuth: 90 })
        bindings()
        const frontLit = pathTracing ? await traced() : await png()
        const front = new THREE.Vector3(-10, 6, 3).project(viewport.camera)
        const x = (front.x + 1) * 64, y = (1 - front.y) * 64
        const directEffect = mean(patch(frontLit, x, y, 2)) - mean(patch(sideLit, x, y, 2))
        check(directEffect > 10, `Light angle must rotate real directional lighting onto the matte front face: ${directEffect}`)
        check(sky() === source && environment() === target && source.version === version && source.image.data === data && environments === count, 'Ambient and angle changes must retain the same generated maps')
        results.push({ pathTracing, brightness, zero, directEffect, regeneratedMaps: environments - count })
      }
      return results
    })

    await run('empty sky coverage, raster/PBR sample parity and whole-sky rotation', async () => {
      await load(new VoxelDocument())
      const results = []
      for (const projection of ['perspective', 'orthographic'] as const) {
        set({ projection, pathTracing: false })
        // Aim at sunset's glow. Parallel orthographic rays should all sample this direction.
        renderer.setView({ position: { x: 0, y: 16, z: 0 }, target: { x: 40, y: 23, z: 0 }, up: { x: 0, y: 1, z: 0 }, zoom: 1, orthographicSpan: 38, fov: 55 })
        const raster = new Map<SkyboxPreset, ImageData>()
        for (const pathTracing of [false, true]) {
          set({ pathTracing })
          for (const skybox of presets) {
            set({ skybox, lightAzimuth: 0 })
            const immediate = await png()
            if (pathTracing) check(difference(immediate.data, raster.get(skybox)!.data).max <= 2, `${projection}/${skybox}: immediate empty-sky PNG must update`)
            const image = pathTracing ? await traced() : immediate
            bindings()
            const locations = [[4, 4], [123, 4], [4, 123], [123, 123], [64, 64]]
            const colors = locations.map(([x, y]) => patch(image, x, y, 1))
            check(colors.every(rgb => mean(rgb) > 4), `${projection}/${skybox}: sky must cover corners and center, not a small unit cube`)
            if (projection === 'orthographic' || skybox === 'solid') check(colors.every(rgb => difference(rgb, colors[0]).max <= 1), `${projection}/${skybox}: parallel sky rays must be spatially uniform`)
            else if (skybox === 'sunset') check(difference(colors[0], colors[4]).mean > 3, 'Perspective sky must retain its directional glow, not a flat clear color')
            if (!pathTracing) raster.set(skybox, image)
            else {
              const deltas = locations.map(([x, y]) => difference(patch(image, x, y, 1), patch(raster.get(skybox)!, x, y, 1)))
              check(deltas.every(delta => delta.mean <= 5 && delta.max <= 12), `${projection}/${skybox}: raster and PBR sky samples disagree: ${JSON.stringify(deltas)}`)
              results.push({ projection, skybox, deltas })
            }
          }
          set({ skybox: 'sunset', lightAzimuth: 0 })
          const before = pathTracing ? await traced() : await png()
          const source = sky()!, target = environment(), version = source.version, count = environments
          set({ lightAzimuth: 90 })
          bindings()
          const after = pathTracing ? await traced() : await png()
          const delta = difference(patch(before, 64, 64), patch(after, 64, 64))
          check(delta.mean > 8, `${projection}: Light angle must visibly rotate the sky glow: ${JSON.stringify(delta)}`)
          check(sky() === source && environment() === target && source.version === version && environments === count, 'Light angle must rotate existing source and PMREM maps without regeneration')
          results.push({ projection, pathTracing, rotation: delta, regeneratedMaps: environments - count })
        }
      }
      return results
    })

    await run('context restoration rebinds the selected sky in raster and PBR', async () => {
      if (!contextControl) return { skipped: 'WEBGL_lose_context is unavailable' }
      await load(fixture)
      set({ skybox: 'sunset', lightAzimuth: 37, ambient: 1.8 })
      ground().visible = true
      const results = []
      for (const pathTracing of [false, true]) {
        set({ pathTracing })
        ground().visible = true
        const before = pathTracing ? await traced() : (await idle(), pixels())
        const source = sky(), target = environment(), tracer = Reflect.get(viewport, 'pathTracer'), count = environments
        contextControl = webgl.getContext().getExtension('WEBGL_lose_context')
        check(contextControl, 'Context recovery extension disappeared')
        contextControl.loseContext()
        await until(() => Reflect.get(viewport, 'contextLost') && webgl.getContext().isContextLost(), 'skybox context loss')
        const lossError = webgl.getContext().getError()
        check(lossError === webgl.getContext().CONTEXT_LOST_WEBGL || lossError === 0, `Unexpected error during intentional context loss: ${lossError}`)
        const captureError = await bounded(renderer.capture().then(() => '', error => String(error)), 'lost sky capture rejection', 3000)
        check(/context.*lost/i.test(captureError), 'Capturing a lost sky context must reject rather than return stale PNG data')
        await new Promise(resolve => setTimeout(resolve, 120))
        await restoreContext()
        // Do not capture/render the raster reference: restoration must schedule its own draw.
        const after = pathTracing ? await traced() : (await idle(), pixels())
        bindings()
        check(viewport.settings.skybox === 'sunset' && viewport.settings.lightAzimuth === 37, 'Recovery must retain the chosen sky and light angle')
        check(environments === count + 1 && sky() === source && environment() !== target, 'Recovery must regenerate exactly one sky PMREM and reupload the retained CPU sky')
        if (pathTracing) check(Reflect.get(viewport, 'pathTracer') !== tracer, 'Recovery must replace the lost tracer')
        const delta = pathTracing ? tracedRepeat(before, after) : difference(before.data, after.data)
        check(pathTracing || delta.mean <= 0.5 && delta.max <= 3, `Restored raster sky pixels differ: ${JSON.stringify(delta)}`)
        results.push({ pathTracing, delta, regeneratedMaps: environments - count, captureError })
      }
      return results
    })
    report.ok = true
  } catch (error) {
    report.errors.push(`${report.current}: ${error instanceof Error ? error.message : String(error)}; trace=${traceState()}`)
  } finally {
    report.current = 'restoring host'
    try {
      renderer.setRenderMode(false)
      if (webgl.getContext().isContextLost() || Reflect.get(viewport, 'contextLost')) await restoreContext()
    } catch (error) { report.errors.push(`context cleanup: ${String(error)}`) }
    for (const restore of restores.reverse()) restore()
    probeMaterial.dispose()
    try {
      renderer.setDocument(saved.document)
      renderer.setSettings(saved.settings)
      renderer.applySelection({ cells: saved.selection, count: saved.selection.length, floating: saved.floating }, false)
      host.style.width = saved.width; host.style.height = saved.height
      renderer.setView(saved.view)
      webgl.setPixelRatio(saved.ratio)
      await bounded(renderer.whenMeshIdle(), 'restored host meshes')
      renderer.setRenderMode(saved.renderMode)
      ground().visible = saved.groundVisible
    } catch (error) {
      host.style.width = saved.width; host.style.height = saved.height
      report.errors.push(`host cleanup: ${String(error)}`)
    }
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    report.ok &&= !report.errors.length && errors.length === errorStart
    report.current = 'complete'; report.running = false
  }
  return report
}
