// Browser import only; run sequentially with other GPU suites and poll window.sceneryChecks.
import type { Mesh, Object3D, DirectionalLight, WebGLRenderTarget } from 'three'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import type { VoxelRenderer } from '../src/editors/model/renderer'
import type { VoxelDocument } from '../src/shared/voxel/document'
import type { ViewSettings } from '../src/shared/rendering/settings'

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
async function until(condition: () => boolean, message: string, timeout = 180000) {
  const deadline = performance.now() + timeout
  while (!condition()) { check(performance.now() < deadline, `Timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 20)) }
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Capture timed out')), 180000) })]) }
  finally { clearTimeout(timer) }
}
function rgb(image: { data: ArrayLike<number>; width: number }, box = [0, 0, image.width, image.width]) {
  const values: number[] = []
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
    const i = (y * image.width + x) * 4; values.push(image.data[i], image.data[i + 1], image.data[i + 2])
  }
  return values
}
function difference(a: ArrayLike<number>, b: ArrayLike<number>) {
  check(a.length > 0 && a.length === b.length, 'Probes need matching nonempty sizes')
  let sum = 0, max = 0
  for (let i = 0; i < a.length; i++) { const delta = Math.abs(a[i] - b[i]); sum += delta; max = Math.max(max, delta) }
  return { mean: sum / a.length, max }
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const config = (tracer: WebGLPathTracer) => ({ tiles: tracer.tiles.clone(), values: {
  dynamicLowRes: tracer.dynamicLowRes, fadeDuration: tracer.fadeDuration, renderScale: tracer.renderScale,
  renderDelay: tracer.renderDelay, minSamples: tracer.minSamples, pausePathTracing: tracer.pausePathTracing,
} })

export async function runSceneryChecks(renderer: VoxelRenderer, settings: ViewSettings, errors: string[]) {
  check(!Reflect.get(window, 'sceneryChecks')?.running, 'Scenery checks are already running')
  const report = { running: true, current: 'setup', results: [] as object[], error: undefined as string | undefined }
  Object.assign(window, { sceneryChecks: report })
  const viewport = renderer.viewport, webgl = viewport.renderer, canvas = webgl.domElement, gl = webgl.getContext()
  const host = Reflect.get(viewport, 'host') as HTMLElement, raster = Reflect.get(viewport, 'raster')
  const hooks = ['ensurePathTracer', 'renderPathTrace'].map(key => ({ key, value: Reflect.get(viewport, key), descriptor: Object.getOwnPropertyDescriptor(viewport, key) }))
  const previousTracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer | undefined
  const saved = { document: Reflect.get(renderer, 'document') as VoxelDocument, settings: { ...viewport.settings }, view: renderer.getView(),
    mode: viewport.renderMode, width: host.style.width, height: host.style.height, ratio: webgl.getPixelRatio(),
    auto: Reflect.get(viewport, 'autoSimplifyRendering'), budget: Reflect.get(raster, 'maxFrameMilliseconds'), tracer: previousTracer && config(previousTracer),
    selection: [...(Reflect.get(renderer, 'selection') as Map<number, { x: number; y: number; z: number }>).values()], floating: Reflect.get(renderer, 'floatingSelection') }
  const configured = new Map<WebGLPathTracer, ReturnType<typeof config>>(), errorStart = errors.length
  let size = 128, restoring = false, vertices: string | undefined
  const geometry = () => {
    const data: unknown[] = []
    ;(Reflect.get(renderer, 'model') as Object3D).traverse(object => { if ((object as Mesh).isMesh) {
      const mesh = object as Mesh; data.push(mesh.uuid, mesh.geometry.uuid, mesh.geometry.getAttribute('position').array, mesh.geometry.index?.array)
    } })
    return JSON.stringify(data)
  }
  const healthy = () => {
    check(errors.length === errorStart, errors.slice(errorStart).join('\n'))
    check(!Reflect.get(viewport, 'pathTracingFailed') && !renderer.meshState().failed, 'Renderer fallback or meshing failure')
    check(!gl.isContextLost() && gl.getError() === gl.NO_ERROR, 'WebGL error or context loss')
    if (vertices) check(geometry() === vertices && renderer.meshState().pending === 0, 'Scenery controls must not remesh or change model vertices')
  }
  const resize = (pixels: number) => {
    size = pixels; host.style.width = host.style.height = `${size / Math.min(devicePixelRatio, 2)}px`; renderer.resize()
    check(canvas.width === size && canvas.height === size, `Host layout/DPR must permit an exact ${size}x${size} buffer`)
  }
  try {
    const [{ VoxelDocument }, THREE] = await Promise.all([import('../src/shared/voxel/document'), import('three')])
    renderer.setRenderMode(false); viewport.setAutoSimplifyRendering(false)
    await until(() => { healthy(); return renderer.meshState().pending === 0 && !Reflect.get(viewport, 'pathTracingBuildRunning') }, 'original renderer idle')
    resize(128); Reflect.set(raster, 'maxFrameMilliseconds', 180000)
    Reflect.set(viewport, 'ensurePathTracer', async () => {
      const tracer = await hooks[0].value.call(viewport) as WebGLPathTracer | undefined
      if (tracer && restoring && saved.tracer) { Object.assign(tracer, saved.tracer.values); tracer.tiles.copy(saved.tracer.tiles) }
      if (tracer && !restoring && !configured.has(tracer)) {
        configured.set(tracer, config(tracer)); Object.assign(tracer, { dynamicLowRes: false, fadeDuration: 0, renderScale: 1, renderDelay: 0, minSamples: 1, pausePathTracing: false }); tracer.tiles.set(1, 1)
      }
      return tracer
    })
    // Cap outside renderPathTrace's finally, which restores the previous pause flag.
    Reflect.set(viewport, 'renderPathTrace', (pause = false) => {
      const value = hooks[1].value.call(viewport, pause), tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer | undefined
      if (!restoring && tracer && tracer.samples >= 8) tracer.pausePathTracing = true
      return value
    })
    const fp = (target: WebGLRenderTarget) => {
      check(target.width === size && target.height === size && (target.texture.type === THREE.FloatType || target.texture.type === THREE.HalfFloatType), 'Read a bounded floating-point GPU target')
      const half = target.texture.type === THREE.HalfFloatType
      const raw = half ? new Uint16Array(size * size * 4).fill(0x7e00) : new Float32Array(size * size * 4).fill(NaN)
      webgl.readRenderTargetPixels(target, 0, 0, size, size, raw)
      const data = Float32Array.from(raw, value => half ? THREE.DataUtils.fromHalfFloat(value) : value)
      check(data.every(Number.isFinite), 'GPU readback contains NaN/Inf or unwritten pixels'); healthy()
      return { data, width: size }
    }
    const read = async (label: string, patch: Partial<ViewSettings>, source?: () => WebGLRenderTarget) => {
      report.current = label; renderer.setSettings({ ...viewport.settings, ...patch })
      let tracer: WebGLPathTracer | undefined
      if (viewport.settings.pathTracing) {
        await until(() => { healthy(); return Reflect.get(viewport, 'pathTracingReady') && !Reflect.get(viewport, 'pathTracingBuildRunning') }, `${label}: preparing`)
        tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer; tracer.pausePathTracing = false
        try { await until(() => { healthy(); report.current = `${label}: ${tracer!.samples}/8`; return tracer!.samples >= 8 && !Reflect.get(tracer!, '_queueReset') }, label) }
        finally { tracer.pausePathTracing = true; Reflect.get(viewport, 'stopPathTracingSamples').call(viewport) }
      } else await until(() => { healthy(); return Reflect.get(viewport, 'rasterFrame') === undefined && !Reflect.get(viewport, 'presentationDirty') }, label)
      const raw = source ? fp(source()) : tracer ? fp(tracer.target) : undefined
      const { blob, view } = await bounded(renderer.capture())
      Reflect.get(viewport, 'stopPathTracingSamples').call(viewport)
      check(canvas.width === size && canvas.height === size && view.viewport.width === size && view.viewport.height === size, 'Capture must stay at 128/160px')
      check(blob.type === 'image/png' && blob.size > 0, 'Capture must export a nonempty PNG')
      if (tracer) check(tracer.samples === 8 && !Reflect.get(viewport, 'traceHidden') && !Reflect.get(viewport, 'presentationDirty'), 'Read exactly 8 presented PBR samples, never fallback')
      const context = new OffscreenCanvas(size, size).getContext('2d')!; context.drawImage(canvas, 0, 0)
      const png = new Uint8Array(await bounded(blob.arrayBuffer())); healthy()
      return { image: context.getImageData(0, 0, size, size), raw, png }
    }
    const base: ViewSettings = { ...settings, previewRenderer: 'standard', pbrMaterials: true, pathTracing: false, skybox: 'solid', showSun: true,
      background: '#000000', ambient: 1.2, light: 2.4, lightAzimuth: 0, shadows: true, ambientOcclusion: false, volumetricLighting: false,
      fogDensity: 1, fogSpread: 0.25, fogColor: '#ffffff', grid: false, faceGrid: false, meshVertices: false, meshTriangles: false, tiltShift: false }
    renderer.setSettings(base); renderer.setDocument(new VoxelDocument()); renderer.setRenderMode(true)
    viewport.scene.traverseVisible(object => check(!(object instanceof THREE.Mesh), 'Empty Render mode must contain no geometry'))
    const sunlight = Reflect.get(viewport, 'sunlight') as DirectionalLight
    const light = () => JSON.stringify([sunlight.intensity, sunlight.color, sunlight.position, sunlight.target.position, sunlight.visible, sunlight.castShadow,
      Reflect.get(viewport, 'hemisphere').intensity, viewport.scene.environmentIntensity, viewport.scene.environment?.uuid, viewport.scene.environmentRotation])
    for (const projection of ['perspective', 'orthographic'] as const) {
      renderer.setSettings({ ...base, projection })
      renderer.setView({ position: { x: 0, y: 16, z: 0 }, target: { x: 40, y: 23, z: 0 }, up: { x: 0, y: 1, z: 0 }, zoom: 1, fov: 55, orthographicSpan: 38 })
      for (const skybox of ['daylight', 'night'] as const) {
        let reference: ImageData | undefined
        for (const pathTracing of [false, true]) {
          const name = `${projection}/${skybox}/${pathTracing ? 'PBR' : 'raster'}`, on = await read(name, { skybox, pathTracing, showSun: true })
          check([[4, 4], [120, 4], [4, 120], [120, 120], [62, 62]].every(([x, y]) => mean(rgb(on.image, [x, y, x + 4, y + 4])) > 4), 'Panorama must cover all corners and center')
          const diversity = [16, 56, 80].map(y => difference(rgb(on.image, [12, y, 28, y + 16]), rgb(on.image, [100, y, 116, y + 16])).mean)
          check(Math.max(...diversity) > 3, `Panorama needs horizontal cloud/terrain diversity: ${diversity}`)
          const parity = reference && difference(rgb(reference), rgb(on.image))
          check(!parity || parity.mean <= 5, `Raster/PBR RGB MAE exceeds 5 (edge maxima diagnostic only): ${JSON.stringify(parity)}`)
          const indicator = host.querySelector<HTMLElement>('.key-light-guide'), illumination = light()
          check(indicator && !indicator.hidden && getComputedStyle(indicator).display !== 'none', 'Show Sun must display its DOM indicator')
          const off = await read(`${name}/hide indicator`, { showSun: false })
          check(indicator.hidden && getComputedStyle(indicator).display === 'none', 'Show Sun false must hide the DOM indicator')
          check(difference(on.png, off.png).max === 0 && light() === illumination, 'Hiding the indicator must change neither PNG nor lighting')
          report.results.push({ name, diversity, parity, finite: !!on.raw, samples: pathTracing ? 8 : 0, indicatorOnly: true }); reference = on.image
        }
      }
    }
    renderer.setRenderMode(false); renderer.setSettings({ ...base, projection: 'orthographic' }); resize(160)
    const roof = new VoxelDocument({ x: 16, y: 16, z: 16 }); roof.palette[40] = 0xffffff
    Object.assign(roof.materials[40], { opacity: 1, transmission: 0, roughness: 1, metalness: 0, emissiveIntensity: 0 })
    for (let z = 0; z < 16; z++) for (let y = 12; y < 14; y++) for (let x = 0; x < 16; x++) if (x % 4 < 2) roof.setVoxel(x, y, z, 40)
    renderer.setDocument(roof)
    await until(() => { healthy(); return renderer.meshState().pending === 0 }, 'roof meshes', 15000)
    renderer.setView({ position: { x: 0, y: 8, z: 38 }, target: { x: 0, y: 8, z: 0 }, up: { x: 0, y: 1, z: 0 }, zoom: 1, orthographicSpan: 24 }); renderer.setRenderMode(true)
    vertices = geometry(); check(vertices !== '[]', 'Roof needs actual model geometry')
    const dim = await read('old-equivalent moonlight', { skybox: 'night', lightAzimuth: 90, light: 2.4 * 0.03 / 0.65 })
    const bright = await read('default moonlight', { light: 2.4 }), roi = [55, 43, 65, 51]
    const moon = { old: mean(rgb(dim.image, roi)), current: mean(rgb(bright.image, roi)) }
    check(Math.abs(sunlight.intensity - 2.4 * 0.65) < 1e-10 && moon.current > moon.old + 10, `Moon must brighten the white roof front-face ROI: ${JSON.stringify(moon)}`)
    report.results.push({ name: 'moonlight', ...moon })
    // Lower-center rays miss the y=12..14 roof; the spread probe lies outside unpadded x bounds.
    const air = [28, 84, 132, 120], fringe = [4, 84, 20, 120], source = () => Reflect.get(raster, 'volumetrics').target as WebGLRenderTarget
    const off = await read('fog off', { skybox: 'solid', light: 5, ambient: 0.05, lightAzimuth: 0 })
    const zero = await read('zero density', { volumetricLighting: true, fogDensity: 0 })
    check(rgb(off.image, air).every(value => value === 0) && rgb(zero.image, air).every(value => value === 0) && !raster.volumetricLighting, 'Zero density must leave exact black empty air and skip scattering')
    const white = await read('white fog', { fogDensity: 1 }, source), blue = await read('blue fog', { fogColor: '#4080ff' }, source)
    const dense = await read('denser fog', { fogDensity: 2 }, source), narrow = await read('zero spread', { fogSpread: 0 })
    const fog = { scattering: difference(rgb(zero.image, air), rgb(white.image, air)), tint: difference(rgb(white.image, air), rgb(blue.image, air)),
      sourceRGB: difference(rgb(white.raw!), rgb(blue.raw!)), density: difference(rgb(blue.image, air), rgb(dense.image, air)), spread: difference(rgb(dense.image, fringe), rgb(narrow.image, fringe)) }
    check(fog.scattering.mean > 0.1 && fog.tint.mean > 0.1 && fog.sourceRGB.mean > 0.0001 && fog.density.mean > 0.1 && fog.spread.mean > 0.1, `Fog controls must affect real GPU pixels: ${JSON.stringify(fog)}`)
    check(rgb(narrow.image, fringe).every(value => value === 0), 'Zero spread must exclude the outside-model empty-air probe')
    report.results.push({ name: 'raster fog', ...fog, verticesUnchanged: true })
    const tracedWhite = await read('PBR white fog', { pathTracing: true, fogDensity: 1, fogSpread: 0.25, fogColor: '#ffffff' })
    const tracedBlue = await read('PBR blue fog', { fogColor: '#4080ff' })
    const tint = difference(rgb(tracedWhite.image, air), rgb(tracedBlue.image, air))
    const redDrop = mean(rgb(tracedWhite.image, air).filter((_, i) => i % 3 === 0)) - mean(rgb(tracedBlue.image, air).filter((_, i) => i % 3 === 0))
    check(tint.mean > 0.1 && redDrop > 0.1, `PBR blue fog must reduce empty-air red scattering: ${JSON.stringify({ tint, redDrop })}`)
    report.results.push({ name: 'PBR fog tint', tint, redDrop, samples: 8, finite: true, verticesUnchanged: true }); healthy()
  } catch (error) { report.error = `${report.current}: ${error instanceof Error ? error.message : String(error)}` }
  finally {
    report.current = 'restoring'; restoring = true; vertices = undefined
    try {
      renderer.setRenderMode(false)
      try { await until(() => !Reflect.get(viewport, 'pathTracingBuildRunning'), 'in-flight trace cleanup') }
      catch (error) { report.error = [report.error, String(error)].filter(Boolean).join('\n') }
      for (const [tracer, previous] of configured) { Object.assign(tracer, previous.values); tracer.tiles.copy(previous.tiles) }
      renderer.setDocument(saved.document); renderer.setSettings(saved.settings)
      renderer.applySelection({ cells: saved.selection, count: saved.selection.length, floating: saved.floating }, false)
      host.style.width = saved.width; host.style.height = saved.height; renderer.setView(saved.view)
      await until(() => { check(!renderer.meshState().failed, 'Restored mesh failed'); return renderer.meshState().pending === 0 }, 'restored meshes', 15000)
      viewport.setAutoSimplifyRendering(saved.auto); renderer.setRenderMode(saved.mode)
      await until(() => !Reflect.get(viewport, 'pathTracingBuildRunning'), 'restored tracer configuration'); healthy()
    } catch (error) { report.error = [report.error, `Restoration: ${String(error)}`].filter(Boolean).join('\n') }
    finally {
      for (const hook of hooks) { if (hook.descriptor) Object.defineProperty(viewport, hook.key, hook.descriptor); else Reflect.deleteProperty(viewport, hook.key) }
      Reflect.set(raster, 'maxFrameMilliseconds', saved.budget); host.style.width = saved.width; host.style.height = saved.height; webgl.setPixelRatio(saved.ratio)
      viewport.setAutoSimplifyRendering(saved.auto); renderer.setRenderMode(saved.mode); report.current = report.error ? 'failed' : 'complete'; report.running = false
    }
  }
  return report
}
