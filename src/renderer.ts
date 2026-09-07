import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import { RasterPipeline } from './raster-pipeline'
import type { MeshData } from './mesher'
import { CHUNK_SIZE, chunkCoords, connectedBodyVoxels, connectedSurfaceVoxels, fillShapeVoxels, moveRange, occupiedVoxels, pushPullRange, surfaceVoxels, type FillShape, type PaletteMaterial, type Vec3, type VoxelDocument } from './editor'
import type { AuxiliaryTool, PaintMode, PbrMap, SculptMode, SelectionMode, SelectionState, Tool } from './studio'
import type { ViewSettings } from './storage'
import { faceViews, projectFaces, type FaceView } from './projections'
import { defaultInspectionViews, type InspectionView } from './inspection'

export type { AuxiliaryTool, PaintMode, PbrMap, SculptMode, SelectionMode, SelectionState, Tool } from './studio'

export interface ToolTarget {
  cell: Vec3
  normal: Vec3
  occupied: boolean
  color: number
}

export interface CameraSnapshot {
  projection: ViewSettings['projection']
  position: Vec3
  target: Vec3
  up: Vec3
  zoom?: number
  fov?: number
  orthographicSpan: number
  viewport: { width: number; height: number }
}

/** Borrowed viewport content. The adapter owns its root/resources, never the host GL context.
 * Bounds are world-space; call setSceneContent again after changing them. Full detail
 * must contain every contributor as ordinary meshes, independently owned and budgeted.
 */
export interface SceneContent {
  root: THREE.Group
  bounds: THREE.Box3
  whenReady(): Promise<void>
  onViewportChange(): void
  prepareFullDetail?(signal: AbortSignal): Promise<PreparedSceneContent>
}

export interface PreparedSceneContent {
  root: THREE.Group
  scope: 'full-scene'
  triangles: number
  peakBytes: number
  geometryBytes: number
  sourceBytes: number
  dispose(): void
}

export function shouldOrbitTouch(actionable: boolean, activeTouches: number) {
  return !actionable && activeTouches === 0
}

export function isTouchTap(startX: number, startY: number, endX: number, endY: number) {
  return Math.hypot(endX - startX, endY - startY) < 8
}

export function castsRealtimeShadow(material: Pick<PaletteMaterial, 'opacity' | 'transmission'>) {
  return material.opacity >= 1 && material.transmission === 0
}

/** Conservative directional-shadow demand: camera-clipped receivers in light XY,
 * extended toward the light through occupied scene depth. Polygon clipping handles
 * horizon crossings and negative orthographic near planes without ground-ray divides.
 * worldToLight uses the shadow camera convention (+Z points toward the light).
 */
export function sceneShadowVolume(camera: THREE.Camera, occupied: THREE.Box3, receivers: Iterable<THREE.Box3>, worldToLight: THREE.Matrix4, groundY?: number, margin = 0, groundBounds?: THREE.Box3) {
  if (occupied.isEmpty()) return
  camera.updateMatrixWorld(true)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
  const lightBounds = new THREE.Box3(), point = new THREE.Vector3()
  const include = (points: THREE.Vector3[]) => {
    for (const vertex of points) lightBounds.expandByPoint(point.copy(vertex).applyMatrix4(worldToLight))
  }
  const clip = (polygon: THREE.Vector3[]) => {
    for (const plane of frustum.planes) {
      const result: THREE.Vector3[] = []
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length]
        const da = plane.distanceToPoint(a) + 1e-7, db = plane.distanceToPoint(b) + 1e-7
        if (da >= 0) result.push(a)
        if ((da >= 0) !== (db >= 0)) result.push(a.clone().lerp(b, da / (da - db)))
      }
      polygon = result
      if (!polygon.length) break
    }
    return polygon
  }
  const corners = (bounds: THREE.Box3) => Array.from({ length: 8 }, (_, i) => new THREE.Vector3(
    i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z))
  const viewCorners = corners(new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))).map(p => p.unproject(camera))
  for (const bounds of receivers) {
    if (bounds.isEmpty() || !frustum.intersectsBox(bounds)) continue
    const vertices = corners(bounds)
    if (vertices.every(p => frustum.containsPoint(p))) { include(vertices); continue }
    for (const face of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) include(clip(face.map(i => vertices[i])))
    // A receiver can contain the frustum without any receiver corner being visible.
    include(viewCorners.filter(p => bounds.containsPoint(p)))
  }
  if (groundY !== undefined && (camera instanceof THREE.PerspectiveCamera
    ? camera.getWorldPosition(point).y > groundY : camera.getWorldDirection(point).y < 0)) {
    const footprint = occupied.clone(), light = worldToLight.elements
    footprint.min.y = footprint.max.y = groundY
    // Shadows can land outside the occupied XZ box. Bound ground receivers by the
    // occupied scene's projected shadow footprint, then by the finite stage floor.
    if (light[6] > 1e-8) for (const vertex of corners(occupied)) {
      const distance = (vertex.y - groundY) / light[6]
      footprint.expandByPoint(point.set(vertex.x - light[2] * distance, groundY, vertex.z - light[10] * distance))
    }
    if (groundBounds) {
      footprint.min.x = Math.max(footprint.min.x, groundBounds.min.x); footprint.max.x = Math.min(footprint.max.x, groundBounds.max.x)
      footprint.min.z = Math.max(footprint.min.z, groundBounds.min.z); footprint.max.z = Math.min(footprint.max.z, groundBounds.max.z)
    }
    if (!footprint.isEmpty()) include(clip([
      new THREE.Vector3(footprint.min.x, groundY, footprint.min.z), new THREE.Vector3(footprint.max.x, groundY, footprint.min.z),
      new THREE.Vector3(footprint.max.x, groundY, footprint.max.z), new THREE.Vector3(footprint.min.x, groundY, footprint.max.z),
    ]))
  }
  if (lightBounds.isEmpty()) return
  const padding = Math.max(0, margin) + 1e-5
  lightBounds.expandByScalar(padding)
  lightBounds.max.z = Math.max(lightBounds.max.z, occupied.clone().applyMatrix4(worldToLight).max.z + padding)
  const { min, max } = lightBounds
  if (![...min.toArray(), ...max.toArray()].every(Number.isFinite)) throw new Error('Cannot determine shadow demand from a non-finite camera/light transform.')
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
    .makeOrthographic(min.x, max.x, max.y, min.y, -max.z, -min.z).multiply(worldToLight))
}

export function realtimeEnvironmentIntensity(metalness: number) {
  return 0.2 + metalness * 0.5
}

interface MeshResult extends MeshData {
  id: number
  version: number
}

interface GridResult { id: number; version: number; faceLines: Float32Array }

export interface RendererCallbacks {
  onSelectionChange: (selection: SelectionState) => void
  onPaint: (cells: Vec3[]) => void
  onErase: (cells: Vec3[]) => void
  onFillCommit: (min: Vec3, max: Vec3, normal: Vec3, shape: FillShape) => void
  onPushPullCommit: (cells: Vec3[], normal: Vec3, distance: number, move: boolean, floating: boolean) => void
  onPushPullPreview: (cells?: number, distance?: number, move?: boolean) => void
  onPick: (color: number) => void
  onLayerSelect: (layerId: number) => void
  onViewStart: () => void
  onViewChange: (view: CameraSnapshot) => void
  onHover: (cell?: Vec3) => void
  onMeshStats: (pending: number, quads: number) => void
  onPathTracingStatus: (status: string) => void
  onFps: (fps?: number) => void
  onError: (message: string) => void
}

const axisNames = ['x', 'y', 'z'] as const
// ponytail: large drags keep the solid preview until per-voxel instancing is profiled above this ceiling.
const MAX_FILL_GHOSTS = 16_384

function rayBounds(origin: Vec3, direction: Vec3, dimensions: Vec3) {
  let enter = -Infinity
  let exit = Infinity
  let enterNormal: Vec3 = { x: 0, y: 0, z: 0 }
  let exitNormal: Vec3 = { x: 0, y: 0, z: 0 }
  for (const axis of axisNames) {
    const value = direction[axis]
    if (Math.abs(value) < 1e-10) {
      if (origin[axis] < 0 || origin[axis] > dimensions[axis]) return undefined
      continue
    }
    const first = -origin[axis] / value
    const second = (dimensions[axis] - origin[axis]) / value
    const near = Math.min(first, second)
    const far = Math.max(first, second)
    if (near > enter) {
      enter = near
      enterNormal = { x: 0, y: 0, z: 0 }
      enterNormal[axis] = value > 0 ? -1 : 1
    }
    if (far < exit) {
      exit = far
      exitNormal = { x: 0, y: 0, z: 0 }
      exitNormal[axis] = value > 0 ? 1 : -1
    }
    if (exit < enter) return undefined
  }
  return { enter, exit, enterNormal, exitNormal }
}

export function traceGridRay(document: VoxelDocument, origin: Vec3, direction: Vec3, maxDistance = Infinity): ToolTarget | undefined {
  if (!axisNames.every(axis => Number.isFinite(origin[axis]) && Number.isFinite(direction[axis]))
    || !axisNames.some(axis => direction[axis] !== 0)) return undefined
  const bounds = rayBounds(origin, direction, document.dimensions)
  if (!bounds || bounds.exit < 0) return undefined
  const start = Math.max(0, bounds.enter) + 1e-7
  if (start > Math.min(bounds.exit, maxDistance)) return undefined
  const point = {
    x: origin.x + direction.x * start,
    y: origin.y + direction.y * start,
    z: origin.z + direction.z * start,
  }
  const cell = {
    x: Math.min(document.dimensions.x - 1, Math.max(0, Math.floor(point.x))),
    y: Math.min(document.dimensions.y - 1, Math.max(0, Math.floor(point.y))),
    z: Math.min(document.dimensions.z - 1, Math.max(0, Math.floor(point.z))),
  }
  const step = {
    x: Math.sign(direction.x),
    y: Math.sign(direction.y),
    z: Math.sign(direction.z),
  }
  const delta = {
    x: direction.x ? Math.abs(1 / direction.x) : Infinity,
    y: direction.y ? Math.abs(1 / direction.y) : Infinity,
    z: direction.z ? Math.abs(1 / direction.z) : Infinity,
  }
  const next = {
    x: direction.x ? ((step.x > 0 ? cell.x + 1 : cell.x) - origin.x) / direction.x : Infinity,
    y: direction.y ? ((step.y > 0 ? cell.y + 1 : cell.y) - origin.y) / direction.y : Infinity,
    z: direction.z ? ((step.z > 0 ? cell.z + 1 : cell.z) - origin.z) / direction.z : Infinity,
  }
  let normal = bounds.enter >= 0 ? bounds.enterNormal : { x: 0, y: 0, z: 0 }
  let previous = bounds.enter < 0 ? document.getVisibleVoxel(cell.x, cell.y, cell.z) : 0

  while (document.contains(cell.x, cell.y, cell.z)) {
    const color = document.getVisibleVoxel(cell.x, cell.y, cell.z)
    // A ray inside a solid must leave it before hitting a front-facing surface.
    const exposed = !previous || previous !== color && (document.materials[previous].opacity < 1 || document.materials[previous].transmission > 0)
    if (color && exposed && axisNames.some(axis => normal[axis])) return { cell: { ...cell }, normal, occupied: true, color }
    previous = color

    let axis: keyof Vec3 = 'x'
    if (next.y < next.x) axis = 'y'
    if (next.z < next[axis]) axis = 'z'
    if (next[axis] > Math.min(bounds.exit, maxDistance)) break
    cell[axis] += step[axis]
    normal = { x: 0, y: 0, z: 0 }
    normal[axis] = -step[axis]
    next[axis] += delta[axis]
  }
  if (bounds.exitNormal.y > 0 || bounds.exit > maxDistance) return undefined
  const end = bounds.exit - 1e-7
  const exitPoint = {
    x: origin.x + direction.x * end,
    y: origin.y + direction.y * end,
    z: origin.z + direction.z * end,
  }
  const exitCell = {
    x: Math.min(document.dimensions.x - 1, Math.max(0, Math.floor(exitPoint.x))),
    y: Math.min(document.dimensions.y - 1, Math.max(0, Math.floor(exitPoint.y))),
    z: Math.min(document.dimensions.z - 1, Math.max(0, Math.floor(exitPoint.z))),
  }
  return {
    cell: exitCell,
    normal: {
      x: bounds.exitNormal.x ? -bounds.exitNormal.x : 0,
      y: bounds.exitNormal.y ? -bounds.exitNormal.y : 0,
      z: bounds.exitNormal.z ? -bounds.exitNormal.z : 0,
    },
    occupied: false,
    color: 0,
  }
}

function boxBounds(anchor: Vec3, end: Vec3, normal: Vec3, depth?: number) {
  const min = { x: Math.min(anchor.x, end.x), y: Math.min(anchor.y, end.y), z: Math.min(anchor.z, end.z) }
  const max = { x: Math.max(anchor.x, end.x), y: Math.max(anchor.y, end.y), z: Math.max(anchor.z, end.z) }
  if (depth === undefined) return { min, max }
  const axis = axisNames.find(name => normal[name] !== 0) ?? 'y'
  const tip = anchor[axis] + normal[axis] * (depth - 1)
  min[axis] = Math.min(anchor[axis], tip)
  max[axis] = Math.max(anchor[axis], tip)
  return { min, max }
}

export function tracePlaneRay(document: VoxelDocument, origin: Vec3, direction: Vec3, planeCell: Vec3, normal: Vec3, extendBehind = false) {
  const axis = axisNames.find(name => normal[name] !== 0)
  if (!axis || Math.abs(direction[axis]) < 1e-8) return undefined
  const distance = (planeCell[axis] + 0.5 - origin[axis]) / direction[axis]
  if (distance < 0 && !extendBehind) return undefined
  const cell = {
    x: Math.floor(origin.x + direction.x * distance),
    y: Math.floor(origin.y + direction.y * distance),
    z: Math.floor(origin.z + direction.z * distance),
  }
  cell[axis] = planeCell[axis]
  for (const tangent of axisNames) if (tangent !== axis) cell[tangent] = Math.max(0, Math.min(document.dimensions[tangent] - 1, cell[tangent]))
  return document.contains(cell.x, cell.y, cell.z) ? cell : undefined
}

export function pushPullGhostVoxels(cells: Vec3[], normal: Vec3, distance: number, move: boolean) {
  if (move || !distance) return cells.map(cell => ({
    x: cell.x + normal.x * distance,
    y: cell.y + normal.y * distance,
    z: cell.z + normal.z * distance,
  }))
  const ghosts: Vec3[] = []
  for (const cell of cells) {
    for (let step = 0; step < Math.abs(distance); step++) {
      const offset = distance > 0 ? step + 1 : -step
      ghosts.push({ x: cell.x + normal.x * offset, y: cell.y + normal.y * offset, z: cell.z + normal.z * offset })
    }
  }
  return ghosts
}

export function workspaceGridPositions(dimensions: Vec3, normal: Vec3 = { x: 0, y: 1, z: 0 }) {
  const positions: number[] = []
  const axis = axisNames.find(name => normal[name]) ?? 'y'
  const [u, v] = axisNames.filter(name => name !== axis)
  const fixed = normal[axis] < 0 ? dimensions[axis] : 0
  const push = (uValue: number, vValue: number) => {
    const cell = { x: 0, y: 0, z: 0, [axis]: fixed, [u]: uValue, [v]: vValue }
    positions.push(cell.x - dimensions.x / 2, cell.y, cell.z - dimensions.z / 2)
  }
  for (let value = 0; value <= dimensions[u]; value++) { push(value, 0); push(value, dimensions[v]) }
  for (let value = 0; value <= dimensions[v]; value++) { push(0, value); push(dimensions[u], value) }
  return new Float32Array(positions)
}

export function workspaceGridPlaneVisible(dimensions: Vec3, normal: Vec3, camera: Vec3) {
  const axis = axisNames.find(name => normal[name])
  if (!axis || axis === 'y') return true
  const boundary = normal[axis] > 0 ? -dimensions[axis] / 2 : dimensions[axis] / 2
  return (camera[axis] - boundary) * normal[axis] >= 0
}

interface PushPullDrag {
  cells: Vec3[]
  normal: Vec3
  move: boolean
  distance: number
  min: number
  max: number
  startX: number
  startY: number
  screenX: number
  screenY: number
}

interface MarqueeDrag {
  startX: number
  startY: number
  additive: boolean
  target: ToolTarget
  end: Vec3
  moved: boolean
  action?: 'paint' | 'erase' | 'fill'
}

export class VoxelRenderer {
  private renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  private scene = new THREE.Scene()
  private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera
  private controls: OrbitControls
  private raster: RasterPipeline
  private rasterFrame?: number
  private contextLost = false
  private rasterError?: string
  private presentationDirty = true
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private environmentTarget: THREE.WebGLRenderTarget
  private ambientEnvironment: THREE.DataTexture
  private materials: THREE.MeshPhysicalMaterial[]
  private faceGridMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.46, depthWrite: false, toneMapped: false })
  private meshVerticesMaterial = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, depthWrite: false, toneMapped: false })
  private model = new THREE.Group()
  private chunkMeshes = new Map<number, THREE.Group>()
  private chunkQuads = new Map<number, number>()
  private grid?: THREE.Group
  private limits?: THREE.Box3Helper
  private ground?: THREE.Mesh
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x8c91a0, 1.2)
  private sunlight = new THREE.DirectionalLight(0xffffff, 2.4)
  private sunlightTarget = new THREE.Object3D()
  private hover = new THREE.Mesh(
    new THREE.BoxGeometry(1.04, 1.04, 1.04),
    new THREE.MeshBasicMaterial({ color: 0x2864dc, transparent: true, opacity: 0.3, depthWrite: false }),
  )
  private marqueePreview: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x2864dc, transparent: true, opacity: 0.2, depthWrite: false }),
  )
  private fillPreviewGeometry = {
    box: this.marqueePreview.geometry,
    sphere: new THREE.SphereGeometry(0.5, 20, 12),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 20),
  }
  private worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })
  private queued = new Set<number>()
  private queuedGrids = new Set<number>()
  private versions = new Map<number, number>()
  private nextVersion = 0
  private inFlight = 0
  private workerReady = false
  private meshFailed = false
  private meshWaiters: { resolve: () => void; reject: (error: Error) => void }[] = []
  private document: VoxelDocument
  private settings: ViewSettings
  private renderMode = false
  private tool: Tool = 'select'
  private paintMode: PaintMode = 'paint'
  private sculptMode: SculptMode = 'push'
  private fillShape: FillShape = 'box'
  private fillDepth = 1
  private auxiliary?: AuxiliaryTool
  private activeColor = 1
  private activePointer?: number
  private paintPointer?: number
  private touchPointers = new Set<number>()
  private orbitTouch?: { pointerId: number; startX: number; startY: number }
  private selection = new Map<number, Vec3>()
  private floatingSelection = false
  private selectionMode: SelectionMode = 'point'
  private selectionPreview?: THREE.InstancedMesh
  private marqueeDrag?: MarqueeDrag
  private pushPullDrag?: PushPullDrag
  private fillPreview?: THREE.InstancedMesh
  private pushPullPreview?: THREE.InstancedMesh
  private focusAnimation?: number
  private pathTracer?: WebGLPathTracer
  private pathTracingWorker?: { dispose: () => void }
  private pathTracingRevision = 0
  private pathTracingFrame?: number
  private pathTracingBuildRunning = false
  private pathTracingBuildRequested = false
  private pathTracingReady = false
  private pathTracingFailed = false
  private fpsFrames = 0
  private fpsStarted = performance.now()
  private fpsIdleTimer?: ReturnType<typeof setTimeout>
  private keyboardCell: Vec3 = { x: 0, y: 0, z: 0 }
  private resizeObserver: ResizeObserver
  private orthographicSpan = 32
  private host: HTMLElement
  private callbacks: RendererCallbacks
  private sceneContent?: SceneContent
  private modelSuspended = false
  private fullContent?: PreparedSceneContent
  private fullPreparation?: Promise<PreparedSceneContent>
  private fullAbort?: AbortController
  private fullEpoch = 0
  private fullViewportPixels = 0
  private traceScene?: THREE.Scene
  private traceGround?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  private sceneInteraction = false
  private sceneCameraDirty = false
  private modelView?: CameraSnapshot
  private modelSettings?: ViewSettings
  private modelRenderMode?: boolean

  constructor(host: HTMLElement, document: VoxelDocument, settings: ViewSettings, callbacks: RendererCallbacks) {
    this.host = host
    this.callbacks = callbacks
    this.document = document
    this.settings = { ...settings }
    this.camera = this.createCamera(settings.projection)
    this.controls = this.createControls(this.camera)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    this.environmentTarget = this.createEnvironment()
    this.ambientEnvironment = this.createAmbientEnvironment()
    this.scene.environment = this.ambientEnvironment
    this.materials = this.createMaterials()
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.raster = new RasterPipeline(this.renderer, this.scene, { ambientOcclusion: settings.ambientOcclusion })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    this.renderer.domElement.tabIndex = 0
    this.renderer.domElement.setAttribute('aria-label', 'Voxel editing viewport. Arrow keys move the keyboard cursor, Page Up and Page Down change height, Space applies the active tool, and Shift Space reverses Push Pull or Move.')
    this.host.append(this.renderer.domElement)

    this.scene.add(this.model, this.hemisphere, this.sunlight, this.sunlightTarget, this.hover, this.marqueePreview)
    this.sunlight.castShadow = true
    this.sunlight.target = this.sunlightTarget
    this.sunlight.shadow.mapSize.set(2048, 2048)
    this.hover.visible = false
    this.marqueePreview.visible = false
    this.hover.userData.editorOverlay = this.marqueePreview.userData.editorOverlay = true
    this.model.matrixAutoUpdate = false
    this.bindWorker()
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault()
      this.contextLost = true
      this.pathTracingRevision++
      this.pathTracingReady = false
      this.stopPathTracingSamples()
      if (this.rasterFrame !== undefined) cancelAnimationFrame(this.rasterFrame)
      this.rasterFrame = undefined
      this.disposePathTracer()
      this.releaseSceneDetail()
      this.callbacks.onPathTracingStatus('Graphics context lost')
    })
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false
      this.environmentTarget.dispose()
      this.environmentTarget = this.createEnvironment()
      for (const material of this.materials) { material.envMap = this.environmentTarget.texture; material.needsUpdate = true }
      if (this.ground) (this.ground.material as THREE.MeshStandardMaterial).envMap = this.environmentTarget.texture
      this.renderer.shadowMap.needsUpdate = true
      this.pathTracingFailed = false
      this.requestPathTraceRebuild()
      this.render()
    })
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.bindPointerEvents()
    this.rebuildStage()
    this.updatePalette()
    this.markDirty(this.document.chunks.keys())
    this.frameModel()
    this.resize()
  }

  private bindWorker() {
    const worker = this.worker
    this.worker.onmessage = event => {
      if (worker !== this.worker || this.modelSuspended) return
      const message = event.data as { type: 'ready' } | { type: 'meshed'; results: MeshResult[] } | { type: 'gridded'; results: GridResult[] }
      if (message.type === 'ready') {
        this.workerReady = true
        this.updateWorkerPalette()
        this.pump()
        return
      }
      if (message.type === 'meshed') this.receiveMeshes(message)
      else {
        this.inFlight = 0
        for (const result of message.results) if (this.versions.get(result.id) === result.version) this.receiveGrid(result)
        this.pump()
        if (this.pathTracingBuildRequested && !this.inFlight && !this.queued.size) void this.buildPathTrace()
        this.render()
      }
    }
    this.worker.onerror = () => {
      if (worker !== this.worker || this.modelSuspended) return
      this.inFlight = 0
      this.queued.clear()
      this.queuedGrids.clear()
      this.meshFailed = true
      for (const waiter of this.meshWaiters.splice(0)) waiter.reject(new Error('The voxel surface worker stopped.'))
      this.callbacks.onMeshStats(0, 0)
      this.callbacks.onError('The voxel surface worker stopped. Reload to continue editing.')
    }
  }

  private createCamera(projection: ViewSettings['projection']) {
    if (projection === 'perspective') return new THREE.PerspectiveCamera(34, 1, this.sceneContent ? 0.5 : 0.1, this.sceneContent ? 131072 : 2000)
    return new THREE.OrthographicCamera(-20, 20, 20, -20, this.sceneContent ? -65536 : -1000, this.sceneContent ? 131072 : 2000)
  }

  private createEnvironment() {
    const room = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    try { return pmrem.fromScene(room, 0.04, 0.1, 100, { size: 64 }) }
    finally { room.dispose(); pmrem.dispose() }
  }

  private createAmbientEnvironment() {
    const width = 64, height = 32
    const pixels = new Float32Array(width * height * 4)
    const color = new THREE.Color()
    for (let y = 0; y < height; y++) {
      color.copy(this.hemisphere.groundColor).lerp(this.hemisphere.color, (1 - Math.cos((y + 0.5) / height * Math.PI)) / 2)
      for (let x = 0; x < width; x++) pixels.set([color.r, color.g, color.b, 1], (y * width + x) * 4)
    }
    const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType)
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.needsUpdate = true
    return texture
  }

  private createControls(camera: THREE.Camera) {
    const controls = new OrbitControls(camera, this.renderer.domElement)
    let interacting = false
    let changed = false
    controls.enableDamping = false
    controls.screenSpacePanning = true
    controls.mouseButtons.LEFT = -1 as THREE.MOUSE
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
    controls.touches.ONE = -1 as THREE.TOUCH
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE
    controls.minDistance = 2
    controls.maxDistance = this.sceneContent ? 65536 : 1200
    controls.addEventListener('start', () => {
      if (!interacting) { changed = false; this.callbacks.onViewStart() }
      interacting = true
      this.cancelFocusAnimation()
    })
    controls.addEventListener('change', () => { if (interacting) changed = true; this.cameraChanged() })
    controls.addEventListener('end', () => {
      const report = interacting && changed
      interacting = false
      changed = false
      if (report) this.callbacks.onViewChange(this.getView())
    })
    return controls
  }

  private bindPointerEvents() {
    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', event => {
      if (this.sceneContent) return
      if (event.pointerType !== 'touch') return
      const orbit = this.renderMode || shouldOrbitTouch(this.touchTargetActionable(this.targetAt(event)), this.touchPointers.size)
      this.controls.touches.ONE = orbit ? THREE.TOUCH.ROTATE : -1 as THREE.TOUCH
      this.orbitTouch = orbit ? { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY } : undefined
    }, { capture: true })
    canvas.addEventListener('contextmenu', event => event.preventDefault())
    canvas.addEventListener('pointerdown', event => {
      if (this.sceneContent) return
      if (event.pointerType === 'touch') {
        this.touchPointers.add(event.pointerId)
        if (this.touchPointers.size > 1) {
          this.orbitTouch = undefined
          this.cancelPaint()
          this.cancelPushPull()
          this.cancelMarquee()
          return
        }
      }
      if (event.button !== 0) return
      if (this.renderMode) return
      const target = this.targetAt(event)
      if (event.pointerType === 'touch' && shouldOrbitTouch(this.touchTargetActionable(target), 0)) return
      if (this.auxiliary === 'pick') {
        event.preventDefault()
        if (target?.occupied) this.callbacks.onPick(target.color)
        return
      }
      if (this.tool === 'layer') {
        event.preventDefault()
        if (target?.occupied) this.callbacks.onLayerSelect(this.document.getVisibleVoxelLayer(target.cell.x, target.cell.y, target.cell.z))
        return
      }
      if (this.tool === 'select') {
        event.preventDefault()
        if (!target?.occupied) {
          this.selectTarget(target, event.shiftKey || event.pointerType === 'touch')
          return
        }
        this.startMarquee(event, target, event.shiftKey || event.pointerType === 'touch')
        return
      }
      if (this.tool === 'paint') {
        event.preventDefault()
        if (this.paintMode === 'fill') {
          const cell = this.fillStartCell(target)
          if (!target || !cell) return
          this.startMarquee(event, { cell, normal: { ...target.normal }, occupied: false, color: 0 }, false, 'fill')
          return
        }
        if (this.selectionMode === 'point') {
          if (target?.occupied && this.activeTarget(target) && this.activeLayerEditable()) this.startMarquee(event, target, false, 'paint')
          else this.setSelection([])
          return
        }
        this.paintPointer = event.pointerId
        canvas.setPointerCapture(event.pointerId)
        return
      }
      if (this.tool === 'sculpt') {
        event.preventDefault()
        if (!target?.occupied) {
          this.setSelection([])
          return
        }
        if (this.selectionMode === 'point') {
          if (this.sculptMode === 'erase') {
            if (this.activeTarget(target) && this.activeLayerEditable()) this.startMarquee(event, target, false, 'erase')
            return
          }
          if (!this.selectionContains(target.cell)) {
            if (this.activeTarget(target)) this.startMarquee(event, target, false)
            return
          }
        }
        if (!this.resolveActionTarget(target)) return
        if (this.sculptMode === 'erase') {
          this.callbacks.onErase([...this.selection.values()])
          return
        }
        if (!this.startPushPull(event, target)) return
        this.activePointer = event.pointerId
        canvas.setPointerCapture(event.pointerId)
        return
      }
    })
    canvas.addEventListener('pointermove', event => {
      if (this.sceneContent) return
      if (this.touchPointers.size > 1) return
      if (this.marqueeDrag && this.activePointer === event.pointerId) {
        this.moveMarquee(event)
        return
      }
      if (this.pushPullDrag && this.activePointer === event.pointerId) {
        this.movePushPull(event)
        return
      }
      const target = this.targetAt(event)
      this.showHover(target)
    })
    canvas.addEventListener('pointerup', event => {
      if (this.sceneContent) return
      const deselect = !this.renderMode && event.pointerType === 'touch' && this.orbitTouch?.pointerId === event.pointerId
        && isTouchTap(this.orbitTouch.startX, this.orbitTouch.startY, event.clientX, event.clientY)
      if (this.orbitTouch?.pointerId === event.pointerId) this.orbitTouch = undefined
      this.touchPointers.delete(event.pointerId)
      if (deselect) {
        this.setSelection([])
        return
      }
      if (this.marqueeDrag && this.activePointer === event.pointerId) {
        const action = this.marqueeDrag.action
        if (action === 'fill') {
          const { min, max } = boxBounds(this.marqueeDrag.target.cell, this.marqueeDrag.end, this.marqueeDrag.target.normal, this.fillDepth)
          this.callbacks.onFillCommit(min, max, this.marqueeDrag.target.normal, this.fillShape)
        } else if (this.marqueeDrag.moved) this.selectMarquee(this.marqueeDrag)
        else if (action) this.resolveActionTarget(this.marqueeDrag.target)
        else this.selectTarget(this.marqueeDrag.target, this.marqueeDrag.additive)
        this.cancelMarquee()
        if (action === 'paint') this.callbacks.onPaint([...this.selection.values()])
        if (action === 'erase') this.callbacks.onErase([...this.selection.values()])
      } else if (this.pushPullDrag && this.activePointer === event.pointerId) {
        const { cells, normal, distance, move } = this.pushPullDrag
        if (distance || this.floatingSelection) {
            this.callbacks.onPushPullCommit(cells, normal, distance, move, this.floatingSelection)
        }
        this.cancelPushPull()
      } else if (this.paintPointer === event.pointerId) {
        const target = this.targetAt(event)
        if (this.resolveActionTarget(target)) this.callbacks.onPaint([...this.selection.values()])
        this.cancelPaint()
      }
    })
    canvas.addEventListener('pointercancel', event => {
      if (this.sceneContent) return
      this.touchPointers.delete(event.pointerId)
      if (this.orbitTouch?.pointerId === event.pointerId) this.orbitTouch = undefined
      this.cancelPaint()
      this.cancelPushPull()
      this.cancelMarquee()
    })
    canvas.addEventListener('pointerleave', () => {
      if (this.sceneContent) return
      this.hover.visible = false
      this.callbacks.onHover()
      this.render()
    })
    canvas.addEventListener('keydown', event => this.keyboard(event))
  }

  private keyboard(event: KeyboardEvent) {
    if (this.sceneContent || this.renderMode) return
    const movement: Partial<Vec3> = {}
    if (event.key === 'ArrowLeft') movement.x = -1
    else if (event.key === 'ArrowRight') movement.x = 1
    else if (event.key === 'ArrowUp') movement.z = -1
    else if (event.key === 'ArrowDown') movement.z = 1
    else if (event.key === 'PageUp') movement.y = 1
    else if (event.key === 'PageDown') movement.y = -1
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      const color = this.document.getVisibleVoxel(this.keyboardCell.x, this.keyboardCell.y, this.keyboardCell.z)
      const target = { cell: { ...this.keyboardCell }, normal: { x: 0, y: 1, z: 0 }, occupied: color > 0 || this.floatingSelection && this.selectionContains(this.keyboardCell), color }
      if (this.auxiliary === 'pick') { if (color) this.callbacks.onPick(color); return }
       if (this.tool === 'layer') { if (color) this.callbacks.onLayerSelect(this.document.getVisibleVoxelLayer(target.cell.x, target.cell.y, target.cell.z)); return }
      if (this.tool === 'select') {
        this.selectTarget(target, event.shiftKey)
        return
      }
      if (this.tool === 'paint') {
        if (this.paintMode === 'fill') {
          const cell = target.occupied ? { x: target.cell.x, y: target.cell.y + 1, z: target.cell.z } : target.cell
          if (this.document.contains(cell.x, cell.y, cell.z) && this.activeLayerEditable()) {
            const { min, max } = boxBounds(cell, cell, target.normal, this.fillDepth)
            this.callbacks.onFillCommit(min, max, target.normal, this.fillShape)
          }
          return
        }
        if (this.resolveActionTarget(target)) this.callbacks.onPaint([...this.selection.values()])
        return
      }
      if (this.tool === 'sculpt') {
        if (!target.occupied) { this.setSelection([]); return }
        if (!this.resolveActionTarget(target)) return
        if (this.sculptMode === 'erase') { this.callbacks.onErase([...this.selection.values()]); return }
        const { cells, move, range } = this.pushPullOperation(target)
        const distance = event.shiftKey ? -Math.min(1, range.push) : Math.min(1, range.pull)
        if (distance || this.floatingSelection) {
          this.callbacks.onPushPullCommit(cells, target.normal, distance, move, this.floatingSelection)
        }
        return
      }
      return
    } else return
    event.preventDefault()
    this.keyboardCell = {
      x: THREE.MathUtils.clamp(this.keyboardCell.x + (movement.x ?? 0), 0, this.document.dimensions.x - 1),
      y: THREE.MathUtils.clamp(this.keyboardCell.y + (movement.y ?? 0), 0, this.document.dimensions.y - 1),
      z: THREE.MathUtils.clamp(this.keyboardCell.z + (movement.z ?? 0), 0, this.document.dimensions.z - 1),
    }
    this.showCell(this.keyboardCell)
    this.callbacks.onHover(this.keyboardCell)
  }

  private cancelPaint() {
    this.paintPointer = undefined
  }

  private startMarquee(event: PointerEvent, target: ToolTarget, additive: boolean, action?: MarqueeDrag['action']) {
    this.marqueeDrag = {
      startX: event.clientX,
      startY: event.clientY,
      additive,
      target,
      end: { ...target.cell },
      moved: false,
      action,
    }
    this.activePointer = event.pointerId
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }

  private moveMarquee(event: PointerEvent) {
    if (!this.marqueeDrag) return
    if (!this.marqueeDrag.moved && Math.hypot(event.clientX - this.marqueeDrag.startX, event.clientY - this.marqueeDrag.startY) < 5) return
    const fill = this.marqueeDrag.action === 'fill'
    const pointBox = this.selectionMode === 'point' && !fill
    const pointTarget = pointBox ? this.targetAt(event) : undefined
    const end = pointBox ? pointTarget?.occupied ? pointTarget.cell : undefined : this.planeTargetAt(event, this.marqueeDrag.target.cell, this.marqueeDrag.target.normal)?.cell
    if (!end) return
    this.marqueeDrag.moved = true
    this.marqueeDrag.end = end
    const { min, max } = boxBounds(this.marqueeDrag.target.cell, end, this.marqueeDrag.target.normal, fill ? this.fillDepth : undefined)
    const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 }
    const center = {
      x: (min.x + max.x + 1) / 2 - this.document.dimensions.x / 2,
      y: (min.y + max.y + 1) / 2,
      z: (min.z + max.z + 1) / 2 - this.document.dimensions.z / 2,
    }
    const fillAxis = axisNames.find(name => this.marqueeDrag!.target.normal[name] !== 0) ?? 'y'
    if (fill && size.x * size.y * size.z <= MAX_FILL_GHOSTS) {
      this.marqueePreview.visible = false
      this.updateFillPreview([...fillShapeVoxels(min, max, this.fillShape, fillAxis, this.document.dimensions)])
      this.render()
      return
    }
    this.clearFillPreview()
    if (!pointBox && !fill) {
      const axis = axisNames.find(name => this.marqueeDrag!.target.normal[name] !== 0)!
      size[axis] = 0.06
      center[axis] += this.marqueeDrag.target.normal[axis] * 0.53
    }
    this.marqueePreview.geometry = fill ? this.fillPreviewGeometry[this.fillShape] : this.fillPreviewGeometry.box
    this.marqueePreview.rotation.set(0, 0, 0)
    this.marqueePreview.scale.set(size.x, size.y, size.z)
    if (fill && this.fillShape === 'cylinder') {
      const axis = axisNames.find(name => this.marqueeDrag!.target.normal[name] !== 0)
      if (axis === 'x') {
        this.marqueePreview.rotation.z = Math.PI / 2
        this.marqueePreview.scale.set(size.y, size.x, size.z)
      }
      if (axis === 'z') {
        this.marqueePreview.rotation.x = Math.PI / 2
        this.marqueePreview.scale.set(size.x, size.z, size.y)
      }
    }
    this.marqueePreview.visible = !this.renderMode
    this.marqueePreview.position.set(center.x, center.y, center.z)
    ;(this.marqueePreview.material as THREE.MeshBasicMaterial).color.setHex(this.marqueeDrag.action === 'paint' || fill
      ? this.document.palette[this.activeColor] ?? 0x2864dc
      : this.marqueeDrag.action === 'erase' ? 0xd94a4a : 0x2f66db)
    this.render()
  }

  private selectMarquee(drag: MarqueeDrag) {
    const { min, max } = boxBounds(drag.target.cell, drag.end, drag.target.normal)
    const next = drag.additive ? new Map(this.selection) : new Map<number, Vec3>()
    const cells = this.selectionMode === 'point' ? occupiedVoxels(this.document, min, max, this.document.activeLayerId)
      : surfaceVoxels(this.document, min, max, drag.target.normal, this.document.activeLayerId)
    for (const cell of cells) next.set(this.selectionKey(cell), cell)
    this.setSelection([...next.values()])
  }

  private cancelMarquee() {
    this.marqueeDrag = undefined
    this.marqueePreview.visible = false
    this.clearFillPreview()
    this.activePointer = undefined
    this.render()
  }

  private selectionKey(cell: Vec3) {
    return cell.x + cell.y * this.document.dimensions.x + cell.z * this.document.dimensions.x * this.document.dimensions.y
  }

  private focusBounds() {
    if (!this.selection.size) return this.document.bounds(true)
    const min = { x: this.document.dimensions.x, y: this.document.dimensions.y, z: this.document.dimensions.z }
    const max = { x: 0, y: 0, z: 0 }
    for (const cell of this.selection.values()) {
      min.x = Math.min(min.x, cell.x); min.y = Math.min(min.y, cell.y); min.z = Math.min(min.z, cell.z)
      max.x = Math.max(max.x, cell.x + 1); max.y = Math.max(max.y, cell.y + 1); max.z = Math.max(max.z, cell.z + 1)
    }
    return { min, max }
  }

  private focusCenter() {
    const bounds = this.focusBounds()
    return bounds ? new THREE.Vector3(
      (bounds.min.x + bounds.max.x) / 2 - this.document.dimensions.x / 2,
      (bounds.min.y + bounds.max.y) / 2,
      (bounds.min.z + bounds.max.z) / 2 - this.document.dimensions.z / 2,
    ) : new THREE.Vector3()
  }

  private selectTarget(target: ToolTarget | undefined, additive: boolean) {
    if (!target?.occupied || !this.activeTarget(target)) {
      if (!additive) this.setSelection([])
      return
    }
    const cells = this.selectionMode === 'point' ? [target.cell]
      : this.selectionMode === 'surface' ? connectedSurfaceVoxels(this.document, target.cell, target.normal)
      : this.selectionMode === 'texture' ? connectedBodyVoxels(this.document, target.cell, target.color)
      : connectedBodyVoxels(this.document, target.cell)
    if (!additive) { this.setSelection(cells); return }
    const next = new Map(this.selection)
    const remove = cells.every(cell => next.has(this.selectionKey(cell)))
    for (const cell of cells) remove ? next.delete(this.selectionKey(cell)) : next.set(this.selectionKey(cell), cell)
    this.setSelection([...next.values()])
  }

  setSelection(cells: Vec3[]) {
    this.updateSelection(cells, false, true, true)
  }

  setFloatingSelection(cells: Vec3[]) {
    if (cells[0]) this.keyboardCell = { ...cells[0] }
    this.updateSelection(cells, true, true, true)
  }

  applySelection(selection: SelectionState, focus = true) {
    if (selection.cells[0] && selection.floating) this.keyboardCell = { ...selection.cells[0] }
    this.updateSelection(selection.cells, selection.floating === true, false, focus)
  }

  private updateSelection(cells: Vec3[], floating: boolean, notify: boolean, focus: boolean) {
    this.selection.clear()
    this.floatingSelection = floating
    for (const cell of cells) if (this.document.contains(cell.x, cell.y, cell.z) && (floating
      || this.document.getVisibleVoxelLayer(cell.x, cell.y, cell.z) === this.document.activeLayerId)) this.selection.set(this.selectionKey(cell), { ...cell })
    this.clearSelectionPreview()
    const selected = [...this.selection.values()]
    if (selected.length && !this.sceneContent) {
      const material = new THREE.MeshBasicMaterial({ color: 0x2f66db, transparent: true, opacity: floating ? 0.4 : 0.3, depthTest: !floating, depthWrite: false })
      const preview = new THREE.InstancedMesh(new THREE.BoxGeometry(1.06, 1.06, 1.06), material, selected.length)
      preview.userData.editorOverlay = true
      preview.renderOrder = 3
      const matrix = new THREE.Matrix4()
      selected.forEach((cell, index) => {
        matrix.makeTranslation(cell.x - this.document.dimensions.x / 2 + 0.5, cell.y + 0.5, cell.z - this.document.dimensions.z / 2 + 0.5)
        preview.setMatrixAt(index, matrix)
      })
      preview.instanceMatrix.needsUpdate = true
      preview.computeBoundingSphere()
      preview.visible = !this.renderMode && !this.sceneContent
      this.selectionPreview = preview
      this.scene.add(preview)
    }
    this.finishSelection({ cells: selected, count: selected.length, floating }, notify, focus)
  }

  private clearSelectionPreview() {
    if (this.selectionPreview) {
      this.scene.remove(this.selectionPreview)
      this.selectionPreview.dispose()
      this.selectionPreview.geometry.dispose()
      ;(this.selectionPreview.material as THREE.Material).dispose()
    }
    this.selectionPreview = undefined
  }

  private finishSelection(selection: SelectionState, notify: boolean, focus: boolean) {
    if (focus && !this.sceneContent) this.moveFocus(this.focusCenter())
    if (notify) this.callbacks.onSelectionChange(selection)
    this.render()
  }

  private selectionContains(cell: Vec3) {
    return this.selection.has(this.selectionKey(cell))
  }

  private activeTarget(target: ToolTarget) {
    return this.floatingSelection && this.selectionContains(target.cell)
      || this.document.getVisibleVoxelLayer(target.cell.x, target.cell.y, target.cell.z) === this.document.activeLayerId
  }

  private activeLayerEditable() {
    const layer = this.document.activeLayer
    return layer.visible && !layer.locked
  }

  private fillStartCell(target?: ToolTarget) {
    if (!target || !this.activeLayerEditable()) return
    const cell = target.occupied ? {
      x: target.cell.x + target.normal.x,
      y: target.cell.y + target.normal.y,
      z: target.cell.z + target.normal.z,
    } : { ...target.cell }
    return this.document.contains(cell.x, cell.y, cell.z) ? cell : undefined
  }

  private touchTargetActionable(target?: ToolTarget) {
    if (this.auxiliary) return Boolean(target?.occupied)
    if (this.tool === 'layer') return Boolean(target?.occupied)
    if (this.tool === 'select') return Boolean(target?.occupied && this.activeTarget(target))
    if (this.tool === 'paint') return this.paintMode === 'fill' ? Boolean(this.fillStartCell(target))
      : Boolean(target?.occupied && this.activeTarget(target) && this.activeLayerEditable())
    if (!target?.occupied || !this.activeTarget(target)) return false
    if (this.floatingSelection) return this.selectionContains(target.cell) && this.activeLayerEditable()
    if (this.selectionMode === 'point' && this.sculptMode !== 'erase' && !this.selectionContains(target.cell)) return true
    if (!this.activeLayerEditable()) return false
    if (!this.selectionContains(target.cell) || this.sculptMode === 'erase') return true
    const { cells, range } = this.pushPullOperation(target)
    return Boolean(cells.length && (range.push || range.pull))
  }

  private resolveActionTarget(target?: ToolTarget) {
    if (!target?.occupied || !this.activeTarget(target) || !this.activeLayerEditable()) {
      this.setSelection([])
      return false
    }
    if (target.occupied && !this.selectionContains(target.cell)) this.selectTarget(target, false)
    return true
  }

  private moveFocus(target: THREE.Vector3) {
    this.cancelFocusAnimation()
    const startTarget = this.controls.target.clone()
    const shift = target.clone().sub(startTarget)
    if (shift.lengthSq() < 1e-8) return
    this.callbacks.onViewStart()
    const endPosition = this.camera.position.clone().add(shift)
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(endPosition)
      this.controls.target.copy(target)
      this.controls.update()
      return
    }
    const startPosition = this.camera.position.clone()
    const started = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / 220)
      const eased = 1 - (1 - progress) ** 3
      this.camera.position.lerpVectors(startPosition, endPosition, eased)
      this.controls.target.lerpVectors(startTarget, target, eased)
      this.controls.update()
      this.render()
      if (progress < 1) this.focusAnimation = requestAnimationFrame(step)
      else this.focusAnimation = undefined
    }
    this.focusAnimation = requestAnimationFrame(step)
  }

  private cancelFocusAnimation() {
    if (this.focusAnimation !== undefined) cancelAnimationFrame(this.focusAnimation)
    this.focusAnimation = undefined
  }

  private startPushPull(event: PointerEvent, target: ToolTarget) {
    const { cells, move, range } = this.pushPullOperation(target)
    if (!cells.length) return false
    const rect = this.renderer.domElement.getBoundingClientRect()
    const center = new THREE.Vector3(
      target.cell.x - this.document.dimensions.x / 2 + 0.5,
      target.cell.y + 0.5,
      target.cell.z - this.document.dimensions.z / 2 + 0.5,
    )
    const tip = center.clone().add(new THREE.Vector3(target.normal.x, target.normal.y, target.normal.z))
    center.project(this.camera)
    tip.project(this.camera)
    let screenX = (tip.x - center.x) * rect.width / 2
    let screenY = (center.y - tip.y) * rect.height / 2
    const length = Math.hypot(screenX, screenY)
    if (length < 0.01) { screenX = 0; screenY = -24 }
    else if (length < 12) { screenX *= 12 / length; screenY *= 12 / length }
    this.pushPullDrag = {
      cells,
      normal: { ...target.normal },
      move,
      distance: 0,
      min: -range.push,
      max: range.pull,
      startX: event.clientX,
      startY: event.clientY,
      screenX,
      screenY,
    }

    this.pushPullPreview = this.createGhostPreview(cells.length, 0x2864dc)
    this.updatePushPullPreview()
    if (this.selectionPreview) this.selectionPreview.visible = false
    this.scene.add(this.pushPullPreview)
    this.callbacks.onPushPullPreview(cells.length, 0, move)
    this.render()
    return true
  }

  private pushPullCells(target: ToolTarget) {
    if (!target.occupied || !this.selectionContains(target.cell)) return []
    return connectedSurfaceVoxels(this.document, target.cell, target.normal).filter(cell => this.selectionContains(cell))
  }

  private pushPullOperation(target: ToolTarget) {
    if (this.sculptMode === 'push') {
      const cells = this.pushPullCells(target)
      return { cells, move: false, range: pushPullRange(this.document, cells, target.normal) }
    }
    const selected = [...this.selection.values()]
    return { cells: selected, move: true, range: moveRange(this.document, selected, target.normal) }
  }

  private movePushPull(event: PointerEvent) {
    if (!this.pushPullDrag || !this.pushPullPreview) return
    const { startX, startY, screenX, screenY, min, max, move } = this.pushPullDrag
    const lengthSquared = screenX * screenX + screenY * screenY
    const distance = THREE.MathUtils.clamp(Math.round(((event.clientX - startX) * screenX + (event.clientY - startY) * screenY) / lengthSquared), min, max)
    if (distance === this.pushPullDrag.distance) return
    this.pushPullDrag.distance = distance
    this.updatePushPullPreview()
    ;(this.pushPullPreview.material as THREE.MeshBasicMaterial).color.setHex(!move && distance < 0 ? 0xd94a4a : 0x2864dc)
    this.callbacks.onPushPullPreview(this.pushPullDrag.cells.length, distance, move)
    this.render()
  }

  private updatePushPullPreview() {
    if (!this.pushPullDrag || !this.pushPullPreview) return
    const ghosts = pushPullGhostVoxels(this.pushPullDrag.cells, this.pushPullDrag.normal, this.pushPullDrag.distance, this.pushPullDrag.move)
    if (this.pushPullPreview.instanceMatrix.count < ghosts.length) {
      const old = this.pushPullPreview
      this.pushPullPreview = this.createGhostPreview(Math.max(ghosts.length, old.instanceMatrix.count * 2), (old.material as THREE.MeshBasicMaterial).color.getHex())
      this.scene.remove(old)
      old.dispose()
      old.geometry.dispose()
      ;(old.material as THREE.Material).dispose()
      this.scene.add(this.pushPullPreview)
    }
    this.updateGhostPreview(this.pushPullPreview, ghosts)
  }

  private createGhostPreview(capacity: number, color: number) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.24, depthTest: false, depthWrite: false })
    const preview = new THREE.InstancedMesh(new THREE.BoxGeometry(0.94, 0.94, 0.94), material, capacity)
    preview.userData.editorOverlay = true
    preview.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    preview.renderOrder = 4
    return preview
  }

  private updateGhostPreview(preview: THREE.InstancedMesh, cells: Vec3[]) {
    const matrix = new THREE.Matrix4()
    preview.count = cells.length
    cells.forEach((cell, index) => {
      matrix.makeTranslation(
        cell.x - this.document.dimensions.x / 2 + 0.5,
        cell.y + 0.5,
        cell.z - this.document.dimensions.z / 2 + 0.5,
      )
      preview.setMatrixAt(index, matrix)
    })
    preview.instanceMatrix.clearUpdateRanges()
    if (cells.length) preview.instanceMatrix.addUpdateRange(0, cells.length * 16)
    preview.instanceMatrix.needsUpdate = true
    preview.computeBoundingSphere()
  }

  private updateFillPreview(cells: Vec3[]) {
    if (!this.fillPreview || this.fillPreview.instanceMatrix.count < cells.length) {
      this.clearFillPreview()
      this.fillPreview = this.createGhostPreview(2 ** Math.ceil(Math.log2(Math.max(1, cells.length))), this.document.palette[this.activeColor] ?? 0x2864dc)
      this.scene.add(this.fillPreview)
    }
    ;(this.fillPreview.material as THREE.MeshBasicMaterial).color.setHex(this.document.palette[this.activeColor] ?? 0x2864dc)
    this.fillPreview.visible = !this.renderMode
    this.updateGhostPreview(this.fillPreview, cells)
  }

  private clearFillPreview() {
    if (!this.fillPreview) return
    this.scene.remove(this.fillPreview)
    this.fillPreview.dispose()
    this.fillPreview.geometry.dispose()
    ;(this.fillPreview.material as THREE.Material).dispose()
    this.fillPreview = undefined
  }

  private cancelPushPull() {
    if (this.pushPullPreview) {
      this.scene.remove(this.pushPullPreview)
      this.pushPullPreview.dispose()
      this.pushPullPreview.geometry.dispose()
      ;(this.pushPullPreview.material as THREE.Material).dispose()
    }
    if (this.pushPullDrag) this.callbacks.onPushPullPreview()
    this.pushPullPreview = undefined
    this.pushPullDrag = undefined
    if (this.selectionPreview) this.selectionPreview.visible = !this.renderMode && !this.sceneContent
    this.activePointer = undefined
    this.render()
  }

  private gridRay(event: MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    // Match the rendered clip volume, including negative orthographic near planes.
    this.raycaster.ray.origin.set(this.pointer.x, this.pointer.y, -1).unproject(this.camera)
    this.raycaster.near = 0
    this.raycaster.far = new THREE.Vector3(this.pointer.x, this.pointer.y, 1).unproject(this.camera).distanceTo(this.raycaster.ray.origin)
    return {
      origin: {
        x: this.raycaster.ray.origin.x + this.document.dimensions.x / 2,
        y: this.raycaster.ray.origin.y,
        z: this.raycaster.ray.origin.z + this.document.dimensions.z / 2,
      },
      direction: { x: this.raycaster.ray.direction.x, y: this.raycaster.ray.direction.y, z: this.raycaster.ray.direction.z },
    }
  }

  private targetAt(event: MouseEvent): ToolTarget | undefined {
    const ray = this.gridRay(event)
    if (this.floatingSelection && this.selectionPreview) {
      const hit = this.raycaster.intersectObject(this.selectionPreview)[0]
      const cell = hit?.instanceId === undefined ? undefined : [...this.selection.values()][hit.instanceId]
      if (cell && hit.face) return {
        cell: { ...cell },
        normal: { x: Math.round(hit.face.normal.x), y: Math.round(hit.face.normal.y), z: Math.round(hit.face.normal.z) },
        occupied: true,
        color: 0,
      }
    }
    return traceGridRay(this.document, ray.origin, ray.direction, this.raycaster.far)
  }

  private planeTargetAt(event: PointerEvent, cell: Vec3, normal: Vec3): ToolTarget | undefined {
    const ray = this.gridRay(event)
    const projected = tracePlaneRay(this.document, ray.origin, ray.direction, cell, normal, this.camera instanceof THREE.OrthographicCamera)
    return projected ? { cell: projected, normal: { ...normal }, occupied: false, color: 0 } : undefined
  }

  private showHover(target?: ToolTarget) {
    const cell = this.tool === 'paint' && this.paintMode === 'fill' && !this.auxiliary ? this.fillStartCell(target)
      : target?.occupied ? target.cell : undefined
    if (!cell || this.renderMode) {
      if (!this.hover.visible) return
      this.hover.visible = false
      this.callbacks.onHover()
      this.render()
      return
    }
    if (this.showCell(cell)) this.callbacks.onHover(cell)
  }

  private showCell(cell: Vec3) {
    const material = this.hover.material as THREE.MeshBasicMaterial
    const color = this.tool === 'paint' ? this.document.palette[this.activeColor] ?? 0x2864dc
      : this.tool === 'sculpt' && this.sculptMode === 'erase' ? 0xd94a4a : 0x2864dc
    const x = cell.x - this.document.dimensions.x / 2 + 0.5, y = cell.y + 0.5, z = cell.z - this.document.dimensions.z / 2 + 0.5
    if (this.hover.visible === !this.renderMode && this.hover.position.x === x && this.hover.position.y === y && this.hover.position.z === z && material.color.getHex() === color) return false
    this.hover.visible = !this.renderMode
    this.hover.position.set(x, y, z)
    material.color.setHex(color)
    this.render()
    return true
  }

  private receiveMeshes(message: { type: 'meshed'; results: MeshResult[] }) {
    if (message.type !== 'meshed') return
    if (this.sceneContent) return
    this.inFlight = 0
    for (const result of message.results) {
      if (this.versions.get(result.id) !== result.version || !this.document.chunks.has(result.id)) continue
      this.removeChunk(result.id)
      if (!result.positions.length) continue
      const chunkMesh = new THREE.Group()
      // Draw the post-merge positions once each, without the surface's triangle indices.
      const verticesGeometry = new THREE.BufferGeometry()
      verticesGeometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3))
      const vertices = new THREE.Points(verticesGeometry, this.meshVerticesMaterial)
      vertices.userData.meshVertices = true
      vertices.userData.editorOverlay = true
      vertices.visible = this.settings.meshVertices && !this.renderMode
      vertices.renderOrder = 2
      chunkMesh.add(vertices)
      for (const group of result.groups) {
        const geometry = new THREE.BufferGeometry()
        const start = group.vertexStart, end = start + group.vertexCount
        geometry.setAttribute('position', new THREE.BufferAttribute(result.positions.subarray(start * 3, end * 3), 3))
        geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals.subarray(start * 3, end * 3), 3))
        geometry.setAttribute('uv', new THREE.BufferAttribute(result.uvs.subarray(start * 2, end * 2), 2))
        const indices = result.indices.subarray(group.start, group.start + group.count)
        for (let index = 0; index < indices.length; index++) indices[index] -= start
        geometry.setIndex(new THREE.BufferAttribute(indices, 1))
        const bounds = new THREE.Box3(new THREE.Vector3(...group.bounds.slice(0, 3)), new THREE.Vector3(...group.bounds.slice(3)))
        geometry.boundingBox = bounds
        geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere())
        const mesh = new THREE.Mesh(geometry, this.materials[group.materialIndex])
        mesh.matrixAutoUpdate = false
        mesh.castShadow = castsRealtimeShadow(this.document.materials[group.materialIndex])
        mesh.receiveShadow = true
        chunkMesh.add(mesh)
      }
      const chunk = chunkCoords(result.id)
      chunkMesh.position.set(chunk.x * CHUNK_SIZE - this.document.dimensions.x / 2, chunk.y * CHUNK_SIZE, chunk.z * CHUNK_SIZE - this.document.dimensions.z / 2)
      chunkMesh.updateMatrix()
      chunkMesh.matrixAutoUpdate = false
      this.chunkMeshes.set(result.id, chunkMesh)
      this.chunkQuads.set(result.id, result.quads)
      this.model.add(chunkMesh)
      chunkMesh.updateWorldMatrix(true, true)
      if (result.faceLines.length) this.receiveGrid(result)
      else if (this.settings.faceGrid) this.queuedGrids.add(result.id)
    }
    this.renderer.shadowMap.needsUpdate = true
    this.pump()
    this.requestPathTraceRebuild()
    this.render()
  }

  private receiveGrid(result: GridResult) {
    const chunk = this.chunkMeshes.get(result.id)
    if (!chunk) return
    for (const child of [...chunk.children]) if (child.userData.faceGrid) {
      (child as THREE.LineSegments).geometry.dispose()
      chunk.remove(child)
    }
    chunk.userData.faceGridReady = true
    if (!result.faceLines.length) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(result.faceLines, 3))
    geometry.computeBoundingSphere()
    const lines = new THREE.LineSegments(geometry, this.faceGridMaterial)
    lines.userData.faceGrid = true
    lines.visible = this.settings.faceGrid && !this.renderMode
    lines.renderOrder = 1
    chunk.add(lines)
    lines.updateWorldMatrix(true, false)
  }

  private removeChunk(id: number) {
    const chunk = this.chunkMeshes.get(id)
    if (chunk) {
      chunk.traverse(child => { if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Points) child.geometry.dispose() })
      this.model.remove(chunk)
      this.chunkMeshes.delete(id)
      this.renderer.shadowMap.needsUpdate = true
    }
    this.chunkQuads.delete(id)
  }

  private reportMeshStats() {
    let quads = 0
    for (const count of this.chunkQuads.values()) quads += count
    const pending = this.queued.size + this.queuedGrids.size + this.inFlight
    this.callbacks.onMeshStats(pending, quads)
    if (!pending) for (const waiter of this.meshWaiters.splice(0)) waiter.resolve()
  }

  private pump() {
    if (this.sceneContent) return
    if (!this.workerReady || this.meshFailed || this.inFlight) { this.reportMeshStats(); return }
    while (this.queued.size || this.queuedGrids.size) {
      const grid = !this.queued.size
      const queue = grid ? this.queuedGrids : this.queued
      const id = queue.values().next().value!
      queue.delete(id)
      if (!this.document.chunks.has(id)) { this.removeChunk(id); continue }
      if (grid && this.chunkMeshes.get(id)?.userData.faceGridReady) continue
      const voxels = this.document.paddedChunk(id, true).buffer
      this.inFlight = 1
      this.worker.postMessage({ type: grid ? 'grid' : 'mesh', jobs: [{ id, version: this.versions.get(id)!, voxels }], faceGrid: this.settings.faceGrid }, [voxels])
      break
    }
    this.reportMeshStats()
    if (!this.inFlight && !this.queued.size && this.pathTracingBuildRequested && this.pathTracingEnabled()) void this.buildPathTrace()
  }

  markDirty(ids: Iterable<number>) {
    if (this.sceneContent) return
    for (const id of ids) {
      this.versions.set(id, ++this.nextVersion)
      this.queued.add(id)
      this.queuedGrids.delete(id)
      if (!this.document.chunks.has(id)) this.removeChunk(id)
    }
    this.requestPathTraceRebuild()
    this.pump()
    this.render()
  }

  whenMeshIdle() {
    if (this.modelSuspended) return Promise.reject(new Error('Model meshing is suspended in scene mode.'))
    if (this.meshFailed) return Promise.reject(new Error('The voxel surface worker stopped.'))
    if (!this.queued.size && !this.queuedGrids.size && !this.inFlight) return Promise.resolve()
    return new Promise<void>((resolve, reject) => this.meshWaiters.push({ resolve, reject }))
  }

  meshState() {
    return { pending: this.queued.size + this.queuedGrids.size + this.inFlight, failed: this.meshFailed }
  }

  private createMaterials() {
    return this.document.materials.map(({ name, roughness, metalness, emissiveIntensity, opacity, transmission, ior }, index) => {
      const material = new THREE.MeshPhysicalMaterial({
        name,
        color: this.document.palette[index],
        envMap: this.environmentTarget.texture,
        envMapIntensity: realtimeEnvironmentIntensity(metalness),
        roughness,
        metalness,
        emissive: this.document.palette[index],
        emissiveIntensity,
        opacity,
        transmission,
        ior,
        transparent: opacity < 1,
        depthWrite: opacity >= 1,
      })
      Object.assign(material, { castShadow: this.settings.shadows })
      return material
    })
  }

  private disposeMaterials() {
    for (const material of this.materials) {
      for (const map of ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) material[map]?.dispose()
      material.dispose()
    }
  }

  updatePalette() {
    this.materials.forEach((material, index) => {
      material.color.setHex(this.document.palette[index])
      material.emissive.copy(material.color)
      material.needsUpdate = true
    })
    this.updatePathTracing('materials')
    this.render()
  }

  private updateWorkerPalette() {
    if (!this.workerReady) return
    const transparent = Uint8Array.from(this.document.materials, material => Number(material.opacity < 1 || material.transmission > 0)).buffer
    this.worker.postMessage({ type: 'palette', transparent }, [transparent])
  }

  updatePaletteMaterial(index: number) {
    const preset = this.document.materials[index]
    const material = this.materials[index]
    const wasTransparent = material.opacity < 1 || material.transmission > 0
    material.name = preset.name
    material.roughness = preset.roughness
    material.metalness = preset.metalness
    material.envMapIntensity = realtimeEnvironmentIntensity(preset.metalness)
    material.emissive.setHex(this.document.palette[index])
    material.emissiveIntensity = preset.emissiveIntensity
    material.opacity = preset.opacity
    material.transmission = preset.transmission
    material.ior = preset.ior
    material.transparent = preset.opacity < 1
    material.depthWrite = preset.opacity >= 1
    material.needsUpdate = true
    if (wasTransparent !== (preset.opacity < 1 || preset.transmission > 0)) {
      this.updateWorkerPalette()
      this.markDirty(this.document.chunks.keys())
    } else this.updatePathTracing('materials')
    this.render()
  }

  setDocument(document: VoxelDocument, preserveMaterials = false) {
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    this.document = document
    this.applySelection({ cells: [], count: 0 }, false)
    this.queued.clear()
    this.queuedGrids.clear()
    this.versions.clear()
    this.worker.terminate()
    if (!this.sceneContent) this.worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })
    this.inFlight = 0
    this.workerReady = false
    this.meshFailed = false
    if (!this.sceneContent) this.bindWorker()
    for (const id of [...this.chunkMeshes.keys()]) this.removeChunk(id)
    if (!preserveMaterials) {
      this.disposeMaterials()
      this.materials = this.createMaterials()
    }
    this.keyboardCell = { x: 0, y: 0, z: 0 }
    this.rebuildStage()
    this.updatePalette()
    this.markDirty(this.document.chunks.keys())
    this.frameModel()
  }

  setTool(tool: Tool) {
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    this.tool = tool
    this.hover.visible = false
    this.render()
  }

  setSculptMode(mode: SculptMode) {
    this.cancelPushPull()
    this.cancelMarquee()
    this.sculptMode = mode
    this.render()
  }

  setPaintMode(mode: PaintMode) {
    this.cancelPaint()
    this.cancelMarquee()
    this.paintMode = mode
    this.render()
  }

  setFillShape(shape: FillShape) {
    this.fillShape = shape
  }

  setFillDepth(depth: number) {
    this.fillDepth = Math.max(1, Math.round(depth))
  }

  setAuxiliary(tool?: AuxiliaryTool) {
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    this.auxiliary = tool
    this.hover.visible = false
    this.render()
  }

  setSelectionMode(mode: SelectionMode) {
    this.selectionMode = mode
  }

  clearSelection() {
    this.cancelPushPull()
    this.cancelMarquee()
    this.setSelection([])
  }

  focusViewport() {
    this.renderer.domElement.focus({ preventScroll: true })
  }

  setActiveColor(index: number) {
    this.activeColor = index
    if (this.hover.visible) this.showCell({ x: this.hover.position.x + this.document.dimensions.x / 2 - 0.5, y: this.hover.position.y - 0.5, z: this.hover.position.z + this.document.dimensions.z / 2 - 0.5 })
  }

  async setPbrMap(index: number, map: PbrMap, file: Blob) {
    const url = URL.createObjectURL(file)
    let texture: THREE.Texture
    try {
      texture = await new THREE.TextureLoader().loadAsync(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.colorSpace = map === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    const material = this.materials[index]
    const previous = material[map]
    if (previous) previous.dispose()
    material[map] = texture
    material.needsUpdate = true
    this.updatePathTracing('materials')
    this.render()
  }

  clearPbrMaps(index: number, selected?: PbrMap) {
    const material = this.materials[index]
    for (const map of ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) {
      if (selected && map !== selected) continue
      material[map]?.dispose()
      material[map] = null
    }
    material.needsUpdate = true
    this.updatePathTracing('materials')
    this.render()
  }

  private pathTracingEnabled() {
    return (!this.sceneContent || !!this.sceneContent.prepareFullDetail) && !this.sceneInteraction && this.renderMode && this.settings.pathTracing && !this.pathTracingFailed && !this.contextLost
  }

  private stopPathTracingSamples() {
    if (this.pathTracingFrame !== undefined) cancelAnimationFrame(this.pathTracingFrame)
    this.pathTracingFrame = undefined
  }

  private startPathTracingSamples(reset = true) {
    if (!this.pathTracer || !this.pathTracingEnabled() || !this.pathTracingReady) return
    this.stopPathTracingSamples()
    if (reset) { this.pathTracer.reset(); this.presentationDirty = true }
    this.resetFps()
    let reportedSamples = -1
    const sample = () => {
      this.pathTracingFrame = undefined
      if (!this.pathTracer || !this.pathTracingEnabled() || !this.pathTracingReady) return
      try {
        const previousSamples = Math.floor(this.pathTracer.samples)
        this.pathTracer.renderSample()
        const samples = Math.floor(this.pathTracer.samples)
        if (this.pathTracer.samples > 0) this.presentationDirty = false
        if (samples > previousSamples) this.recordFrame(samples - previousSamples)
        if (samples !== reportedSamples) {
          reportedSamples = samples
          this.callbacks.onPathTracingStatus(`${samples} ${samples === 1 ? 'sample' : 'samples'}`)
        }
        if (samples < 128) this.pathTracingFrame = requestAnimationFrame(sample)
        else this.resetFps()
      } catch (error) {
        this.failPathTracing(error)
      }
    }
    this.pathTracingFrame = requestAnimationFrame(sample)
  }

  private async ensurePathTracer() {
    if (this.pathTracer) return this.pathTracer
    const [{ WebGLPathTracer }, { GenerateMeshBVHWorker }] = await Promise.all([
      import('three-gpu-pathtracer'),
      import('three-mesh-bvh/worker'),
    ])
    if (!this.pathTracingEnabled()) return undefined
    const tracer = new WebGLPathTracer(this.renderer)
    const worker = new GenerateMeshBVHWorker()
    this.pathTracingWorker = worker
    tracer.setBVHWorker(worker)
    tracer.bounces = 4
    tracer.tiles.set(2, 2)
    tracer.renderScale = this.sceneContent ? 0.75 * Math.min(1, Math.sqrt(1_000_000 / (this.renderer.domElement.width * this.renderer.domElement.height))) : 0.75
    tracer.renderDelay = 0
    tracer.minSamples = 1
    tracer.fadeDuration = 180
    tracer.dynamicLowRes = true
    tracer.rasterizeSceneCallback = () => this.renderRaster()
    this.pathTracer = tracer
    return tracer
  }

  private requestPathTraceRebuild() {
    this.pathTracingRevision++
    this.pathTracingBuildRequested = true
    this.pathTracingReady = false
    this.stopPathTracingSamples()
    this.render()
    if (this.sceneContent && !this.sceneContent.prepareFullDetail && this.renderMode && this.settings.pathTracing) this.callbacks.onPathTracingStatus('Scene raster only (no full-detail adapter)')
    if (!this.pathTracingEnabled()) return
    if (this.inFlight || this.queued.size) {
      this.callbacks.onPathTracingStatus('Updating mesh')
      return
    }
    void this.buildPathTrace()
  }

  private async buildPathTrace() {
    if (this.pathTracingBuildRunning) return
    this.pathTracingBuildRunning = true
    let buildingTracer: WebGLPathTracer | undefined
    let buildingRevision = this.pathTracingRevision
    try {
      while (this.pathTracingEnabled() && this.pathTracingBuildRequested && !this.inFlight && !this.queued.size) {
        const revision = this.pathTracingRevision
        buildingRevision = revision
        this.pathTracingBuildRequested = false
        const content = this.sceneContent
        let prepared: PreparedSceneContent | undefined
        if (content) {
          this.callbacks.onPathTracingStatus('Preparing full scene')
          prepared = await this.prepareSceneContent()
          if (!this.pathTracingEnabled() || content !== this.sceneContent) break
          if (revision !== this.pathTracingRevision) { this.pathTracingBuildRequested = true; continue }
          // A fresh generator avoids retaining a previous expanded scene during a rebuild.
          this.disposePathTracer()
        }
        const tracer = await this.ensurePathTracer()
        buildingTracer = tracer
        if (!tracer || !this.pathTracingEnabled()) break
        if (revision !== this.pathTracingRevision || this.inFlight || this.queued.size) {
          this.pathTracingBuildRequested = true
          continue
        }
        let progressStep = -1
        this.callbacks.onPathTracingStatus('Preparing')
        const traceScene = prepared ? this.createTraceScene(prepared) : this.scene
        await tracer.setSceneAsync(traceScene, this.camera, {
          onProgress: progress => {
            if (!this.pathTracingEnabled() || revision !== this.pathTracingRevision) return
            const step = Math.floor(progress * 10)
            if (step !== progressStep) {
              progressStep = step
              this.callbacks.onPathTracingStatus(`Preparing ${Math.round(progress * 100)}%`)
            }
          },
        })
        this.pathTracingReady = this.pathTracingEnabled() && revision === this.pathTracingRevision
          && !this.pathTracingBuildRequested && !this.inFlight && !this.queued.size
        if (this.pathTracingReady) this.sceneCameraDirty = false
      }
    } catch (error) {
      if (!this.contextLost && (!buildingTracer || buildingTracer === this.pathTracer) && buildingRevision === this.pathTracingRevision && this.pathTracingEnabled()) this.failPathTracing(error)
    } finally {
      this.pathTracingBuildRunning = false
    }
    if (this.pathTracingEnabled() && this.pathTracingBuildRequested && !this.inFlight && !this.queued.size) void this.buildPathTrace()
    else if (this.pathTracingEnabled() && this.pathTracingReady && !this.pathTracingBuildRequested && !this.inFlight && !this.queued.size) this.startPathTracingSamples()
  }

  private disposePathTracer() {
    this.pathTracingWorker?.dispose()
    this.pathTracingWorker = undefined
    this.pathTracer?.dispose()
    this.pathTracer = undefined
    this.traceScene?.clear()
    this.traceScene = undefined
    this.traceGround?.geometry.dispose()
    this.traceGround?.material.dispose()
    this.traceGround = undefined
  }

  private failPathTracing(error: unknown) {
    // GL reports loss before the DOM event is delivered. Let restoration own
    // recovery rather than reporting a transient device loss as a tracer failure.
    if (this.contextLost || this.renderer.getContext().isContextLost()) {
      this.contextLost = true
      this.pathTracingReady = false
      this.stopPathTracingSamples()
      return
    }
    this.pathTracingFailed = true
    this.pathTracingReady = false
    this.pathTracingBuildRequested = true
    this.pathTracingRevision++
    this.stopPathTracingSamples()
    this.disposePathTracer()
    if (this.sceneContent) this.releaseSceneDetail()
    this.resetFps()
    this.callbacks.onPathTracingStatus('Raster fallback')
    this.callbacks.onError(`Progressive PBR stopped. Using the realtime renderer. ${error instanceof Error ? error.message : ''}`.trim())
    this.render()
  }

  private updatePathTracing(...changes: ('materials' | 'lights' | 'environment' | 'camera')[]) {
    if (!this.pathTracingEnabled()) return
    if (!this.pathTracer || !this.pathTracingReady || this.pathTracingBuildRunning || this.inFlight || this.queued.size) {
      this.requestPathTraceRebuild()
      return
    }
    try {
      for (const change of changes) {
        if (change === 'materials') this.pathTracer.updateMaterials()
        else if (change === 'lights') this.pathTracer.updateLights()
        else if (change === 'environment') this.pathTracer.updateEnvironment()
        else this.pathTracer.setCamera(this.camera)
      }
      if (changes.includes('camera')) this.sceneCameraDirty = false
      this.startPathTracingSamples()
    } catch (error) { this.failPathTracing(error) }
  }

  private cameraChanged() {
    if (this.sceneContent) this.sceneCameraDirty = true
    if (this.sceneContent && this.camera instanceof THREE.PerspectiveCamera) {
      // Scene-scale depth precision without sacrificing close-up voxel editing.
      this.camera.near = Math.max(0.1, this.controls.getDistance() / 1000)
      this.camera.updateProjectionMatrix()
    }
    this.updateWorkspaceGridVisibility()
    this.sceneContent?.onViewportChange()
    if (this.pathTracer && this.pathTracingReady && !this.pathTracingBuildRunning) this.updatePathTracing('camera')
    this.render()
  }

  setRenderMode(enabled: boolean) {
    if (this.renderMode === enabled) return
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    this.renderMode = enabled
    this.hover.visible = false
    this.marqueePreview.visible = false
    if (this.selectionPreview) this.selectionPreview.visible = !enabled && !this.sceneContent
    this.updateWorkspaceGridVisibility()
    if (this.limits) this.limits.visible = this.settings.grid && !enabled
    this.updateMeshOverlayVisibility()
    if (this.ground) this.ground.visible = enabled
    this.sceneContent?.onViewportChange()
    if (enabled && this.settings.pathTracing) {
      this.pathTracingFailed = false
      if (this.sceneContent && this.pathTracingReady && !this.pathTracingBuildRequested) {
        if (this.sceneCameraDirty) this.updatePathTracing('camera')
        else this.startPathTracingSamples(false)
      } else this.requestPathTraceRebuild()
    } else {
      this.pathTracingRevision++
      this.resetFps()
      if (!this.sceneContent) this.pathTracingReady = false
      else if (this.pathTracingBuildRunning || this.fullPreparation) this.invalidateSceneContent()
      this.stopPathTracingSamples()
      this.callbacks.onPathTracingStatus('Ready')
      this.render()
    }
  }

  setSettings(settings: ViewSettings) {
    const previous = this.settings
    const projectionChanged = settings.projection !== this.settings.projection
    const pathTracingChanged = settings.pathTracing !== this.settings.pathTracing
    const faceGridChanged = settings.faceGrid !== this.settings.faceGrid
    const sceneDependenciesChanged = this.sceneContent && (['background', 'ambient', 'light', 'lightAzimuth', 'shadows'] as const).some(key => settings[key] !== previous[key])
    this.settings = { ...settings }
    const background = new THREE.Color(settings.background)
    this.scene.background = background
    const luminance = background.r * 0.2126 + background.g * 0.7152 + background.b * 0.0722
    this.faceGridMaterial.color.setHex(luminance > 0.35 ? 0x20262c : 0xf9faf8)
    this.meshVerticesMaterial.color.copy(this.faceGridMaterial.color)
    this.hemisphere.intensity = settings.ambient
    this.scene.environmentIntensity = settings.ambient / Math.PI
    this.sunlight.intensity = settings.light
    this.raster.ambientOcclusion.enabled = settings.ambientOcclusion
    this.renderer.shadowMap.enabled = settings.shadows
    this.updateWorkspaceGridVisibility()
    if (this.limits) this.limits.visible = settings.grid && !this.renderMode
    this.updateMeshOverlayVisibility()
    if (this.ground) {
      this.ground.visible = this.renderMode
      ;(this.ground.material as THREE.MeshStandardMaterial).color.set(settings.background).offsetHSL(0, -0.04, -0.035)
      ;(this.ground.material as THREE.Material).needsUpdate = true
    }
    const stageSize = this.sceneContent?.bounds.getSize(new THREE.Vector3()) ?? this.document.dimensions
    const center = this.sceneContent?.bounds.getCenter(new THREE.Vector3()) ?? new THREE.Vector3()
    const radius = Math.max(this.sceneContent ? 32 : 0, stageSize.x, stageSize.y, stageSize.z)
    const radians = THREE.MathUtils.degToRad(settings.lightAzimuth)
    this.sunlight.position.set(Math.cos(radians) * radius, radius * 1.7, Math.sin(radians) * radius).add(center)
    if (settings.shadows !== previous.shadows) for (const material of this.materials) Object.assign(material, { castShadow: settings.shadows })
    if (settings.shadows !== previous.shadows || settings.lightAzimuth !== previous.lightAzimuth) this.renderer.shadowMap.needsUpdate = true
    this.fitShadowCamera()
    if (projectionChanged) this.switchProjection(settings.projection)
    if (faceGridChanged && settings.faceGrid) {
      for (const [id, chunk] of this.chunkMeshes) if (!chunk.userData.faceGridReady && !this.queued.has(id)) this.queuedGrids.add(id)
      this.pump()
    }
    if (pathTracingChanged && settings.pathTracing) this.pathTracingFailed = false
    if (pathTracingChanged) this.resetFps()
    if (sceneDependenciesChanged) this.invalidateSceneContent()
    else if (pathTracingChanged && this.pathTracingEnabled()) this.requestPathTraceRebuild()
    else if (!this.pathTracingEnabled()) {
      if (pathTracingChanged) this.pathTracingRevision++
      this.pathTracingReady = false
      this.stopPathTracingSamples()
      this.callbacks.onPathTracingStatus(this.sceneContent && this.renderMode && settings.pathTracing ? 'Scene raster fallback' : 'Ready')
    } else {
      const changes: ('materials' | 'lights' | 'environment' | 'camera')[] = []
      if (settings.background !== previous.background || settings.shadows !== previous.shadows) changes.push('materials')
      if (settings.background !== previous.background || settings.ambient !== previous.ambient) changes.push('environment')
      if (settings.light !== previous.light || settings.lightAzimuth !== previous.lightAzimuth) changes.push('lights')
      if (projectionChanged) changes.push('camera')
      if (changes.length) this.updatePathTracing(...changes)
    }
    this.sceneContent?.onViewportChange()
    this.render()
  }

  private updateMeshOverlayVisibility() {
    this.model.traverse(child => {
      if (child.userData.faceGrid) child.visible = this.settings.faceGrid && !this.renderMode
      if (child.userData.meshVertices) child.visible = this.settings.meshVertices && !this.renderMode
    })
  }

  private updateWorkspaceGridVisibility() {
    if (!this.grid) return
    this.grid.visible = this.settings.grid && !this.renderMode
    if (!this.grid.visible) return
    if (this.sceneContent) return
    for (const child of this.grid.children) child.visible = workspaceGridPlaneVisible(this.document.dimensions, child.userData.normal as Vec3, this.camera.position)
  }

  private switchProjection(projection: ViewSettings['projection']) {
    this.cancelFocusAnimation()
    const position = this.camera.position.clone()
    const target = this.controls.target.clone()
    this.controls.dispose()
    this.camera = this.createCamera(projection)
    this.camera.position.copy(position)
    this.controls = this.createControls(this.camera)
    this.controls.target.copy(this.sceneContent ? target : this.focusCenter())
    this.controls.update()
    this.resize()
  }

  private rebuildStage() {
    if (this.grid) {
      this.scene.remove(this.grid)
      for (const child of this.grid.children) {
        const lines = child as THREE.LineSegments
        lines.geometry.dispose()
        ;(lines.material as THREE.Material).dispose()
      }
    }
    if (this.limits) {
      this.scene.remove(this.limits)
      this.limits.geometry.dispose()
      ;(this.limits.material as THREE.Material).dispose()
    }
    if (this.ground) { this.scene.remove(this.ground); this.ground.geometry.dispose(); (this.ground.material as THREE.Material).dispose() }
    const sceneBounds = this.sceneContent?.bounds
    const stageSize = sceneBounds?.getSize(new THREE.Vector3()) ?? this.document.dimensions
    const center = sceneBounds?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3()
    const size = Math.max(32, stageSize.x, stageSize.z)
    this.grid = new THREE.Group()
    const gridNormals: Vec3[] = [
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ]
    for (const normal of sceneBounds ? [] : gridNormals) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(workspaceGridPositions(this.document.dimensions, normal), 3))
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xb8c3ca, transparent: true, opacity: 0.58 }))
      lines.position.set(-normal.x * 0.002, -normal.y * 0.002, -normal.z * 0.002)
      lines.userData.normal = normal
      this.grid.add(lines)
    }
    if (sceneBounds) {
      const spacing = Math.max(1, 2 ** Math.ceil(Math.log2(size / 64)))
      const grid = new THREE.GridHelper(Math.ceil(size / spacing) * spacing, Math.ceil(size / spacing), 0x7b8993, 0xb8c3ca)
      grid.position.set(center.x, sceneBounds.min.y, center.z)
      this.grid.add(grid)
    }
    const bounds = new THREE.Box3(
      new THREE.Vector3(-this.document.dimensions.x / 2, 0, -this.document.dimensions.z / 2),
      new THREE.Vector3(this.document.dimensions.x / 2, this.document.dimensions.y, this.document.dimensions.z / 2),
    )
    this.limits = new THREE.Box3Helper(sceneBounds?.clone() ?? bounds, 0x7b8993)
    const limitsMaterial = this.limits.material as THREE.LineBasicMaterial
    limitsMaterial.transparent = true
    limitsMaterial.opacity = 0.68
    limitsMaterial.depthWrite = false
    this.limits.visible = this.settings.grid && !this.renderMode
    this.scene.add(this.grid, this.limits)
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 2, size * 2),
      new THREE.MeshStandardMaterial({ color: this.settings.background, roughness: 1, envMap: this.environmentTarget.texture, envMapIntensity: 0 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.set(center.x, (sceneBounds?.min.y ?? 0) - 0.03, center.z)
    this.ground.receiveShadow = true
    this.ground.visible = this.renderMode
    this.scene.add(this.ground)
    this.sunlightTarget.position.copy(sceneBounds ? center : new THREE.Vector3(0, this.document.dimensions.y / 3, 0))
    this.setSettings(this.settings)
  }

  private fitShadowCamera() {
    this.sunlight.updateMatrixWorld(true)
    this.sunlightTarget.updateMatrixWorld(true)
    this.sunlight.shadow.updateMatrices(this.sunlight)
    const camera = this.sunlight.shadow.camera
    const { x, y, z } = this.document.dimensions
    const size = Math.max(32, x, z)
    const bounds = (this.sceneContent?.bounds.clone() ?? new THREE.Box3(new THREE.Vector3(-size, -0.03, -size), new THREE.Vector3(size, y, size))).applyMatrix4(camera.matrixWorldInverse)
    const values = [bounds.min.x - 1, bounds.max.x + 1, bounds.max.y + 1, bounds.min.y - 1, Math.max(0.1, -bounds.max.z - 1), -bounds.min.z + 1]
    if (values.some((value, index) => value !== [camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far][index])) this.renderer.shadowMap.needsUpdate = true
    ;[camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far] = values
    camera.updateProjectionMatrix()
  }

  frameModel() {
    if (this.sceneContent) { this.frameSceneBounds(this.sceneContent.bounds); return }
    this.cancelFocusAnimation()
    const bounds = this.focusBounds()
    const center = this.focusCenter()
    const size = bounds ? Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z, 8) : 24
    const direction = new THREE.Vector3(1, 0.78, 1).normalize()
    this.camera.position.copy(center).add(direction.multiplyScalar(size * 2.6))
    this.controls.target.copy(center)
    this.orthographicSpan = size * 1.65
    if (this.camera instanceof THREE.OrthographicCamera) this.camera.zoom = 1
    this.resize()
    this.controls.update()
    this.render()
  }

  /** Live references: reacquire after projection/context changes. Do not dispose them. */
  getSceneViewport() {
    return { renderer: this.renderer, scene: this.scene, camera: this.camera,
      canvas: this.renderer.domElement, environment: this.environmentTarget.texture,
      controls: this.controls, renderMode: this.renderMode, shadows: this.settings.shadows }
  }

  /** Receiver-scoped shadow residency only; the shared shadow map keeps its existing
   * scene-wide fit. Include the PCF footprint so filtered edge shadows are retained. */
  getSceneShadowVolume(receivers: Iterable<THREE.Box3>, occupied: THREE.Box3) {
    if (!this.settings.shadows) return
    const shadow = this.sunlight.shadow, camera = shadow.camera
    const texel = Math.max((camera.right - camera.left) / shadow.mapSize.x, (camera.top - camera.bottom) / shadow.mapSize.y)
    let groundBounds: THREE.Box3 | undefined
    if (this.ground?.visible) {
      this.ground.updateWorldMatrix(true, false)
      this.ground.geometry.computeBoundingBox()
      groundBounds = this.ground.geometry.boundingBox!.clone().applyMatrix4(this.ground.matrixWorld)
    }
    return sceneShadowVolume(this.camera, occupied, receivers, camera.matrixWorldInverse,
      this.ground?.visible ? this.ground.position.y : undefined, texel * (Math.abs(shadow.radius) + 1) + Math.abs(shadow.normalBias), groundBounds)
  }

  /** Mount/unmount external scene content on the existing camera, stage and raster host.
   * Passing undefined restores the model camera/settings and its input hooks.
   */
  setSceneContent(content?: SceneContent) {
    const previous = this.sceneContent
    if (!previous && !content) return
    if (!previous) { this.modelView = this.getView(); this.modelSettings = { ...this.settings }; this.modelRenderMode = this.renderMode }
    if (previous !== content) { this.disposePathTracer(); this.releaseSceneDetail(); this.pathTracingFailed = false }
    this.sceneContent = content
    if (content && !previous) this.suspendModelMeshes()
    else if (!content) this.resumeModelMeshes()
    this.cancelFocusAnimation()
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    this.touchPointers.clear()
    this.orbitTouch = undefined
    for (const object of [this.hover, this.marqueePreview, this.selectionPreview, this.fillPreview, this.pushPullPreview]) if (object) object.visible = false
    if (previous && previous !== content) this.scene.remove(previous.root)
    if (content) this.scene.add(content.root)
    this.model.visible = !content
    this.controls.enabled = true
    this.controls.touches.ONE = -1 as THREE.TOUCH
    this.controls.maxDistance = content ? 65536 : 1200
    this.camera.near = this.camera instanceof THREE.PerspectiveCamera ? content ? 0.5 : 0.1 : content ? -65536 : -1000
    this.camera.far = content ? 131072 : 2000
    this.camera.updateProjectionMatrix()
    this.renderer.domElement.setAttribute('aria-label', content ? 'Scene viewport. Select or place objects; right drag or two-finger drag orbits. Escape cancels a transform.' : 'Voxel editing viewport. Arrow keys move the keyboard cursor, Page Up and Page Down change height, Space applies the active tool, and Shift Space reverses Push Pull or Move.')
    this.rebuildStage()
    if (!content) {
      if (this.modelSettings) this.setSettings(this.modelSettings)
      if (this.modelRenderMode !== undefined) this.setRenderMode(this.modelRenderMode)
      if (this.modelView) this.setView(this.modelView)
      if (this.selectionPreview) this.selectionPreview.visible = !this.renderMode
      this.modelView = undefined
      this.modelSettings = undefined
      this.modelRenderMode = undefined
    }
    this.renderer.shadowMap.needsUpdate = true
    this.requestPathTraceRebuild()
  }

  /** Only committed scene dependencies call this. Streaming and selection never do. */
  invalidateSceneContent() {
    if (!this.sceneContent) return
    this.disposePathTracer()
    this.releaseSceneDetail()
    this.pathTracingFailed = false
    this.requestPathTraceRebuild()
  }

  setSceneInteraction(active: boolean) {
    if (this.sceneInteraction === active) return
    this.sceneInteraction = active
    if (active) { this.stopPathTracingSamples(); this.render() }
    else if (this.pathTracingReady && this.pathTracingEnabled()) this.startPathTracingSamples(false)
  }

  private releaseSceneDetail() {
    this.fullEpoch++
    this.fullAbort?.abort()
    this.fullAbort = undefined
    this.fullPreparation = undefined
    this.fullContent?.dispose()
    this.fullContent = undefined
  }

  private prepareSceneContent(): Promise<PreparedSceneContent> {
    if (this.fullContent) return Promise.resolve(this.fullContent)
    if (this.fullPreparation) return this.fullPreparation
    const content = this.sceneContent
    if (!content?.prepareFullDetail) return Promise.reject(new Error('This scene adapter cannot provide exact full-scene content.'))
    const controller = new AbortController(), epoch = this.fullEpoch
    this.fullAbort = controller
    this.fullViewportPixels = this.renderer.domElement.width * this.renderer.domElement.height
    const promise = content.prepareFullDetail(controller.signal).then(prepared => {
      if (controller.signal.aborted || epoch !== this.fullEpoch || content !== this.sceneContent) {
        prepared.dispose(); throw new DOMException('Full-scene preparation was superseded', 'AbortError')
      }
      // Defense at the tracer boundary: never accidentally accept an instanced adapter.
      try {
        if (prepared.scope !== 'full-scene' || !Number.isSafeInteger(prepared.triangles) || prepared.triangles > 1_000_000 || !Number.isFinite(prepared.peakBytes) || prepared.peakBytes > 96 * 1024 * 1024) throw new Error('Full-scene adapter exceeded its declared budget.')
        const materials = new Set<THREE.Material>()
        let triangles = 2
        prepared.root.traverse(object => {
          if ((object as THREE.InstancedMesh).isInstancedMesh || (object as THREE.BatchedMesh).isBatchedMesh) throw new Error('The tracer requires ordinary expanded meshes, not instancing.')
          if (object instanceof THREE.Mesh) {
            triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3
            for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
          }
        })
        if (triangles > prepared.triangles || materials.size > 65534) throw new Error('Full-scene adapter understated its triangle/material count.')
      } catch (error) { prepared.dispose(); throw error }
      this.fullContent = prepared
      return prepared
    }).finally(() => { if (this.fullPreparation === promise) this.fullPreparation = undefined })
    this.fullPreparation = promise
    return promise
  }

  private createTraceScene(prepared: PreparedSceneContent) {
    const scene = new THREE.Scene()
    scene.background = this.scene.background
    scene.environment = this.scene.environment
    scene.environmentIntensity = this.scene.environmentIntensity
    scene.backgroundIntensity = this.scene.backgroundIntensity
    scene.add(prepared.root)
    const light = this.sunlight.clone()
    light.target = this.sunlightTarget.clone()
    scene.add(light, light.target)
    if (this.ground?.visible) {
      const source = this.ground as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
      const ground = new THREE.Mesh(source.geometry.clone(), source.material.clone())
      ground.material.envMap = null
      Object.assign(ground.material, { castShadow: this.settings.shadows })
      ground.position.copy(source.position); ground.quaternion.copy(source.quaternion); ground.scale.copy(source.scale)
      ground.receiveShadow = true
      scene.add(ground); this.traceGround = ground
    }
    this.traceScene = scene
    return scene
  }

  private suspendModelMeshes() {
    this.modelSuspended = true
    this.worker.terminate()
    this.workerReady = false
    this.inFlight = 0
    this.queued.clear(); this.queuedGrids.clear(); this.versions.clear()
    for (const id of [...this.chunkMeshes.keys()]) this.removeChunk(id)
    this.clearSelectionPreview()
    for (const waiter of this.meshWaiters.splice(0)) waiter.reject(new Error('Model meshing was suspended for scene mode.'))
    this.callbacks.onMeshStats(0, 0)
  }

  private resumeModelMeshes() {
    if (!this.modelSuspended) return
    this.modelSuspended = false
    this.meshFailed = false
    this.workerReady = false
    this.inFlight = 0
    this.worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })
    this.bindWorker()
    this.updateSelection([...this.selection.values()], this.floatingSelection, false, false)
    this.markDirty(this.document.chunks.keys())
  }

  frameSceneBounds(bounds: THREE.Box3) {
    if (bounds.isEmpty()) return
    this.cancelFocusAnimation()
    const center = bounds.getCenter(new THREE.Vector3())
    const size = Math.max(8, bounds.getSize(new THREE.Vector3()).length())
    const aspect = Math.max(0.1, this.host.clientWidth / Math.max(1, this.host.clientHeight))
    const fit = 1 / Math.min(1, aspect)
    const direction = this.camera.position.clone().sub(this.controls.target).normalize()
    if (!direction.lengthSq()) direction.set(1, 0.78, 1).normalize()
    this.setView({ position: center.clone().addScaledVector(direction, size * 2 * fit), target: center, orthographicSpan: size * 1.3 * fit, zoom: 1 })
  }

  getView(): CameraSnapshot {
    return {
      projection: this.camera instanceof THREE.PerspectiveCamera ? 'perspective' : 'orthographic',
      position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      target: { x: this.controls.target.x, y: this.controls.target.y, z: this.controls.target.z },
      up: { x: this.camera.up.x, y: this.camera.up.y, z: this.camera.up.z },
      zoom: this.camera instanceof THREE.OrthographicCamera ? this.camera.zoom : undefined,
      fov: this.camera instanceof THREE.PerspectiveCamera ? this.camera.fov : undefined,
      orthographicSpan: this.orthographicSpan,
      viewport: { width: this.renderer.domElement.width, height: this.renderer.domElement.height },
    }
  }

  setView(view: Pick<CameraSnapshot, 'position' | 'target'> & Partial<Pick<CameraSnapshot, 'up' | 'zoom' | 'fov' | 'orthographicSpan'>>) {
    this.cancelFocusAnimation()
    this.camera.position.set(view.position.x, view.position.y, view.position.z)
    this.controls.target.set(view.target.x, view.target.y, view.target.z)
    if (view.up) this.camera.up.set(view.up.x, view.up.y, view.up.z)
    if (view.orthographicSpan !== undefined) this.orthographicSpan = view.orthographicSpan
    if (this.camera instanceof THREE.OrthographicCamera && view.zoom !== undefined) this.camera.zoom = view.zoom
    if (this.camera instanceof THREE.PerspectiveCamera && view.fov !== undefined) this.camera.fov = view.fov
    this.resize()
    this.controls.update()
    this.render()
  }

  resize() {
    const width = Math.max(1, this.host.clientWidth)
    const height = Math.max(1, this.host.clientHeight)
    const aspect = width / height
    const pixelRatio = Math.min(devicePixelRatio, 2)
    const size = this.renderer.getSize(new THREE.Vector2())
    if (this.renderer.getPixelRatio() !== pixelRatio) this.renderer.setPixelRatio(pixelRatio)
    if (size.x !== width || size.y !== height) this.renderer.setSize(width, height, false)
    if (this.camera instanceof THREE.PerspectiveCamera) this.camera.aspect = aspect
    else {
      this.camera.left = -this.orthographicSpan * aspect / 2
      this.camera.right = this.orthographicSpan * aspect / 2
      this.camera.top = this.orthographicSpan / 2
      this.camera.bottom = -this.orthographicSpan / 2
    }
    this.camera.updateProjectionMatrix()
    this.renderer.getDrawingBufferSize(size)
    this.raster.setSize(size.x, size.y)
    if (this.sceneContent && (this.fullContent || this.fullPreparation) && this.fullViewportPixels !== size.x * size.y) this.invalidateSceneContent()
    this.cameraChanged()
  }

  private resetFps() {
    if (this.fpsIdleTimer) clearTimeout(this.fpsIdleTimer)
    this.fpsFrames = 0
    this.fpsStarted = performance.now()
    this.callbacks.onFps()
  }

  private recordFrame(frames = 1) {
    const now = performance.now()
    this.fpsFrames += frames
    const elapsed = now - this.fpsStarted
    if (elapsed < 500) return
    const fps = this.fpsFrames * 1000 / elapsed
    this.callbacks.onFps(fps >= 10 ? Math.round(fps) : Number(fps.toFixed(fps < 1 ? 2 : 1)))
    this.fpsFrames = 0
    this.fpsStarted = now
    if (this.pathTracingEnabled()) return
    if (this.fpsIdleTimer) clearTimeout(this.fpsIdleTimer)
    this.fpsIdleTimer = setTimeout(() => {
      this.fpsFrames = 0
      this.fpsStarted = performance.now()
      this.callbacks.onFps()
    }, 750)
  }

  private renderRaster(camera = this.camera, raster = this.raster) {
    if (this.contextLost) return
    raster.render(camera)
    this.rasterError = undefined
    if (raster === this.raster) {
      this.presentationDirty = false
      if (!this.pathTracingEnabled()) this.recordFrame()
    }
  }

  render() {
    if (this.contextLost || this.pathTracingEnabled() && this.pathTracingReady) return
    this.presentationDirty = true
    if (this.rasterFrame !== undefined) return
    this.rasterFrame = requestAnimationFrame(() => {
      this.rasterFrame = undefined
      if (this.pathTracingEnabled() && this.pathTracingReady) return
      try { this.renderRaster() }
      catch (error) {
        if (this.renderer.getContext().isContextLost()) return
        const message = error instanceof Error ? error.message : 'Realtime rendering failed.'
        if (message !== this.rasterError) this.callbacks.onError(message)
        this.rasterError = message
      }
    })
  }

  /** exact=true is a full-scene LOD-1 raster capture with all shadow contributors.
   * The bounded adapter rejects oversized/missing dependencies; no partial PNG is returned. */
  async capture(exact = false) {
    const content = this.sceneContent
    const viewBefore = exact ? JSON.stringify(this.getView()) : undefined
    const epoch = this.fullEpoch
    const prepared = exact && content ? await this.prepareSceneContent() : undefined
    if (!prepared) await (content ? content.whenReady() : this.whenMeshIdle())
    if (content !== this.sceneContent) throw new Error('Viewport changed during capture. Try again.')
    if (exact && (epoch !== this.fullEpoch || viewBefore !== JSON.stringify(this.getView()))) throw new Error('Scene or camera changed during exact capture. Try again.')
    if (this.contextLost || this.renderer.getContext().isContextLost()) throw new Error('Cannot capture while the graphics context is lost.')
    if (this.rasterFrame !== undefined) cancelAnimationFrame(this.rasterFrame)
    this.rasterFrame = undefined
    const overlays: THREE.Object3D[] = []
    if (content) {
      for (const object of [this.grid, this.limits]) if (object?.visible) overlays.push(object)
      content.root.traverse(object => { if (object.visible && object.userData.editorOverlay) overlays.push(object) })
    }
    const parent = prepared?.root.parent
    const contentVisible = content?.root.visible
    const environments = new Map<THREE.MeshStandardMaterial, THREE.Texture | null>()
    try {
      for (const object of overlays) object.visible = false
      if (prepared && content) {
        content.root.visible = false
        prepared.root.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material instanceof THREE.MeshStandardMaterial && !environments.has(material)) {
            environments.set(material, material.envMap)
            material.envMap = this.environmentTarget.texture; material.needsUpdate = true
          }
        })
        this.scene.add(prepared.root)
        this.renderer.shadowMap.needsUpdate = true
      }
      if (prepared || this.presentationDirty || !this.pathTracingEnabled() || !this.pathTracingReady) this.renderRaster()
    } finally {
      if (prepared && content) {
        this.scene.remove(prepared.root); parent?.add(prepared.root)
        content.root.visible = contentVisible!
        this.renderer.shadowMap.needsUpdate = true
        for (const [material, environment] of environments) { material.envMap = environment; material.needsUpdate = true }
      }
      for (const object of overlays) object.visible = true
      if (overlays.length) this.render()
    }
    const view = this.getView()
    const blob = await new Promise<Blob>((resolve, reject) => this.renderer.domElement.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not capture the viewport.')), 'image/png'))
    if (prepared && content === this.sceneContent && epoch === this.fullEpoch && this.pathTracingEnabled() && this.pathTracingReady && this.pathTracer) {
      // Restore the accumulated trace presentation after the exact raster snapshot,
      // without resetting samples or consuming an extra sample at the 128-sample cap.
      const paused = this.pathTracer.pausePathTracing
      try { this.pathTracer.pausePathTracing = true; this.pathTracer.renderSample(); this.presentationDirty = false }
      finally { this.pathTracer.pausePathTracing = paused }
    }
    return { blob, view }
  }

  async inspect(views: readonly InspectionView[] = defaultInspectionViews) {
    if (this.sceneContent) throw new Error('Model inspection is unavailable in scene mode. Use viewport capture for a raster scene PNG.')
    const faces = views.filter((name): name is FaceView => (faceViews as readonly string[]).includes(name))
    const isometric = views.filter(name => name.startsWith('iso-'))
    if (isometric.length) await this.whenMeshIdle()
    const images: { name: InspectionView; width: number; height: number; direction: string; pixelAxes?: string; canvas: OffscreenCanvas }[] = []
    for (const { rgba, ...face } of projectFaces(this.document, faces)) {
      const canvas = new OffscreenCanvas(face.width, face.height)
      canvas.getContext('2d')!.putImageData(new ImageData(rgba, face.width, face.height), 0, 0)
      images.push({ ...face, canvas })
    }
    if (isometric.length) {
      const bounds = this.document.bounds(true) ?? { min: { x: 0, y: 0, z: 0 }, max: this.document.dimensions }
      const offset = new THREE.Vector3(-this.document.dimensions.x / 2, 0, -this.document.dimensions.z / 2)
      const box = new THREE.Box3(new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z).add(offset), new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z).add(offset))
      const center = box.getCenter(new THREE.Vector3())
      const distance = box.getSize(new THREE.Vector3()).length() + 1
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, distance * 3)
      const raster = new RasterPipeline(this.renderer, this.scene, { ambientOcclusion: this.settings.ambientOcclusion })
      raster.setSize(512, 512)
      raster.renderToScreen = false
      const visibility = new Map<THREE.Object3D, boolean>()
      const target = this.renderer.getRenderTarget()
      const viewport = this.renderer.getViewport(new THREE.Vector4())
      const scissor = this.renderer.getScissor(new THREE.Vector4())
      const scissorTest = this.renderer.getScissorTest()
      try {
        // No await while scene visibility is overridden; the live camera and canvas are never changed.
        for (const object of [this.grid, this.limits, this.ground, this.hover, this.marqueePreview, this.selectionPreview, this.fillPreview, this.pushPullPreview]) {
          if (object) visibility.set(object, object.visible)
        }
        this.model.traverse(object => { if (object.userData.faceGrid || object.userData.meshVertices) visibility.set(object, object.visible) })
        for (const object of visibility.keys()) object.visible = false
        for (const name of isometric) {
          const x = name.endsWith('right') ? 1 : -1
          const z = name.includes('front') ? 1 : -1
          camera.position.copy(center).add(new THREE.Vector3(x, 1, z).normalize().multiplyScalar(distance))
          camera.lookAt(center)
          camera.updateMatrixWorld(true)
          let extent = 0
          for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
            const point = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse)
            extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y))
          }
          extent = Math.max(1, extent * 1.1)
          camera.left = camera.bottom = -extent
          camera.right = camera.top = extent
          camera.updateProjectionMatrix()
          this.renderRaster(camera, raster)
          const pixels = new Uint16Array(512 * 512 * 4)
          this.renderer.readRenderTargetPixels(raster.readBuffer, 0, 0, 512, 512, pixels)
          const rgba = new Uint8ClampedArray(pixels.length)
          for (let y = 0; y < 512; y++) for (let x = 0; x < 2048; x++) rgba[(511 - y) * 2048 + x] = Math.round(THREE.DataUtils.fromHalfFloat(pixels[y * 2048 + x]) * 255)
          const canvas = new OffscreenCanvas(512, 512)
          canvas.getContext('2d')!.putImageData(new ImageData(rgba, 512, 512), 0, 0)
          images.push({ name, width: 512, height: 512, direction: `camera side (${x},1,${z}), orthographic, +Y up, raster materials`, canvas })
        }
      } finally {
        for (const [object, visible] of visibility) object.visible = visible
        this.renderer.setRenderTarget(target)
        this.renderer.setViewport(viewport)
        this.renderer.setScissor(scissor)
        this.renderer.setScissorTest(scissorTest)
        raster.dispose()
      }
    }
    return Promise.all(views.map(async name => {
      const { canvas, ...metadata } = images.find(image => image.name === name)!
      return { ...metadata, blob: await canvas.convertToBlob({ type: 'image/png' }) }
    }))
  }
}
