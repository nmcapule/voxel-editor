// Import in the browser, run sequentially with other GPU suites, and poll window.volumetricChecks.
import type { Mesh, Object3D } from 'three'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import type { VoxelRenderer } from '../src/editors/model/renderer'
import type { VoxelDocument } from '../src/shared/voxel/document'
import type { ViewSettings } from '../src/shared/rendering/settings'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function until(condition: () => boolean, message: string, timeout = 180000) {
  const deadline = performance.now() + timeout
  while (!condition()) {
    check(performance.now() < deadline, `Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
function difference(a: ArrayLike<number>, b: ArrayLike<number>) {
  check(a.length > 0 && a.length === b.length, 'Pixel probes need matching nonempty sizes')
  let sum = 0, max = 0
  for (let i = 0; i < a.length; i++) { const delta = Math.abs(a[i] - b[i]); sum += delta; max = Math.max(max, delta) }
  return { mean: sum / a.length, max }
}

export async function runVolumetricChecks(renderer: VoxelRenderer, settings: ViewSettings, errors: string[], samples = 16) {
  const report = { running: true, current: 'setup', results: [] as object[], error: undefined as string | undefined }
  Object.assign(window, { volumetricChecks: report })
  const viewport = renderer.viewport, webgl = viewport.renderer, canvas = webgl.domElement
  const host = Reflect.get(viewport, 'host') as HTMLElement, raster = Reflect.get(viewport, 'raster')
  const ensure = Reflect.get(viewport, 'ensurePathTracer'), descriptor = Object.getOwnPropertyDescriptor(viewport, 'ensurePathTracer')
  const saved = {
    document: Reflect.get(renderer, 'document') as VoxelDocument, settings: { ...viewport.settings }, view: renderer.getView(),
    mode: viewport.renderMode, width: host.style.width, height: host.style.height, ratio: webgl.getPixelRatio(),
    auto: Reflect.get(viewport, 'autoSimplifyRendering') as boolean, budget: Reflect.get(raster, 'maxFrameMilliseconds'),
    selection: [...(Reflect.get(renderer, 'selection') as Map<number, { x: number; y: number; z: number }>).values()],
    floating: Reflect.get(renderer, 'floatingSelection') as boolean,
  }
  const errorStart = errors.length
  const healthy = () => {
    check(errors.length === errorStart, errors.slice(errorStart).join('\n'))
    check(!Reflect.get(viewport, 'pathTracingFailed') && !renderer.meshState().failed, 'Renderer entered fallback or meshing failed')
    check(!webgl.getContext().isContextLost(), 'WebGL context lost')
    check(webgl.getContext().getError() === 0, 'Unexpected WebGL error')
  }
  const pixels = () => {
    check(canvas.width === 160 && canvas.height === 160, 'Suite must render only a 160x160 buffer')
    const context = new OffscreenCanvas(160, 160).getContext('2d')!
    context.drawImage(canvas, 0, 0)
    return context.getImageData(0, 0, 160, 160)
  }
  // All rays in this lower-center rectangle stay below y=8; the only geometry is at y=12..14.
  const empty = (image: ImageData) => {
    const rgb: number[] = []
    for (let y = 84; y < 120; y++) for (let x = 28; x < 132; x++) {
      const i = (y * image.width + x) * 4
      rgb.push(image.data[i], image.data[i + 1], image.data[i + 2])
    }
    return rgb
  }
  try {
    check(Number.isInteger(samples) && samples >= 16 && samples <= 128, 'Use 16-128 real progressive samples')
    const [{ VoxelDocument }, THREE] = await Promise.all([import('../src/shared/voxel/document'), import('three')])
    renderer.setRenderMode(false)
    viewport.setAutoSimplifyRendering(false)
    await until(() => { healthy(); return renderer.meshState().pending === 0 }, 'original meshes', 15000)
    // ResizeObserver and capture policies use device DPR, so bound the actual drawing buffer.
    host.style.width = host.style.height = `${160 / Math.min(devicePixelRatio, 2)}px`
    renderer.resize()
    Reflect.set(raster, 'maxFrameMilliseconds', 180000)
    Reflect.set(viewport, 'ensurePathTracer', async () => {
      const tracer = await ensure.call(viewport) as WebGLPathTracer | undefined
      if (tracer) { Object.assign(tracer, { dynamicLowRes: false, fadeDuration: 0, renderScale: 1 }); tracer.tiles.set(1, 1) }
      return tracer
    })
    const fixture = new VoxelDocument({ x: 16, y: 16, z: 16 })
    fixture.palette[40] = 0xffffff
    Object.assign(fixture.materials[40], { opacity: 1, transmission: 0, roughness: 1, metalness: 0, emissiveIntensity: 0 })
    for (let z = 0; z < 16; z++) for (let y = 12; y < 14; y++) for (let x = 0; x < 16; x++) if (x % 4 < 2) fixture.setVoxel(x, y, z, 40)
    const base: ViewSettings = { ...settings, previewRenderer: 'standard', pbrMaterials: true, skybox: 'solid', background: '#000000',
      ambient: 0.05, light: 5, lightAzimuth: 0, shadows: true, ambientOcclusion: false, volumetricLighting: false, pathTracing: false,
      grid: false, faceGrid: false, meshVertices: false, meshTriangles: false, tiltShift: false }
    renderer.setSettings(base)
    renderer.setDocument(fixture)
    await until(() => { healthy(); return renderer.meshState().pending === 0 }, 'slatted roof meshes', 15000)
    renderer.setRenderMode(true)
    const geometry = () => {
      const ids: string[] = []
      ;(Reflect.get(renderer, 'model') as Object3D).traverse(object => { if ((object as Mesh).isMesh) ids.push(object.uuid, (object as Mesh).geometry.uuid) })
      check(ids.length > 0, 'Roof must have actual rendered geometry')
      return JSON.stringify(ids)
    }
    const originalGeometry = geometry()
    for (const [projection, z] of [['orthographic', 38], ['perspective', 38], ['perspective', 8]] as const) {
      const name = `${projection}/${z === 8 ? 'inside' : 'front'}`
      renderer.setSettings({ ...base, projection })
      renderer.setView({ position: { x: 0, y: 8, z }, target: { x: 0, y: 8, z: 0 }, up: { x: 0, y: 1, z: 0 }, zoom: 1, orthographicSpan: 24, fov: 35 })
      check(projection !== 'orthographic' || viewport.camera.near < 0, 'Exercise the real negative-near orthographic camera')
      const picks = () => [[-3, 12.25, -7], [0, 7, 0]].map(([x, y, z]) => {
        viewport.camera.updateMatrixWorld(true)
        const point = new THREE.Vector3(x, y, z).project(viewport.camera), rect = canvas.getBoundingClientRect()
        check(Math.abs(point.x) < 1 && Math.abs(point.y) < 1, 'Pick probe must be visible')
        return Reflect.get(renderer, 'targetAt').call(renderer, new MouseEvent('mousemove', {
          clientX: rect.left + (point.x + 1) * rect.width / 2, clientY: rect.top + (1 - point.y) * rect.height / 2,
        }))
      })
      const beforePicks = picks(), pickState = JSON.stringify(beforePicks)
      check(beforePicks[0]?.occupied && !beforePicks[1]?.occupied, 'Pick fixture needs an occupied roof and empty air')
      const unchanged = () => {
        healthy()
        check(geometry() === originalGeometry && renderer.meshState().pending === 0, 'Lighting must not replace geometry or schedule meshing')
        check(JSON.stringify(picks()) === pickState, 'Lighting must not change occupied or empty picks')
        viewport.scene.traverse(object => {
          if (object instanceof THREE.Mesh) check(!(Array.isArray(object.material) ? object.material : [object.material])
            .some(material => Reflect.get(material, 'isFogVolumeMaterial')), 'Fog mesh must be absent from the live scene/root')
        })
      }
      const realtime = async (label: string, patch: Partial<ViewSettings>) => {
        report.current = `${name}/realtime ${label}`
        renderer.setSettings({ ...viewport.settings, ...patch })
        await until(() => { healthy(); return Reflect.get(viewport, 'rasterFrame') === undefined && !Reflect.get(viewport, 'presentationDirty') }, report.current)
        unchanged()
        return pixels()
      }
      const off = await realtime('off', {}), background = empty(off)
      check(background.every(value => value === 0), 'Empty-background probes must be black with fog off')
      const on = await realtime('on', { volumetricLighting: true })
      const noShadows = await realtime('shadows off', { shadows: false })
      const angle = await realtime('angle 90', { shadows: true, lightAzimuth: 90 })
      const restored = await realtime('restored off', { volumetricLighting: false, lightAzimuth: 0 })
      const deltas = { fog: difference(background, empty(on)), shadows: difference(empty(on), empty(noShadows)),
        angle: difference(empty(on), empty(angle)), restored: difference(off.data, restored.data) }
      report.results.push({ name, mode: 'realtime', emptyPixels: background.length / 3, ...deltas })
      check(deltas.fog.mean > 0.1 && deltas.shadows.mean > 0.1 && deltas.angle.mean > 0.1, `Empty air must show haze, shadow shafts and light-angle response: ${JSON.stringify(deltas)}`)
      check(deltas.restored.max === 0, `Fog off must restore exact realtime pixels: ${JSON.stringify(deltas.restored)}`)
      const progressive = async (enabled: boolean) => {
        const label = `${name}/progressive ${enabled ? 'on' : 'off'}`
        report.current = `${label}: preparing`
        renderer.setSettings({ ...viewport.settings, pathTracing: true, volumetricLighting: enabled })
        await until(() => { healthy(); return Reflect.get(viewport, 'pathTracingReady') && !Reflect.get(viewport, 'pathTracingBuildRunning') }, report.current)
        const tracer = Reflect.get(viewport, 'pathTracer') as WebGLPathTracer
        try {
          await until(() => { healthy(); report.current = `${label}: ${tracer.samples}/${samples} samples`; return tracer.samples >= samples && !Reflect.get(tracer, '_queueReset') }, label)
        } finally { Reflect.get(viewport, 'stopPathTracingSamples').call(viewport) }
        unchanged()
        check(!Reflect.get(viewport, 'traceHidden') && !Reflect.get(viewport, 'presentationDirty'), 'Read a presented trace, not raster fallback')
        check(Reflect.get(tracer, '_pathTracer').material.defines.FEATURE_FOG === Number(enabled), 'FEATURE_FOG must follow the app setting after convergence')
        const fog = Reflect.get(viewport, 'traceFog') as Mesh | undefined
        if (enabled) check(fog && !fog.parent && (z !== 8 || new THREE.Box3().setFromObject(fog).containsPoint(viewport.camera.position)), 'Inside camera must be in the detached fog volume')
        const target = tracer.target
        check(target.width === 160 && target.height === 160 && target.texture.type === THREE.FloatType, 'Read the real 160x160 HDR trace target')
        const raw = new Float32Array(160 * 160 * 4).fill(NaN)
        webgl.readRenderTargetPixels(target, 0, 0, 160, 160, raw)
        check(raw.every(Number.isFinite), 'Progressive HDR readback must contain no NaN/Inf or unwritten pixels')
        healthy()
        return { image: pixels(), samples: tracer.samples, peakRadiance: raw.reduce((max, value, i) => i % 4 === 3 ? max : Math.max(max, value), 0) }
      }
      const tracedOn = await progressive(true), tracedOff = await progressive(false)
      const delta = difference(empty(tracedOn.image), empty(tracedOff.image))
      report.results.push({ name, mode: 'progressive', samples: [tracedOn.samples, tracedOff.samples], emptyDifference: delta,
        peakRadiance: [tracedOn.peakRadiance, tracedOff.peakRadiance], finite: true, featureCleared: true })
      check(delta.mean > 0.1 && empty(tracedOff.image).every(value => value === 0), `Converged fog off must clear empty-air scattering: ${JSON.stringify(delta)}`)
    }
  } catch (error) { report.error = `${report.current}: ${error instanceof Error ? error.message : String(error)}` }
  finally {
    report.current = 'restoring'
    renderer.setRenderMode(false)
    if (descriptor) Object.defineProperty(viewport, 'ensurePathTracer', descriptor); else Reflect.deleteProperty(viewport, 'ensurePathTracer')
    Reflect.set(raster, 'maxFrameMilliseconds', saved.budget)
    host.style.width = saved.width; host.style.height = saved.height
    try {
      renderer.setDocument(saved.document)
      renderer.setSettings(saved.settings)
      renderer.applySelection({ cells: saved.selection, count: saved.selection.length, floating: saved.floating }, false)
      renderer.setView(saved.view)
      await until(() => { check(!renderer.meshState().failed, 'Restored mesh failed'); return renderer.meshState().pending === 0 }, 'restored meshes', 15000)
    } catch (error) { report.error = [report.error, `Restoration: ${String(error)}`].filter(Boolean).join('\n') }
    finally {
      webgl.setPixelRatio(saved.ratio)
      viewport.setAutoSimplifyRendering(saved.auto)
      renderer.setRenderMode(saved.mode)
      report.current = report.error ? 'failed' : 'complete'; report.running = false
    }
  }
  return report
}
