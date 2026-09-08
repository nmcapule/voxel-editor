import assert from 'node:assert/strict'
import { cpus } from 'node:os'
import { BufferGeometry, Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, PointsMaterial } from 'three'
import { VoxelRenderer } from '../src/editors/model/renderer'
import { CHUNK_SIZE, dirtyChunks, VoxelDocument } from '../src/shared/voxel/document'

// Run: bun scripts/isolation-benchmark.ts [samples=9] [xChunks=4]
// Real worker + renderer CPU geometry; no WebGL, GPU upload, drawing, shadows or path tracing.
const samples = Number(Bun.argv[2] ?? 9), xChunks = Number(Bun.argv[3] ?? 4), warmups = 3
assert(Number.isSafeInteger(samples) && samples > 0, 'samples must be a positive integer')
assert(Number.isSafeInteger(xChunks) && xChunks >= 4 && xChunks <= 16, 'xChunks must be an integer from 4 to 16')
const metrics = () => ({ totalMs: 0, paddingMs: 0, workerMs: 0, installMs: 0, normal: 0, isolation: 0, allocated: 0, disposed: 0 })
let current = metrics()
const live = new Set<BufferGeometry>(), seen = new WeakSet<BufferGeometry>()
const setAttribute = BufferGeometry.prototype.setAttribute
// Count initialized CPU geometries, including hidden surfaces, once by identity.
BufferGeometry.prototype.setAttribute = function (name, attribute) {
  if (!seen.has(this)) {
    seen.add(this)
    live.add(this)
    current.allocated++
    this.addEventListener('dispose', () => { current.disposed++; live.delete(this) })
  }
  return setAttribute.call(this, name, attribute)
}

const worker = new Worker(new URL('../src/editors/model/mesher.worker.ts', import.meta.url), { type: 'module' })
const postMessage = worker.postMessage.bind(worker)
const rows: { fixture: string; phase: string; [key: string]: string | number }[] = []
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker startup timed out')), 10_000)
    worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)) }
    worker.onmessage = event => {
      clearTimeout(timeout)
      assert.equal(event.data.type, 'ready')
      resolve()
    }
  })
  for (const fixture of ['sparse', 'dense', 'localized'] as const) {
    const document = new VoxelDocument({ x: xChunks * CHUNK_SIZE, y: 32, z: 32 })
    const layers = [document.activeLayerId, document.createLayer().id, document.createLayer().id]
    const { x: width, y: height, z: depth } = document.dimensions
    for (const [index, layer] of layers.entries()) {
      for (let z = 0; z < depth; z++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (fixture === 'localized' && (index === 0 && (x >= CHUNK_SIZE || y >= CHUNK_SIZE || z >= CHUNK_SIZE)
          || index === 1 && (x < width - CHUNK_SIZE || y < height - CHUNK_SIZE || z < depth - CHUNK_SIZE))) continue
        const hash = (Math.imul(x + y * width + z * width * height, 1664525) + index * 1013904223) >>> 0
        // Shared chunk-corner cells guarantee exact overlaps and populated boundary halos.
        if (hash % 101 < (fixture === 'sparse' ? 3 : 65) || (x % CHUNK_SIZE === 0 && y % CHUNK_SIZE === 0 && z % CHUNK_SIZE === 0)) {
          document.setVoxel(x, y, z, 5 + index, layer)
        }
      }
    }
    assert.equal(document.chunks.size, xChunks * 4)
    console.log(`${fixture}: ${width}x${height}x${depth}, ${document.chunks.size} chunks, 3 layers, ${document.voxelCount} layer-voxels (${layers.map(id => document.layerVoxelCount(id)).join('/')}).`)
    if (fixture === 'localized') console.log('Localized A/B occupy opposite single corner chunks; background spans every chunk. Visibility toggles B with A still selected.')
    const transparent = Uint8Array.from(document.materials, material => Number(material.opacity < 1 || material.transmission > 0)).buffer
    postMessage({ type: 'palette', transparent }, [transparent])
    const paddedChunk = document.paddedChunk.bind(document)
    document.paddedChunk = (...args) => {
      const start = performance.now()
      try { return paddedChunk(...args) }
      finally { current.paddingMs += performance.now() - start }
    }
    const results = new Map<string, ReturnType<typeof metrics>[]>()
    for (let run = -warmups; run < samples; run++) {
      document.setActiveLayer(layers[0])
      const materials = document.materials.map(() => new MeshPhysicalMaterial())
      const contextMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false })
      const meshVerticesMaterial = new PointsMaterial()
      // Constructor-only seam: keep this initializer aligned with renderer-isolation.test.ts.
      // All transitions, queueing, meshing, installation and visibility use real methods.
      const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
        document, model: new Group(), modelSuspended: false, tool: 'layer', paintMode: 'paint',
        layerState: '', nextVersion: 0, inFlight: 0, workerReady: true, meshFailed: false, worker,
        queued: new Set(), queuedGrids: new Set(), versions: new Map(), chunkMeshes: new Map(), chunkQuads: new Map(), meshWaiters: [],
        materials, contextMaterial, meshVerticesMaterial, hover: { visible: false }, marqueePreview: { visible: false },
        settings: { faceGrid: false, meshVertices: false, meshTriangles: false },
        callbacks: { onMeshStats() {}, onError(message: string) { console.error(message) } },
        viewport: { renderMode: false, renderer: { shadowMap: {} }, requestPathTraceRebuild() {}, contentBecameReady() {}, render() {}, setRasterInteraction() {} },
      })
      let sentAt = 0
      worker.postMessage = (message, transfers) => {
        sentAt = performance.now()
        postMessage(message, Array.isArray(transfers) ? { transfer: transfers } : transfers)
      }
      // The sole private method call wires the production message/error handlers.
      probe.bindWorker()
      const deliver = worker.onmessage!
      worker.onmessage = event => {
        const start = performance.now()
        current.workerMs += start - sentAt
        assert.equal(event.data.type, 'meshed', 'Overlays are disabled; unexpected worker protocol')
        for (const result of event.data.results) {
          current.normal += Number(!!result.normal)
          current.isolation += Number(!!result.active) + Number(!!result.context)
        }
        const paddingBefore = current.paddingMs
        deliver.call(worker, event)
        // Delivery also pumps the next chunk. Exclude its padding, retain scheduling overhead.
        current.installMs += performance.now() - start - (current.paddingMs - paddingBefore)
      }
      const renderer = probe as VoxelRenderer
      const showB = (visible: boolean) => {
        document.getLayer(layers[1])!.visible = visible
        // Match Studio.setLayerVisibility + editor effects: refresh scope, then dirty content/halos.
        renderer.refreshLayerScope()
        const ids = [...document.chunks].filter(([, chunks]) => chunks.has(layers[1])).map(([id]) => id)
        renderer.markDirty(dirtyChunks(document, ids))
      }
      const phases: [string, () => void][] = [
        ['normal bootstrap', () => { renderer.refreshLayerScope(); renderer.markDirty(document.chunks.keys()) }],
        ['cold entry A', () => renderer.setTool('select')],
        ['exit', () => renderer.setTool('layer')],
        ['warm reentry A', () => renderer.setTool('select')],
        ['A -> B', () => { document.setActiveLayer(layers[1]); renderer.refreshLayerScope() }],
        ['B -> A', () => { document.setActiveLayer(layers[0]); renderer.refreshLayerScope() }],
      ]
      if (fixture === 'localized') phases.push(['hide B, scoped A', () => showB(false)], ['show B, scoped A', () => showB(true)])
      try {
        for (const [phase, change] of phases) {
          current = metrics()
          const start = performance.now()
          change()
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              renderer.whenMeshIdle(),
              new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${fixture}/${phase} timed out`)), 30_000) }),
            ])
          } finally { clearTimeout(timeout) }
          current.totalMs = performance.now() - start
          assert.deepEqual(renderer.meshState(), { pending: 0, failed: false })
          let visible = 0
          probe.model.traverseVisible((child: Group | Mesh) => { if (child instanceof Mesh) visible++ })
          assert(visible > 0, `${fixture}/${phase}: no installed visible surface`)
          if (phase === 'exit' || phase === 'warm reentry A') {
            assert.equal(current.normal + current.isolation + current.allocated + current.disposed, 0, `${fixture}/${phase}: expected cached geometry reuse`)
          }
          if (fixture === 'localized' && (phase === 'A -> B' || phase === 'B -> A')) {
            assert.equal(current.normal, 0, 'Layer switching must retain normal meshes')
            assert(current.isolation > 0 && current.isolation < document.chunks.size * 2, 'Distant context chunks must be reused')
          }
          if (run >= 0) {
            if (!results.has(phase)) results.set(phase, [])
            results.get(phase)!.push(current)
          }
        }
      } finally {
        // Bypass WebGL-owning dispose(); count transition disposal above, not harness teardown.
        current = metrics()
        for (const geometry of live) geometry.dispose()
        probe.model.clear()
        for (const material of [...materials, contextMaterial, meshVerticesMaterial]) material.dispose()
      }
    }
    for (const [phase, measurements] of results) {
      const row: typeof rows[number] = { fixture, phase }
      for (const key of Object.keys(current) as (keyof typeof current)[]) {
        const values = measurements.map(sample => sample[key]).sort((a, b) => a - b)
        if (!key.endsWith('Ms')) assert.equal(values[0], values.at(-1), `${fixture}/${phase}: unstable ${key} count`)
        row[key] = Number(((values[Math.floor(values.length / 2)] + values[Math.ceil(values.length / 2) - 1]) / 2).toFixed(3))
      }
      rows.push(row)
    }
  }
  console.log(`Bun ${Bun.version}; ${cpus()[0]?.model}; ${warmups} discarded sequences, median of ${samples} fresh-renderer sequences; worker reused.`)
  console.log('Cold = no isolation cache after normal bootstrap; warm = A after exit, no document edits. Overlays disabled.')
  console.log('Times in ms: padding = paddedChunk; worker = meshing + transfer/event-loop RTT; install = delivery minus padding (includes scheduling).')
  console.log('Phase medians are independent, not additive. Counts: normal/isolation mesh passes (isolation = active + context), initialized/disposed CPU geometries.')
  console.log('Excludes fixture/probe/worker setup, teardown, WebGL/GPU upload, rendering, shadows, BVH and path tracing. Includes measurement overhead.')
  console.table(rows)
} finally {
  worker.terminate()
  BufferGeometry.prototype.setAttribute = setAttribute
}
