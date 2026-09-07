import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  BufferAttribute, BufferGeometry, Color, CubeTexture, DataTexture, Float32BufferAttribute,
  Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector4,
} from 'three'
import type { Material, WebGLRenderer, WebGLRenderTarget } from 'three'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { BVHShaderGLSL, MeshBVH } from 'three-mesh-bvh'
// Explicit ESM entry is the source Vite uses; Bun otherwise selects the UMD main.
import { PathTracingSceneGenerator, WebGLPathTracer } from 'three-gpu-pathtracer/src/index.js'
// @ts-expect-error Upstream no longer declares this deprecated, still exported renderer.
import { PathTracingRenderer } from 'three-gpu-pathtracer/src/core/PathTracingRenderer.js'
// @ts-expect-error Upstream does not publish declarations for its internal merge helper.
import { mergeGeometries } from 'three-gpu-pathtracer/src/core/utils/mergeGeometries.js'
// @ts-expect-error Upstream does not publish declarations for WorkerBase.
import { WorkerBase } from 'three-mesh-bvh/src/workers/utils/WorkerBase.js'
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker'
import { WebGLProperties } from 'three/src/renderers/webgl/WebGLProperties.js'

afterEach(() => mock.restore())

function makeScene(count = 2) {
  const scene = new Scene()
  for (let i = 0; i < count; i++) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0], 3))
    geometry.setIndex([0, 1, 2])
    const mesh = new Mesh(geometry, new MeshStandardMaterial())
    mesh.uuid = `mesh-${i}`
    scene.add(mesh)
  }
  scene.updateMatrixWorld(true)
  return scene
}

// Real worker task/serialization, with a controllable transport and actual buffer transfer.
function makeWorker() {
  const transport = {
    onerror: null as null | ((event: { message: string }) => void),
    onmessage: null as null | ((event: { data: object }) => void),
    message: null as any,
    terminate: mock(() => {}),
    postMessage(data: object, transfer: Transferable[]) {
      this.message = structuredClone(data, { transfer })
    },
    succeed() {
      const { position, index, options } = this.message
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(position, 3))
      if (index) geometry.setIndex(new BufferAttribute(index, 1))
      geometry.groups = options.groups
      const bvh = new MeshBVH(geometry, options)
      this.onmessage!({ data: { serialized: MeshBVH.serialize(bvh), position, progress: 1 } })
      geometry.dispose()
    },
  }
  const worker = new WorkerBase(transport)
  // @ts-expect-error runTask is implemented by the real dependency but omitted from its types.
  worker.runTask = GenerateMeshBVHWorker.prototype.runTask
  return { worker, transport }
}

class StubRenderer {
  target: WebGLRenderTarget | null = null
  touched: (WebGLRenderTarget | null)[] = []
  cleared: (WebGLRenderTarget | null)[] = []
  rendered = new Map<Material, number>()
  color = new Color(0x123456)
  alpha = 0.7
  autoClear = true
  toneMapping = 0
  extensions = { get: () => true }
  getContextAttributes() { return { premultipliedAlpha: true } }
  getRenderTarget() { return this.target }
  setRenderTarget(target: WebGLRenderTarget | null) { this.target = target; this.touched.push(target) }
  getClearAlpha() { return this.alpha }
  getClearColor(target: Color) { return target.copy(this.color) }
  setClearColor(color: Color | number, alpha = this.alpha) { this.color.set(color); this.alpha = alpha }
  clearColor() { this.cleared.push(this.target) }
  getScissorTest() { return false }
  setScissorTest() {}
  getScissor(target: Vector4) { return target.set(0, 0, 1, 1) }
  getViewport(target: Vector4) { return target.set(0, 0, 1, 1) }
  setScissor() {}
  setViewport() {}
  compileAsync() { return Promise.resolve() }
  readRenderTargetPixels() {}
  render(mesh: Mesh) {
    const material = mesh.material as Material
    if (!this.rendered.has(material)) {
      this.rendered.set(material, 0)
      material.addEventListener('dispose', () => this.rendered.set(material, this.rendered.get(material)! + 1))
    }
  }
}

const compileEntries = ['src/renderers/WebGLRenderer.js', 'build/three.module.js', 'build/three.cjs']

async function compilationBoundary(entry: string, parallel: boolean) {
  // compileAsync closes over renderer internals, so execute the installed method itself
  // with controlled GL readiness/timers rather than constructing an unrelated fake GPU.
  const source = await Bun.file(new URL(`../../../node_modules/three/${entry}`, import.meta.url)).text()
  const method = source.match(/this\.compileAsync = (function[\s\S]*?\n\t\t});/)?.[1]
  if (!method) throw new Error(`Missing compileAsync in ${entry}`)
  const properties = new WebGLProperties() as any
  const canvas = new EventTarget()
  const added = spyOn(canvas, 'addEventListener')
  const removed = spyOn(canvas, 'removeEventListener')
  const control = { ready: false, lost: false, linked: true }
  const ready = mock(() => control.ready)
  const gl = {
    LINK_STATUS: 0x8b82,
    isContextLost: () => control.lost,
    getProgramParameter: mock(() => control.linked),
    getProgramInfoLog: () => 'Injected fragment shader link failure',
  }
  const timers = new Map<number, () => void>()
  let timerId = 0
  const compileAsync = new Function('properties', 'canvas', '_gl', 'extensions', 'setTimeout', 'clearTimeout',
    `let _isContextLost = false; return ${method};`)(
    properties, canvas, gl, { get: () => parallel ? {} : null },
    (callback: () => void) => { timers.set(++timerId, callback); return timerId },
    (id: number) => timers.delete(id),
  )
  const renderer = Object.assign(new StubRenderer(), {
    compile: mock((mesh: Mesh) => {
      const materials = new Set(Array.isArray(mesh.material) ? mesh.material : [mesh.material])
      for (const material of materials) if (!properties.has(material)) {
        const program = { program: {} as object | undefined, isReady: ready }
        properties.get(material).currentProgram = program
        const dispose = () => {
          properties.remove(material)
          program.program = undefined
          material.removeEventListener('dispose', dispose)
        }
        material.addEventListener('dispose', dispose)
      }
      return materials
    }),
    compileAsync,
  })
  return {
    renderer, properties, canvas, control, ready, gl, timers, added, removed,
    tick() {
      const next = timers.entries().next().value
      if (!next) throw new Error('Expected a pending compilation timer')
      timers.delete(next[0])
      next[1]()
    },
  }
}

test.each(compileEntries)('%s: disposal and context loss settle pending compilation and permit a fresh tracer', async entry => {
  for (const parallel of [true, false]) for (const cancellation of ['dispose', 'context event', 'context flag', 'removed properties', 'missing program', 'destroyed program']) {
    const boundary = await compilationBoundary(entry, parallel)
    const { renderer, properties, canvas, control, ready, gl, timers, added, removed } = boundary
    const tracer = new WebGLPathTracer(renderer as unknown as WebGLRenderer) as any
    const pt = tracer._pathTracer
    pt.material.needsUpdate = true
    const pending = pt._compilePromise as Promise<unknown>
    const queued = [...timers.values()][0]
    expect(pt.isCompiling).toBe(true)
    expect(queued).toBeFunction()
    expect(gl.getProgramParameter).not.toHaveBeenCalled()
    if (cancellation === 'dispose') tracer.dispose()
    if (cancellation === 'context event') canvas.dispatchEvent(new Event('webglcontextlost'))
    if (cancellation === 'context flag') control.lost = true
    if (cancellation === 'removed properties') properties.remove(pt.material)
    if (cancellation === 'missing program') delete properties.get(pt.material).currentProgram
    if (cancellation === 'destroyed program') properties.get(pt.material).currentProgram.program = undefined
    if (timers.size) expect(() => boundary.tick()).not.toThrow()
    // Match the parent's immediate teardown after context loss, before promise callbacks run.
    tracer.dispose()
    expect(timers.size).toBe(0)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(pt.isCompiling).toBe(false)
    expect(pt._compileError).toBeNull()
    const polls = ready.mock.calls.length
    expect(() => queued()).not.toThrow()
    pt._compileFunction()
    pt.update()
    tracer.renderSample()
    expect(ready).toHaveBeenCalledTimes(polls)
    expect(gl.getProgramParameter).not.toHaveBeenCalled()
    expect(properties.has(pt.material)).toBe(false)
    expect(added.mock.calls.length).toBe(removed.mock.calls.length)

    control.lost = false
    control.ready = true
    const fresh = new WebGLPathTracer(renderer as unknown as WebGLRenderer) as any
    fresh.synchronizeRenderSize = false
    fresh.renderToCanvas = false
    fresh.renderDelay = 0
    fresh._pathTracer.material.backgroundAlpha = 1
    fresh.tiles.set(1, 1)
    fresh._pathTracer.material.onBeforeRender()
    const compiled = fresh._pathTracer._compilePromise
    while (timers.size) boundary.tick()
    await compiled
    expect(fresh.isCompiling).toBe(false)
    fresh.renderSample()
    expect(fresh.samples).toBe(1)
    expect(timers.size).toBe(0)
    fresh.dispose()
    expect(added.mock.calls.length).toBe(removed.mock.calls.length)
  }
})

test.each(compileEntries)('%s: compilation failures reject, stop polling and reach renderSample without a logging hook', async entry => {
  for (const parallel of [true, false]) for (const failure of ['link', 'readiness', 'synchronous compile']) {
    const { renderer, control, ready, gl, timers, added, removed, tick } = await compilationBoundary(entry, parallel)
    const tracer = new WebGLPathTracer(renderer as unknown as WebGLRenderer) as any
    tracer.synchronizeRenderSize = false
    tracer.renderToCanvas = false
    tracer.renderDelay = 0
    if (failure === 'synchronous compile') renderer.compile.mockImplementation(() => { throw new Error('Injected compile failure') })
    tracer._pathTracer.material.needsUpdate = true
    const pending = tracer._pathTracer._compilePromise
    if (failure === 'readiness') ready.mockImplementation(() => { throw new Error('Injected readiness failure') })
    control.ready = true
    control.linked = failure !== 'link'
    if (timers.size) expect(() => tick()).not.toThrow()
    await expect(pending).rejects.toThrow('Injected')
    expect(tracer.isCompiling).toBe(false)
    expect(timers.size).toBe(0)
    expect(added.mock.calls.length).toBe(removed.mock.calls.length)
    expect(() => tracer.renderSample()).toThrow('Injected')
    if (failure === 'link') expect(gl.getProgramParameter).toHaveBeenCalledTimes(1)
    else expect(gl.getProgramParameter).not.toHaveBeenCalled()
    tracer.dispose()
    await Bun.sleep(0) // An ignored .then/.finally rejection would fail the Bun test runner.
  }
})

test.each(['resolve', 'reject'] as const)('pathtracer ignores superseded compilation and late %s after disposal', async outcome => {
  const renderer = new StubRenderer()
  const tracer = new PathTracingRenderer(renderer as unknown as WebGLRenderer) as any
  const jobs: { resolve: () => void; reject: (error: Error) => void }[] = []
  const compile = spyOn(renderer, 'compileAsync').mockImplementation(() => new Promise<void>((resolve, reject) => jobs.push({ resolve, reject })))
  tracer._compileFunction()
  const first = tracer._compilePromise
  tracer._compileFunction()
  const second = tracer._compilePromise
  jobs[0].reject(new Error('Superseded compile'))
  await expect(first).rejects.toThrow('Superseded')
  expect(tracer._compilePromise).toBe(second)
  expect(tracer._compileError).toBeNull()
  jobs[1].resolve()
  await second
  expect(tracer.isCompiling).toBe(false)
  tracer._compileFunction()
  const late = tracer._compilePromise
  tracer.dispose()
  const touched = renderer.touched.length
  if (outcome === 'resolve') { jobs[2].resolve(); await late }
  else { jobs[2].reject(new Error('Disposed compile')); await expect(late).rejects.toThrow('Disposed') }
  tracer.update()
  tracer._compileFunction()
  await expect(tracer.compileMaterial()).rejects.toMatchObject({ name: 'AbortError' })
  expect(tracer._compilePromise).toBeNull()
  expect(tracer._compileError).toBeNull()
  expect(renderer.touched).toHaveLength(touched)
  expect(compile).toHaveBeenCalledTimes(3)
  await Bun.sleep(0)
})

test('repeated generation has stable groups and material indices without a browser global length', () => {
  expect('length' in globalThis).toBe(false)
  const scene = makeScene()
  const generator = new PathTracingSceneGenerator(scene) as any
  try {
    for (let i = 0; i < 5; i++) {
      const result = generator.generate()
      expect(result.geometry.groups).toEqual([
        { start: 0, count: 3, materialIndex: 0 }, { start: 3, count: 3, materialIndex: 1 },
      ])
      expect([...result.geometry.attributes.materialIndex.array]).toEqual([0, 0, 0, 1, 1, 1])
      expect(result.needsMaterialIndexUpdate).toBe(i === 0)
    }
    const replacement = new MeshStandardMaterial()
    ;(scene.children[0] as Mesh).material = replacement
    expect(generator.generate().needsMaterialIndexUpdate).toBe(true)
    expect(generator.generate().needsMaterialIndexUpdate).toBe(false)
    scene.remove(scene.children[0])
    const result = generator.generate()
    expect(result.geometry.groups).toEqual([{ start: 0, count: 3, materialIndex: 0 }])
    expect([...result.geometry.attributes.materialIndex.array]).toEqual([0, 0, 0])
  } finally {
    generator.dispose()
  }
})

test('mergeGeometries clears stale groups when groups are disabled', () => {
  const source = (makeScene(1).children[0] as Mesh).geometry
  const target = new BufferGeometry()
  mergeGeometries([source], { useGroups: true }, target)
  mergeGeometries([source], { useGroups: false }, target)
  expect(target.groups).toEqual([])
  source.dispose()
  target.dispose()
})

test('queued async generations coalesce and settle with the latest scene', async () => {
  const { worker, transport } = makeWorker()
  const generator = new PathTracingSceneGenerator(makeScene(1)) as any
  generator.setBVHWorker(worker)
  const first = generator.generateAsync()
  generator.setObjects(makeScene(2))
  const second = generator.generateAsync()
  const third = generator.generateAsync()
  transport.succeed()
  await first
  transport.succeed()
  const [a, b] = await Promise.all([second, third])
  expect(a).toBe(b)
  expect(a.materials).toHaveLength(2)
  expect(a.bvh).toBeInstanceOf(MeshBVH)
  expect(generator._pendingGenerate).toBeNull()
  expect(generator._buildAsync).toBe(false)
  expect(worker.running).toBe(false)
  worker.dispose()
  generator.dispose()
})

test.each(['message', 'error', 'dispose'] as const)('failed worker (%s) rejects queued requests; recovery uses fresh owned state', async failure => {
  const scene = makeScene()
  const { worker, transport } = makeWorker()
  const generator = new PathTracingSceneGenerator(scene) as any
  generator.setBVHWorker(worker)
  const results = Promise.allSettled([generator.generateAsync(), generator.generateAsync(), generator.generateAsync()])
  expect(generator.geometry.attributes.position.array.byteLength).toBe(0)
  expect((scene.children[0] as Mesh).geometry.attributes.position.array.byteLength).toBeGreaterThan(0)
  if (failure === 'message') transport.onmessage!({ data: { error: 'build failed' } })
  if (failure === 'error') transport.onerror!({ message: 'worker failed' })
  if (failure === 'dispose') worker.dispose()
  for (const result of await results) expect(result.status).toBe('rejected')
  expect(generator._pendingGenerate).toBeNull()
  expect(generator._buildAsync).toBe(false)
  expect(worker.running).toBe(false)
  expect(transport.onmessage).toBeNull()
  expect(transport.onerror).toBeNull()
  // Clearing bvh would not restore detached buffers or the static geometry cache.
  await expect(generator.generateAsync()).rejects.toThrow()
  worker.dispose()
  generator.dispose()

  const recovered = new PathTracingSceneGenerator(scene) as any
  const fresh = makeWorker()
  recovered.setBVHWorker(fresh.worker)
  const pending = recovered.generateAsync()
  fresh.transport.succeed()
  const result = await pending
  expect(result.bvh).toBeInstanceOf(MeshBVH)
  expect([...result.geometry.attributes.materialIndex.array]).toEqual([0, 0, 0, 1, 1, 1])
  expect(result.geometry.attributes.position.array.byteLength).toBeGreaterThan(0)
  fresh.worker.dispose()
  recovered.dispose()
  await Bun.sleep(0) // Let any accidentally ignored rejection chain reach the test runner.
})

test('synchronous generation failures restore async flags and worker running state', async () => {
  const { worker, transport } = makeWorker()
  spyOn(transport, 'postMessage').mockImplementation(() => { throw new Error('post failed') })
  await expect(worker.generate((makeScene(1).children[0] as Mesh).geometry)).rejects.toThrow('post failed')
  expect(worker.running).toBe(false)
  worker.runTask = () => { throw new Error('task failed') }
  await expect(worker.generate()).rejects.toThrow('task failed')
  expect(worker.running).toBe(false)
  worker.dispose()

  const generator = new PathTracingSceneGenerator(makeScene()) as any
  generator.setBVHWorker({ generate() { throw new Error('generation failed') } })
  await expect(generator.generateAsync()).rejects.toThrow('generation failed')
  expect(generator._buildAsync).toBe(false)
  generator.dispose()

  const renderer = new StubRenderer()
  const tracer = new WebGLPathTracer(renderer as unknown as WebGLRenderer) as any
  const scene = makeScene()
  spyOn(scene, 'updateMatrixWorld').mockImplementation(() => { throw new Error('scene failed') })
  expect(() => tracer.setSceneAsync(scene, new PerspectiveCamera())).toThrow('scene failed')
  expect(tracer._buildAsync).toBe(false)
  tracer.dispose()
})

test('opaque reset never binds blend targets; alpha transitions clear and release them', () => {
  const renderer = new StubRenderer()
  const tracer = new PathTracingRenderer(renderer as unknown as WebGLRenderer) as any
  const primary = tracer._primaryTarget
  const blend = tracer._blendTargets as WebGLRenderTarget[]
  const disposed = blend.map(target => spyOn(target, 'dispose'))
  for (const alpha of [false, true, true, false, false, true]) {
    renderer.touched.length = renderer.cleared.length = 0
    tracer.alpha = alpha
    tracer.reset()
    expect(tracer.target).toBe(alpha ? blend[1] : primary)
    expect(renderer.cleared.includes(primary)).toBe(true)
    for (const target of blend) expect(renderer.touched.includes(target)).toBe(alpha)
    expect(renderer.target).toBeNull()
    expect(renderer.color.getHex()).toBe(0x123456)
    expect(renderer.alpha).toBe(0.7)
  }
  for (const dispose of disposed) expect(dispose).toHaveBeenCalledTimes(1)
  tracer.alpha = false
  renderer.touched.length = 0
  tracer.setSize(32, 16)
  for (const target of blend) expect(renderer.touched.includes(target)).toBe(false)
  tracer.dispose()
})

test.each([false, true])('WebGLPathTracer disposal releases owned resources, not scene inputs (borrowed low-res material: %s)', borrowed => {
  const renderer = new StubRenderer()
  const tracer = new WebGLPathTracer(renderer as unknown as WebGLRenderer) as any
  const scene = makeScene()
  const mesh = scene.children[0] as Mesh<BufferGeometry, MeshStandardMaterial>
  const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  mesh.material.map = map
  scene.environment = map
  scene.background = new Color(0xabcdef)
  tracer.setScene(scene, new PerspectiveCamera())
  const staticGenerator = tracer._generator.staticGeometryGenerator
  const primary = tracer._pathTracer
  const lowRes = tracer._lowResPathTracer
  const owned: { dispose(): void }[] = [
    tracer._quad.material, tracer._generator.geometry, tracer._colorBackground,
    ...staticGenerator._intermediateGeometry.values(),
    staticGenerator._dummyMesh.geometry, staticGenerator._dummyMesh.material,
  ]
  for (const pt of [primary, lowRes]) {
    const material = pt.material
    owned.push(pt._primaryTarget, ...pt._blendTargets, pt._sobolTarget, pt._blendQuad.material, material,
      material.bvh, material.attributesArray, material.materialIndexAttribute, material.materials,
      material.textures.renderTarget, material.textures.renderTarget.fsQuad.material,
      material.iesProfiles.renderTarget, material.iesProfiles.renderTarget.fsQuad.material,
      material.envMapInfo.map, material.envMapInfo.marginalWeights, material.envMapInfo.conditionalWeights,
      material.lights.tex, material.stratifiedTexture, material.stratifiedOffsetTexture)
  }
  const spies = owned.map(resource => spyOn(resource, 'dispose'))
  const shared = [mesh.geometry, mesh.material, map].map(resource => spyOn(resource, 'dispose'))
  if (borrowed) lowRes.material = primary.material
  tracer.dispose()
  for (const dispose of spies) expect(dispose).toHaveBeenCalledTimes(1)
  for (const dispose of shared) expect(dispose).not.toHaveBeenCalled()
  expect(staticGenerator._intermediateGeometry.size).toBe(0)
  expect(primary.material.hasEventListener('recompilation', lowRes._compileFunction)).toBe(false)
  expect(primary.material.hasEventListener('recompilation', primary._compileFunction)).toBe(false)
  for (const count of renderer.rendered.values()) expect(count).toBeGreaterThan(0)
})

test('cube backgrounds remain valid across updates and owned conversions are disposed', () => {
  const renderer = new StubRenderer()
  const tracer = new WebGLPathTracer(renderer as unknown as WebGLRenderer) as any
  const scene = makeScene()
  const cube = new CubeTexture(Array.from({ length: 6 }, () => ({ width: 1, height: 1 })))
  const shared = spyOn(cube, 'dispose')
  scene.background = scene.environment = cube
  tracer.setScene(scene, new PerspectiveCamera())
  const background = tracer._internalBackground
  const owned = spyOn(background, 'dispose')
  tracer.updateEnvironment()
  expect(tracer._internalBackground).toBe(background)
  expect(owned).not.toHaveBeenCalled()
  tracer.dispose()
  expect(owned).toHaveBeenCalledTimes(1)
  expect(shared).not.toHaveBeenCalled()
  for (const count of renderer.rendered.values()) expect(count).toBeGreaterThan(0)
})

test('GTAOPass disposes both GTAO and blend materials', () => {
  const pass = new GTAOPass(new Scene(), new PerspectiveCamera(), 1, 1)
  const gtao = spyOn(pass.gtaoMaterial, 'dispose')
  const blend = spyOn(pass.blendMaterial, 'dispose')
  pass.dispose()
  expect(gtao).toHaveBeenCalledTimes(1)
  expect(blend).toHaveBeenCalledTimes(1)
})

test('Bun/CommonJS entry points retain the same generation, disposal and shader patches', async () => {
  const publicPathTracer = await import('three-gpu-pathtracer')
  const generator = new publicPathTracer.PathTracingSceneGenerator(makeScene())
  generator.generate()
  expect(generator.generate().geometry.groups).toHaveLength(2)
  generator.dispose()
  const tracer = new publicPathTracer.WebGLPathTracer(new StubRenderer() as unknown as WebGLRenderer) as any
  expect(tracer._pathTracer.material.fragmentShader).toContain('localDist == minDistance && localSide > side')
  const primary = spyOn(tracer._pathTracer.material, 'dispose')
  const lowRes = spyOn(tracer._lowResPathTracer.material, 'dispose')
  tracer.dispose()
  expect(primary).toHaveBeenCalledTimes(1)
  expect(lowRes).toHaveBeenCalledTimes(1)
})

describe('GLSL equal-distance policy (CPU probe, GPU compilation is validated in the browser)', () => {
  test('the shipped predicate prefers front-facing ties, never farther hits, in either visitation order', () => {
    const shader = BVHShaderGLSL.bvh_ray_functions
    const predicate = shader.match(/&&\s*(\( localDist < minDistance[^\n]+)\n/)?.[1]
    expect(predicate).toBeDefined()
    // Evaluate the actual scalar GLSL predicate, rather than duplicating the intended policy.
    const accepts = new Function('localDist', 'minDistance', 'localSide', 'side', `return ${predicate};`)
    expect(accepts(1, 1, 1, -1)).toBe(true)
    expect(accepts(1, 1, -1, 1)).toBe(false)
    expect(accepts(1, 1, 1, 1)).toBe(false)
    expect(accepts(1.000001, 1, 1, -1)).toBe(false)
    expect(accepts(0.999999, 1, -1, 1)).toBe(true)
    for (const sides of [[-1, 1], [1, -1]]) {
      let distance = Infinity
      let side = 0
      for (const localSide of sides) if (accepts(255, distance, localSide, side)) {
        distance = 255
        side = localSide
      }
      expect(side).toBe(1)
      expect(distance).toBe(255)
    }
    expect(shader).toContain('|| boundsHitDistance > triangleDistance')
    expect(shader).not.toContain('boundsHitDistance >= triangleDistance')
    const tracer = new PathTracingRenderer(new StubRenderer() as unknown as WebGLRenderer)
    expect(tracer.material.fragmentShader).toContain(predicate!)
    expect(tracer.material.fragmentShader).toContain('#define RAY_OFFSET 1e-4')
    tracer.dispose()
  })
})
