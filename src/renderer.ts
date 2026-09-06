import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import { CHUNK_SIZE, chunkCoords, connectedBodyVoxels, connectedSurfaceVoxels, fillShapeVoxels, moveRange, occupiedVoxels, pushPullRange, surfaceVoxels, type FillShape, type PaletteMaterial, type Vec3, type VoxelDocument } from './editor'
import type { AuxiliaryTool, PaintMode, PbrMap, SculptMode, SelectionMode, SelectionState, Tool } from './studio'
import type { ViewSettings } from './storage'

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

export function shouldOrbitTouch(actionable: boolean, activeTouches: number) {
  return !actionable && activeTouches === 0
}

export function isTouchTap(startX: number, startY: number, endX: number, endY: number) {
  return Math.hypot(endX - startX, endY - startY) < 8
}

export function castsRealtimeShadow(material: Pick<PaletteMaterial, 'opacity' | 'transmission'>) {
  return material.opacity >= 1 && material.transmission === 0
}

export function realtimeEnvironmentIntensity(metalness: number) {
  return 0.2 + metalness * 0.5
}

interface MeshResult {
  id: number
  version: number
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  uvs: Float32Array
  indices: Uint16Array | Uint32Array
  faceLines: Float32Array
  groups: { start: number; count: number; materialIndex: number }[]
  quads: number
}

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

export function traceGridRay(document: VoxelDocument, origin: Vec3, direction: Vec3): ToolTarget | undefined {
  const bounds = rayBounds(origin, direction, document.dimensions)
  if (!bounds || bounds.exit < 0) return undefined
  const start = Math.max(0, bounds.enter) + 1e-7
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
  let normal = bounds.enter > 0 ? bounds.enterNormal : { x: 0, y: 0, z: 0 }

  while (document.contains(cell.x, cell.y, cell.z)) {
    const color = document.getVisibleVoxel(cell.x, cell.y, cell.z)
    if (color) return { cell: { ...cell }, normal, occupied: true, color }

    let axis: keyof Vec3 = 'x'
    if (next.y < next.x) axis = 'y'
    if (next.z < next[axis]) axis = 'z'
    if (next[axis] > bounds.exit) break
    cell[axis] += step[axis]
    normal = { x: 0, y: 0, z: 0 }
    normal[axis] = -step[axis]
    next[axis] += delta[axis]
  }
  if (bounds.exitNormal.y > 0) return undefined
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
  private renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  private scene = new THREE.Scene()
  private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera
  private controls: OrbitControls
  private composer: EffectComposer
  private renderPass: RenderPass
  private ambientOcclusionPass: GTAOPass
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private environmentMap: THREE.Texture
  private materials: THREE.MeshPhysicalMaterial[]
  private faceGridMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.46, depthWrite: false, toneMapped: false })
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
  private selectionPreview?: THREE.Mesh | THREE.InstancedMesh
  private marqueeDrag?: MarqueeDrag
  private pushPullDrag?: PushPullDrag
  private fillPreview?: THREE.InstancedMesh
  private pushPullPreview?: THREE.InstancedMesh
  private focusAnimation?: number
  private pathTracer?: WebGLPathTracer
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
    const room = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.environmentMap = pmrem.fromScene(room, 0.04, 0.1, 100, { size: 64 }).texture
    room.dispose()
    pmrem.dispose()
    this.materials = this.createMaterials()
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.composer = new EffectComposer(this.renderer)
    this.renderPass = new RenderPass(this.scene, this.camera)
    this.ambientOcclusionPass = this.createAmbientOcclusionPass()
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.ambientOcclusionPass)
    this.composer.addPass(new OutputPass())
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.tabIndex = 0
    this.renderer.domElement.setAttribute('aria-label', 'Voxel editing viewport. Arrow keys move the keyboard cursor, Page Up and Page Down change height, Space applies the active tool, and Shift Space reverses Push Pull or Move.')
    this.host.append(this.renderer.domElement)

    this.scene.add(this.model, this.hemisphere, this.sunlight, this.sunlightTarget, this.hover, this.marqueePreview)
    this.sunlight.castShadow = true
    this.sunlight.target = this.sunlightTarget
    this.sunlight.shadow.mapSize.set(2048, 2048)
    this.hover.visible = false
    this.marqueePreview.visible = false
    this.worker.onmessage = event => {
      const message = event.data as { type: 'ready' } | { type: 'meshed'; results: MeshResult[] }
      if (message.type === 'ready') {
        this.workerReady = true
        this.updateWorkerPalette()
        this.pump()
        return
      }
      this.receiveMeshes(message)
    }
    this.worker.onerror = () => {
      this.inFlight = 0
      this.queued.clear()
      this.meshFailed = true
      for (const waiter of this.meshWaiters.splice(0)) waiter.reject(new Error('The voxel surface worker stopped.'))
      this.callbacks.onMeshStats(0, 0)
      this.callbacks.onError('The voxel surface worker stopped. Reload to continue editing.')
    }
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.bindPointerEvents()
    this.rebuildStage()
    this.updatePalette()
    this.frameModel()
    this.resize()
  }

  private createCamera(projection: ViewSettings['projection']) {
    if (projection === 'perspective') return new THREE.PerspectiveCamera(34, 1, 0.1, 2000)
    return new THREE.OrthographicCamera(-20, 20, 20, -20, -1000, 2000)
  }

  private createAmbientOcclusionPass() {
    const pass = new GTAOPass(this.scene, this.camera, 1, 1)
    pass.updateGtaoMaterial({ radius: 0.8, thickness: 1.1, distanceFallOff: 1, samples: 16 })
    pass.blendIntensity = 0.65
    pass.enabled = this.settings.ambientOcclusion
    return pass
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
    controls.maxDistance = 1200
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
      if (event.pointerType !== 'touch') return
      const orbit = this.renderMode || shouldOrbitTouch(this.touchTargetActionable(this.targetAt(event)), this.touchPointers.size)
      this.controls.touches.ONE = orbit ? THREE.TOUCH.ROTATE : -1 as THREE.TOUCH
      this.orbitTouch = orbit ? { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY } : undefined
    }, { capture: true })
    canvas.addEventListener('contextmenu', event => event.preventDefault())
    canvas.addEventListener('pointerdown', event => {
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
      this.touchPointers.delete(event.pointerId)
      if (this.orbitTouch?.pointerId === event.pointerId) this.orbitTouch = undefined
      this.cancelPaint()
      this.cancelPushPull()
      this.cancelMarquee()
    })
    canvas.addEventListener('pointerleave', () => {
      this.hover.visible = false
      this.callbacks.onHover()
      this.render()
    })
    canvas.addEventListener('keydown', event => this.keyboard(event))
  }

  private keyboard(event: KeyboardEvent) {
    if (this.renderMode) return
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
    if (selected.length) {
      const material = new THREE.MeshBasicMaterial({ color: 0x2f66db, transparent: true, opacity: floating ? 0.4 : 0.3, depthTest: !floating, depthWrite: false })
      const preview = new THREE.InstancedMesh(new THREE.BoxGeometry(1.06, 1.06, 1.06), material, selected.length)
      preview.renderOrder = 3
      const matrix = new THREE.Matrix4()
      selected.forEach((cell, index) => {
        matrix.makeTranslation(cell.x - this.document.dimensions.x / 2 + 0.5, cell.y + 0.5, cell.z - this.document.dimensions.z / 2 + 0.5)
        preview.setMatrixAt(index, matrix)
      })
      preview.instanceMatrix.needsUpdate = true
      preview.computeBoundingSphere()
      preview.visible = !this.renderMode
      this.selectionPreview = preview
      this.scene.add(preview)
    }
    this.finishSelection({ cells: selected, count: selected.length, floating }, notify, focus)
  }

  private clearSelectionPreview() {
    if (this.selectionPreview) {
      this.scene.remove(this.selectionPreview)
      this.selectionPreview.geometry.dispose()
      ;(this.selectionPreview.material as THREE.Material).dispose()
    }
    this.selectionPreview = undefined
  }

  private finishSelection(selection: SelectionState, notify: boolean, focus: boolean) {
    if (focus) this.moveFocus(this.focusCenter())
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

    const layers = move ? 1 : Math.max(1, range.pull, range.push)
    this.pushPullPreview = this.createGhostPreview(cells.length * layers, 0x2864dc)
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
    this.updateGhostPreview(this.pushPullPreview, ghosts)
  }

  private createGhostPreview(capacity: number, color: number) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.24, depthTest: false, depthWrite: false })
    const preview = new THREE.InstancedMesh(new THREE.BoxGeometry(0.94, 0.94, 0.94), material, capacity)
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
    this.fillPreview.geometry.dispose()
    ;(this.fillPreview.material as THREE.Material).dispose()
    this.fillPreview = undefined
  }

  private cancelPushPull() {
    if (this.pushPullPreview) {
      this.scene.remove(this.pushPullPreview)
      this.pushPullPreview.geometry.dispose()
      ;(this.pushPullPreview.material as THREE.Material).dispose()
    }
    if (this.pushPullDrag) this.callbacks.onPushPullPreview()
    this.pushPullPreview = undefined
    this.pushPullDrag = undefined
    if (this.selectionPreview) this.selectionPreview.visible = !this.renderMode
    this.activePointer = undefined
    this.render()
  }

  private gridRay(event: MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
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
    return traceGridRay(this.document, ray.origin, ray.direction)
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
      this.hover.visible = false
      this.callbacks.onHover()
      this.render()
      return
    }
    this.showCell(cell)
    this.callbacks.onHover(cell)
  }

  private showCell(cell: Vec3) {
    this.hover.visible = !this.renderMode
    this.hover.position.set(cell.x - this.document.dimensions.x / 2 + 0.5, cell.y + 0.5, cell.z - this.document.dimensions.z / 2 + 0.5)
    const material = this.hover.material as THREE.MeshBasicMaterial
    material.color.setHex(this.tool === 'paint' ? this.document.palette[this.activeColor] || 0x2864dc
      : this.tool === 'sculpt' && this.sculptMode === 'erase' ? 0xd94a4a : 0x2864dc)
    this.render()
  }

  private receiveMeshes(message: { type: 'meshed'; results: MeshResult[] }) {
    if (message.type !== 'meshed') return
    this.inFlight = 0
    for (const result of message.results) {
      if (this.versions.get(result.id) !== result.version || !this.document.chunks.has(result.id)) continue
      this.removeChunk(result.id)
      if (!result.positions.length) continue
      const position = new THREE.BufferAttribute(result.positions, 3)
      const normal = new THREE.BufferAttribute(result.normals, 3)
      const color = new THREE.BufferAttribute(result.colors, 4)
      const uv = new THREE.BufferAttribute(result.uvs, 2)
      const chunkMesh = new THREE.Group()
      for (const group of result.groups) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', position)
        geometry.setAttribute('normal', normal)
        geometry.setAttribute('color', color)
        geometry.setAttribute('uv', uv)
        geometry.setIndex(new THREE.BufferAttribute(result.indices.slice(group.start, group.start + group.count), 1))
        geometry.computeBoundingSphere()
        const mesh = new THREE.Mesh(geometry, this.materials[group.materialIndex])
        mesh.castShadow = castsRealtimeShadow(this.document.materials[group.materialIndex])
        mesh.receiveShadow = true
        chunkMesh.add(mesh)
      }
      if (result.faceLines.length) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(result.faceLines, 3))
        geometry.computeBoundingSphere()
        const lines = new THREE.LineSegments(geometry, this.faceGridMaterial)
        lines.userData.faceGrid = true
        lines.visible = this.settings.faceGrid && !this.renderMode
        lines.renderOrder = 1
        chunkMesh.add(lines)
      }
      const chunk = chunkCoords(result.id)
      chunkMesh.position.set(chunk.x * CHUNK_SIZE - this.document.dimensions.x / 2, chunk.y * CHUNK_SIZE, chunk.z * CHUNK_SIZE - this.document.dimensions.z / 2)
      this.chunkMeshes.set(result.id, chunkMesh)
      this.chunkQuads.set(result.id, result.quads)
      this.model.add(chunkMesh)
    }
    this.reportMeshStats()
    this.render()
    this.pump()
    this.requestPathTraceRebuild()
  }

  private removeChunk(id: number) {
    const chunk = this.chunkMeshes.get(id)
    if (chunk) {
      chunk.traverse(child => { if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) child.geometry.dispose() })
      this.model.remove(chunk)
      this.chunkMeshes.delete(id)
    }
    this.chunkQuads.delete(id)
  }

  private reportMeshStats() {
    let quads = 0
    for (const count of this.chunkQuads.values()) quads += count
    const pending = this.queued.size + this.inFlight
    this.callbacks.onMeshStats(pending, quads)
    if (!pending) for (const waiter of this.meshWaiters.splice(0)) waiter.resolve()
  }

  private pump() {
    if (!this.workerReady) { this.reportMeshStats(); return }
    if (this.inFlight || !this.queued.size) { this.reportMeshStats(); return }
    const jobs: { id: number; version: number; voxels: ArrayBuffer }[] = []
    for (const id of this.queued) {
      this.queued.delete(id)
      if (!this.document.chunks.has(id)) { this.removeChunk(id); continue }
      const voxels = this.document.paddedChunk(id, true).buffer
      jobs.push({ id, version: this.versions.get(id)!, voxels })
      if (jobs.length === 24) break
    }
    if (!jobs.length) { this.reportMeshStats(); this.pump(); return }
    this.inFlight = jobs.length
    this.worker.postMessage({ type: 'mesh', jobs, faceGrid: this.settings.faceGrid }, jobs.map(job => job.voxels))
    this.reportMeshStats()
  }

  markDirty(ids: Iterable<number>) {
    for (const id of ids) {
      this.versions.set(id, ++this.nextVersion)
      this.queued.add(id)
      if (!this.document.chunks.has(id)) this.removeChunk(id)
    }
    this.pump()
    this.requestPathTraceRebuild()
    this.render()
  }

  whenMeshIdle() {
    if (this.meshFailed) return Promise.reject(new Error('The voxel surface worker stopped.'))
    if (!this.queued.size && !this.inFlight) return Promise.resolve()
    return new Promise<void>((resolve, reject) => this.meshWaiters.push({ resolve, reject }))
  }

  meshState() {
    return { pending: this.queued.size + this.inFlight, failed: this.meshFailed }
  }

  private createMaterials() {
    return this.document.materials.map(({ name, roughness, metalness, emissiveIntensity, opacity, transmission, ior }, index) => new THREE.MeshPhysicalMaterial({
      name,
      vertexColors: true,
      envMap: this.environmentMap,
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
    }))
  }

  private disposeMaterials() {
    for (const material of this.materials) {
      for (const map of ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) material[map]?.dispose()
      material.dispose()
    }
  }

  updatePalette() {
    this.materials.forEach((material, index) => material.emissive.setHex(this.document.palette[index]))
    this.updateWorkerPalette()
    this.markDirty(this.document.chunks.keys())
  }

  private updateWorkerPalette() {
    if (!this.workerReady) return
    const palette = this.document.palette.slice().buffer
    const transparent = Uint8Array.from(this.document.materials, material => Number(material.opacity < 1 || material.transmission > 0)).buffer
    this.worker.postMessage({ type: 'palette', palette, transparent }, [palette, transparent])
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
    if (wasTransparent !== (preset.opacity < 1 || preset.transmission > 0)) this.updatePalette()
    this.requestPathTraceRebuild()
    this.render()
  }

  setDocument(document: VoxelDocument, preserveMaterials = false) {
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    this.document = document
    this.applySelection({ cells: [], count: 0 }, false)
    this.queued.clear()
    this.versions.clear()
    for (const id of [...this.chunkMeshes.keys()]) this.removeChunk(id)
    if (!preserveMaterials) {
      this.disposeMaterials()
      this.materials = this.createMaterials()
    }
    this.keyboardCell = { x: 0, y: 0, z: 0 }
    this.rebuildStage()
    this.updatePalette()
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
    if (this.hover.visible) this.showCell(this.keyboardCell)
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
    this.requestPathTraceRebuild()
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
    this.requestPathTraceRebuild()
    this.render()
  }

  private pathTracingEnabled() {
    return this.renderMode && this.settings.pathTracing && !this.pathTracingFailed
  }

  private stopPathTracingSamples() {
    if (this.pathTracingFrame !== undefined) cancelAnimationFrame(this.pathTracingFrame)
    this.pathTracingFrame = undefined
  }

  private startPathTracingSamples() {
    if (!this.pathTracer || !this.pathTracingEnabled() || !this.pathTracingReady) return
    this.stopPathTracingSamples()
    this.pathTracer.reset()
    this.resetFps()
    let reportedSamples = -1
    const sample = () => {
      if (!this.pathTracer || !this.pathTracingEnabled() || !this.pathTracingReady) return
      const previousSamples = Math.floor(this.pathTracer.samples)
      this.pathTracer.renderSample()
      const samples = Math.floor(this.pathTracer.samples)
      if (samples > previousSamples) this.recordFrame(samples - previousSamples)
      if (samples !== reportedSamples) {
        reportedSamples = samples
        this.callbacks.onPathTracingStatus(`${samples} ${samples === 1 ? 'sample' : 'samples'}`)
      }
      if (samples < 128) this.pathTracingFrame = requestAnimationFrame(sample)
      else this.pathTracingFrame = undefined
    }
    this.pathTracingFrame = requestAnimationFrame(sample)
  }

  private async ensurePathTracer() {
    if (this.pathTracer) return this.pathTracer
    const [{ WebGLPathTracer }, { GenerateMeshBVHWorker }] = await Promise.all([
      import('three-gpu-pathtracer'),
      import('three-mesh-bvh/worker'),
    ])
    const tracer = new WebGLPathTracer(this.renderer)
    const worker = new GenerateMeshBVHWorker()
    tracer.setBVHWorker(worker)
    tracer.bounces = 4
    tracer.tiles.set(2, 2)
    tracer.renderScale = 0.75
    tracer.renderDelay = 0
    tracer.minSamples = 1
    tracer.fadeDuration = 180
    tracer.dynamicLowRes = true
    this.pathTracer = tracer
    return tracer
  }

  private requestPathTraceRebuild() {
    if (!this.pathTracingEnabled()) return
    this.pathTracingBuildRequested = true
    this.pathTracingReady = false
    this.stopPathTracingSamples()
    this.renderRaster()
    if (this.inFlight || this.queued.size) {
      this.callbacks.onPathTracingStatus('Updating mesh')
      return
    }
    void this.buildPathTrace()
  }

  private async buildPathTrace() {
    if (this.pathTracingBuildRunning) return
    this.pathTracingBuildRunning = true
    try {
      while (this.pathTracingEnabled() && this.pathTracingBuildRequested && !this.inFlight && !this.queued.size) {
        this.pathTracingBuildRequested = false
        const tracer = await this.ensurePathTracer()
        if (!this.pathTracingEnabled()) break
        let progressStep = -1
        this.callbacks.onPathTracingStatus('Preparing')
        await tracer.setSceneAsync(this.scene, this.camera, {
          onProgress: progress => {
            const step = Math.floor(progress * 10)
            if (step !== progressStep) {
              progressStep = step
              this.callbacks.onPathTracingStatus(`Preparing ${Math.round(progress * 100)}%`)
            }
          },
        })
        this.pathTracingReady = true
      }
    } catch {
      this.pathTracingFailed = true
      this.pathTracingReady = false
      this.callbacks.onPathTracingStatus('Raster fallback')
      this.callbacks.onError('Progressive PBR is unavailable on this device. Using the realtime renderer instead.')
      this.renderRaster()
    } finally {
      this.pathTracingBuildRunning = false
    }
    if (this.pathTracingEnabled() && this.pathTracingBuildRequested && !this.inFlight && !this.queued.size) void this.buildPathTrace()
    else if (this.pathTracingEnabled() && this.pathTracingReady) this.startPathTracingSamples()
  }

  private cameraChanged() {
    this.updateWorkspaceGridVisibility()
    this.renderRaster()
    if (!this.pathTracingEnabled()) return
    if (this.pathTracer && this.pathTracingReady && !this.pathTracingBuildRunning) {
      this.pathTracer.updateCamera()
      this.startPathTracingSamples()
    }
  }

  setRenderMode(enabled: boolean) {
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    this.renderMode = enabled
    this.hover.visible = false
    this.marqueePreview.visible = false
    if (this.selectionPreview) this.selectionPreview.visible = !enabled
    this.updateWorkspaceGridVisibility()
    if (this.limits) this.limits.visible = this.settings.grid && !enabled
    this.updateFaceGridVisibility()
    if (this.ground) this.ground.visible = enabled
    if (enabled && this.settings.pathTracing) {
      this.pathTracingFailed = false
      this.requestPathTraceRebuild()
    } else {
      this.resetFps()
      this.pathTracingReady = false
      this.stopPathTracingSamples()
      this.callbacks.onPathTracingStatus('Ready')
      this.renderRaster()
    }
  }

  setSettings(settings: ViewSettings) {
    const projectionChanged = settings.projection !== this.settings.projection
    const pathTracingChanged = settings.pathTracing !== this.settings.pathTracing
    const faceGridChanged = settings.faceGrid !== this.settings.faceGrid
    this.settings = { ...settings }
    const background = new THREE.Color(settings.background)
    this.scene.background = background
    const luminance = background.r * 0.2126 + background.g * 0.7152 + background.b * 0.0722
    this.faceGridMaterial.color.setHex(luminance > 0.35 ? 0x20262c : 0xf9faf8)
    this.hemisphere.intensity = settings.ambient
    this.sunlight.intensity = settings.light
    this.ambientOcclusionPass.enabled = settings.ambientOcclusion
    this.renderer.shadowMap.enabled = settings.shadows
    this.updateWorkspaceGridVisibility()
    if (this.limits) this.limits.visible = settings.grid && !this.renderMode
    this.updateFaceGridVisibility()
    if (this.ground) {
      this.ground.visible = this.renderMode
      ;(this.ground.material as THREE.MeshStandardMaterial).color.set(settings.background).offsetHSL(0, -0.04, -0.035)
    }
    const radius = Math.max(this.document.dimensions.x, this.document.dimensions.y, this.document.dimensions.z)
    const radians = THREE.MathUtils.degToRad(settings.lightAzimuth)
    this.sunlight.position.set(Math.cos(radians) * radius, radius * 1.7, Math.sin(radians) * radius)
    if (projectionChanged) this.switchProjection(settings.projection)
    if (faceGridChanged && settings.faceGrid) this.markDirty(this.document.chunks.keys())
    if (pathTracingChanged && settings.pathTracing) this.pathTracingFailed = false
    if (pathTracingChanged) this.resetFps()
    if (this.pathTracingEnabled()) this.requestPathTraceRebuild()
    else {
      this.pathTracingReady = false
      this.stopPathTracingSamples()
      this.callbacks.onPathTracingStatus('Ready')
      this.renderRaster()
    }
  }

  private updateFaceGridVisibility() {
    const visible = this.settings.faceGrid && !this.renderMode
    this.model.traverse(child => { if (child.userData.faceGrid) child.visible = visible })
  }

  private updateWorkspaceGridVisibility() {
    if (!this.grid) return
    this.grid.visible = this.settings.grid && !this.renderMode
    if (!this.grid.visible) return
    for (const child of this.grid.children) child.visible = workspaceGridPlaneVisible(this.document.dimensions, child.userData.normal as Vec3, this.camera.position)
  }

  private switchProjection(projection: ViewSettings['projection']) {
    this.cancelFocusAnimation()
    const position = this.camera.position.clone()
    this.controls.dispose()
    this.camera = this.createCamera(projection)
    this.renderPass.camera = this.camera
    this.composer.removePass(this.ambientOcclusionPass)
    this.ambientOcclusionPass.dispose()
    this.ambientOcclusionPass = this.createAmbientOcclusionPass()
    this.composer.insertPass(this.ambientOcclusionPass, 1)
    this.camera.position.copy(position)
    this.controls = this.createControls(this.camera)
    this.controls.target.copy(this.focusCenter())
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
    if (this.ground) { this.scene.remove(this.ground); this.ground.geometry.dispose() }
    const size = Math.max(32, this.document.dimensions.x, this.document.dimensions.z)
    this.grid = new THREE.Group()
    const gridNormals: Vec3[] = [
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ]
    for (const normal of gridNormals) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(workspaceGridPositions(this.document.dimensions, normal), 3))
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xb8c3ca, transparent: true, opacity: 0.58 }))
      lines.position.set(-normal.x * 0.002, -normal.y * 0.002, -normal.z * 0.002)
      lines.userData.normal = normal
      this.grid.add(lines)
    }
    const bounds = new THREE.Box3(
      new THREE.Vector3(-this.document.dimensions.x / 2, 0, -this.document.dimensions.z / 2),
      new THREE.Vector3(this.document.dimensions.x / 2, this.document.dimensions.y, this.document.dimensions.z / 2),
    )
    this.limits = new THREE.Box3Helper(bounds, 0x7b8993)
    const limitsMaterial = this.limits.material as THREE.LineBasicMaterial
    limitsMaterial.transparent = true
    limitsMaterial.opacity = 0.68
    limitsMaterial.depthWrite = false
    this.limits.visible = this.settings.grid && !this.renderMode
    this.scene.add(this.grid, this.limits)
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 2, size * 2),
      new THREE.MeshStandardMaterial({ color: this.settings.background, roughness: 1 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.y = -0.01
    this.ground.receiveShadow = true
    this.ground.visible = this.renderMode
    this.scene.add(this.ground)
    const shadowSize = Math.max(this.document.dimensions.x, this.document.dimensions.z) * 0.85
    const shadowCamera = this.sunlight.shadow.camera as THREE.OrthographicCamera
    shadowCamera.left = -shadowSize; shadowCamera.right = shadowSize; shadowCamera.top = shadowSize; shadowCamera.bottom = -shadowSize
    shadowCamera.near = 0.1; shadowCamera.far = Math.max(600, this.document.dimensions.y * 5)
    shadowCamera.updateProjectionMatrix()
    this.sunlightTarget.position.set(0, this.document.dimensions.y / 3, 0)
    this.setSettings(this.settings)
  }

  frameModel() {
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
    this.renderer.setSize(width, height, false)
    if (this.camera instanceof THREE.PerspectiveCamera) this.camera.aspect = aspect
    else {
      this.camera.left = -this.orthographicSpan * aspect / 2
      this.camera.right = this.orthographicSpan * aspect / 2
      this.camera.top = this.orthographicSpan / 2
      this.camera.bottom = -this.orthographicSpan / 2
    }
    this.camera.updateProjectionMatrix()
    this.composer.setSize(width, height)
    const aoScale = this.renderer.getPixelRatio() * 0.5
    this.ambientOcclusionPass.setSize(Math.max(1, Math.round(width * aoScale)), Math.max(1, Math.round(height * aoScale)))
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

  private renderRaster() {
    this.composer.render()
    this.recordFrame()
  }

  render() {
    if (!this.pathTracingEnabled() || !this.pathTracingReady) this.renderRaster()
  }

  async capture() {
    await this.whenMeshIdle()
    this.render()
    const view = this.getView()
    const blob = await new Promise<Blob>((resolve, reject) => this.renderer.domElement.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not capture the viewport.')), 'image/png'))
    return { blob, view }
  }
}
