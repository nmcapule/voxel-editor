import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { chunkCoords, type Vec3 } from '../../shared/voxel/document'
import type { MeshData } from '../../shared/voxel/mesher'
import { castsRealtimeShadow } from '../../shared/rendering/stage'
import type { CameraSnapshot, PreparedSceneContent, SceneContent } from '../../shared/rendering/contracts'
import type { Viewport } from '../../shared/rendering/viewport'
import type { ViewSettings } from '../../shared/rendering/settings'
import { describeSceneChunk, validateSceneChunkDescriptor } from './chunks'
import { loadSceneChunk } from './storage'
import { instanceMatrix, type SceneDocument } from './document'
import { SCENE_GEOMETRY_BUDGET, WORLD_CELL_SIZE, type SceneAsset, type SceneBounds, type SceneChange, type SceneChunk, type SceneInstance, type SceneStats, type SceneTool, type SceneTransform, type TransformMode } from './types'
import { coarse8, sceneChunkFingerprint, sceneChunkNeighbors, sceneLod, type SceneLod, type SceneMeshJob } from './mesher'

export interface SceneRendererCallbacks {
  onSelect(ids: string[]): void
  onPlace(assetId: string, position: Vec3): void
  onTransform(transforms: (SceneTransform & { id: string })[]): void
  onLayer(id: number): void
  onStats(stats: SceneStats): void
  onError(message: string): void
}

const vector = (v: Vec3) => new THREE.Vector3(v.x, v.y, v.z)
const box = (b: SceneBounds) => new THREE.Box3(vector(b.min), vector(b.max))
const quaternion = (q: SceneTransform['rotation']) => new THREE.Quaternion(q.x, q.y, q.z, q.w)
const plain = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z })

export function sceneInstanceMatrix(transform: SceneTransform, pivot: Vec3) {
  return instanceMatrix(transform, { pivot })
}

/** World rotation and uniform group scale preserve each member's local TRS, never shear. */
export function sceneGroupTransform(original: SceneTransform, center: Vec3, position: Vec3, rotation: SceneTransform['rotation'], scale: number): SceneTransform {
  const q = quaternion(rotation)
  const p = vector(original.position).sub(vector(center)).multiplyScalar(scale).applyQuaternion(q).add(vector(position))
  const r = q.multiply(quaternion(original.rotation)).normalize()
  return { position: plain(p), rotation: { x: r.x, y: r.y, z: r.z, w: r.w }, scale: plain(vector(original.scale).multiplyScalar(scale)) }
}

interface AssetState {
  asset: SceneAsset
  fingerprints: Map<number, string>
  chunks: Map<number, SceneChunk[]>
  bounds: THREE.Box3
  chunkBounds: Map<number, THREE.Box3>
  counts: Map<number, number>
  verified: Set<SceneChunk>
}
interface Entry {
  instance: SceneInstance
  asset: AssetState
  matrix: THREE.Matrix4
  bounds: THREE.Box3
  cell: string
  lod: SceneLod
}
interface Demand { key: string; asset: AssetState; id: number; lod: SceneLod; priority: number }
interface Surface {
  demand: Demand
  parts: { geometry: THREE.BufferGeometry; material: THREE.MeshPhysicalMaterial; materialKey: string; triangles: number }[]
  bytes: number
  used: number
}
interface Batch { mesh: THREE.InstancedMesh; surface: Surface; ids: string[]; transforms: SceneTransform[]; part: number }
interface MeshResponse { key: string; generation: number; mesh?: MeshData; error?: string }
interface Hit { entry: Entry; point: THREE.Vector3; normal: THREE.Vector3; distance: number; approximate?: boolean }

// Worst-case fixed-16 transparent chunk fits this allowance, including retained CPU arrays.
const UPLOAD_BYTES_PER_FRAME = 8 * 1024 * 1024

export const SCENE_DETAIL_TRIANGLES = 1_000_000
export const SCENE_DETAIL_PEAK_BYTES = 96 * 1024 * 1024

/** Conservative peak: source buffers, expanded/baked/merged attributes, BVH worker
 * copies and GPU tables (2 KiB/triangle), material tables, and new trace targets.
 * Scene tracing caps its 0.75-scale input area to one megapixel; exact raster
 * capture still uses the existing full-resolution raster targets.
 * Existing host raster targets and storage's raw cache have separate budgets. */
export function sceneDetailBudget(triangles: number, materials: number, sourceBytes: number, pixels = 0) {
  if (![triangles, materials, sourceBytes, pixels].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid full-scene budget inputs')
  const peakBytes = sourceBytes + 16 * 1024 * 1024 + triangles * 2048 + materials * 8192 + Math.min(pixels, 1_000_000) * 48
  if (!Number.isSafeInteger(triangles) || triangles > SCENE_DETAIL_TRIANGLES) throw new Error('Full-scene detail exceeds the 1,000,000-triangle limit. Use adaptive raster or reduce the scene.')
  if (materials > 65534) throw new Error('Full-scene detail exceeds the tracer\'s 16-bit material limit.')
  if (peakBytes > SCENE_DETAIL_PEAK_BYTES) throw new Error(`Full-scene detail needs an estimated ${(peakBytes / 1048576).toFixed(1)} MiB peak; the limit is 96 MiB. Use adaptive raster or reduce the scene/resolution.`)
  return { triangles, peakBytes, sourceBytes }
}

interface DetailPart { geometry: THREE.BufferGeometry; material: THREE.MeshPhysicalMaterial; matrix: THREE.Matrix4 }

/** One ordinary mesh per material, with every instance baked into world-space arrays.
 * No InstancedMesh, shared mutable materials, or borrowed geometry escapes this adapter. */
export function expandSceneDetail(parts: DetailPart[], pixels = 0, shadows = true): PreparedSceneContent {
  const groups = new Map<THREE.MeshPhysicalMaterial, { parts: DetailPart[]; vertices: number }>()
  const sources = new Set<THREE.BufferGeometry>(), buffers = new Set<ArrayBufferLike>()
  let triangles = 0, sourceBytes = 0
  for (const part of parts) {
    const vertices = part.geometry.index?.count ?? part.geometry.getAttribute('position').count
    if (vertices % 3) throw new Error('Invalid full-scene triangle data')
    const group = groups.get(part.material) ?? { parts: [], vertices: 0 }
    group.parts.push(part); group.vertices += vertices; groups.set(part.material, group)
    triangles += vertices / 3
    if (!sources.has(part.geometry)) {
      sources.add(part.geometry)
      for (const attribute of [...Object.values(part.geometry.attributes), ...(part.geometry.index ? [part.geometry.index] : [])]) {
        if (!(attribute instanceof THREE.BufferAttribute)) throw new Error('Full-scene detail requires non-interleaved mesh attributes')
        sourceBytes += attribute.array.byteLength
        if (!buffers.has(attribute.array.buffer)) { buffers.add(attribute.array.buffer); sourceBytes += attribute.array.buffer.byteLength }
      }
    }
  }
  const budget = sceneDetailBudget(triangles, groups.size, sourceBytes, pixels)
  const root = new THREE.Group()
  let geometryBytes = 0, disposed = false
  try {
    for (const [source, group] of groups) {
      const positions = new Float32Array(group.vertices * 3), normals = new Float32Array(group.vertices * 3), uvs = new Float32Array(group.vertices * 2)
      let offset = 0
      const point = new THREE.Vector3(), normal = new THREE.Vector3()
      for (const { geometry, matrix } of group.parts) {
        const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv'), index = geometry.index
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
        for (let i = 0, count = index?.count ?? p.count; i < count; i++, offset++) {
          const vertex = index ? index.getX(i) : i
          point.fromBufferAttribute(p, vertex).applyMatrix4(matrix)
          normal.fromBufferAttribute(n, vertex).applyNormalMatrix(normalMatrix)
          positions[offset * 3] = point.x; positions[offset * 3 + 1] = point.y; positions[offset * 3 + 2] = point.z
          normals[offset * 3] = normal.x; normals[offset * 3 + 1] = normal.y; normals[offset * 3 + 2] = normal.z
          uvs[offset * 2] = uv?.getX(vertex) ?? 0; uvs[offset * 2 + 1] = uv?.getY(vertex) ?? 0
        }
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
      geometry.computeBoundingBox(); geometry.computeBoundingSphere()
      const material = source.clone()
      material.envMap = null // The trace scene supplies the shared environment, not a packed material texture.
      Object.assign(material, { castShadow: shadows })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = castsRealtimeShadow(source); mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      root.add(mesh)
      geometryBytes += (positions.byteLength + normals.byteLength + uvs.byteLength) * 2
    }
  } catch (error) {
    root.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose() } })
    throw error
  }
  return { root, ...budget, geometryBytes, sourceBytes, scope: 'full-scene', dispose() {
    if (disposed) return
    disposed = true
    root.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose() } })
    root.clear()
  } }
}

/** One worker, one borrowed viewport. Call refresh after document commands; callbacks own
 * command/history execution. Construction is inactive; setActive(true) mounts scene mode.
 * whenReady waits for drawable current LODs (or finer cached surfaces), independent
 * of optional full-scene trace preparation and lower-LOD background optimization.
 */
export class SceneRenderer {
  private host: Viewport
  private callbacks: SceneRendererCallbacks
  private document: SceneDocument
  private root = new THREE.Group()
  private surfaces = new Map<string, Surface>()
  private materials = new Map<string, { material: THREE.MeshPhysicalMaterial; refs: number }>()
  private assets = new Map<string, AssetState>()
  private entries = new Map<string, Entry>()
  private batches = new Map<string, Batch>()
  private desired = new Map<string, Demand>()
  private adaptiveDesired = new Map<string, Demand>()
  private failed = new Map<string, string>()
  private queue: Demand[] = []
  private busy?: Demand
  private busySignal?: AbortSignal
  private completed?: MeshResponse
  private worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })
  private workerFailed = false
  private generation = 0
  private pickGeneration = 0
  private geometryBytes = 0
  private matrixBytes = 0
  private transientBytes = 0
  private uploadBytes = 0
  private batchFailure?: string
  private lastError?: string
  private pressureLod: SceneLod = 1
  private clock = 0
  private active = false
  private sceneView?: CameraSnapshot
  private sceneRenderMode = false
  private appliedSettings?: ViewSettings
  private fullDetailSignal?: AbortSignal
  private fullDetailDemand?: Map<string, Demand>
  private detailReservationBytes = 0
  private detailGeometryBytes = 0
  private disposed = false
  private frame?: number
  private dirty = true
  private selection = new Set<string>()
  private tool: SceneTool = 'select'
  private mode: TransformMode = 'translate'
  private snap = true
  private placementAsset?: string
  private placementPosition?: THREE.Vector3
  private ghost = new THREE.Group()
  private ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x73b6df, transparent: true, opacity: 0.35, depthWrite: false })
  private outline = new THREE.Box3Helper(new THREE.Box3(), 0x4595dd)
  private marquee = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4595dd, depthTest: false, depthWrite: false }))
  private proxy = new THREE.Object3D()
  private gizmo: TransformControls
  private drag?: { originals: Map<string, SceneTransform>; center: THREE.Vector3; changed: boolean }
  private previews = new Map<string, SceneTransform>()
  private pointer?: { id: number; x: number; y: number; additive: boolean; moved: boolean; gizmo: boolean }
  private touches = new Set<number>()
  private blockedTouches = false
  private listeners = new AbortController()
  private waiters: { full: boolean; resolve(): void; reject(error: Error): void }[] = []
  private content: SceneContent
  private bounds = new THREE.Box3(new THREE.Vector3(-16, 0, -16), new THREE.Vector3(16, 32, 16))
  private statsValue: SceneStats = { residentBytes: 0, geometryBytes: 0, activeInstances: 0, pending: 0, triangles: 0, representedVoxels: 0, detail: 'Scene inactive' }
  /** Instrumentation: TRS changes update matrices, never invalidate surface cache keys. */
  readonly diagnostics = { meshJobs: 0, chunkReads: 0, uploads: 0, staleResults: 0, matrixUpdates: 0 }

  constructor(host: Viewport, document: SceneDocument, callbacks: SceneRendererCallbacks) {
    this.host = host
    this.callbacks = callbacks
    this.document = document
    const viewport = host.getSceneViewport()
    // Use TransformControls' public pointer API rather than installing a second set of
    // DOM listeners. Capture-phase routing gives either the gizmo or OrbitControls ownership.
    this.gizmo = new TransformControls(viewport.camera)
    this.gizmo.domElement = viewport.canvas
    this.gizmo.setSize(0.85)
    this.setSnap(true)
    this.gizmo.addEventListener('change', () => { if (this.active) this.host.render() })
    this.gizmo.addEventListener('mouseDown', () => this.startTransform())
    this.gizmo.addEventListener('objectChange', () => this.previewTransform())
    this.gizmo.addEventListener('mouseUp', () => this.finishTransform())
    for (const object of [this.ghost, this.outline, this.marquee, this.proxy, this.gizmo.getHelper()]) object.userData.editorOverlay = true
    this.outline.visible = this.marquee.visible = this.ghost.visible = false
    this.marquee.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3))
    this.marquee.frustumCulled = false
    this.marquee.renderOrder = 1000
    this.root.add(this.ghost, this.outline, this.marquee, this.proxy, this.gizmo.getHelper())
    this.content = { root: this.root, bounds: this.bounds,
      label: 'Scene viewport. Select or place objects; right drag or two-finger drag orbits. Escape cancels a transform.',
      whenReady: () => this.whenReady(), prepareFullDetail: signal => this.prepareFullDetail(signal), onViewportChange: () => {
      this.pickGeneration++
      for (const { material } of this.materials.values()) this.host.applyEnvironment(material)
      const viewport = this.host.getSceneViewport()
      this.gizmo.camera = viewport.camera
      viewport.controls.touches.ONE = viewport.renderMode ? THREE.TOUCH.ROTATE : -1 as THREE.TOUCH
      if (viewport.renderMode) { this.cancelInteraction(); this.ghost.visible = false }
      this.dirty = true
      this.updateGizmo()
      this.schedule()
    } }
    this.worker.onmessage = (event: MessageEvent<MeshResponse>) => {
      if (this.disposed) return
      if (!this.active) { this.busy = undefined; this.transientBytes = 0; return }
      this.completed = event.data
      this.schedule()
    }
    this.worker.onerror = () => {
      if (this.disposed) return
      this.workerFailed = true
      this.busy = undefined
      this.transientBytes = 0
      this.callbacks.onError('The scene surface worker stopped. Reload to retry.')
      this.schedule()
    }
    const options = { capture: true, signal: this.listeners.signal }
    viewport.canvas.addEventListener('pointerdown', event => this.pointerDown(event), options)
    viewport.canvas.addEventListener('pointermove', event => this.pointerMove(event), options)
    viewport.canvas.addEventListener('pointerup', event => this.pointerUp(event), options)
    viewport.canvas.addEventListener('pointercancel', () => { this.touches.clear(); this.blockedTouches = false; this.cancelInteraction() }, options)
    const cancelAbandonedDrag = () => {
      if (!this.active || !this.pointer && !this.drag) return
      this.touches.clear(); this.blockedTouches = false; this.cancelInteraction()
    }
    viewport.canvas.addEventListener('lostpointercapture', event => {
      if (this.pointer?.id === event.pointerId || !this.pointer && this.drag) cancelAbandonedDrag()
    }, options)
    viewport.canvas.addEventListener('webglcontextlost', cancelAbandonedDrag, options)
    const ownerDocument = viewport.canvas.ownerDocument
    ownerDocument.defaultView?.addEventListener('blur', cancelAbandonedDrag, { signal: this.listeners.signal })
    ownerDocument.addEventListener('visibilitychange', () => { if (ownerDocument.hidden) cancelAbandonedDrag() }, options)
    viewport.canvas.addEventListener('pointerleave', () => { if (!this.pointer) { this.ghost.visible = false; this.host.render() } }, options)
    viewport.canvas.addEventListener('keydown', event => {
      if (!this.active || event.key !== 'Escape') return
      if (this.drag || this.pointer) { event.preventDefault(); event.stopImmediatePropagation(); this.cancelInteraction() }
    }, options)
    viewport.canvas.addEventListener('webglcontextrestored', () => {
      for (const { material } of this.materials.values()) this.host.applyEnvironment(material)
      this.dirty = true
      this.schedule()
    }, { signal: this.listeners.signal })
    this.refresh()
  }

  get stats() { return { ...this.statsValue } }

  setDocument(document: SceneDocument) {
    this.cancelInteraction()
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Scene document changed during streaming'))
    this.generation++
    this.pickGeneration++
    this.document = document
    this.sceneView = undefined
    this.appliedSettings = undefined
    this.clearBatches()
    this.ghost.clear()
    for (const surface of [...this.surfaces.values()]) this.evict(surface)
    this.assets.clear()
    this.failed.clear()
    this.batchFailure = undefined
    this.pressureLod = 1
    this.desired.clear()
    this.adaptiveDesired.clear()
    this.queue = []
    this.refresh()
    if (this.active) this.frameSelection()
  }

  refresh(change?: SceneChange) {
    if (this.disposed) return
    this.pickGeneration++
    this.batchFailure = undefined
    this.failed.clear()
    if (this.drag) this.cancelInteraction()
    let dependenciesChanged = false
    const nextAssets = new Map<string, AssetState>()
    for (const asset of this.document.data.assets) {
      const previous = this.assets.get(asset.id)
      if (previous?.asset === asset && !change?.assetIds.includes(asset.id)) { nextAssets.set(asset.id, previous); continue }
      dependenciesChanged = true
      const chunks = new Map<number, SceneChunk[]>(), chunkBounds = new Map<number, THREE.Box3>(), counts = new Map<number, number>()
      const visibleLayers = new Map(asset.model.layers.filter(layer => layer.visible).map((layer, index) => [layer.id, index]))
      const bounds = new THREE.Box3()
      for (const chunk of asset.chunks) {
        if (!visibleLayers.has(chunk.layerId) || !chunk.count) continue
        const list = chunks.get(chunk.id) ?? []
        list.push(chunk)
        chunks.set(chunk.id, list)
        const b = chunkBounds.get(chunk.id) ?? new THREE.Box3()
        b.union(box(chunk.bounds)); chunkBounds.set(chunk.id, b); bounds.union(b)
        counts.set(chunk.id, (counts.get(chunk.id) ?? 0) + chunk.count)
      }
      for (const [id, list] of chunks) {
        list.sort((a, b) => visibleLayers.get(a.layerId)! - visibleLayers.get(b.layerId)!)
        const old = previous?.chunks.get(id)
        if (old?.length === list.length && list.every((chunk, i) => chunk === old[i])) {
          chunks.set(id, old)
          chunkBounds.set(id, previous!.chunkBounds.get(id)!)
        }
      }
      const unchanged = previous && chunks.size === previous.chunks.size && [...chunks].every(([id, list]) => list === previous.chunks.get(id))
      const fingerprints = new Map([...chunks.keys()].map(id => [id, sceneChunkFingerprint(asset, chunks, id)]))
      const descriptors = new Set(asset.chunks)
      nextAssets.set(asset.id, { asset, chunks: unchanged ? previous.chunks : chunks, fingerprints, bounds: previous?.bounds.equals(bounds) ? previous.bounds : bounds,
        chunkBounds: unchanged ? previous.chunkBounds : chunkBounds, counts, verified: new Set([...previous?.verified ?? []].filter(chunk => descriptors.has(chunk))) })
      for (const [key, cached] of this.materials) {
        const index = Number(key.slice(key.lastIndexOf(':') + 1))
        if (key !== `${asset.id}:${index}`) continue
        const preset = asset.model.materials[index], material = cached.material
        material.setValues({ ...preset, color: asset.model.palette[index], emissive: asset.model.palette[index],
          transparent: preset.opacity < 1, depthWrite: preset.opacity >= 1 })
        this.host.applyEnvironment(material)
        material.needsUpdate = true
      }
    }
    this.assets = nextAssets
    const previousEntries = this.entries
    this.entries = new Map()
    const bounds = new THREE.Box3()
    const visibleLayers = new Set(this.document.data.layers.filter(layer => layer.visible).map(layer => layer.id))
    for (const instance of this.document.data.instances) {
      const asset = this.assets.get(instance.assetId)
      if (!asset || asset.bounds.isEmpty() || !visibleLayers.has(instance.layerId)) continue
      const previous = previousEntries.get(instance.id)
      const sameTransform = previous && previous.instance.position === instance.position && previous.instance.rotation === instance.rotation && previous.instance.scale === instance.scale
        && (['x', 'y', 'z'] as const).every(axis => previous.asset.asset.pivot[axis] === asset.asset.pivot[axis])
      const matrix = sameTransform ? previous.matrix : sceneInstanceMatrix(instance, asset.asset.pivot)
      dependenciesChanged ||= !sameTransform
      if (!sameTransform) this.diagnostics.matrixUpdates = (this.diagnostics.matrixUpdates ?? 0) + 1
      const worldBounds = sameTransform && previous.asset.bounds === asset.bounds ? previous.bounds : asset.bounds.clone().applyMatrix4(matrix)
      const center = worldBounds.getCenter(new THREE.Vector3())
      const cell = worldBounds === previous?.bounds ? previous.cell : [center.x, center.y, center.z].map(n => Math.floor(n / WORLD_CELL_SIZE)).join(',')
      const entry = { instance, asset, matrix, bounds: worldBounds, cell, lod: previous?.lod ?? 8 as SceneLod }
      this.entries.set(instance.id, entry)
      bounds.union(worldBounds)
    }
    dependenciesChanged ||= previousEntries.size !== this.entries.size || [...previousEntries.keys()].some(id => !this.entries.has(id))
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-16, 0, -16), new THREE.Vector3(16, 32, 16))
    bounds.min.y = Math.min(0, bounds.min.y)
    const boundsChanged = !this.bounds.equals(bounds)
    this.bounds.copy(bounds)
    this.selection = new Set(this.document.selection)
    this.updateGizmo()
    if (this.active && dependenciesChanged) this.host.invalidateSceneContent()
    if (this.active && boundsChanged) this.host.setSceneContent(this.content)
    if (this.active && this.appliedSettings !== this.document.data.settings) {
      this.appliedSettings = this.document.data.settings
      this.host.setSettings(this.appliedSettings)
    }
    this.dirty = true
    this.schedule()
  }

  setTool(tool: SceneTool) { this.cancelInteraction(); this.tool = tool; this.ghost.visible = false; this.host.getSceneViewport().canvas.title = ''; this.updateGizmo(); this.dirty = true; this.schedule() }
  setTransformMode(mode: TransformMode) { this.cancelInteraction(); this.mode = mode; this.updateGizmo(); this.host.render() }
  setPlacementAsset(id?: string) { this.placementAsset = id; this.placementPosition = undefined; this.ghost.clear(); this.ghost.visible = false; this.dirty = true; this.schedule() }
  setSnap(enabled: boolean) { this.snap = enabled; this.gizmo.setTranslationSnap(enabled ? 1 : null); this.gizmo.setRotationSnap(enabled ? Math.PI / 12 : null); this.gizmo.setScaleSnap(enabled ? 0.1 : null) }
  setSelection(ids: string[]) { this.cancelInteraction(); this.pickGeneration++; this.selection = new Set(ids); this.updateGizmo(); this.dirty = true; this.schedule() }

  setActive(active: boolean) {
    if (this.disposed || this.active === active) return
    if (active && this.host.content) throw new Error('Deactivate the current viewport adapter before activating the scene')
    this.cancelInteraction()
    if (!active) { this.sceneView = this.host.getView(); this.sceneRenderMode = this.host.getSceneViewport().renderMode }
    this.active = active
    this.touches.clear(); this.blockedTouches = false
    this.pickGeneration++
    if (active || this.host.content === this.content) this.host.setSceneContent(active ? this.content : undefined)
    if (active) {
      this.failed.clear(); this.batchFailure = undefined; this.pressureLod = 1
      this.appliedSettings = this.document.data.settings
      this.host.setSettings(this.appliedSettings)
      this.host.setRenderMode(this.sceneRenderMode)
      if (this.sceneView) this.host.setView(this.sceneView)
      else this.frameSelection()
      this.dirty = true
      this.updateGizmo()
      this.schedule()
    } else {
      this.generation++
      if (this.frame !== undefined) cancelAnimationFrame(this.frame)
      this.frame = undefined
      this.queue = []
      this.desired.clear()
      this.adaptiveDesired.clear()
      if (this.completed) { this.completed = undefined; this.busy = undefined; this.transientBytes = 0 }
      this.clearBatches()
      this.ghost.clear()
      this.host.getSceneViewport().canvas.title = ''
      // The active editing model is the only pinned model; dormant scene surfaces are released.
      for (const surface of [...this.surfaces.values()]) this.evict(surface)
      this.report()
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Scene mode was unmounted'))
    }
  }

  frameSelection() {
    const bounds = new THREE.Box3()
    for (const id of this.selection) {
      const entry = this.entries.get(id)
      if (entry) bounds.union(entry.bounds).expandByPoint(vector(entry.instance.position))
    }
    this.host.frameSceneBounds(bounds.isEmpty() ? this.bounds : bounds)
  }

  whenReady(): Promise<void> {
    return this.waitForScene(false)
  }

  private waitForScene(full: boolean): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Scene renderer is disposed'))
    if (!this.active) return Promise.reject(new Error('Scene mode is not active'))
    this.dirty = true
    this.schedule()
    return new Promise((resolve, reject) => this.waiters.push({ full, resolve, reject }))
  }

  /** exact=true captures all visible scene layers at LOD 1, including offscreen
   * shadow/reflection contributors. It rejects rather than silently omitting any. */
  capture(exact = false) {
    if (!this.active || this.disposed) return Promise.reject(new Error('Scene mode is not active'))
    return this.host.capture(exact)
  }

  private detailBudget(requireComplete: boolean) {
    const surfaces = new Set<Surface>(), materials = new Set<string>()
    const counts = new Map<AssetState, number>()
    for (const entry of this.entries.values()) counts.set(entry.asset, (counts.get(entry.asset) ?? 0) + 1)
    let triangles = 0
    for (const [asset, count] of counts) for (const id of asset.chunks.keys()) {
      const surface = this.surfaces.get(this.key(asset, id, 1))
      if (!surface) { if (requireComplete) throw new Error('Full-scene dependencies are incomplete'); continue }
      surfaces.add(surface)
      for (const part of surface.parts) { triangles += part.triangles * count; materials.add(part.materialKey) }
    }
    const canvas = this.host.getSceneViewport().canvas
    return sceneDetailBudget(triangles, materials.size, [...surfaces].reduce((sum, surface) => sum + surface.bytes, 0), canvas.width * canvas.height)
  }

  async prepareFullDetail(signal: AbortSignal): Promise<PreparedSceneContent> {
    signal.throwIfAborted()
    if (!this.active || this.disposed) throw new Error('Scene mode is not active')
    if (this.fullDetailSignal && !this.fullDetailSignal.aborted) throw new Error('Full-scene detail is already preparing')
    this.fullDetailSignal = signal
    this.fullDetailDemand = new Map()
    for (const asset of new Set([...this.entries.values()].map(entry => entry.asset))) for (const id of asset.chunks.keys()) {
      const key = this.key(asset, id, 1)
      this.fullDetailDemand.set(key, { key, asset, id, lod: 1, priority: 0 })
    }
    const abort = () => {
      this.waiters = this.waiters.filter(waiter => {
        if (!waiter.full) return true
        waiter.reject(new DOMException('Full-scene preparation was superseded', 'AbortError')); return false
      })
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      this.detailBudget(false)
      await this.waitForScene(true)
      signal.throwIfAborted()
      const budget = this.detailBudget(true)
      const reserved = budget.peakBytes - budget.sourceBytes
      if (!this.makeRoom(reserved)) throw new Error('Full-scene staging does not fit the 128 MiB geometry budget. Reduce the scene or resolution.')
      const parts: DetailPart[] = []
      for (const entry of this.entries.values()) for (const id of entry.asset.chunks.keys()) {
        const c = chunkCoords(id), matrix = entry.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(c.x * 16, c.y * 16, c.z * 16))
        for (const part of this.surfaces.get(this.key(entry.asset, id, 1))!.parts) parts.push({ ...part, matrix })
      }
      const { canvas, shadows } = this.host.getSceneViewport()
      const detail = expandSceneDetail(parts, canvas.width * canvas.height, shadows)
      this.detailReservationBytes += reserved
      this.detailGeometryBytes += detail.geometryBytes
      const dispose = detail.dispose
      let released = false
      detail.dispose = () => {
        if (released) return
        released = true; dispose()
        this.detailReservationBytes -= reserved; this.detailGeometryBytes -= detail.geometryBytes
      }
      return detail
    } finally {
      signal.removeEventListener('abort', abort)
      if (this.fullDetailSignal === signal) { this.fullDetailSignal = undefined; this.fullDetailDemand = undefined }
      this.dirty = true
      this.schedule()
    }
  }

  private schedule() {
    if (!this.active || this.disposed || this.frame !== undefined) return
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      this.uploadBytes = 0
      // Finish the one worker result before matrix uploads; both share a frame allowance.
      if (this.completed) this.upload()
      if (this.dirty) this.reconcile()
      this.pump()
      this.report()
      this.host.render()
    })
  }

  private key(asset: AssetState, id: number, lod: SceneLod) { return `${asset.asset.id}:${asset.fingerprints.get(id)}:${id}:${lod}` }

  private reconcile(adaptive = false) {
    this.dirty = false
    this.clock++
    const full = !!this.fullDetailSignal && !this.fullDetailSignal.aborted && !adaptive
    if (full) {
      // Stage unique full chunks without replacing the live adaptive batches or
      // multiplying preparation metadata by the instance count.
      this.reconcile(true)
      this.desired = new Map(this.fullDetailDemand)
      this.queue = [...this.desired.values()].filter(d => !this.surfaces.has(d.key) && !this.failed.has(d.key) && d.key !== this.busy?.key).slice(0, 64)
      return
    }
    const { camera, canvas, shadows } = this.host.getSceneViewport()
    camera.updateMatrixWorld()
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    const desired = new Map<string, Demand>()
    const groups = new Map<string, { demand: Demand; entries: Entry[] }>()
    const require = (asset: AssetState, id: number, lod: SceneLod, priority: number) => {
      const key = this.key(asset, id, lod)
      const demand = desired.get(key) ?? { key, asset, id, lod, priority }
      demand.priority = Math.min(demand.priority, priority)
      desired.set(key, demand)
      return demand
    }
    const visibleIds = new Set([...this.document.index.queryFrustum(frustum), ...this.selection])
    const receivers: THREE.Box3[] = []
    const occupied = this.previews.size ? this.bounds.clone() : this.bounds
    if (shadows) for (const id of visibleIds) {
      const entry = this.entries.get(id)
      if (!entry) continue
      const preview = this.previews.get(id)
      const bounds = preview ? entry.asset.bounds.clone().applyMatrix4(sceneInstanceMatrix(preview, entry.asset.asset.pivot)) : entry.bounds
      if (preview) occupied.union(bounds)
      if (frustum.intersectsBox(bounds)) receivers.push(bounds)
    }
    // Only objects projecting onto visible receivers can contribute directional
    // shadows. Full capture/PBR still use the separate, complete fullDetailDemand.
    const shadowVolume = shadows ? this.host.getSceneShadowVolume(receivers, occupied) : undefined
    if (shadowVolume) for (const id of this.document.index.queryFrustum(shadowVolume)) visibleIds.add(id)
    entriesLoop: for (const instanceId of visibleIds) {
        const entry = this.entries.get(instanceId)
        if (!entry) continue
        const selected = this.selection.has(entry.instance.id)
        const preview = this.previews.get(entry.instance.id)
        const matrix = preview ? sceneInstanceMatrix(preview, entry.asset.asset.pivot) : entry.matrix
        const bounds = preview ? entry.asset.bounds.clone().applyMatrix4(matrix) : entry.bounds
        const visible = frustum.intersectsBox(bounds)
        if (!visible && !selected && !shadowVolume?.intersectsBox(bounds)) continue
        const distance = Math.max(1, camera.position.distanceTo(bounds.getCenter(new THREE.Vector3())) - bounds.getSize(new THREE.Vector3()).length() / 2)
        const scale = Math.max(entry.instance.scale.x, entry.instance.scale.y, entry.instance.scale.z)
        const pixels = camera instanceof THREE.PerspectiveCamera ? 16 * scale * canvas.clientHeight / (2 * Math.tan(camera.fov * Math.PI / 360) * distance) : 16 * scale * canvas.clientHeight * camera.zoom / (camera.top - camera.bottom)
        entry.lod = Math.max(sceneLod(visible ? pixels : 0, entry.lod, selected), selected ? 1 : this.pressureLod) as SceneLod
        for (const [id, localBounds] of entry.asset.chunkBounds) {
          const worldBounds = localBounds.clone().applyMatrix4(matrix)
          const chunkVisible = visible && frustum.intersectsBox(worldBounds)
           const chunkCaster = shadowVolume?.intersectsBox(worldBounds) && (!this.document.data.settings.pbrMaterials
             || entry.asset.chunks.get(id)!.some(chunk => chunk.colors.some(color => castsRealtimeShadow(entry.asset.asset.model.materials[color]))))
          if (!chunkVisible && !selected && !chunkCaster) continue
          const demand = require(entry.asset, id, entry.lod, selected ? 0 : 10 + distance)
          if (!chunkVisible && !chunkCaster) continue
          // A coarse preview remains visible while full detail streams. Never turn missing data into empty space.
          const fallback = this.surfaces.has(demand.key) ? demand : [4, 8, 1].map(lod => ({ ...demand, lod: lod as SceneLod, key: this.key(entry.asset, id, lod as SceneLod) })).find(d => this.surfaces.has(d.key))
          if (!fallback && entry.lod === 1) require(entry.asset, id, 4, selected ? -1 : 5 + distance)
          const shown = fallback ?? demand
          const groupKey = `${entry.cell}:${shown.key}`
          // ponytail: bound adaptive draw metadata as well as buffers; the exact
          // path is separately preflighted and never truncates contributors.
          if (!groups.has(groupKey) && groups.size >= 16_384) {
            this.batchFailure = 'Adaptive draw-batch limit reached; some scene/shadow contributors are omitted. Try bounded full-scene capture or reduce the scene.'
            break entriesLoop
          }
          const group = groups.get(groupKey) ?? { demand: shown, entries: [] }
          group.entries.push(entry); groups.set(groupKey, group)
        }
    }
    const ghostAsset = this.tool === 'place' ? this.assets.get(this.placementAsset ?? '') : undefined
    if (ghostAsset) for (const id of ghostAsset.chunks.keys()) require(ghostAsset, id, 4, 1)
    this.desired = desired
    this.adaptiveDesired = desired
    for (const [key, batch] of this.batches) {
      const group = groups.get(key.slice(0, key.lastIndexOf(':')))
      if (!group || group.demand.key !== batch.surface.demand.key) this.removeBatch(key, batch)
    }
    this.ghost.clear()
    for (const surface of [...this.surfaces.values()]) {
      const asset = this.assets.get(surface.demand.asset.asset.id)
      if (!asset || this.key(asset, surface.demand.id, surface.demand.lod) !== surface.demand.key) this.evict(surface)
      else surface.demand = { ...surface.demand, asset }
    }
    for (const [key, group] of groups) {
      const surface = this.surfaces.get(group.demand.key)
      if (!surface) continue
      surface.used = this.clock
      const transforms = group.entries.map(entry => this.previews.get(entry.instance.id) ?? entry.instance)
      const c = chunkCoords(group.demand.id)
      const offset = new THREE.Matrix4().makeTranslation(c.x * 16, c.y * 16, c.z * 16)
      surface.parts.forEach((part, index) => {
        const batchKey = `${key}:${index}`
        let batch = this.batches.get(batchKey)
        Object.assign(part.material, { castShadow: shadows })
        if (batch) batch.mesh.castShadow = castsRealtimeShadow(group.demand.asset.asset.model.materials[Number(part.materialKey.split(':').at(-1))])
        if (batch && batch.transforms.length === transforms.length && transforms.every((t, i) => t === batch!.transforms[i])) return
        const uploadBytes = group.entries.length * 16 * 4
        if (this.uploadBytes + uploadBytes > UPLOAD_BYTES_PER_FRAME) { this.dirty = true; this.schedule(); return }
        if (batch && batch.mesh.instanceMatrix.count < group.entries.length) { this.removeBatch(batchKey, batch); batch = undefined }
        if (!batch) {
          const bytes = group.entries.length * 16 * 4 * 2
          if (!this.makeRoom(bytes)) {
            if (!this.batchFailure) this.callbacks.onError('Scene instance-buffer budget reached. Reduce the visible scene or selection.')
            this.batchFailure = 'Scene instance-buffer budget reached'
            return
          }
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, group.entries.length)
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
          mesh.receiveShadow = true
          mesh.castShadow = castsRealtimeShadow(group.demand.asset.asset.model.materials[Number(part.materialKey.split(':').at(-1))])
          batch = { mesh, surface, ids: [], transforms: [], part: index }
          this.batches.set(batchKey, batch); this.root.add(mesh); this.matrixBytes += bytes
        }
        this.uploadBytes += uploadBytes
        batch.mesh.count = group.entries.length
        batch.ids = group.entries.map(entry => entry.instance.id)
        batch.transforms = transforms
        group.entries.forEach((entry, index) => {
          const preview = this.previews.get(entry.instance.id)
          batch!.mesh.setMatrixAt(index, (preview ? sceneInstanceMatrix(preview, entry.asset.asset.pivot) : entry.matrix.clone()).multiply(offset))
        })
        batch.mesh.instanceMatrix.needsUpdate = true
        batch.mesh.computeBoundingBox(); batch.mesh.computeBoundingSphere()
      })
    }
    if (ghostAsset) {
      for (const id of ghostAsset.chunks.keys()) {
        const surface = [1, 4, 8].map(lod => this.surfaces.get(this.key(ghostAsset, id, lod as SceneLod))).find(Boolean)
        if (!surface) continue
        surface.used = this.clock
        const c = chunkCoords(id)
        for (const part of surface.parts) {
          const mesh = new THREE.Mesh(part.geometry, this.ghostMaterial)
          mesh.position.set(c.x * 16 - ghostAsset.asset.pivot.x, c.y * 16 - ghostAsset.asset.pivot.y, c.z * 16 - ghostAsset.asset.pivot.z)
          this.ghost.add(mesh)
        }
      }
    }
    this.queue = [...desired.values()].filter(d => !this.surfaces.has(d.key) && !this.failed.has(d.key) && d.key !== this.busy?.key).sort((a, b) => a.priority - b.priority).slice(0, 64)
    this.host.getSceneViewport().renderer.shadowMap.needsUpdate = true
  }

  private async composite(asset: AssetState, id: number, lod: SceneLod, current = () => true) {
    const n = lod === 1 ? 4096 : 64
    const voxels = new Uint8Array(n)
    for (const chunk of asset.chunks.get(id) ?? []) {
      this.diagnostics.chunkReads += Number(lod === 1)
      const data = lod === 1 ? await loadSceneChunk(chunk.blob) : chunk.lod
      if (!current()) throw new DOMException('Scene request superseded', 'AbortError')
      if (data.length !== n) throw new Error(`Invalid chunk ${chunk.blob}: expected ${n} cells`)
      if (lod === 1 && !asset.verified.has(chunk)) {
        const actual = describeSceneChunk(chunk.id, chunk.layerId, data as Uint8Array, chunk.blob)
        validateSceneChunkDescriptor(chunk, actual)
        asset.verified.add(chunk)
      }
      for (let index = 0; index < n; index++) if (data[index]) voxels[index] = data[index]
    }
    return lod === 8 ? coarse8(voxels) : voxels
  }

  private pump() {
    if (this.busy || this.workerFailed || !this.active) return
    const demand = this.queue.shift()
    if (!demand) return
    if (!this.makeRoom(UPLOAD_BYTES_PER_FRAME)) {
      if (demand.priority >= 10 && this.pressureLod < 8) {
        this.pressureLod = this.pressureLod === 1 ? 4 : 8
        this.dirty = true; this.schedule(); return
      }
      this.fail(demand.key, new Error('Scene geometry budget reached; zoom out or reduce the selection.'))
      this.dirty = true; this.schedule(); return
    }
    this.busy = demand
    const signal = this.fullDetailSignal
    this.busySignal = signal
    const generation = this.generation
    const current = () => generation === this.generation && this.active && this.desired.has(demand.key) && (!signal || !signal.aborted && signal === this.fullDetailSignal)
    void (async () => {
      try {
        const ids = sceneChunkNeighbors(demand.id).filter(id => demand.asset.chunks.has(id))
        const chunks: SceneMeshJob['chunks'] = []
        for (const id of ids) {
          const voxels = await this.composite(demand.asset, id, demand.lod, current)
          if (!current()) { this.busy = undefined; this.busySignal = undefined; this.transientBytes = 0; this.dirty = true; this.schedule(); return }
          chunks.push({ id, voxels })
          this.transientBytes += voxels.byteLength
        }
        const transparent = Uint8Array.from(demand.asset.asset.model.materials, m => Number(m.opacity < 1 || m.transmission > 0))
        this.diagnostics.meshJobs++
        this.worker.postMessage({ key: demand.key, generation, id: demand.id, step: demand.lod, chunks, transparent } satisfies SceneMeshJob, chunks.map(c => c.voxels.buffer))
      } catch (error) {
        if (generation === this.generation && this.active && !(error instanceof DOMException && error.name === 'AbortError')) this.fail(demand.key, error)
        this.busy = undefined; this.busySignal = undefined; this.transientBytes = 0; this.dirty = true; this.schedule()
      }
    })()
  }

  private upload() {
    const result = this.completed!, demand = this.busy, signal = this.busySignal
    this.completed = undefined; this.busy = undefined; this.busySignal = undefined; this.transientBytes = 0
    const asset = demand && this.assets.get(demand.asset.asset.id)
    if (!demand || !asset || signal && (signal.aborted || signal !== this.fullDetailSignal) || result.generation !== this.generation || !this.desired.has(result.key) || this.key(asset, demand.id, demand.lod) !== result.key) {
      this.diagnostics.staleResults++; this.dirty = true; return
    }
    demand.asset = asset
    if (!result.mesh) { this.fail(result.key, result.error); this.dirty = true; return }
    const mesh = result.mesh
    const bytes = (mesh.positions.byteLength + mesh.normals.byteLength + mesh.uvs.byteLength + mesh.indices.byteLength) * 2
    if (bytes > UPLOAD_BYTES_PER_FRAME || !this.makeRoom(bytes)) { this.fail(result.key, new Error('Scene geometry budget reached; zoom out or reduce the selection. Coarse surfaces remain visible.')); this.dirty = true; return }
    const parts: Surface['parts'] = []
    for (const group of mesh.groups) {
      const start = group.vertexStart, end = start + group.vertexCount
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions.subarray(start * 3, end * 3), 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals.subarray(start * 3, end * 3), 3))
      geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs.subarray(start * 2, end * 2), 2))
      const indices = mesh.indices.subarray(group.start, group.start + group.count)
      for (let i = 0; i < indices.length; i++) indices[i] -= start
      geometry.setIndex(new THREE.BufferAttribute(indices, 1))
      geometry.computeBoundingBox(); geometry.computeBoundingSphere()
      const materialKey = `${demand.asset.asset.id}:${group.materialIndex}`
      let cached = this.materials.get(materialKey)
      if (!cached) {
        const preset = demand.asset.asset.model.materials[group.materialIndex]
        const color = demand.asset.asset.model.palette[group.materialIndex]
        const material = new THREE.MeshPhysicalMaterial({ ...preset, color, emissive: color,
          transparent: preset.opacity < 1, depthWrite: preset.opacity >= 1 })
        this.host.applyEnvironment(material)
        cached = { material, refs: 0 }; this.materials.set(materialKey, cached)
      }
      cached.refs++
      parts.push({ geometry, material: cached.material, materialKey, triangles: group.count / 3 })
    }
    this.surfaces.set(result.key, { demand, parts, bytes, used: this.clock })
    this.geometryBytes += bytes
    this.uploadBytes += bytes / 2
    this.diagnostics.uploads++
    this.dirty = true
  }

  private fail(key: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error ?? 'Scene meshing failed')
    this.failed.set(key, message)
    if (message !== this.lastError) { this.lastError = message; this.callbacks.onError(message) }
  }

  private makeRoom(bytes: number) {
    const reserve = (this.busy ? UPLOAD_BYTES_PER_FRAME : 0) + (this.detailReservationBytes ?? 0)
    if (this.geometryBytes + this.matrixBytes + bytes + reserve <= SCENE_GEOMETRY_BUDGET) return true
    const pinned = new Set([...this.batches.values()].map(batch => batch.surface))
    for (const surface of [...this.surfaces.values()].sort((a, b) => a.used - b.used)) {
      if (pinned.has(surface) || surface.used === this.clock || this.desired.get(surface.demand.key)?.priority === 0 || this.fullDetailDemand?.has(surface.demand.key)) continue
      this.evict(surface)
      if (this.geometryBytes + this.matrixBytes + bytes + reserve <= SCENE_GEOMETRY_BUDGET) return true
    }
    return false
  }

  private evict(surface: Surface) {
    for (const part of surface.parts) {
      part.geometry.dispose()
      const cached = this.materials.get(part.materialKey)!
      if (--cached.refs === 0) { cached.material.dispose(); this.materials.delete(part.materialKey) }
    }
    this.geometryBytes -= surface.bytes
    this.surfaces.delete(surface.demand.key)
  }

  private removeBatch(key: string, batch: Batch) {
    this.matrixBytes -= batch.mesh.instanceMatrix.array.byteLength * 2
    this.root.remove(batch.mesh); batch.mesh.dispose(); this.batches.delete(key)
  }
  private clearBatches() { for (const [key, batch] of this.batches) this.removeBatch(key, batch) }

  private report() {
    const instances = new Set<string>(), represented = new Set<string>()
    const { camera } = this.host.getSceneViewport()
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    let triangles = 0, representedVoxels = 0
    for (const batch of this.batches.values()) {
      if (batch.mesh.frustumCulled && !frustum.intersectsObject(batch.mesh)) continue
      triangles += batch.surface.parts[batch.part].triangles * batch.mesh.count
      for (const id of batch.ids) {
        instances.add(id)
        const key = `${id}:${batch.surface.demand.id}`
        if (!represented.has(key)) { represented.add(key); representedVoxels += batch.surface.demand.asset.counts.get(batch.surface.demand.id) ?? 0 }
      }
    }
    const missing = [...this.desired.keys()].filter(key => !this.surfaces.has(key))
    const pending = new Set([...missing.filter(key => !this.failed.has(key)), ...(this.busy ? [this.busy.key] : [])]).size
    const adaptiveMissing = [...this.adaptiveDesired.values()].filter(d => !this.surfaces.has(d.key)
      && !([1, 4, 8] as const).some(lod => lod <= d.lod && this.surfaces.has(this.key(d.asset, d.id, lod))))
    const adaptiveFailure = this.workerFailed ? 'Scene surface worker stopped' : this.batchFailure ?? adaptiveMissing.map(d => this.failed.get(d.key)).find(Boolean)
    let fullFailure = this.workerFailed ? 'Scene surface worker stopped' : missing.map(key => this.failed.get(key)).find(Boolean)
    if (this.fullDetailSignal) { try { this.detailBudget(false) } catch (error) { fullFailure = error instanceof Error ? error.message : String(error) } }
    const failure = this.fullDetailSignal ? fullFailure : adaptiveFailure
    this.statsValue = { residentBytes: (this.geometryBytes + this.matrixBytes + this.detailGeometryBytes) / 2 + this.transientBytes,
      geometryBytes: this.geometryBytes + this.matrixBytes + this.detailGeometryBytes, activeInstances: instances.size, pending,
      triangles, representedVoxels, detail: failure ? `Adaptive raster; shadows may be incomplete: ${failure}` : `${this.fullDetailSignal ? 'Full-scene detail' : 'Adaptive LOD 1/4/8'}; ${this.host.getSceneViewport().shadows ? pending ? 'relevant shadow contributors streaming' : 'relevant shadow contributors, adaptive LOD' : 'shadows off'}; represented = source voxels${this.pressureLod > 1 ? '; reduced detail to fit memory budget' : ''}` }
    this.callbacks.onStats(this.stats)
    if (!this.dirty) this.waiters = this.waiters.filter(waiter => {
      const error = waiter.full ? fullFailure : adaptiveFailure
      const waiting = waiter.full ? pending : adaptiveMissing.length
      if (error) waiter.reject(new Error(error))
      else if (!waiting) waiter.resolve()
      else return true
      return false
    })
  }

  private updateGizmo() {
    if (this.drag) return
    const entries = [...this.selection].map(id => this.entries.get(id)).filter((entry): entry is Entry => !!entry)
    const bounds = new THREE.Box3()
    for (const entry of entries) bounds.union(entry.bounds)
    this.outline.box.copy(bounds)
    this.outline.visible = this.active && !this.host.getSceneViewport().renderMode && !bounds.isEmpty()
    const editable = entries.length && entries.every(entry => !this.document.data.layers.find(layer => layer.id === entry.instance.layerId)?.locked)
    if (!this.active || this.host.getSceneViewport().renderMode || this.tool !== 'transform' || !editable) { this.gizmo.detach(); return }
    if (entries.length === 1) {
      const t = entries[0].instance
      this.proxy.position.copy(vector(t.position)); this.proxy.quaternion.copy(quaternion(t.rotation)); this.proxy.scale.copy(vector(t.scale))
    } else {
      this.proxy.position.copy(bounds.getCenter(new THREE.Vector3())); this.proxy.quaternion.identity(); this.proxy.scale.setScalar(1)
    }
    this.proxy.updateMatrixWorld()
    this.gizmo.setMode(this.mode)
    this.gizmo.setSpace(entries.length === 1 && this.mode !== 'translate' ? 'local' : 'world')
    this.setSnap(this.snap)
    this.gizmo.attach(this.proxy)
  }

  private syncRasterInteraction() {
    this.host.setRasterInteraction('scene', !!this.drag || !!this.pointer && (this.pointer.gizmo || this.tool === 'select' || this.tool === 'transform'))
  }

  private startTransform() {
    const originals = new Map<string, SceneTransform>()
    for (const id of this.selection) { const entry = this.entries.get(id); if (entry) originals.set(id, structuredClone({ position: entry.instance.position, rotation: entry.instance.rotation, scale: entry.instance.scale })) }
    this.drag = { originals, center: this.proxy.position.clone(), changed: false }
    this.syncRasterInteraction()
    this.host.setSceneInteraction(true)
    this.host.getSceneViewport().controls.enabled = false
  }

  private previewTransform() {
    if (!this.drag) return
    if (this.drag.originals.size > 1 && this.mode === 'scale') {
      const axis = this.gizmo.axis?.includes('X') ? 'x' : this.gizmo.axis?.includes('Y') ? 'y' : 'z'
      let min = 0, max = Infinity
      for (const original of this.drag.originals.values()) {
        min = Math.max(min, 0.01 / Math.min(original.scale.x, original.scale.y, original.scale.z))
        max = Math.min(max, 256 / Math.max(original.scale.x, original.scale.y, original.scale.z))
      }
      this.proxy.scale.setScalar(THREE.MathUtils.clamp(this.proxy.scale[axis], min, max))
    }
    if (this.drag.originals.size === 1) this.proxy.scale.clamp(new THREE.Vector3(0.01, 0.01, 0.01), new THREE.Vector3(256, 256, 256))
    const q = this.proxy.quaternion
    const rotation = { x: q.x, y: q.y, z: q.z, w: q.w }
    for (const [id, original] of this.drag.originals) this.previews.set(id, this.drag.originals.size === 1
      ? { position: plain(this.proxy.position), rotation, scale: plain(this.proxy.scale) }
      : sceneGroupTransform(original, this.drag.center, this.proxy.position, rotation, this.proxy.scale.x))
    this.drag.changed = true
    this.dirty = true
    this.schedule()
  }

  private finishTransform() {
    const drag = this.drag
    this.drag = undefined
    this.host.setSceneInteraction(false)
    this.host.getSceneViewport().controls.enabled = true
    if (!drag) { this.syncRasterInteraction(); return }
    const transforms = [...this.previews].filter(([id, t]) => {
      const old = drag.originals.get(id)!
      const before = sceneInstanceMatrix(old, { x: 0, y: 0, z: 0 }).elements
      return !sceneInstanceMatrix(t, { x: 0, y: 0, z: 0 }).elements.every((n, index) => Math.abs(n - before[index]) < 1e-8)
    }).map(([id, t]) => ({ id, ...t }))
    this.previews.clear()
    try { if (drag.changed && transforms.length) this.callbacks.onTransform(transforms) }
    catch (error) { this.callbacks.onError(error instanceof Error ? error.message : 'Transform rejected') }
    finally { this.syncRasterInteraction(); this.refresh() }
  }

  private cancelInteraction() {
    if (!this.active && !this.pointer && !this.drag) return
    this.pickGeneration++
    this.drag = undefined
    this.host.setSceneInteraction(false)
    this.previews.clear()
    this.gizmo.dragging = false
    this.gizmo.axis = null
    const pointer = this.pointer
    this.pointer = undefined
    this.syncRasterInteraction()
    const { canvas, controls } = this.host.getSceneViewport()
    if (pointer && canvas.hasPointerCapture(pointer.id)) canvas.releasePointerCapture(pointer.id)
    controls.enabled = true
    this.marquee.visible = false
    this.updateGizmo()
    this.dirty = true
    this.schedule()
  }

  private coordinates(event: MouseEvent, button = event.button) {
    const rect = this.host.getSceneViewport().canvas.getBoundingClientRect()
    // @types/three calls this a DOM PointerEvent, but the installed public API
    // explicitly takes normalized {x,y,button} coordinates (see _getPointer).
    return { x: (event.clientX - rect.left) / rect.width * 2 - 1, y: -(event.clientY - rect.top) / rect.height * 2 + 1, button } as PointerEvent
  }

  private ray(event: MouseEvent) {
    const { camera } = this.host.getSceneViewport()
    camera.updateMatrixWorld()
    const p = this.coordinates(event)
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), camera)
    raycaster.ray.origin.set(p.x, p.y, -1).unproject(camera)
    raycaster.far = new THREE.Vector3(p.x, p.y, 1).unproject(camera).distanceTo(raycaster.ray.origin)
    return raycaster
  }

  private pointerDown(event: PointerEvent) {
    if (!this.active || this.host.getSceneViewport().renderMode) return
    if (event.pointerType === 'touch') {
      this.touches.add(event.pointerId)
      if (this.touches.size > 1) {
        this.blockedTouches ||= !!this.drag
        this.cancelInteraction()
        if (this.blockedTouches) event.stopImmediatePropagation()
        return
      }
    }
    if (event.button !== 0 || this.pointer) return
    this.host.focusViewport()
    if (this.gizmo.object) { this.gizmo.getHelper().updateMatrixWorld(true); this.gizmo.pointerHover(this.coordinates(event)); this.gizmo.pointerDown(this.coordinates(event)) }
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, additive: event.shiftKey, moved: false, gizmo: !!this.drag }
    this.syncRasterInteraction()
    if (this.drag) { event.preventDefault(); event.stopImmediatePropagation() }
    this.host.getSceneViewport().canvas.setPointerCapture(event.pointerId)
  }

  private pointerMove(event: PointerEvent) {
    if (!this.active || this.host.getSceneViewport().renderMode || this.touches.size > 1) return
    if (this.pointer?.id === event.pointerId) {
      if (this.pointer.gizmo) { event.stopImmediatePropagation(); this.gizmo.pointerMove(this.coordinates(event, -1)); return }
      this.pointer.moved ||= Math.hypot(event.clientX - this.pointer.x, event.clientY - this.pointer.y) >= 5
      if (this.pointer.moved && (this.tool === 'select' || this.tool === 'transform')) this.drawMarquee(event)
    } else if (this.gizmo.object) this.gizmo.pointerHover(this.coordinates(event))
    if (this.tool === 'place' && !event.buttons) this.updatePlacement(this.approximateHit(this.ray(event)), this.ray(event).ray)
  }

  private pointerUp(event: PointerEvent) {
    if (!this.active) return
    this.touches.delete(event.pointerId)
    if (this.blockedTouches) { event.stopImmediatePropagation(); if (!this.touches.size) this.blockedTouches = false; return }
    const pointer = this.pointer
    if (!pointer || pointer.id !== event.pointerId) return
    this.pointer = undefined
    this.marquee.visible = false
    try {
      if (pointer.gizmo) { event.stopImmediatePropagation(); this.gizmo.pointerUp(this.coordinates(event)); this.updateGizmo() }
      else if (pointer.moved && (this.tool === 'select' || this.tool === 'transform')) this.selectMarquee(pointer, event)
      else if (!pointer.moved) void this.click(event, pointer.additive)
    } finally {
      if (pointer.gizmo && (this.drag || this.gizmo.dragging)) this.cancelInteraction()
      this.syncRasterInteraction()
      const canvas = this.host.getSceneViewport().canvas
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      this.host.render()
    }
  }

  private drawMarquee(event: PointerEvent) {
    const p = this.pointer!, camera = this.host.getSceneViewport().camera
    const first = this.coordinates({ clientX: p.x, clientY: p.y, button: 0 } as MouseEvent), end = this.coordinates(event)
    const positions = this.marquee.geometry.getAttribute('position') as THREE.BufferAttribute
    ;[[first.x, first.y], [end.x, first.y], [end.x, end.y], [first.x, end.y]].forEach(([x, y], i) => {
      const v = new THREE.Vector3(x, y, -0.99).unproject(camera); positions.setXYZ(i, v.x, v.y, v.z)
    })
    positions.needsUpdate = true; this.marquee.visible = true; this.host.render()
  }

  private selectMarquee(pointer: { x: number; y: number; additive: boolean }, event: PointerEvent) {
    const selected = new Set(pointer.additive ? this.selection : [])
    const start = this.coordinates({ clientX: pointer.x, clientY: pointer.y, button: 0 } as MouseEvent), end = this.coordinates(event)
    const { camera } = this.host.getSceneViewport()
    for (const entry of this.entries.values()) {
      const screen = new THREE.Box3()
      for (const x of [entry.bounds.min.x, entry.bounds.max.x]) for (const y of [entry.bounds.min.y, entry.bounds.max.y]) for (const z of [entry.bounds.min.z, entry.bounds.max.z]) screen.expandByPoint(new THREE.Vector3(x, y, z).project(camera))
      if (screen.max.z < -1 || screen.min.z > 1) continue
      if (screen.max.x >= Math.min(start.x, end.x) && screen.min.x <= Math.max(start.x, end.x) && screen.max.y >= Math.min(start.y, end.y) && screen.min.y <= Math.max(start.y, end.y)) selected.add(entry.instance.id)
    }
    this.callbacks.onSelect([...selected])
  }

  private candidates(ray: THREE.Ray) {
    return this.document.index.queryRay(ray).flatMap(({ id, distance }) => {
      const entry = this.entries.get(id)
      return entry && ray.intersectsBox(entry.bounds) ? [{ entry, distance }] : []
    })
  }

  private loadedHit(entry: Entry, id: number, raycaster: THREE.Raycaster): Hit | undefined {
    const surface = this.surfaces.get(this.key(entry.asset, id, 1))
    if (!surface) return
    const c = chunkCoords(id), matrix = entry.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(c.x * 16, c.y * 16, c.z * 16))
    let best: Hit | undefined
    for (const part of surface.parts) {
      const mesh = new THREE.Mesh(part.geometry, part.material)
      mesh.matrixWorld.copy(matrix)
      const hit = raycaster.intersectObject(mesh, false)[0]
      if (hit?.face && (!best || hit.distance < best.distance)) best = { entry, point: hit.point, normal: hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(matrix)), distance: hit.distance }
    }
    return best
  }

  private approximateHit(raycaster: THREE.Raycaster): Hit | undefined {
    let best: Hit | undefined
    for (const { entry, distance } of this.candidates(raycaster.ray)) {
      if (best && distance > best.distance) break
      for (const [id, bounds] of entry.asset.chunkBounds) {
        const worldBounds = bounds.clone().applyMatrix4(entry.matrix)
        const point = raycaster.ray.intersectBox(worldBounds, new THREE.Vector3())
        if (!point) continue
        const surface = this.surfaces.get(this.key(entry.asset, id, 1))
        const hit = surface ? this.loadedHit(entry, id, raycaster) : { entry, point, normal: new THREE.Vector3(0, 1, 0), distance: point.distanceTo(raycaster.ray.origin), approximate: true }
        if (hit && (!best || hit.distance < best.distance)) best = hit
      }
    }
    return best
  }

  private async exactHit(raycaster: THREE.Raycaster, generation: number): Promise<Hit | undefined> {
    let best: Hit | undefined
    for (const { entry, distance } of this.candidates(raycaster.ray)) {
      if (best && distance > best.distance) break
      const localRay = raycaster.ray.clone().applyMatrix4(entry.matrix.clone().invert())
      const transparent = Uint8Array.from(entry.asset.asset.model.materials, material => Number(material.opacity < 1 || material.transmission > 0))
      const chunks = [...entry.asset.chunkBounds].flatMap(([id, bounds]) => {
        const point = localRay.intersectBox(bounds, new THREE.Vector3())
        return point ? [{ id, distance: bounds.containsPoint(localRay.origin) ? 0 : point.applyMatrix4(entry.matrix).distanceTo(raycaster.ray.origin) }] : []
      }).sort((a, b) => a.distance - b.distance)
      for (const { id, distance } of chunks) {
        if (best && distance > best.distance || distance > raycaster.far) break
        let hit: Hit | undefined
        if (this.surfaces.has(this.key(entry.asset, id, 1))) hit = this.loadedHit(entry, id, raycaster)
        else {
          const voxels = await this.composite(entry.asset, id, 1, () => generation === this.pickGeneration && this.active)
          if (generation !== this.pickGeneration || !this.active) return
          const c = chunkCoords(id), origin = new THREE.Vector3(c.x * 16, c.y * 16, c.z * 16)
          const local = traceSceneChunk(localRay, origin, voxels, transparent)
          if (local) {
            const point = local.point.applyMatrix4(entry.matrix)
            hit = { entry, point, normal: local.normal.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(entry.matrix)), distance: point.distanceTo(raycaster.ray.origin) }
          }
        }
        if (hit && hit.distance <= raycaster.far && (!best || hit.distance < best.distance)) best = hit
      }
    }
    return best
  }

  private async click(event: PointerEvent, additive: boolean) {
    const generation = ++this.pickGeneration, tool = this.tool, assetId = this.placementAsset
    const raycaster = this.ray(event)
    try {
      const hit = await this.exactHit(raycaster, generation)
      if (generation !== this.pickGeneration || !this.active) return
      if (tool === 'place') {
        this.updatePlacement(hit, raycaster.ray)
        if (assetId && this.placementPosition) this.callbacks.onPlace(assetId, plain(this.placementPosition))
      } else if (tool === 'layer') { if (hit) this.callbacks.onLayer(hit.entry.instance.layerId) }
      else {
        const selected = new Set(additive ? this.selection : [])
        if (hit) { const id = hit.entry.instance.id; if (additive && selected.has(id)) selected.delete(id); else selected.add(id) }
        this.callbacks.onSelect([...selected])
      }
    } catch (error) {
      if (generation === this.pickGeneration) this.callbacks.onError(`Could not resolve occupied voxels. ${error instanceof Error ? error.message : 'Chunk unavailable'}`)
    }
  }

  private updatePlacement(hit: Hit | undefined, ray: THREE.Ray) {
    const asset = this.assets.get(this.placementAsset ?? '')
    const point = hit?.point.clone() ?? ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.bounds.min.y), new THREE.Vector3())
    if (!asset || !point) { this.ghost.visible = false; this.placementPosition = undefined; return }
    const normal = hit?.normal ?? new THREE.Vector3(0, 1, 0)
    const relative = asset.bounds.clone().translate(vector(asset.asset.pivot).negate())
    const support = new THREE.Vector3(normal.x >= 0 ? relative.min.x : relative.max.x, normal.y >= 0 ? relative.min.y : relative.max.y, normal.z >= 0 ? relative.min.z : relative.max.z).dot(normal)
    point.addScaledVector(normal, -support)
    if (this.snap) point.round()
    this.placementPosition = point
    this.ghost.position.copy(point); this.ghost.visible = !this.host.getSceneViewport().renderMode
    this.host.getSceneViewport().canvas.title = hit?.approximate ? 'Placement preview uses coarse bounds; click resolves occupied voxels.' : 'Placement preview on occupied surface or ground.'
    this.host.render()
  }

  dispose() {
    if (this.disposed) return
    this.setActive(false)
    this.disposed = true
    this.generation++; this.pickGeneration++
    this.worker.terminate()
    this.listeners.abort()
    this.gizmo.dispose()
    this.outline.geometry.dispose(); (this.outline.material as THREE.Material).dispose()
    this.marquee.geometry.dispose(); (this.marquee.material as THREE.Material).dispose()
    this.ghostMaterial.dispose()
    this.clearBatches()
    for (const surface of [...this.surfaces.values()]) this.evict(surface)
    this.assets.clear(); this.entries.clear(); this.desired.clear(); this.adaptiveDesired.clear()
    this.completed = undefined; this.busy = undefined; this.queue = []
    this.root.clear()
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Scene renderer disposed'))
  }
}

/** Exact DDA for just the requested chunk; absent chunks are fetched before calling. */
export function traceSceneChunk(ray: THREE.Ray, origin: THREE.Vector3, voxels: Uint8Array, transparent = new Uint8Array(256)) {
  if (voxels.length !== 4096) throw new RangeError('Invalid scene chunk')
  if (![...ray.origin.toArray(), ...ray.direction.toArray()].every(Number.isFinite) || !ray.direction.lengthSq()) return
  const bounds = new THREE.Box3(origin.clone(), origin.clone().addScalar(16))
  const entry = ray.intersectBox(bounds, new THREE.Vector3())
  if (!entry) return
  const start = bounds.containsPoint(ray.origin) ? ray.origin.clone() : entry
  const point = start.clone().addScaledVector(ray.direction, 1e-7)
  const cell = point.clone().sub(origin).floor()
  const step = new THREE.Vector3(Math.sign(ray.direction.x), Math.sign(ray.direction.y), Math.sign(ray.direction.z))
  const next = new THREE.Vector3(), delta = new THREE.Vector3(), normal = new THREE.Vector3()
  const axes = ['x', 'y', 'z'] as const
  for (const axis of axes) {
    delta[axis] = ray.direction[axis] ? Math.abs(1 / ray.direction[axis]) : Infinity
    next[axis] = ray.direction[axis] ? (origin[axis] + cell[axis] + (step[axis] > 0 ? 1 : 0) - ray.origin[axis]) / ray.direction[axis] : Infinity
    if (ray.direction[axis] && !normal.lengthSq() && Math.abs(start[axis] - bounds.min[axis]) < 1e-6) normal[axis] = -1
    else if (ray.direction[axis] && !normal.lengthSq() && Math.abs(start[axis] - bounds.max[axis]) < 1e-6) normal[axis] = 1
  }
  let distance = start.distanceTo(ray.origin)
  let previous = normal.lengthSq() ? 0 : voxels[cell.x + cell.y * 16 + cell.z * 256]
  while (axes.every(axis => cell[axis] >= 0 && cell[axis] < 16)) {
    const color = voxels[cell.x + cell.y * 16 + cell.z * 256]
    if (color && (!previous || color !== previous && transparent[previous]) && normal.lengthSq()) return { point: ray.at(distance, new THREE.Vector3()), normal: normal.normalize() }
    previous = color
    let axis: typeof axes[number] = 'x'
    if (next.y < next.x) axis = 'y'
    if (next.z < next[axis]) axis = 'z'
    distance = next[axis]; next[axis] += delta[axis]; cell[axis] += step[axis]
    normal.set(0, 0, 0); normal[axis] = -step[axis]
  }
}
