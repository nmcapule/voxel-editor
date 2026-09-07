import { expect, spyOn, test } from 'bun:test'
import * as THREE from 'three'
import { chunkId, VoxelDocument } from './editor'
import { meshChunk } from './mesher'
import { coarse8, meshSceneChunk, sceneLod, type SceneLod, type SceneMeshJob } from './scene-mesher'
import { SceneRenderer, expandSceneDetail, sceneDetailBudget, sceneGroupTransform, sceneInstanceMatrix, traceSceneChunk } from './scene-renderer'
import { VoxelRenderer, sceneShadowVolume } from './renderer'
import { createScene, SceneDocument } from './scene'
import { encodeProjectSnapshot } from './protocol'
import type { ViewSettings } from './storage'
import { SCENE_GEOMETRY_BUDGET, type SceneAsset, type SceneTransform } from './scene-types'
import { describeSceneChunk } from './scene-storage'
import * as sceneStorage from './scene-storage'

const defaultSettings: ViewSettings = { background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42, ambientOcclusion: true, shadows: true, grid: true, faceGrid: false, meshVertices: false, meshTriangles: false, projection: 'orthographic', pathTracing: false }

function rendererProbe(document: SceneDocument) {
  const camera = new THREE.OrthographicCamera(-1000, 1000, 1000, -1000, 0.1, 10000)
  camera.position.set(0, 400, 1000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
  const viewport = { camera, canvas: { clientHeight: 800, width: 800, height: 600 }, renderer: { shadowMap: {} }, shadows: true, environment: new THREE.Texture(),
    shadowMatrix: new THREE.Matrix4().makeRotationX(Math.PI / 2), groundY: undefined as number | undefined }
  return Object.assign(Object.create(SceneRenderer.prototype), {
    document, active: true, disposed: false, clock: 0, generation: 0, pickGeneration: 0, pressureLod: 1, uploadBytes: 0,
    root: new THREE.Group(), ghost: new THREE.Group(), ghostMaterial: new THREE.MeshBasicMaterial(),
    assets: new Map(), entries: new Map(), batches: new Map(), surfaces: new Map(), materials: new Map(), desired: new Map(), adaptiveDesired: new Map(), failed: new Map(), previews: new Map(), selection: new Set(), waiters: [],
    bounds: new THREE.Box3(), queue: [], geometryBytes: 0, matrixBytes: 0, transientBytes: 0, detailReservationBytes: 0, detailGeometryBytes: 0,
    diagnostics: { meshJobs: 0, chunkReads: 0, uploads: 0, staleResults: 0, matrixUpdates: 0 },
    host: { getSceneViewport: () => viewport, getSceneShadowVolume: (receivers: THREE.Box3[], bounds: THREE.Box3) => sceneShadowVolume(viewport.camera, bounds, receivers, viewport.shadowMatrix, viewport.groundY),
      setSceneContent() {}, setSettings() {}, invalidateSceneContent() {}, setSceneInteraction() {} },
    callbacks: { onError(message: string) { throw new Error(message) }, onStats() {} }, updateGizmo() {}, schedule() {},
  })
}

async function drainSceneWorker(probe: ReturnType<typeof rendererProbe>) {
  for (let jobs = 0; probe.queue.length; jobs++) {
    if (jobs > 20) throw new Error('Unexpected remesh loop')
    probe.pump()
    const started = performance.now()
    while (!probe.completed) { if (performance.now() - started > 3000) throw new Error('Scene worker did not finish'); await Bun.sleep(1) }
    probe.uploadBytes = 0; probe.upload(); probe.reconcile()
  }
}

function job(step: SceneLod = 1): SceneMeshJob {
  return { key: 'asset:0:0:1', generation: 4, id: 0, step, chunks: [{ id: 0, voxels: new Uint8Array((16 / step) ** 3).fill(1) }], transparent: new Uint8Array(256) }
}

test('scene LODs preserve chunk boundaries and suppress shared opaque faces, including negative halos', () => {
  for (const step of [1, 4, 8] as const) {
    const left = job(step)
    expect(meshSceneChunk(left).quads).toBe(6)
    left.chunks.push({ id: chunkId(1, 0, 0), voxels: left.chunks[0].voxels.slice() })
    const leftMesh = meshSceneChunk(left)
    expect(leftMesh.quads).toBe(5)
    expect(Math.min(...leftMesh.positions)).toBe(0)
    expect(Math.max(...leftMesh.positions)).toBe(16)
    const rightMesh = meshSceneChunk({ ...left, id: chunkId(1, 0, 0) })
    expect(rightMesh.quads).toBe(5)
    // At the positive/negative interface there is no owned +/-X face.
    expect(Array.from(leftMesh.normals).filter((v, i) => i % 3 === 0 && v === 1)).toHaveLength(0)
    expect(Array.from(rightMesh.normals).filter((v, i) => i % 3 === 0 && v === -1)).toHaveLength(0)
  }
})

test('scene full meshing matches the model mesher; transparent seams retain both interfaces', () => {
  const document = new VoxelDocument()
  document.setVoxel(15, 3, 4, 1)
  document.setVoxel(16, 3, 4, 2)
  const transparent = new Uint8Array(256); transparent[1] = transparent[2] = 1
  const chunks = [...document.chunks].map(([id, layers]) => ({ id, voxels: layers.get(1)! }))
  for (const id of [0, 1]) expect(meshSceneChunk({ ...job(), id, chunks, transparent })).toEqual(meshChunk(document.paddedChunk(id, true), undefined, false, transparent))
  expect(() => meshSceneChunk({ ...job(), chunks: [] })).toThrow('Missing center chunk')
  expect(() => meshSceneChunk({ ...job(), chunks: [{ id: 0, voxels: new Uint8Array(2) }] })).toThrow('Invalid scene chunk size')
})

test('metadata downsampling keeps thin features and LOD hysteresis pins full selection', () => {
  const preview = new Uint8Array(64); preview[0] = 7; preview[1] = preview[4] = 2; preview[63] = 9
  expect(coarse8(preview)).toEqual(new Uint8Array([2, 0, 0, 0, 0, 0, 0, 9]))
  expect(sceneLod(55, 1)).toBe(1)
  expect(sceneLod(55, 4)).toBe(4)
  expect(sceneLod(8, 4)).toBe(4)
  expect(sceneLod(8, 8)).toBe(8)
  expect(sceneLod(0, 8, true)).toBe(1)
})

test('scene worker transfers versioned arrays and reports malformed jobs without stopping', async () => {
  const worker = new Worker(new URL('./scene-mesher.worker.ts', import.meta.url), { type: 'module' })
  const receive = () => new Promise<any>((resolve, reject) => { worker.onmessage = event => resolve(event.data); worker.onerror = reject })
  try {
    const input = job(4), expected = meshSceneChunk(input), buffer = input.chunks[0].voxels.buffer
    const first = receive(); worker.postMessage(input, [buffer])
    expect(await first).toEqual({ key: input.key, generation: 4, mesh: expected })
    expect(buffer.byteLength).toBe(0)
    const second = receive(); worker.postMessage({ ...job(), chunks: [] })
    expect(await second).toMatchObject({ generation: 4, error: 'Missing center chunk is not empty space' })
  } finally { worker.terminate() }
})

test('group transforms preserve local nonuniform scale without introducing shear', () => {
  const original: SceneTransform = { position: { x: 10, y: 20, z: 30 }, rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.4, 0.7)), scale: { x: 2, y: 3, z: 4 } }
  const center = new THREE.Vector3(1, 2, 3), position = new THREE.Vector3(5, 6, 7), rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, 0.1, 0.3))
  const transformed = sceneGroupTransform(original, center, position, rotation, 1.7)
  const expected = new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1.7, 1.7, 1.7))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z))
    .multiply(sceneInstanceMatrix(original, { x: 0, y: 0, z: 0 }))
  sceneInstanceMatrix(transformed, { x: 0, y: 0, z: 0 }).elements.forEach((n, i) => expect(n).toBeCloseTo(expected.elements[i], 10))
  expect(new THREE.Vector3(4, 5, 6).applyMatrix4(sceneInstanceMatrix(original, { x: 4, y: 5, z: 6 }))).toEqual(new THREE.Vector3(10, 20, 30))
})

test('chunk-local picking hits occupied cells, skips holes and internal faces, and rejects missing data', () => {
  const voxels = new Uint8Array(4096); voxels[2 + 3 * 16 + 4 * 256] = 1; voxels[3 + 3 * 16 + 4 * 256] = 1; voxels[6 + 3 * 16 + 4 * 256] = 2
  const origin = new THREE.Vector3(32, 16, 48)
  const hit = traceSceneChunk(new THREE.Ray(new THREE.Vector3(0, 19.5, 52.5), new THREE.Vector3(1, 0, 0)), origin, voxels)
  expect(hit?.point).toEqual(new THREE.Vector3(34, 19.5, 52.5))
  expect(hit?.normal).toEqual(new THREE.Vector3(-1, 0, 0))
  expect(traceSceneChunk(new THREE.Ray(new THREE.Vector3(34.5, 19.5, 52.5), new THREE.Vector3(1, 0, 0)), origin, voxels)?.point.x).toBe(38)
  expect(traceSceneChunk(new THREE.Ray(new THREE.Vector3(0, 18.5, 52.5), new THREE.Vector3(1, 0, 0)), origin, voxels)).toBeUndefined()
  expect(traceSceneChunk(new THREE.Ray(new THREE.Vector3(), new THREE.Vector3()), origin, voxels)).toBeUndefined()
  expect(() => traceSceneChunk(new THREE.Ray(), origin, new Uint8Array())).toThrow('Invalid scene chunk')
  const transparent = new Uint8Array(256); transparent[1] = 1; voxels[3 + 3 * 16 + 4 * 256] = 2
  expect(traceSceneChunk(new THREE.Ray(new THREE.Vector3(34.5, 19.5, 52.5), new THREE.Vector3(1, 0, 0)), origin, voxels, transparent)?.point.x).toBe(35)
})

test('streaming reuses geometry across cells and TRS commands, queues are bounded, and stale results never upload', () => {
  const model = new VoxelDocument(); model.setVoxel(0, 0, 0, 1)
  const { chunks: _chunks, ...header } = encodeProjectSnapshot(model, defaultSettings)
  const asset: SceneAsset = { id: 'asset', revision: 0, model: header, pivot: { x: 0, y: 0, z: 0 }, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, voxelCount: 1, chunks: [{ id: 0, layerId: 1, blob: 'a'.repeat(64), count: 1, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, colors: [1], lod: [1, ...Array(63).fill(0)] }] }
  const doc = new SceneDocument(createScene(defaultSettings))
  doc.execute({ type: 'asset.add', asset })
  for (const x of [0, 300]) doc.execute({ type: 'instance.place', assetId: asset.id, position: { x, y: 0, z: 0 } })
  doc.execute({ type: 'selection.set', ids: [] })
  const probe = rendererProbe(doc)
  try {
    probe.refresh(); probe.reconcile()
    expect(probe.desired.size).toBe(1)
    const demand = [...probe.desired.values()][0] as any
    expect(demand.lod).toBe(8)
    probe.busy = demand
    probe.completed = { key: demand.key, generation: 0, mesh: meshSceneChunk(job(8)) }
    probe.upload(); probe.reconcile()
    expect(probe.batches.size).toBe(2)
    const geometry = [...probe.batches.values()].map((batch: any) => batch.mesh.geometry)
    expect(geometry[0]).toBe(geometry[1])
    const bytes = probe.geometryBytes, uploads = probe.diagnostics.uploads
    const instance = doc.data.instances[0]
    const otherMatrix = probe.entries.get(doc.data.instances[1].id).matrix
    const matrixUpdates = probe.diagnostics.matrixUpdates
    const change = doc.execute({ type: 'instances.transform', transforms: [{ id: instance.id, rotation: instance.rotation, scale: instance.scale, position: { x: 50, y: 2, z: 0 } }] })
    probe.refresh(change); probe.reconcile()
    expect(probe.queue).toHaveLength(0)
    expect(probe.geometryBytes).toBe(bytes)
    expect(probe.diagnostics.uploads).toBe(uploads)
    expect(probe.diagnostics.meshJobs).toBe(0)
    expect(probe.entries.get(doc.data.instances[1].id).matrix).toBe(otherMatrix)
    expect(probe.diagnostics.matrixUpdates - matrixUpdates).toBe(1)
    probe.busy = demand; probe.completed = { key: demand.key, generation: -1, mesh: meshSceneChunk(job(8)) }
    probe.upload()
    expect(probe.diagnostics.staleResults).toBe(1)
    expect(probe.diagnostics.uploads).toBe(uploads)
    probe.clearBatches()
    probe.clock++
    probe.desired.set(demand.key, { ...demand, priority: 0 })
    expect(probe.makeRoom(SCENE_GEOMETRY_BUDGET)).toBe(false)
    expect(probe.surfaces.size).toBe(1)
    probe.desired.clear()
    expect(probe.makeRoom(SCENE_GEOMETRY_BUDGET)).toBe(true)
    expect(probe.geometryBytes).toBe(0); expect(probe.matrixBytes).toBe(0); expect(probe.materials.size).toBe(0)
    const many = createScene(defaultSettings)
    many.assets = Array.from({ length: 100 }, (_, i) => ({ ...asset, id: `asset-${i}` }))
    many.instances = many.assets.map((asset, i) => ({ ...instance, id: `instance-${i}`, assetId: asset.id, position: { x: i * 2, y: 0, z: 0 } }))
    probe.document = new SceneDocument(many)
    probe.refresh(); probe.reconcile()
    expect(probe.desired.size).toBe(100)
    expect(probe.queue).toHaveLength(64)
  } finally { probe.ghostMaterial.dispose(); probe.host.getSceneViewport().environment.dispose() }
})

test('scene content gates model keyboard and tracing before any voxel access', () => {
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    sceneContent: {}, renderMode: true, settings: { pathTracing: true },
    document: new Proxy({}, { get() { throw new Error('Model document must not be read') } }),
  })
  expect(probe.pathTracingEnabled()).toBe(false)
  probe.keyboard({ key: ' ' })
})

test('transform preview stays outside the document, mouseup commits once, Escape restores orbit without a command', () => {
  const original: SceneTransform = { position: { x: 0, y: 10, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 2, z: 3 } }
  let commits = 0, committed: SceneTransform | undefined
  const controls = { enabled: true }, proxy = new THREE.Object3D()
  proxy.position.copy(original.position); proxy.scale.copy(original.scale)
  const probe = Object.assign(Object.create(SceneRenderer.prototype), {
    active: true, pickGeneration: 0, selection: new Set(['one']), entries: new Map([['one', { instance: original }]]),
    proxy, previews: new Map(), mode: 'translate', gizmo: { dragging: true, axis: 'X' }, marquee: { visible: false },
    host: { getSceneViewport: () => ({ controls, canvas: {} }), setSceneInteraction() {} },
    callbacks: { onTransform(transforms: SceneTransform[]) { commits++; committed = transforms[0] }, onError(message: string) { throw new Error(message) } },
    updateGizmo() { proxy.position.copy(original.position); proxy.scale.copy(original.scale) }, schedule() {}, refresh() {},
  })
  probe.startTransform()
  expect(controls.enabled).toBe(false)
  proxy.position.x = 2; probe.previewTransform()
  proxy.position.x = 5; probe.previewTransform()
  expect(original.position.x).toBe(0)
  expect(commits).toBe(0)
  probe.finishTransform()
  expect(commits).toBe(1); expect(committed?.position.x).toBe(5); expect(controls.enabled).toBe(true)
  probe.startTransform(); proxy.position.x = 8; probe.previewTransform(); probe.cancelInteraction()
  expect(commits).toBe(1); expect(probe.previews.size).toBe(0); expect(controls.enabled).toBe(true)
  expect(proxy.position.x).toBe(0); expect(probe.gizmo.dragging).toBe(false)
})

test('scene capture waits for scene dependencies and hides overlays only for raster pixels', async () => {
  const root = new THREE.Group(), overlay = new THREE.Group(); root.add(overlay); overlay.userData.editorOverlay = true
  let ready = false, pixels = ''
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    sceneContent: { root, async whenReady() { ready = true } },
    whenMeshIdle() { throw new Error('Must not wait for the hidden model') },
    renderRaster() { expect(ready).toBe(true); expect(overlay.visible).toBe(false); pixels = 'scene' },
    render() {}, getView() { return {} },
    renderer: { getContext: () => ({ isContextLost: () => false }), domElement: { toBlob(callback: (blob: Blob) => void) { callback(new Blob([pixels])) } } },
  })
  expect(await (await probe.capture()).blob.text()).toBe('scene')
  expect(overlay.visible).toBe(true)
})

test('late explicit-click results cannot select in a newer viewport generation', async () => {
  let finish!: (hit: unknown) => void, selections = 0
  const probe = Object.assign(Object.create(SceneRenderer.prototype), {
    active: true, pickGeneration: 0, tool: 'select', selection: new Set(),
    ray() { return {} }, exactHit() { return new Promise(resolve => { finish = resolve }) },
    callbacks: { onSelect() { selections++ }, onError(message: string) { throw new Error(message) } },
  })
  const pending = probe.click({}, false)
  probe.pickGeneration++
  finish({ entry: { instance: { id: 'stale' } } })
  await pending
  expect(selections).toBe(0)
})

test('editing one of three distant chunks only meshes that chunk; RGB/PBR updates keep every surface', async () => {
  const model = new VoxelDocument({ x: 160, y: 16, z: 16 })
  for (const x of [0, 64, 128]) model.setVoxel(x, 0, 0, 1)
  const { chunks: _chunks, ...header } = encodeProjectSnapshot(model, defaultSettings)
  const chunks = [...model.chunks].map(([id, layers], i) => describeSceneChunk(id, 1, layers.get(1)!, 'abc'[i].repeat(64))!)
  const asset: SceneAsset = { id: 'local', revision: 0, model: header, chunks, pivot: { x: 0, y: 0, z: 0 }, voxelCount: 3,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 129, y: 1, z: 1 } } }
  const doc = new SceneDocument(createScene(defaultSettings))
  doc.execute({ type: 'asset.add', asset }); doc.execute({ type: 'instance.place', assetId: asset.id, position: { x: 0, y: 0, z: 0 } }); doc.execute({ type: 'selection.set', ids: [] })
  const probe = rendererProbe(doc)
  const worker = new Worker(new URL('./scene-mesher.worker.ts', import.meta.url), { type: 'module' })
  probe.worker = worker
  worker.onmessage = event => { probe.completed = event.data }
  try {
    probe.refresh(); probe.reconcile(); await drainSceneWorker(probe)
    expect(probe.diagnostics.meshJobs).toBe(3)
    const before = new Map([...probe.surfaces].map(([key, surface]: any) => [surface.demand.id, { key, geometry: surface.parts[0].geometry }]))
    const old = doc.data.assets[0]
    const edited = { ...old, revision: 1, chunks: old.chunks.map(chunk => chunk.id === 0 ? { ...chunk, blob: 'd'.repeat(64), colors: [2], lod: [2, ...Array(63).fill(0)] } : chunk) }
    probe.refresh(doc.execute({ type: 'asset.update', asset: edited })); probe.reconcile()
    expect(probe.queue.map((d: any) => d.id)).toEqual([0])
    for (const id of [4, 8]) {
      expect(probe.key(probe.assets.get(asset.id), id, 8)).toBe(before.get(id)!.key)
      expect(probe.surfaces.get(before.get(id)!.key).parts[0].geometry).toBe(before.get(id)!.geometry)
    }
    await drainSceneWorker(probe); expect(probe.diagnostics.meshJobs).toBe(4)
    const maps = probe.assets.get(asset.id).chunks, keys = [...probe.surfaces.keys()], material = probe.materials.get('local:1').material
    const current = doc.data.assets[0]
    const palette = [...current.model.palette]; palette[1] = 0x112233
    const materials = current.model.materials.map((m, i) => i === 1 ? { ...m, roughness: 0.2 } : m)
    probe.refresh(doc.execute({ type: 'asset.update', asset: { ...current, revision: 2, model: { ...current.model, palette, materials } } })); probe.reconcile()
    expect(probe.queue).toHaveLength(0); expect(probe.diagnostics.meshJobs).toBe(4)
    expect([...probe.surfaces.keys()]).toEqual(keys)
    expect(probe.assets.get(asset.id).chunks).toBe(maps)
    expect(probe.materials.get('local:1').material).toBe(material)
    expect(material.color.getHex()).toBe(0x112233); expect(material.roughness).toBe(0.2)
  } finally {
    worker.terminate(); probe.clearBatches()
    for (const surface of [...probe.surfaces.values()]) probe.evict(surface)
    probe.ghostMaterial.dispose(); probe.host.getSceneViewport().environment.dispose()
  }
})

test('mesh fingerprints include six neighbors, visible layer ownership and only used transparency classes', () => {
  const model = new VoxelDocument({ x: 160, y: 16, z: 16 }); model.setVoxel(15, 0, 0, 1); model.setVoxel(16, 0, 0, 1); model.setVoxel(128, 0, 0, 2)
  const { chunks: _chunks, ...header } = encodeProjectSnapshot(model, defaultSettings)
  const chunks = [...model.chunks].map(([id, layers], i) => describeSceneChunk(id, 1, layers.get(1)!, 'abc'[i].repeat(64))!)
  const doc = new SceneDocument({ ...createScene(defaultSettings), assets: [{ id: 'a', revision: 0, model: header, chunks, voxelCount: 3, pivot: { x: 0, y: 0, z: 0 }, bounds: { min: { x: 15, y: 0, z: 0 }, max: { x: 129, y: 1, z: 1 } } }] })
  const probe = rendererProbe(doc)
  const keys = () => [0, 1, 8].map(id => probe.key(probe.assets.get('a'), id, 1))
  try {
    probe.refresh(); const before = keys(), asset = doc.data.assets[0]
    probe.refresh(doc.execute({ type: 'asset.update', asset: { ...asset, revision: 1, model: { ...asset.model, materials: asset.model.materials.map((m, i) => i === 1 ? { ...m, transmission: 0.5 } : m) } } }))
    const after = keys(); expect(after[0]).not.toBe(before[0]); expect(after[1]).not.toBe(before[1]); expect(after[2]).toBe(before[2])
    const next = doc.data.assets[0]
    probe.refresh(doc.execute({ type: 'asset.update', asset: { ...next, revision: 2, model: { ...next.model, layers: next.model.layers.map(layer => ({ ...layer, visible: false })) } } }))
    expect(probe.assets.get('a').chunks.size).toBe(0)
  } finally { probe.ghostMaterial.dispose(); probe.host.getSceneViewport().environment.dispose() }
})

test('expanded full detail includes distant contributors, uses independent materials and ordinary traceable meshes', async () => {
  const { PathTracingSceneGenerator } = await import('three-gpu-pathtracer')
  const geometry = new THREE.BoxGeometry(1, 1, 1), material = new THREE.MeshPhysicalMaterial({ color: 0xabcdef })
  const detail = expandSceneDetail([{ geometry, material, matrix: new THREE.Matrix4() }, { geometry, material, matrix: new THREE.Matrix4().makeTranslation(8000, 10, 0) }], 320 * 240)
  const generator = new PathTracingSceneGenerator(detail.root)
  try {
    expect(detail.scope).toBe('full-scene'); expect(detail.triangles).toBe(26)
    expect(detail.root.children).toHaveLength(1)
    const mesh = detail.root.children[0] as THREE.Mesh
    expect((mesh as THREE.InstancedMesh).isInstancedMesh).toBeUndefined()
    expect(mesh.material).not.toBe(material)
    expect(mesh.geometry.boundingBox!.max.x).toBe(8000.5)
    expect(mesh.geometry.getAttribute('position').count).toBe(72)
    expect(generator.generate().geometry.getAttribute('position').count).toBe(72)
    material.color.setHex(0xff0000)
    expect((mesh.material as THREE.MeshPhysicalMaterial).color.getHex()).toBe(0xabcdef)
    expect(detail.peakBytes).toBeLessThan(96 * 1024 * 1024)
  } finally { generator.dispose(); detail.dispose(); detail.dispose(); geometry.dispose(); material.dispose() }
})

test('full-detail preflight enforces triangle, 16-bit material and peak-memory limits before expansion', () => {
  expect(() => sceneDetailBudget(1_000_001, 1, 0)).toThrow('triangle limit')
  expect(() => sceneDetailBudget(1, 65535, 0)).toThrow('16-bit material')
  expect(() => sceneDetailBudget(50_000, 1, 0)).toThrow('96 MiB')
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshPhysicalMaterial()
  const parts = Array.from({ length: 5000 }, () => ({ geometry, material, matrix: new THREE.Matrix4() }))
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const version = position.version
  expect(() => expandSceneDetail(parts)).toThrow('96 MiB')
  expect(position.version).toBe(version)
  geometry.dispose(); material.dispose()
})

test('model surfaces and jobs are released/suspended in scene mode, then all model chunks resume', () => {
  const model = new VoxelDocument(); model.setVoxel(0, 0, 0, 1)
  let stopped = 0, posted = 0
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshPhysicalMaterial(), chunk = new THREE.Group(), root = new THREE.Group()
  chunk.add(new THREE.Mesh(geometry, material)); root.add(chunk)
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    document: model, model: root, selection: new Map(), floatingSelection: false,
    chunkMeshes: new Map([[0, chunk]]), chunkQuads: new Map([[0, 6]]), queued: new Set([0]), queuedGrids: new Set([0]), versions: new Map([[0, 1]]), meshWaiters: [], nextVersion: 1,
    renderer: { shadowMap: {} }, callbacks: { onMeshStats() {} }, worker: { terminate() { stopped++ }, postMessage() { posted++ } }, workerReady: true, inFlight: 1,
    requestPathTraceRebuild() {}, render() {}, bindWorker() {}, updateSelection() {},
  })
  probe.sceneContent = {}; probe.suspendModelMeshes()
  expect(stopped).toBe(1); expect(probe.chunkMeshes.size).toBe(0); expect(root.children).toHaveLength(0)
  probe.markDirty([0]); probe.pump(); expect(posted).toBe(0); expect(probe.queued.size).toBe(0)
  probe.sceneContent = undefined; probe.resumeModelMeshes()
  try { expect(probe.modelSuspended).toBe(false); expect(probe.queued.has(0)).toBe(true); expect(probe.workerReady).toBe(false) }
  finally { probe.worker.terminate(); material.dispose() }
})

test('fitting scenes reach the tracer as complete ordinary geometry; oversized preparation explicitly falls back', async () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshPhysicalMaterial()
  const detail = expandSceneDetail([{ geometry, material, matrix: new THREE.Matrix4().makeTranslation(7900, 0, 0) }])
  let builds = 0, samples = 0, rasters = 0
  const statuses: string[] = [], errors: string[] = []
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    sceneContent: { root: new THREE.Group(), prepareFullDetail: async () => detail }, scene: new THREE.Scene(),
    sunlight: new THREE.DirectionalLight(), sunlightTarget: new THREE.Object3D(), camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: { width: 320, height: 240 }, getContext: () => ({ isContextLost: () => false }) },
    fullEpoch: 0, pathTracingRevision: 0, pathTracingBuildRequested: true, pathTracingBuildRunning: false, pathTracingFailed: false, pathTracingReady: false,
    renderMode: true, settings: { pathTracing: true }, inFlight: 0, queued: new Set(),
    callbacks: { onPathTracingStatus: (status: string) => statuses.push(status), onError: (message: string) => errors.push(message) },
    render() { rasters++ }, resetFps() {}, stopPathTracingSamples() {}, startPathTracingSamples() { samples++ },
    requestPathTraceRebuild() { this.pathTracingRevision++; this.pathTracingBuildRequested = true; this.pathTracingReady = false },
    async ensurePathTracer() {
      const tracer = { dispose() {}, async setSceneAsync(scene: THREE.Scene) {
        builds++
        scene.traverse(object => expect((object as THREE.InstancedMesh).isInstancedMesh).not.toBe(true))
        const mesh = scene.children.flatMap(object => object.children).find(object => object instanceof THREE.Mesh) as THREE.Mesh
        expect(mesh.geometry.boundingBox!.min.x).toBe(7899.5)
      } }
      Reflect.set(this, 'pathTracer', tracer)
      return tracer
    },
  })
  try {
    await probe.buildPathTrace()
    expect(builds).toBe(1); expect(samples).toBe(1); expect(probe.pathTracingReady).toBe(true)
    probe.sceneContent.prepareFullDetail = async () => { throw new Error('Full-scene detail exceeds 96 MiB') }
    probe.invalidateSceneContent(); await probe.buildPathTrace()
    expect(builds).toBe(1); expect(samples).toBe(1)
    expect(probe.pathTracingFailed).toBe(true); expect(probe.fullContent).toBeUndefined()
    expect(statuses.at(-1)).toBe('Raster fallback'); expect(errors.at(-1)).toContain('96 MiB'); expect(rasters).toBeGreaterThan(0)
  } finally { probe.disposePathTracer(); probe.releaseSceneDetail(); geometry.dispose(); material.dispose() }
})

test('late full-scene preparation is disposed after navigation; instancing is rejected at the tracer boundary', async () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshPhysicalMaterial()
  let finish!: (detail: ReturnType<typeof expandSceneDetail>) => void
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    fullEpoch: 0, renderer: { domElement: { width: 100, height: 100 } },
    sceneContent: { prepareFullDetail: () => new Promise(resolve => { finish = resolve }) },
  })
  const pending = probe.prepareSceneContent()
  probe.releaseSceneDetail()
  const detail = expandSceneDetail([{ geometry, material, matrix: new THREE.Matrix4() }])
  finish(detail)
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(detail.root.children).toHaveLength(0); expect(probe.fullContent).toBeUndefined()
  const root = new THREE.Group(), instanced = new THREE.InstancedMesh(geometry, material, 2)
  root.add(instanced)
  let disposed = 0
  probe.sceneContent = { prepareFullDetail: async () => ({ ...detail, root, dispose() { disposed++; instanced.dispose() } }) }
  await expect(probe.prepareSceneContent()).rejects.toThrow('not instancing')
  expect(disposed).toBe(1)
  geometry.dispose(); material.dispose()
})

test('exact capture uses full geometry and raster environment, restores live content, and never writes a partial PNG', async () => {
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshPhysicalMaterial(), environment = new THREE.Texture()
  const detail = expandSceneDetail([{ geometry, material, matrix: new THREE.Matrix4() }], 10000, false)
  const root = new THREE.Group(), scene = new THREE.Scene(); scene.add(root)
  let captures = 0
  const probe = Object.assign(Object.create(VoxelRenderer.prototype), {
    fullEpoch: 0, scene, environmentTarget: { texture: environment }, renderMode: true, settings: { pathTracing: true },
    sceneContent: { root, prepareFullDetail: async () => detail },
    renderer: { shadowMap: {}, getContext: () => ({ isContextLost: () => false }), domElement: { width: 100, height: 100, toBlob(callback: (blob: Blob) => void) { captures++; callback(new Blob(['exact'])) } } },
    render() {}, getView: () => ({ name: 'stable' }),
    renderRaster(_camera: unknown, _raster: unknown, shadows: boolean) {
      expect(shadows).toBe(true)
      expect(root.visible).toBe(false); expect(detail.root.parent).toBe(scene)
      const material = (detail.root.children[0] as THREE.Mesh).material as THREE.MeshPhysicalMaterial
      expect(material.envMap).toBe(environment); expect(Reflect.get(material, 'castShadow')).toBe(false)
    },
  })
  try {
    expect(await (await probe.capture(true)).blob.text()).toBe('exact')
    expect(root.visible).toBe(true); expect(detail.root.parent).toBeNull()
    expect(((detail.root.children[0] as THREE.Mesh).material as THREE.MeshPhysicalMaterial).envMap).toBeNull()
    probe.releaseSceneDetail()
    probe.sceneContent.prepareFullDetail = async () => { throw new Error('Full-scene detail exceeds 96 MiB') }
    await expect(probe.capture(true)).rejects.toThrow('96 MiB')
    expect(captures).toBe(1); expect(root.visible).toBe(true)
  } finally { probe.releaseSceneDetail(); geometry.dispose(); material.dispose(); environment.dispose() }
})

test('optional full-scene budget failure does not reject a ready adaptive viewport', () => {
  const probe = rendererProbe(new SceneDocument(createScene(defaultSettings)))
  let adaptive = 0, fullError = ''
  probe.dirty = false
  probe.fullDetailSignal = new AbortController().signal
  probe.desired = new Map([['full', { key: 'full' }]])
  probe.detailBudget = () => { throw new Error('Full scene exceeds 96 MiB') }
  probe.waiters = [
    { full: false, resolve() { adaptive++ }, reject(error: Error) { throw error } },
    { full: true, resolve() { throw new Error('Full preparation must not succeed') }, reject(error: Error) { fullError = error.message } },
  ]
  try { probe.report(); expect(adaptive).toBe(1); expect(fullError).toContain('96 MiB'); expect(probe.waiters).toHaveLength(0) }
  finally { probe.ghostMaterial.dispose(); probe.host.getSceneViewport().environment.dispose() }
})

test('shadows ON load relevant offscreen casters, not far noncasters or unrelated chunks/assets', async () => {
  const model = new VoxelDocument({ x: 160, y: 16, z: 16 })
  model.setVoxel(0, 0, 0, 1); model.setVoxel(128, 0, 0, 1)
  const { chunks: _chunks, ...header } = encodeProjectSnapshot(model, defaultSettings)
  const raw = model.chunks.get(0)!.get(1)!, hash = 'a'.repeat(64)
  const chunks = [0, 8].map(id => describeSceneChunk(id, 1, raw, hash)!)
  const shared: SceneAsset = { id: 'shared', revision: 0, model: header, chunks, pivot: { x: 0, y: 0, z: 0 }, voxelCount: 2,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 129, y: 1, z: 1 } } }
  const other: SceneAsset = { ...shared, id: 'other', chunks: [{ ...chunks[0], blob: 'b'.repeat(64) }], bounds: chunks[0].bounds, voxelCount: 1 }
  const glass: SceneAsset = { ...other, id: 'glass', model: { ...header, materials: header.materials.map((m, i) => i === 1 ? { ...m, transmission: 0.5 } : m) } }
  const scene = createScene(defaultSettings); scene.assets = [shared, other, glass]
  scene.instances = [
    ['near', 'shared', 0, 0, 0], ['caster', 'shared', 20, 20, 0],
    ['far-same', 'shared', 7800, 0, 0], ['far-other', 'other', -7800, 0, 7800],
    ['far-caster', 'shared', 7800, 7800, 0], ['noncasting-glass', 'glass', 30, 30, 0],
  ].map(([id, assetId, x, y, z]) => ({ id: String(id), assetId: String(assetId), name: String(id), layerId: 1,
    position: { x: Number(x), y: Number(y), z: Number(z) }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }))
  const doc = new SceneDocument(scene), probe = rendererProbe(doc), viewport = probe.host.getSceneViewport()
  viewport.camera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.1, 200)
  viewport.camera.position.set(0, 80, 0); viewport.camera.up.set(0, 0, -1); viewport.camera.lookAt(0, 0, 0); viewport.camera.updateMatrixWorld()
  const light = new THREE.OrthographicCamera(); light.position.set(20000, 20000, 0); light.lookAt(0, 0, 0); light.updateMatrixWorld()
  viewport.shadowMatrix.copy(light.matrixWorldInverse)
  const read = spyOn(sceneStorage, 'loadSceneChunk').mockImplementation(async blob => {
    expect(blob).toBe(hash) // Neither the distant unique asset nor the glass caster may be fetched.
    return raw.slice()
  })
  const worker = new Worker(new URL('./scene-mesher.worker.ts', import.meta.url), { type: 'module' })
  probe.worker = worker; worker.onmessage = event => { probe.completed = event.data }
  try {
    probe.refresh(); probe.reconcile()
    expect([...probe.desired.values()].every((d: any) => d.asset.asset.id === 'shared' && d.id === 0)).toBe(true)
    await drainSceneWorker(probe)
    const ids = new Set([...probe.batches.values()].flatMap((batch: any) => batch.ids))
    expect([...ids].sort()).toEqual(['caster', 'far-caster', 'near'])
    expect(probe.diagnostics.chunkReads).toBe(1)
    expect(probe.diagnostics.meshJobs).toBe(3) // Near full/preview plus shared shadow LOD 8, all chunk 0.
    expect([...probe.surfaces.values()].every((surface: any) => surface.demand.asset.asset.id === 'shared' && surface.demand.id === 0)).toBe(true)
    probe.report(); expect(probe.stats.detail).toContain('relevant shadow contributors')
    const controller = new AbortController(), full = probe.prepareFullDetail(controller.signal)
    expect(new Set([...probe.fullDetailDemand.values()].map((d: any) => d.asset.asset.id))).toEqual(new Set(['shared', 'other', 'glass']))
    expect([...probe.fullDetailDemand.values()].some((d: any) => d.id === 8 && d.lod === 1)).toBe(true)
    controller.abort(); await expect(full).rejects.toMatchObject({ name: 'AbortError' })
    viewport.shadows = false; probe.reconcile()
    expect(new Set([...probe.batches.values()].flatMap((batch: any) => batch.ids))).toEqual(new Set(['near']))
    probe.refresh(doc.execute({ type: 'selection.set', ids: ['far-other'] })); probe.reconcile()
    expect([...probe.desired.values()].some((d: any) => d.asset.asset.id === 'other' && d.lod === 1)).toBe(true)
  } finally {
    read.mockRestore(); worker.terminate(); probe.clearBatches()
    for (const surface of [...probe.surfaces.values()]) probe.evict(surface)
    probe.ghostMaterial.dispose(); viewport.environment.dispose()
  }
})

test('ground receivers survive horizontal/sloped views and negative orthographic near planes', () => {
  const occupied = new THREE.Box3(new THREE.Vector3(-50, 0, -100), new THREE.Vector3(50, 40, 50))
  const light = new THREE.Matrix4().makeRotationX(Math.PI / 2)
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200)
  camera.position.set(0, 5, 20)
  for (const targetY of [5, 5 + 1e-9, 7]) {
    camera.lookAt(0, targetY, 0); camera.updateMatrixWorld()
    const volume = sceneShadowVolume(camera, occupied, [], light, 0)
    expect(volume).toBeDefined()
    expect(volume!.containsPoint(new THREE.Vector3(0, 20, 0))).toBe(true)
    expect(volume!.planes.every(p => [...p.normal.toArray(), p.constant].every(Number.isFinite))).toBe(true)
  }
  camera.lookAt(0, 100, 20); camera.updateMatrixWorld()
  expect(sceneShadowVolume(camera, occupied, [], light, 0)).toBeUndefined()
  const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, -50, 100)
  ortho.position.set(0, -10, 0); ortho.up.set(0, 0, -1); ortho.lookAt(0, -20, 0); ortho.updateMatrixWorld()
  expect(sceneShadowVolume(ortho, occupied, [], light, 0)!.containsPoint(new THREE.Vector3(0, 20, 0))).toBe(true)
})

test('receiver clipping handles frustum containment and ground shadows outside the occupied XZ box', () => {
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 50)
  camera.position.set(0, 20, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
  const occupied = new THREE.Box3(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100))
  const volume = sceneShadowVolume(camera, occupied, [occupied], new THREE.Matrix4().makeRotationX(Math.PI / 2))!
  expect(volume.containsPoint(new THREE.Vector3(0, 40, 0))).toBe(true)
  expect(volume.containsPoint(new THREE.Vector3(80, 40, 0))).toBe(false)
  const light = new THREE.OrthographicCamera(); light.position.set(100, 100, 0); light.lookAt(0, 0, 0); light.updateMatrixWorld()
  const caster = new THREE.Box3(new THREE.Vector3(20, 20, 0), new THREE.Vector3(21, 21, 1))
  const floor = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(30, 0, 10))
  expect(sceneShadowVolume(camera, caster, [], light.matrixWorldInverse, 0, 0, floor)!.intersectsBox(caster)).toBe(true)
  const absentFloor = new THREE.Box3(new THREE.Vector3(100, 0, 100), new THREE.Vector3(110, 0, 110))
  expect(sceneShadowVolume(camera, caster, [], light.matrixWorldInverse, 0, 0, absentFloor)).toBeUndefined()
})

test('renderer composition rejects inflated descriptors through the shared exact validator', async () => {
  const model = new VoxelDocument(); model.setVoxel(1, 1, 1, 1)
  const raw = model.chunks.get(0)!.get(1)!, descriptor = describeSceneChunk(0, 1, raw, 'c'.repeat(64))!
  const inflated = { ...descriptor, bounds: { min: descriptor.bounds.min, max: { ...descriptor.bounds.max, x: 3 } } }
  const { chunks: _chunks, ...header } = encodeProjectSnapshot(model, defaultSettings)
  const doc = new SceneDocument({ ...createScene(defaultSettings), assets: [{ id: 'invalid-bounds', revision: 0, model: header, pivot: { x: 0, y: 0, z: 0 }, voxelCount: 1, bounds: inflated.bounds, chunks: [inflated] }] })
  const probe = rendererProbe(doc), read = spyOn(sceneStorage, 'loadSceneChunk').mockResolvedValue(raw.slice())
  try {
    probe.refresh(); const state = probe.assets.get('invalid-bounds')
    await expect(probe.composite(state, 0, 1)).rejects.toThrow('does not match')
    expect(state.verified.size).toBe(0)
    state.chunks.set(0, [descriptor])
    expect(await probe.composite(state, 0, 1)).toEqual(raw)
    expect(state.verified.has(descriptor)).toBe(true)
  } finally { read.mockRestore(); probe.ghostMaterial.dispose(); probe.host.getSceneViewport().environment.dispose() }
})
