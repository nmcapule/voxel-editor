// Browser checks, loaded by tests/transparency.ts. Run the suites sequentially.
// Runtime imports are deferred so merely opening the harness does not start GPU checks.
import type { Camera, DirectionalLight, InstancedMesh, Mesh, Object3D, WebGLRenderer, WebGLRenderTarget } from 'three'
import type { VoxelDocument } from '../src/editor'
import type { VoxelRenderer } from '../src/renderer'
import type { ViewSettings } from '../src/storage'

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

async function until(condition: () => boolean, message: string, timeout = 15000) {
  const started = performance.now()
  while (!condition()) {
    check(performance.now() - started < timeout, `Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function image(renderer: VoxelRenderer) {
  const { blob } = await renderer.capture()
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, canvas.width, canvas.height)
  } finally {
    bitmap.close()
  }
}

function patch(image: ImageData, x: number, y: number, radius = 8) {
  const result: number[] = []
  x = Math.floor(x); y = Math.floor(y)
  check(x - radius >= 0 && y - radius >= 0 && x + radius < image.width && y + radius < image.height, 'Pixel probe must be inside the viewport')
  for (let yy = y - radius; yy <= y + radius; yy++) for (let xx = x - radius; xx <= x + radius; xx++) {
    const offset = (yy * image.width + xx) * 4
    result.push(image.data[offset], image.data[offset + 1], image.data[offset + 2])
  }
  return result
}

function difference(a: ArrayLike<number>, b: ArrayLike<number>) {
  check(a.length === b.length && a.length > 0, 'Image probes must have matching nonzero sizes')
  let sum = 0, max = 0
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i])
    sum += delta
    max = Math.max(max, delta)
  }
  return { mean: sum / a.length, max }
}

function fill(document: VoxelDocument, material: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) document.setVoxel(x, y, z, material)
}

async function withViewport<T>(renderer: VoxelRenderer, size: number, run: () => Promise<T>) {
  const host = Reflect.get(renderer, 'host') as HTMLElement
  const webgl = Reflect.get(renderer, 'renderer') as WebGLRenderer
  const saved = {
    document: Reflect.get(renderer, 'document') as VoxelDocument,
    settings: { ...Reflect.get(renderer, 'settings') } as ViewSettings,
    view: renderer.getView(), renderMode: Reflect.get(renderer, 'renderMode') as boolean,
    width: host.style.width, height: host.style.height, ratio: webgl.getPixelRatio(),
    selection: [...(Reflect.get(renderer, 'selection') as Map<number, { x: number; y: number; z: number }>).values()],
    floating: Reflect.get(renderer, 'floatingSelection') as boolean,
    tool: Reflect.get(renderer, 'tool') as Parameters<VoxelRenderer['setTool']>[0],
    sculptMode: Reflect.get(renderer, 'sculptMode') as Parameters<VoxelRenderer['setSculptMode']>[0],
  }
  renderer.setRenderMode(false)
  await renderer.whenMeshIdle()
  try {
    host.style.width = host.style.height = `${size}px`
    webgl.setPixelRatio(1)
    renderer.resize()
    return await run()
  } finally {
    renderer.setRenderMode(false)
    renderer.setDocument(saved.document)
    renderer.setSettings(saved.settings)
    renderer.setTool(saved.tool)
    renderer.setSculptMode(saved.sculptMode)
    renderer.applySelection({ cells: saved.selection, count: saved.selection.length, floating: saved.floating }, false)
    host.style.width = saved.width
    host.style.height = saved.height
    webgl.setPixelRatio(saved.ratio)
    renderer.setView(saved.view)
    await renderer.whenMeshIdle()
    if (saved.renderMode) renderer.setRenderMode(true)
  }
}

export async function runRenderingChecks(renderer: VoxelRenderer, settings: ViewSettings, errors: string[]) {
  const [{ VoxelDocument }, THREE] = await Promise.all([import('../src/editor'), import('three')])
  return withViewport(renderer, 512, async () => {
    const baseline: ViewSettings = { ...settings, projection: 'orthographic', pathTracing: false, ambientOcclusion: false, shadows: false, grid: false, faceGrid: false }
    const webgl = Reflect.get(renderer, 'renderer') as WebGLRenderer
    const errorStart = errors.length
    const counters = { raster: 0, webgl: 0, workerMessages: 0, meshJobs: 0, gridJobs: 0 }
    const jobs: { type: string; count: number }[] = []
    const restores: (() => void)[] = []
    const watch = (target: object, key: string, before: (args: unknown[]) => void) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      const original = Reflect.get(target, key)
      check(typeof original === 'function', `Missing integration method: ${key}`)
      Reflect.set(target, key, function (this: object, ...args: unknown[]) {
        before(args)
        return Reflect.apply(original, this, args)
      })
      restores.push(() => descriptor ? Object.defineProperty(target, key, descriptor) : Reflect.deleteProperty(target, key))
    }
    watch(renderer, 'renderRaster', () => counters.raster++)
    watch(webgl, 'render', () => counters.webgl++)
    watch(Worker.prototype, 'postMessage', ([data]) => {
      counters.workerMessages++
      const message = data as { type: string; jobs?: unknown[] }
      if (message.type !== 'mesh' && message.type !== 'grid') return
      const count = message.jobs?.length ?? 0
      jobs.push({ type: message.type, count })
      if (message.type === 'mesh') counters.meshJobs += count
      else counters.gridJobs += count
    })
    const results: { name: string; counters: typeof counters; details: unknown }[] = []
    const run = async (name: string, action: () => Promise<unknown>) => {
      const before = { ...counters }
      try {
        const details = await action()
        check(errors.length === errorStart, errors.slice(errorStart).join('\n'))
        results.push({ name, details, counters: Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value - before[key as keyof typeof counters]])) as typeof counters })
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
    const fixture = (dimensions = { x: 32, y: 32, z: 32 }) => {
      const document = new VoxelDocument(dimensions)
      for (const [index, color, opacity, transmission] of [[40, 0xf53020, 0.55, 0], [41, 0x54bdff, 1, 0.85], [42, 0xe9e9e9, 1, 0], [43, 0xff9b27, 0.8, 0.65]]) {
        document.palette[index] = color
        Object.assign(document.materials[index], { opacity, transmission, roughness: 0.02, metalness: 0, ior: 1, emissiveIntensity: index === 42 ? 0.25 : 0.1 })
      }
      return document
    }
    const frontView = () => renderer.setView({ position: { x: 0, y: 9, z: 45 }, target: { x: 0, y: 9, z: 0 }, up: { x: 0, y: 1, z: 0 }, zoom: 1, orthographicSpan: 32 })
    const load = async (document: VoxelDocument, options: Partial<ViewSettings> = {}) => {
      renderer.setSettings({ ...baseline, ...options })
      renderer.setDocument(document)
      await renderer.whenMeshIdle()
      frontView()
    }
    const at = (pixels: ImageData, x: number, y: number, z: number, radius = 8) => {
      const document = Reflect.get(renderer, 'document') as VoxelDocument
      const camera = Reflect.get(renderer, 'camera') as Camera
      camera.updateMatrixWorld(true)
      const point = new THREE.Vector3(x - document.dimensions.x / 2, y, z - document.dimensions.z / 2).project(camera)
      return patch(pixels, (point.x + 1) * pixels.width / 2, (1 - point.y) * pixels.height / 2, radius)
    }
    const faceGrids = () => {
      const grids: Mesh[] = []
      ;(Reflect.get(renderer, 'model') as Object3D).traverse(object => { if (object.userData.faceGrid) grids.push(object as Mesh) })
      return grids
    }
    try {
      await run('alpha behind and in front of transmission', async () => {
        const samples: number[][] = []
        for (const alphaZ of [14, 22]) {
          const document = fixture()
          fill(document, 42, 6, 5, 10, 14, 13, 11)
          fill(document, 41, 6, 5, 18, 14, 13, 19)
          await load(document)
          const without = at(await image(renderer), 10, 9, 19)
          fill(document, 40, 6, 5, alphaZ, 14, 13, alphaZ + 1)
          renderer.markDirty(document.chunks.keys())
          const withAlpha = at(await image(renderer), 10, 9, alphaZ + 1)
          check(difference(withAlpha, without).mean > 5, `Alpha at z=${alphaZ} must contribute, including when behind transmission`)
          samples.push(withAlpha)
        }
        const orderDelta = difference(samples[0], samples[1])
        check(orderDelta.mean > 2, 'Moving alpha across glass must change compositing order')
        return { orderDelta }
      })

      await run('disconnected visible objects do not reorder another stack', async () => {
        const document = fixture()
        fill(document, 42, 6, 5, 10, 14, 13, 11)
        fill(document, 43, 6, 5, 14, 14, 13, 15)
        fill(document, 41, 6, 5, 18, 14, 13, 19)
        await load(document)
        const before = await image(renderer)
        fill(document, 43, 22, 7, 28, 27, 12, 29)
        renderer.markDirty(document.chunks.keys())
        const after = await image(renderer)
        const isolated = difference(at(before, 10, 9, 19, 24), at(after, 10, 9, 19, 24))
        const added = difference(at(before, 24, 9, 29), at(after, 24, 9, 29))
        check(added.mean > 5, 'The disconnected object must actually be visible, not outside the frustum')
        check(isolated.max <= 2, `Disconnected visible geometry changed the original stack: ${JSON.stringify(isolated)}`)
        return { isolated, added }
      })

      await run('two simultaneous stacks with reversed material order match isolated references', async () => {
        const document = fixture()
        for (const [x, rear, front] of [[6, 43, 41], [20, 41, 43]]) {
          fill(document, 42, x, 5, 10, x + 6, 13, 11)
          fill(document, rear, x, 5, 14, x + 6, 13, 15)
          fill(document, front, x, 5, 18, x + 6, 13, 19)
        }
        await load(document)
        const both = await image(renderer)
        const deltas = []
        for (const [x, rear, front] of [[6, 43, 41], [20, 41, 43]]) {
          const single = fixture()
          fill(single, 42, x, 5, 10, x + 6, 13, 11)
          fill(single, rear, x, 5, 14, x + 6, 13, 15)
          fill(single, front, x, 5, 18, x + 6, 13, 19)
          await load(single)
          const isolated = await image(renderer)
          const delta = difference(at(both, x + 3, 9, 19, 20), at(isolated, x + 3, 9, 19, 20))
          check(delta.max <= 2, `Stack at x=${x} disagrees with its isolated depth order: ${JSON.stringify(delta)}`)
          fill(single, 0, x, 5, 14, x + 6, 13, 15)
          renderer.markDirty(single.chunks.keys())
          check(difference(at(isolated, x + 3, 9, 19), at(await image(renderer), x + 3, 9, 19)).mean > 3, 'The rear medium must contribute in each stack')
          deltas.push(delta)
        }
        return deltas
      })

      await run('top-down transparent interface and L-junction have no physical gaps', async () => {
        let probes = 0
        for (const rows of [['AB'], ['AB', 'B.']]) {
          const document = fixture()
          for (const index of [41, 43]) {
            document.palette[index] = 0xffffff
            Object.assign(document.materials[index], { opacity: 1, transmission: 0.01, emissiveIntensity: 2 })
          }
          rows.forEach((row, z) => [...row].forEach((cell, x) => { if (cell !== '.') document.setVoxel(15 + x, 8, 15 + z, cell === 'A' ? 41 : 43) }))
          await load(document, { background: '#000000' })
          renderer.setView({ position: { x: 0, y: 40, z: 0 }, target: { x: 0, y: 9, z: 0 }, up: { x: 0, y: 0, z: -1 }, zoom: 1, orthographicSpan: 4 })
          const pixels = await image(renderer)
          rows.forEach((row, z) => [...row].forEach((cell, x) => {
            if (cell === '.') {
              check(Math.max(...at(pixels, 15.5 + x, 9, 15.5 + z, 0)) < 20, 'The L fixture must retain its missing corner')
              return
            }
            for (const dx of [0.01, 0.02, 0.5, 0.98, 0.99]) for (const dz of [0.01, 0.02, 0.5, 0.98, 0.99]) {
              const rgb = at(pixels, 15 + x + dx, 9, 15 + z + dz, 0)
              check(Math.min(...rgb) > 64, `Surface gap at (${15 + x + dx},9,${15 + z + dz}): ${rgb}`)
              probes++
            }
          }))
        }
        return { probes }
      })

      await run('opacity-zero geometry and visible editor helpers do not affect AO', async () => {
        const document = fixture()
        document.palette[42] = 0x4f5664
        Object.assign(document.materials[42], { emissiveIntensity: 0, roughness: 1 })
        fill(document, 42, 8, 0, 8, 24, 1, 24)
        fill(document, 42, 8, 1, 8, 10, 8, 24)
        document.materials[40].opacity = 0
        await load(document, { ambientOcclusion: true })
        renderer.setView({ position: { x: 22, y: 21, z: 27 }, target: { x: 0, y: 2, z: 0 }, up: { x: 0, y: 1, z: 0 }, orthographicSpan: 26 })
        const readAO = () => {
          const raster = Reflect.get(renderer, 'raster')
          check(raster?.ambientOcclusion?.enabled, 'RasterPipeline AO must be enabled')
          const target = raster.ambientOcclusion.pdRenderTarget as WebGLRenderTarget
          const raw = new Uint16Array(target.width * target.height * 4)
          webgl.readRenderTargetPixels(target, 0, 0, target.width, target.height, raw)
          const values = Float32Array.from(raw, THREE.DataUtils.fromHalfFloat)
          check(values.every(Number.isFinite), 'AO readback must be finite')
          return values
        }
        const original = await image(renderer)
        const originalAO = readAO()
        check(originalAO.some((value, index) => index % 4 === 0 && value < 0.95) && originalAO.some((value, index) => index % 4 === 0 && value > 0.99), 'AO fixture must include both occluded and unoccluded pixels')
        fill(document, 40, 12, 1, 14, 16, 4, 18)
        renderer.markDirty(document.chunks.keys())
        const invisible = await image(renderer)
        const zeroAO = difference(originalAO, readAO())
        check(zeroAO.max <= 0.002, `Opacity-zero voxels changed underlying AO: ${JSON.stringify(zeroAO)}`)
        check(difference(original.data, invisible.data).max <= 2, 'Opacity-zero voxels must not change the image')
        renderer.applySelection({ cells: [{ x: 14, y: 0, z: 12 }], count: 1 }, false)
        const hover = Reflect.get(renderer, 'hover') as Object3D
        hover.position.set(4, 2, 0)
        hover.visible = true
        try {
          const helpers = await image(renderer)
          const helperAO = difference(originalAO, readAO())
          check(helperAO.max <= 0.002, `Editor helpers changed underlying AO: ${JSON.stringify(helperAO)}`)
          check(difference(invisible.data, helpers.data).max > 10, 'The helper fixture must contain a visibly rendered overlay')
          return { zeroAO, helperAO }
        } finally {
          hover.visible = false
          renderer.clearSelection()
        }
      })

      await run('tall caster bounds fit the directional shadow frustum', async () => {
        const document = fixture({ x: 16, y: 256, z: 16 })
        for (const [x, y, z] of [[0, 0, 0], [15, 0, 15], [0, 255, 15], [15, 255, 0]]) document.setVoxel(x, y, z, 42)
        await load(document, { shadows: true })
        const sunlight = Reflect.get(renderer, 'sunlight') as DirectionalLight
        const model = Reflect.get(renderer, 'model') as Object3D
        const bounds = new THREE.Box3().setFromObject(model)
        let corners = 0
        for (const lightAzimuth of [0, 42, 90, 225]) {
          renderer.setSettings({ ...baseline, shadows: true, lightAzimuth })
          sunlight.updateMatrixWorld(true)
          sunlight.target.updateMatrixWorld(true)
          sunlight.shadow.updateMatrices(sunlight)
          const camera = sunlight.shadow.camera
          check(camera.near > 0 && camera.far > camera.near, 'Shadow camera needs a valid positive depth interval')
          for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
            const clip = new THREE.Vector3(x, y, z).project(camera)
            check([clip.x, clip.y, clip.z].every(value => Number.isFinite(value) && Math.abs(value) <= 1.00001), `Tall caster clipped at azimuth ${lightAzimuth}: (${x},${y},${z}) -> ${clip.toArray()}`)
            corners++
          }
        }
        return { corners }
      })

      await run('palette color edits update pixels without mesher jobs', async () => {
        const document = fixture()
        fill(document, 42, 6, 5, 18, 14, 13, 19)
        await load(document)
        const before = at(await image(renderer), 10, 9, 19)
        const start = jobs.length
        document.palette[42] = 0xe02040
        renderer.updatePalette()
        const delta = difference(before, at(await image(renderer), 10, 9, 19))
        check(delta.mean > 10, 'A palette color edit must change rendered pixels')
        check(jobs.length === start, 'A color-only palette edit must send no mesh or grid jobs')
        return { delta, jobs: jobs.length - start }
      })

      await run('grid on/off/on reuses geometry; editing while off regenerates grid only on demand', async () => {
        const document = fixture()
        document.setVoxel(5, 5, 5, 42)
        await load(document)
        const start = jobs.length
        const setGrid = async (enabled: boolean) => {
          renderer.setSettings({ ...baseline, faceGrid: enabled })
          await renderer.whenMeshIdle()
          if (enabled) await until(() => faceGrids().some(grid => grid.visible) && renderer.meshState().pending === 0, 'visible face grid')
        }
        await setGrid(true)
        check(jobs.slice(start).some(job => job.type === 'grid') && jobs.slice(start).every(job => job.type === 'grid'), 'Enabling the first grid must not remesh surfaces')
        const geometries = faceGrids().map(grid => grid.geometry)
        const reusable = jobs.length
        await setGrid(false)
        check(faceGrids().every(grid => !grid.visible), 'Disabling the grid must hide its lines')
        await setGrid(true)
        check(jobs.length === reusable && faceGrids().every(grid => geometries.includes(grid.geometry)), 'On/off/on must reuse cached grid buffers without worker jobs')
        await setGrid(false)
        const edit = jobs.length
        document.setVoxel(6, 5, 5, 42)
        renderer.markDirty(document.chunks.keys())
        await renderer.whenMeshIdle()
        check(jobs.slice(edit).some(job => job.type === 'mesh') && jobs.slice(edit).every(job => job.type === 'mesh'), 'Editing with the grid off should build only surfaces')
        const regenerate = jobs.length
        await setGrid(true)
        check(jobs.slice(regenerate).some(job => job.type === 'grid') && jobs.slice(regenerate).every(job => job.type === 'grid'), 'Re-enabling a stale grid must schedule only grid jobs')
        const bounds = new THREE.Box3()
        for (const grid of faceGrids()) bounds.expandByObject(grid)
        const maxX = bounds.max.x
        check(maxX === 7 - document.dimensions.x / 2, 'Regenerated grid must cover the newly added voxel, not cached old geometry')
        return { initial: jobs.slice(start, reusable), edit: jobs.slice(edit, regenerate), regenerate: jobs.slice(regenerate), maxX }
      })

      await run('push preview capacity follows requested cells, not maximum range', async () => {
        const document = fixture({ x: 16, y: 256, z: 16 })
        const cells = []
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
          document.setVoxel(x, 0, z, 42)
          cells.push({ x, y: 0, z })
        }
        await load(document)
        renderer.setTool('sculpt')
        renderer.setSculptMode('push')
        renderer.applySelection({ cells, count: cells.length }, false)
        const target = { cell: cells[0], normal: { x: 0, y: 1, z: 0 }, occupied: true, color: 42 }
        try {
          check(Reflect.get(renderer, 'startPushPull').call(renderer, new PointerEvent('pointerdown', { clientX: 100, clientY: 100 }), target), 'Push fixture must start a real drag')
          const drag = Reflect.get(renderer, 'pushPullDrag') as { max: number; screenX: number; screenY: number }
          const preview = () => Reflect.get(renderer, 'pushPullPreview') as InstancedMesh
          const initialCapacity = preview().instanceMatrix.count
          check(drag.max >= 250, 'Push fixture must expose a near-maximum workspace range')
          check(initialCapacity >= cells.length && initialCapacity <= cells.length * 2, `Initial preview overallocates: ${initialCapacity} matrices for ${cells.length} cells`)
          const capacities = [initialCapacity]
          for (const distance of [2, 17, 1]) {
            Reflect.get(renderer, 'movePushPull').call(renderer, new PointerEvent('pointermove', { clientX: 100 + drag.screenX * distance, clientY: 100 + drag.screenY * distance }))
            check(preview().count === cells.length * distance, 'Preview must contain exactly the requested ghost cells')
            if (distance !== 1) check(preview().instanceMatrix.count >= preview().count && preview().instanceMatrix.count <= preview().count * 2, 'Growing preview capacity must remain proportional to requested ghosts')
            capacities.push(preview().instanceMatrix.count)
          }
          check(capacities[3] === capacities[2], 'Reducing drag distance should reuse preview capacity')
          return { cells: cells.length, maxRange: drag.max, capacities, matrixBytes: capacities.map(count => count * 16 * 4) }
        } finally {
          renderer.setTool('select')
          renderer.clearSelection()
        }
      })

      await run('raster requests coalesce into one pipeline frame', async () => {
        renderer.setSettings(baseline)
        await renderer.whenMeshIdle()
        await image(renderer)
        const before = { ...counters }
        for (let i = 0; i < 20; i++) renderer.render()
        await new Promise(requestAnimationFrame)
        check(counters.raster - before.raster === 1, 'Multiple synchronous render requests should share one raster frame')
        check(counters.webgl > before.webgl, 'The raster request must issue actual WebGL draws')
        return { rasterCalls: counters.raster - before.raster, webglRenderCalls: counters.webgl - before.webgl }
      })
      check(jobs.every(job => job.count === 1), 'Each worker mesh/grid message must contain exactly one job')
      return { checks: results, counters: { ...counters }, workerMessages: jobs }
    } finally {
      for (const restore of restores.reverse()) restore()
    }
  })
}

// Controlled RAF and BVH completion: no GPU sampling or real BVH workers.
export async function runRendererStateChecks(renderer: VoxelRenderer) {
  const { Scene, PerspectiveCamera } = await import('three')
  const makeProbe = (tracer: object) => {
    const probe = Object.create(Object.getPrototypeOf(renderer))
    // Carry primitive lifecycle epochs from the current integration, but never
    // borrow its workers, timers or GPU resources for failure/disposal checks.
    for (const key of Reflect.ownKeys(renderer)) {
      const value = Reflect.get(renderer, key)
      if (value === null || typeof value !== 'object' && typeof value !== 'function') Reflect.set(probe, key, value)
      else if (value instanceof Set) Reflect.set(probe, key, new Set())
      else if (value instanceof Map) Reflect.set(probe, key, new Map())
    }
    const log = { errors: [] as string[], statuses: [] as string[], raster: 0, started: 0 }
    Object.assign(probe, {
      settings: { ...Reflect.get(renderer, 'settings'), pathTracing: true }, renderMode: true,
      renderer: { getContext: () => ({ isContextLost: () => false }) }, scene: new Scene(), camera: new PerspectiveCamera(),
      pathTracer: tracer, pathTracingFrame: undefined, pathTracingReady: false, pathTracingFailed: false,
      pathTracingBuildRunning: false, pathTracingBuildRequested: false, inFlight: 0, fpsIdleTimer: undefined, rasterFrame: undefined,
      callbacks: new Proxy({ onError: (message: string) => log.errors.push(message), onPathTracingStatus: (message: string) => log.statuses.push(message) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }),
      ensurePathTracer: async () => tracer, renderRaster: () => log.raster++, resetFps() {}, recordFrame() {},
    })
    return { probe, log }
  }
  const pending = new Map<number, FrameRequestCallback>()
  const originalRequest = window.requestAnimationFrame
  const originalCancel = window.cancelAnimationFrame
  let nextFrame = 0, attempts = 0
  const sampling = makeProbe({ samples: 0, reset() {}, dispose() {}, renderSample() { attempts++; throw new Error('Injected sample failure') } })
  try {
    window.requestAnimationFrame = callback => { pending.set(++nextFrame, callback); return nextFrame }
    window.cancelAnimationFrame = id => { pending.delete(id) }
    sampling.probe.pathTracingReady = true
    sampling.probe.startPathTracingSamples()
    check(pending.size === 1, 'Sampling must schedule one frame')
    const [id, callback] = [...pending][0]
    pending.delete(id)
    callback(performance.now())
    for (const [frame, fallback] of [...pending]) { pending.delete(frame); fallback(performance.now()) }
    check(attempts === 1 && pending.size === 0, 'A failed sample must render fallback once, not leave a repeating animation loop')
    check(sampling.probe.pathTracingFailed && !sampling.probe.pathTracingReady, 'Sample failure must disable tracing')
    check(sampling.log.errors.length === 1 && sampling.log.statuses.includes('Raster fallback') && sampling.log.raster > 0, 'Sample failure must report once and draw a raster fallback')
  } finally {
    window.requestAnimationFrame = originalRequest
    window.cancelAnimationFrame = originalCancel
  }

  const releases: (() => void)[] = []
  const stale = makeProbe({ samples: 0, reset() {}, dispose() {}, setSceneAsync: () => new Promise<void>(resolve => releases.push(resolve)) })
  stale.probe.startPathTracingSamples = () => { stale.log.started++ }
  stale.probe.pathTracingBuildRequested = true
  const first = stale.probe.buildPathTrace() as Promise<void>
  try {
    await until(() => releases.length === 1, 'first stub scene build')
    stale.probe.inFlight = 1
    stale.probe.requestPathTraceRebuild()
    releases[0]()
    await first
    check(!stale.probe.pathTracingReady && stale.log.started === 0, 'Obsolete async geometry must not become ready or start sampling while newer meshes are pending')
    stale.probe.inFlight = 0
    stale.probe.requestPathTraceRebuild()
    await until(() => releases.length === 2, 'replacement stub scene build')
    releases[1]()
    await until(() => !stale.probe.pathTracingBuildRunning, 'replacement build completion')
    check(stale.probe.pathTracingReady && stale.log.started === 1, 'Only the current completed scene may start sampling')
    check(stale.log.errors.length === 0, stale.log.errors.join('\n'))
    return { sampleFailure: { attempts, ...sampling.log }, obsoleteBuild: { builds: releases.length, ...stale.log } }
  } finally {
    stale.probe.renderMode = false
    for (const release of releases) release()
    await first
  }
}

export async function runPathTracingChecks(renderer: VoxelRenderer, settings: ViewSettings, errors: string[], samples = 16) {
  check(Number.isInteger(samples) && samples >= 4 && samples <= 128, 'Use 4-128 actual path-traced samples')
  const [{ VoxelDocument }, THREE] = await Promise.all([import('../src/editor'), import('three')])
  return withViewport(renderer, 256, async () => {
    const document = new VoxelDocument()
    Object.assign(document.materials[3], { roughness: 1, metalness: 0, opacity: 1, transmission: 0, emissiveIntensity: 0 })
    fill(document, 3, 12, 0, 12, 20, 8, 20)
    const options: ViewSettings = { ...settings, background: '#305070', projection: 'orthographic', ambient: 0, light: 0, pathTracing: true, ambientOcclusion: false, shadows: true, grid: false, faceGrid: false }
    renderer.setSettings(options)
    renderer.setDocument(document)
    await renderer.whenMeshIdle()
    renderer.setView({ position: { x: 20, y: 22, z: 20 }, target: { x: 0, y: 4, z: 0 }, up: { x: 0, y: 1, z: 0 }, zoom: 1, orthographicSpan: 18 })
    renderer.setRenderMode(true)
    await until(() => Boolean(Reflect.get(renderer, 'pathTracer')) || Reflect.get(renderer, 'pathTracingFailed'), 'tracer initialization', 60000)
    const tracer = Reflect.get(renderer, 'pathTracer')
    check(tracer, errors.join('\n') || 'Tracer initialization failed')
    const saved = { stableNoise: tracer.stableNoise, dynamicLowRes: tracer.dynamicLowRes, fadeDuration: tracer.fadeDuration, renderDelay: tracer.renderDelay, renderScale: tracer.renderScale, tiles: tracer.tiles.clone() }
    Object.assign(tracer, { stableNoise: true, dynamicLowRes: false, fadeDuration: 0, renderDelay: 0, renderScale: 1 })
    tracer.tiles.set(1, 1)
    const errorStart = errors.length
    const results: { name: string; samples: number; brightness: number; background: number[] }[] = []
    try {
      for (const [name, ambient, light] of [['dark', 0, 0], ['ambient only', 1.2, 0], ['directional only', 0, 2.4]] as const) {
        renderer.setSettings({ ...options, ambient, light })
        if (!Reflect.get(renderer, 'renderMode')) renderer.setRenderMode(true)
        // Keep the corner probe on the background rather than the lit stage floor.
        ;(Reflect.get(renderer, 'ground') as Object3D).visible = false
        Reflect.get(renderer, 'requestPathTraceRebuild').call(renderer)
        await until(() => {
          check(errors.length === errorStart && !Reflect.get(renderer, 'pathTracingFailed'), errors.slice(errorStart).join('\n') || 'Actual path tracing failed')
          return Reflect.get(renderer, 'pathTracingReady') && tracer.samples >= samples
        }, `${name}: ${samples} real samples`, 180000)
        const pixels = await image(renderer)
        const camera = Reflect.get(renderer, 'camera') as Camera
        const point = new THREE.Vector3(0, 8, 0).project(camera)
        const rgb = patch(pixels, (point.x + 1) * pixels.width / 2, (1 - point.y) * pixels.height / 2, 6)
        const background = patch(pixels, 12, 12, 2)
        results.push({ name, samples: tracer.samples, brightness: rgb.reduce((sum, value) => sum + value, 0) / rgb.length, background })
      }
      check(results[0].brightness < 8, `Zero ambient and directional intensity must not leave hidden environment lighting: ${results[0].brightness}`)
      check(results[1].brightness > results[0].brightness + 10, 'Ambient intensity must affect actual traced surface samples')
      check(results[2].brightness > results[0].brightness + 10, 'Directional intensity must affect actual traced surface samples')
      check(results.every(result => difference(result.background, results[0].background).max <= 2), 'Lighting intensity must not recolor the visible background')
      check(results[0].background.some(value => value > 10), 'The dark-lighting test must retain a visible nonblack background')
      return { requestedSamples: samples, results }
    } finally {
      renderer.setRenderMode(false)
      const { tiles, ...options } = saved
      Object.assign(tracer, options)
      tracer.tiles.copy(tiles)
    }
  })
}
