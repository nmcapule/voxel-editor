import * as THREE from 'three'
import { Viewport } from '../../shared/rendering/viewport'
import { castsRealtimeShadow } from '../../shared/rendering/stage'
import type { CameraSnapshot, SceneContent } from '../../shared/rendering/contracts'
import type { MeshData } from '../../shared/voxel/mesher'
import { CHUNK_SIZE, chunkCoords, connectedBodyVoxels, connectedSurfaceVoxels, fillShapeVoxels, moveRange, occupiedVoxels, pushPullFaces, pushPullRange, surfaceVoxels, type FillShape, type Vec3, type VoxelDocument } from '../../shared/voxel/document'
import type { AuxiliaryTool, PaintMode, PbrMap, SculptMode, SelectionMode, SelectionState, Tool } from './studio'
import type { ViewSettings } from '../../shared/rendering/settings'
import { faceViews, projectFaces, type FaceView } from '../../shared/voxel/projections'
import { defaultInspectionViews, type InspectionView } from './inspection'


export interface ToolTarget {
  cell: Vec3
  normal: Vec3
  occupied: boolean
  color: number
}

export function shouldOrbitTouch(actionable: boolean, activeTouches: number) {
  return !actionable && activeTouches === 0
}

export function isTouchTap(startX: number, startY: number, endX: number, endY: number) {
  return Math.hypot(endX - startX, endY - startY) < 8
}

interface MeshResult extends MeshData {
  id: number
  version: number
  layerId?: number
  active?: MeshData
  context?: MeshData
}

interface GridResult { id: number; version: number; faceLines: Float32Array; activeFaceLines?: Float32Array }

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

export function traceGridRay(document: VoxelDocument, origin: Vec3, direction: Vec3, maxDistance = Infinity, layerId?: number): ToolTarget | undefined {
  const voxel = layerId === undefined ? (x: number, y: number, z: number) => document.getVisibleVoxel(x, y, z)
    : (x: number, y: number, z: number) => document.getLayer(layerId)?.visible ? document.getLayerVoxel(x, y, z, layerId) : 0
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
  let previous = bounds.enter < 0 ? voxel(cell.x, cell.y, cell.z) : 0

  while (document.contains(cell.x, cell.y, cell.z)) {
    const color = voxel(cell.x, cell.y, cell.z)
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
  if (!move && !distance) return pushPullFaces(cells, normal)
  if (move) return cells.map(cell => ({
    x: cell.x + normal.x * distance,
    y: cell.y + normal.y * distance,
    z: cell.z + normal.z * distance,
  }))
  const selected = new Set(cells.map(cell => `${cell.x},${cell.y},${cell.z}`))
  const ghosts = new Map<string, Vec3>()
  for (const cell of pushPullFaces(cells, normal)) {
    for (let step = 0; step < Math.abs(distance); step++) {
      const offset = distance > 0 ? step + 1 : -step
      const ghost = { x: cell.x + normal.x * offset, y: cell.y + normal.y * offset, z: cell.z + normal.z * offset }
      const key = `${ghost.x},${ghost.y},${ghost.z}`
      if (distance < 0 || !selected.has(key)) ghosts.set(key, ghost)
    }
  }
  return [...ghosts.values()]
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
  readonly viewport: Viewport
  private ownsViewport: boolean
  private root = new THREE.Group()
  private content: SceneContent
  private listeners = new AbortController()
  private disposed = false
  private textureLoads = new Map<string, symbol>()

  constructor(host: HTMLElement | Viewport, document: VoxelDocument, settings: ViewSettings, callbacks: RendererCallbacks) {
    this.ownsViewport = !(host instanceof Viewport)
    this.viewport = host instanceof Viewport ? host : new Viewport(host, settings, callbacks)
    this.document = document
    this.settings = { ...settings }
    this.callbacks = callbacks
    this.materials = this.createMaterials()
    this.root.add(this.model, this.hover, this.marqueePreview)
    this.hover.visible = this.marqueePreview.visible = false
    this.hover.userData.editorOverlay = this.marqueePreview.userData.editorOverlay = true
    this.model.matrixAutoUpdate = false
    this.content = {
      root: this.root, bounds: new THREE.Box3(), stage: 'bounded',
      label: 'Voxel editing viewport. Arrow keys move the keyboard cursor, Page Up and Page Down change height, Space applies the active tool, and Shift Space reverses Push Pull or Move.',
      whenReady: () => this.whenMeshIdle(),
      isReady: () => !this.inFlight && !this.queued.size,
      focusTarget: () => this.focusCenter(),
      onViewportChange: () => this.syncViewport(),
    }
    this.updateBounds()
    this.setActive(true)
  }

  /** Borrowed viewports outlive the model adapter. Only active models own input hooks/jobs. */
  setActive(active: boolean) {
    if (this.disposed || active === !this.modelSuspended) return
    if (!active) {
      this.modelView = this.viewport.getView()
      this.modelSettings = { ...this.settings }
      this.modelRenderMode = this.viewport.renderMode
      this.listeners.abort()
      const canvas = this.viewport.renderer.domElement
      for (const id of new Set([this.activePointer, this.paintPointer, ...this.touchPointers])) if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id)
      if (this.viewport.content === this.content) this.viewport.setSceneContent(undefined)
      this.cancelPaint(); this.cancelPushPull(); this.cancelMarquee()
      this.hover.visible = false
      this.touchPointers.clear(); this.orbitTouch = undefined
      this.suspendModelMeshes()
    } else {
      if (this.viewport.content) throw new Error('Deactivate the current viewport adapter before activating the model')
      const renderMode = this.modelRenderMode ?? false
      this.viewport.setRenderMode(false)
      this.viewport.setSettings(this.modelSettings ?? this.settings)
      this.resumeModelMeshes()
      this.viewport.setSceneContent(this.content)
      this.listeners = new AbortController()
      this.bindPointerEvents()
      if (this.modelView) this.viewport.setView(this.modelView)
      else this.frameModel()
      this.viewport.setRenderMode(renderMode)
    }
  }

  private updateBounds() {
    const { x, y, z } = this.document.dimensions
    this.content.bounds.set(new THREE.Vector3(-x / 2, 0, -z / 2), new THREE.Vector3(x / 2, y, z / 2))
    if (!this.modelSuspended) this.viewport.setSceneContent(this.content)
  }

  private syncViewport() {
    const previous = this.settings
    this.settings = { ...this.viewport.settings }
    const background = new THREE.Color(this.settings.background)
    const luminance = background.r * 0.2126 + background.g * 0.7152 + background.b * 0.0722
    this.faceGridMaterial.color.setHex(luminance > 0.35 ? 0x20262c : 0xf9faf8)
    this.meshVerticesMaterial.color.copy(this.faceGridMaterial.color)
    this.meshTrianglesMaterial.color.copy(this.faceGridMaterial.color)
    for (const material of this.materials) {
      Object.assign(material, { castShadow: this.settings.shadows })
      this.viewport.applyEnvironment(material)
    }
    if (this.modelRenderMode !== this.viewport.renderMode) {
      this.modelRenderMode = this.viewport.renderMode
      this.cancelPaint(); this.cancelPushPull(); this.cancelMarquee()
      this.hover.visible = false
      if (this.selectionPreview) this.selectionPreview.visible = !this.viewport.renderMode
    }
    this.refreshLayerScope()
    if (this.settings.faceGrid && !previous.faceGrid) {
      for (const [id, chunk] of this.chunkMeshes) if (!chunk.userData.faceGridReady && !this.queued.has(id)) this.queuedGrids.add(id)
      this.pump()
    }
  }

  getView() { return this.viewport.getView() }
  setView(view: Parameters<Viewport['setView']>[0]) { this.viewport.setView(view) }
  getSceneViewport() { return this.viewport.getSceneViewport() }
  setSettings(settings: ViewSettings) {
    if (this.modelSuspended) { this.settings = { ...settings }; this.modelSettings = { ...settings } }
    else this.viewport.setSettings(settings)
  }
  setRenderMode(enabled: boolean) { this.viewport.setRenderMode(enabled) }
  focusViewport() { this.viewport.focusViewport() }
  resize() { this.viewport.resize() }
  render() { this.viewport.render() }
  capture(exact = false) { return this.viewport.capture(exact) }
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()

  private materials: THREE.MeshPhysicalMaterial[]
  private contextMaterial = new THREE.MeshBasicMaterial({ color: 0x87949d, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false })
  private faceGridMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.46, depthWrite: false, toneMapped: false })

  private meshVerticesMaterial = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, depthWrite: false, toneMapped: false })
  private meshTrianglesMaterial = new THREE.LineBasicMaterial({ depthWrite: false, toneMapped: false })

  private model = new THREE.Group()
  private chunkMeshes = new Map<number, THREE.Group>()

  private chunkQuads = new Map<number, number>()
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

  private worker!: Worker
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

  private keyboardCell: Vec3 = { x: 0, y: 0, z: 0 }
  private callbacks: RendererCallbacks

  private modelSuspended = true
  private modelView?: CameraSnapshot

  private modelSettings?: ViewSettings
  private modelRenderMode?: boolean
  private layerState = ''
  private meshLayerId?: number

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
        this.viewport.contentBecameReady()
        this.viewport.render()
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

  private bindPointerEvents() {
    const canvas = this.viewport.renderer.domElement
    const options = { signal: this.listeners.signal }
    canvas.addEventListener('pointerdown', event => {
      if (this.modelSuspended) return
      if (event.pointerType !== 'touch') return
      const orbit = this.viewport.renderMode || shouldOrbitTouch(this.touchTargetActionable(this.targetAt(event)), this.touchPointers.size)
      this.viewport.controls.touches.ONE = orbit ? THREE.TOUCH.ROTATE : -1 as THREE.TOUCH
      this.orbitTouch = orbit ? { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY } : undefined
    }, { ...options, capture: true })
    canvas.addEventListener('pointerdown', event => {
      if (this.modelSuspended) return
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
      if (this.viewport.renderMode) return
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
    }, options)
    canvas.addEventListener('pointermove', event => {
      if (this.modelSuspended) return
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
    }, options)
    canvas.addEventListener('pointerup', event => {
      if (this.modelSuspended) return
      const deselect = !this.viewport.renderMode && event.pointerType === 'touch' && this.orbitTouch?.pointerId === event.pointerId
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
    }, options)
    canvas.addEventListener('pointercancel', event => {
      if (this.modelSuspended) return
      this.touchPointers.delete(event.pointerId)
      if (this.orbitTouch?.pointerId === event.pointerId) this.orbitTouch = undefined
      this.cancelPaint()
      this.cancelPushPull()
      this.cancelMarquee()
    }, options)
    canvas.addEventListener('pointerleave', () => {
      if (this.modelSuspended) return
      this.hover.visible = false
      this.callbacks.onHover()
      this.viewport.render()
    }, options)
    canvas.addEventListener('keydown', event => this.keyboard(event), options)
  }

  private keyboard(event: KeyboardEvent) {
    if (this.modelSuspended || this.viewport.renderMode) return
    const movement: Partial<Vec3> = {}
    if (event.key === 'ArrowLeft') movement.x = -1
    else if (event.key === 'ArrowRight') movement.x = 1
    else if (event.key === 'ArrowUp') movement.z = -1
    else if (event.key === 'ArrowDown') movement.z = 1
    else if (event.key === 'PageUp') movement.y = 1
    else if (event.key === 'PageDown') movement.y = -1
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      const { x, y, z } = this.keyboardCell
      const color = this.isolatedLayerId() === undefined ? this.document.getVisibleVoxel(x, y, z)
        : this.document.activeLayer.visible ? this.document.getLayerVoxel(x, y, z) : 0
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
    this.viewport.renderer.domElement.setPointerCapture(event.pointerId)
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
      this.viewport.render()
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
    this.marqueePreview.visible = !this.viewport.renderMode
    this.marqueePreview.position.set(center.x, center.y, center.z)
    ;(this.marqueePreview.material as THREE.MeshBasicMaterial).color.setHex(this.marqueeDrag.action === 'paint' || fill
      ? this.document.palette[this.activeColor] ?? 0x2864dc
      : this.marqueeDrag.action === 'erase' ? 0xd94a4a : 0x2f66db)
    this.viewport.render()
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
    this.viewport.render()
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
      : this.selectionMode === 'surface' ? connectedSurfaceVoxels(this.document, target.cell, target.normal, undefined, this.document.activeLayerId)
      : this.selectionMode === 'texture' ? connectedBodyVoxels(this.document, target.cell, target.color, this.document.activeLayerId)
      : connectedBodyVoxels(this.document, target.cell, undefined, this.document.activeLayerId)
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
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    if (selection.cells[0] && selection.floating) this.keyboardCell = { ...selection.cells[0] }
    this.updateSelection(selection.cells, selection.floating === true, false, focus)
  }

  private updateSelection(cells: Vec3[], floating: boolean, notify: boolean, focus: boolean) {
    this.selection.clear()
    this.floatingSelection = floating
    for (const cell of cells) if (this.document.contains(cell.x, cell.y, cell.z) && (floating
      || this.document.activeLayer.visible && this.document.getLayerVoxel(cell.x, cell.y, cell.z))) this.selection.set(this.selectionKey(cell), { ...cell })
    this.clearSelectionPreview()
    const selected = [...this.selection.values()]
    if (selected.length && !this.modelSuspended) {
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
      preview.visible = !this.viewport.renderMode && !this.modelSuspended
      this.selectionPreview = preview
      this.root.add(preview)
    }
    this.finishSelection({ cells: selected, count: selected.length, floating }, notify, focus)
  }

  private clearSelectionPreview() {
    if (this.selectionPreview) {
      this.root.remove(this.selectionPreview)
      this.selectionPreview.dispose()
      this.selectionPreview.geometry.dispose()
      ;(this.selectionPreview.material as THREE.Material).dispose()
    }
    this.selectionPreview = undefined
  }

  private finishSelection(selection: SelectionState, notify: boolean, focus: boolean) {
    if (focus && !this.modelSuspended) this.viewport.moveFocus(this.focusCenter())
    if (notify) this.callbacks.onSelectionChange(selection)
    this.viewport.render()
  }

  private selectionContains(cell: Vec3) {
    return this.selection.has(this.selectionKey(cell))
  }

  private activeTarget(target: ToolTarget) {
    return this.floatingSelection && this.selectionContains(target.cell)
      || this.document.activeLayer.visible && Boolean(this.document.getLayerVoxel(target.cell.x, target.cell.y, target.cell.z))
  }

  private isolatedLayerId() {
    return !this.modelSuspended && !this.viewport.renderMode && !this.auxiliary
      && (this.tool === 'select' || this.tool === 'sculpt' || this.tool === 'paint' && this.paintMode === 'paint')
      ? this.document.activeLayerId : undefined
  }

  refreshLayerScope() {
    if (this.modelSuspended) return
    const layer = this.document.activeLayer
    const state = `${layer.id}:${layer.visible}:${layer.locked}`
    if (state !== this.layerState) {
      this.layerState = state
      this.cancelPaint(); this.cancelPushPull(); this.cancelMarquee()
      this.hover.visible = false
    }
    const isolated = this.isolatedLayerId()
    // Retain the composited surface for normal viewing and clean inspection.
    // Only build extra geometry while editing alongside other visible layers.
    const meshLayerId = isolated !== undefined && this.document.layers.some(other => other.visible && other.id !== isolated)
      ? isolated : undefined
    const changed = meshLayerId !== this.meshLayerId
    this.meshLayerId = meshLayerId
    if (changed) {
      this.viewport.renderer.shadowMap.needsUpdate = true
      this.markDirty(this.document.chunks.keys())
    }
    this.updateMeshOverlayVisibility()
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

  private startPushPull(event: PointerEvent, target: ToolTarget) {
    const { cells, move, range } = this.pushPullOperation(target)
    if (!cells.length) return false
    const rect = this.viewport.renderer.domElement.getBoundingClientRect()
    const center = new THREE.Vector3(
      target.cell.x - this.document.dimensions.x / 2 + 0.5,
      target.cell.y + 0.5,
      target.cell.z - this.document.dimensions.z / 2 + 0.5,
    )
    const tip = center.clone().add(new THREE.Vector3(target.normal.x, target.normal.y, target.normal.z))
    center.project(this.viewport.camera)
    tip.project(this.viewport.camera)
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

    this.pushPullPreview = this.createGhostPreview(move ? cells.length : pushPullFaces(cells, target.normal).length, 0x2864dc)
    this.updatePushPullPreview()
    if (this.selectionPreview) this.selectionPreview.visible = false
    this.root.add(this.pushPullPreview)
    this.callbacks.onPushPullPreview(cells.length, 0, move)
    this.viewport.render()
    return true
  }

  private pushPullCells(target: ToolTarget) {
    if (!target.occupied || !this.selectionContains(target.cell)) return []
    return [...this.selection.values()]
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
    this.viewport.render()
  }

  private updatePushPullPreview() {
    if (!this.pushPullDrag || !this.pushPullPreview) return
    const ghosts = pushPullGhostVoxels(this.pushPullDrag.cells, this.pushPullDrag.normal, this.pushPullDrag.distance, this.pushPullDrag.move)
    if (this.pushPullPreview.instanceMatrix.count < ghosts.length) {
      const old = this.pushPullPreview
      this.pushPullPreview = this.createGhostPreview(Math.max(ghosts.length, old.instanceMatrix.count * 2), (old.material as THREE.MeshBasicMaterial).color.getHex())
      this.root.remove(old)
      old.dispose()
      old.geometry.dispose()
      ;(old.material as THREE.Material).dispose()
      this.root.add(this.pushPullPreview)
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
      this.root.add(this.fillPreview)
    }
    ;(this.fillPreview.material as THREE.MeshBasicMaterial).color.setHex(this.document.palette[this.activeColor] ?? 0x2864dc)
    this.fillPreview.visible = !this.viewport.renderMode
    this.updateGhostPreview(this.fillPreview, cells)
  }

  private clearFillPreview() {
    if (!this.fillPreview) return
    this.root.remove(this.fillPreview)
    this.fillPreview.dispose()
    this.fillPreview.geometry.dispose()
    ;(this.fillPreview.material as THREE.Material).dispose()
    this.fillPreview = undefined
  }

  private cancelPushPull() {
    if (this.pushPullPreview) {
      this.root.remove(this.pushPullPreview)
      this.pushPullPreview.dispose()
      this.pushPullPreview.geometry.dispose()
      ;(this.pushPullPreview.material as THREE.Material).dispose()
    }
    if (this.pushPullDrag) this.callbacks.onPushPullPreview()
    this.pushPullPreview = undefined
    this.pushPullDrag = undefined
    if (this.selectionPreview) this.selectionPreview.visible = !this.viewport.renderMode && !this.modelSuspended
    this.activePointer = undefined
    this.viewport.render()
  }

  private gridRay(event: MouseEvent) {
    const rect = this.viewport.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.viewport.camera)
    // Match the rendered clip volume, including negative orthographic near planes.
    this.raycaster.ray.origin.set(this.pointer.x, this.pointer.y, -1).unproject(this.viewport.camera)
    this.raycaster.near = 0
    this.raycaster.far = new THREE.Vector3(this.pointer.x, this.pointer.y, 1).unproject(this.viewport.camera).distanceTo(this.raycaster.ray.origin)
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
    return traceGridRay(this.document, ray.origin, ray.direction, this.raycaster.far, this.isolatedLayerId())
  }

  private planeTargetAt(event: PointerEvent, cell: Vec3, normal: Vec3): ToolTarget | undefined {
    const ray = this.gridRay(event)
    const projected = tracePlaneRay(this.document, ray.origin, ray.direction, cell, normal, this.viewport.camera instanceof THREE.OrthographicCamera)
    return projected ? { cell: projected, normal: { ...normal }, occupied: false, color: 0 } : undefined
  }

  private showHover(target?: ToolTarget) {
    const cell = this.tool === 'paint' && this.paintMode === 'fill' && !this.auxiliary ? this.fillStartCell(target)
      : target?.occupied ? target.cell : undefined
    if (!cell || this.viewport.renderMode) {
      if (!this.hover.visible) return
      this.hover.visible = false
      this.callbacks.onHover()
      this.viewport.render()
      return
    }
    if (this.showCell(cell)) this.callbacks.onHover(cell)
  }

  private showCell(cell: Vec3) {
    const material = this.hover.material as THREE.MeshBasicMaterial
    const color = this.tool === 'paint' ? this.document.palette[this.activeColor] ?? 0x2864dc
      : this.tool === 'sculpt' && this.sculptMode === 'erase' ? 0xd94a4a : 0x2864dc
    const x = cell.x - this.document.dimensions.x / 2 + 0.5, y = cell.y + 0.5, z = cell.z - this.document.dimensions.z / 2 + 0.5
    if (this.hover.visible === !this.viewport.renderMode && this.hover.position.x === x && this.hover.position.y === y && this.hover.position.z === z && material.color.getHex() === color) return false
    this.hover.visible = !this.viewport.renderMode
    this.hover.position.set(x, y, z)
    material.color.setHex(color)
    this.viewport.render()
    return true
  }

  private receiveMeshes(message: { type: 'meshed'; results: MeshResult[] }) {
    if (message.type !== 'meshed') return
    if (this.modelSuspended) return
    this.inFlight = 0
    for (const result of message.results) {
      if (this.versions.get(result.id) !== result.version || !this.document.chunks.has(result.id)) continue
      this.removeChunk(result.id)
      if (!result.positions.length && !result.active?.positions.length && !result.context?.positions.length) continue
      const chunkMesh = this.createSurface(result)
      if (result.active) {
        const isolated = this.createSurface(result.active)
        isolated.userData.layerIsolation = true
        isolated.userData.layerId = result.layerId
        if (result.context?.positions.length) {
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.BufferAttribute(result.context.positions, 3))
          geometry.setIndex(new THREE.BufferAttribute(result.context.indices, 1))
          geometry.computeBoundingSphere()
          const context = new THREE.Mesh(geometry, this.contextMaterial)
          context.userData.editorOverlay = true
          context.userData.layerContext = true
          isolated.add(context)
        }
        chunkMesh.add(isolated)
      }
      const chunk = chunkCoords(result.id)
      chunkMesh.position.set(chunk.x * CHUNK_SIZE - this.document.dimensions.x / 2, chunk.y * CHUNK_SIZE, chunk.z * CHUNK_SIZE - this.document.dimensions.z / 2)
      chunkMesh.updateMatrix()
      chunkMesh.matrixAutoUpdate = false
      this.chunkMeshes.set(result.id, chunkMesh)
      this.chunkQuads.set(result.id, result.quads + (result.active?.quads ?? 0) + (result.context?.quads ?? 0))
      this.model.add(chunkMesh)
      chunkMesh.updateWorldMatrix(true, true)
      if (result.faceLines.length || result.active?.faceLines.length) this.receiveGrid({ ...result, activeFaceLines: result.active?.faceLines })
      else if (this.settings.faceGrid) this.queuedGrids.add(result.id)
      this.updateMeshOverlayVisibility([chunkMesh])
    }
    this.viewport.renderer.shadowMap.needsUpdate = true
    this.pump()
    this.viewport.requestPathTraceRebuild()
    this.viewport.render()
  }

  private createSurface(data: MeshData) {
    const surface = new THREE.Group()
    // Draw the post-merge positions once each, without the surface's triangle indices.
    const verticesGeometry = new THREE.BufferGeometry()
    verticesGeometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    const vertices = new THREE.Points(verticesGeometry, this.meshVerticesMaterial)
    vertices.userData.meshVertices = true
    vertices.userData.editorOverlay = true
    vertices.renderOrder = 2
    surface.add(vertices)
    for (const group of data.groups) {
      const geometry = new THREE.BufferGeometry()
      const start = group.vertexStart, end = start + group.vertexCount
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.subarray(start * 3, end * 3), 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals.subarray(start * 3, end * 3), 3))
      geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs.subarray(start * 2, end * 2), 2))
      const indices = data.indices.subarray(group.start, group.start + group.count)
      for (let index = 0; index < indices.length; index++) indices[index] -= start
      geometry.setIndex(new THREE.BufferAttribute(indices, 1))
      const bounds = new THREE.Box3(new THREE.Vector3(...group.bounds.slice(0, 3)), new THREE.Vector3(...group.bounds.slice(3)))
      geometry.boundingBox = bounds
      geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere())
      const mesh = new THREE.Mesh(geometry, this.materials[group.materialIndex])
      mesh.matrixAutoUpdate = false
      mesh.castShadow = castsRealtimeShadow(this.document.materials[group.materialIndex])
      mesh.receiveShadow = true
      surface.add(mesh)
    }
    return surface
  }

  private receiveGrid(result: GridResult) {
    const chunk = this.chunkMeshes.get(result.id)
    if (!chunk) return
    this.installFaceGrid(chunk, result.faceLines)
    const isolated = chunk.children.find(child => child.userData.layerIsolation)
    if (isolated && result.activeFaceLines) this.installFaceGrid(isolated, result.activeFaceLines)
    this.updateMeshOverlayVisibility([chunk])
  }

  private installFaceGrid(chunk: THREE.Object3D, faceLines: Float32Array) {
    for (const child of [...chunk.children]) if (child.userData.faceGrid) {
      (child as THREE.LineSegments).geometry.dispose()
      chunk.remove(child)
    }
    chunk.userData.faceGridReady = true
    if (!faceLines.length) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(faceLines, 3))
    geometry.computeBoundingSphere()
    const lines = new THREE.LineSegments(geometry, this.faceGridMaterial)
    lines.userData.faceGrid = true
    lines.visible = this.settings.faceGrid && !this.viewport.renderMode
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
      this.viewport.renderer.shadowMap.needsUpdate = true
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
    if (this.modelSuspended) return
    if (!this.workerReady || this.meshFailed || this.inFlight) { this.reportMeshStats(); return }
    while (this.queued.size || this.queuedGrids.size) {
      const grid = !this.queued.size
      const queue = grid ? this.queuedGrids : this.queued
      const id = queue.values().next().value!
      queue.delete(id)
      if (!this.document.chunks.has(id)) { this.removeChunk(id); continue }
      if (grid && this.chunkMeshes.get(id)?.userData.faceGridReady) continue
      const voxels = this.document.paddedChunk(id, true).buffer
      const layerId = this.meshLayerId
      const active = layerId === undefined ? undefined : this.document.paddedChunk(id, true, [layerId]).buffer
      const context = layerId === undefined || grid ? undefined
        : this.document.paddedChunk(id, true, this.document.layers.filter(layer => layer.id !== layerId).map(layer => layer.id)).buffer
      const buffers = [voxels, ...(active ? [active] : []), ...(context ? [context] : [])]
      this.inFlight = 1
      this.worker.postMessage({ type: grid ? 'grid' : 'mesh', jobs: [{ id, version: this.versions.get(id)!, voxels, layerId, active, context }], faceGrid: this.settings.faceGrid }, buffers)
      break
    }
    this.reportMeshStats()
    this.viewport.contentBecameReady()
  }

  markDirty(ids: Iterable<number>) {
    if (this.modelSuspended) return
    for (const id of ids) {
      this.versions.set(id, ++this.nextVersion)
      this.queued.add(id)
      this.queuedGrids.delete(id)
      if (!this.document.chunks.has(id)) this.removeChunk(id)
    }
    this.viewport.requestPathTraceRebuild()
    this.pump()
    this.viewport.render()
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
      this.viewport.applyEnvironment(material)
      Object.assign(material, { castShadow: this.settings.shadows })
      return material
    })
  }

  private disposeMaterials() {
    this.textureLoads.clear()
    for (const material of this.materials) {
      for (const map of ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) material[map]?.dispose()
      material.dispose()
    }
  }

  updatePalette() {
    this.materials.forEach((material, index) => {
      material.color.setHex(this.document.palette[index])
      material.emissive.copy(material.color)
      this.viewport.applyEnvironment(material)
      material.needsUpdate = true
    })
    if (!this.modelSuspended) this.viewport.updatePathTracing('materials')
    this.viewport.render()
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
    material.emissive.setHex(this.document.palette[index])
    material.emissiveIntensity = preset.emissiveIntensity
    material.opacity = preset.opacity
    material.transmission = preset.transmission
    material.ior = preset.ior
    material.transparent = preset.opacity < 1
    material.depthWrite = preset.opacity >= 1
    this.viewport.applyEnvironment(material)
    material.needsUpdate = true
    if (wasTransparent !== (preset.opacity < 1 || preset.transmission > 0)) {
      this.updateWorkerPalette()
      this.markDirty(this.document.chunks.keys())
    } else if (!this.modelSuspended) this.viewport.updatePathTracing('materials')
    this.viewport.render()
  }

  setDocument(document: VoxelDocument, preserveMaterials = false) {
    if (this.disposed) throw new Error('Model renderer is disposed')
    if (!this.modelSuspended) this.viewport.invalidateSceneContent()
    for (const waiter of this.meshWaiters.splice(0)) waiter.reject(new Error('Model document changed during meshing'))
    this.textureLoads.clear()
    this.cancelPaint()
    this.cancelPushPull()
    this.cancelMarquee()
    this.document = document
    this.layerState = ''
    this.meshLayerId = undefined
    this.applySelection({ cells: [], count: 0 }, false)
    this.queued.clear()
    this.queuedGrids.clear()
    this.versions.clear()
    this.worker.terminate()
    if (!this.modelSuspended) this.worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' })
    this.inFlight = 0
    this.workerReady = false
    this.meshFailed = false
    if (!this.modelSuspended) this.bindWorker()
    for (const id of [...this.chunkMeshes.keys()]) this.removeChunk(id)
    if (!preserveMaterials) {
      this.disposeMaterials()
      this.materials = this.createMaterials()
    }
    this.keyboardCell = { x: 0, y: 0, z: 0 }
    this.updateBounds()
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
    this.refreshLayerScope()
    this.viewport.render()
  }

  setSculptMode(mode: SculptMode) {
    this.cancelPushPull()
    this.cancelMarquee()
    this.sculptMode = mode
    this.viewport.render()
  }

  setPaintMode(mode: PaintMode) {
    this.cancelPaint()
    this.cancelMarquee()
    this.paintMode = mode
    this.refreshLayerScope()
    this.viewport.render()
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
    this.refreshLayerScope()
    this.viewport.render()
  }

  setSelectionMode(mode: SelectionMode) {
    this.selectionMode = mode
  }

  clearSelection() {
    this.cancelPushPull()
    this.cancelMarquee()
    this.setSelection([])
  }

  setActiveColor(index: number) {
    this.activeColor = index
    if (this.hover.visible) this.showCell({ x: this.hover.position.x + this.document.dimensions.x / 2 - 0.5, y: this.hover.position.y - 0.5, z: this.hover.position.z + this.document.dimensions.z / 2 - 0.5 })
  }

  async setPbrMap(index: number, map: PbrMap, file: Blob) {
    const material = this.materials[index]
    if (this.disposed || !material) throw new Error('Model material is unavailable')
    const key = `${index}:${map}`, request = Symbol()
    this.textureLoads.set(key, request)
    const url = URL.createObjectURL(file)
    let texture: THREE.Texture
    try {
      texture = await new THREE.TextureLoader().loadAsync(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (this.disposed || this.materials[index] !== material || this.textureLoads.get(key) !== request) {
      texture.dispose()
      throw new DOMException('Texture load was superseded', 'AbortError')
    }
    this.textureLoads.delete(key)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.colorSpace = map === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.anisotropy = Math.min(8, this.viewport.renderer.capabilities.getMaxAnisotropy())
    const previous = material[map]
    if (previous) previous.dispose()
    material[map] = texture
    this.viewport.applyEnvironment(material)
    material.needsUpdate = true
    if (!this.modelSuspended) this.viewport.updatePathTracing('materials')
    this.viewport.render()
  }

  clearPbrMaps(index: number, selected?: PbrMap) {
    const material = this.materials[index]
    for (const map of ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) {
      if (selected && map !== selected) continue
      this.textureLoads.delete(`${index}:${map}`)
      material[map]?.dispose()
      material[map] = null
    }
    this.viewport.applyEnvironment(material)
    material.needsUpdate = true
    if (!this.modelSuspended) this.viewport.updatePathTracing('materials')
    this.viewport.render()
  }

  private updateMeshOverlayVisibility(chunks: Iterable<THREE.Group> = this.chunkMeshes.values()) {
    const showTriangles = this.settings.meshTriangles && !this.viewport.renderMode
    for (const chunk of chunks) {
      const isolated = chunk.children.find(child => child.userData.layerIsolation)
      const focused = !!isolated && this.isolatedLayerId() === isolated.userData.layerId
      if (isolated) isolated.visible = focused
      for (const surface of isolated ? [chunk, isolated] : [chunk]) for (const child of surface.children) {
        if (child === isolated || child.userData.layerContext) continue
        const visible = surface !== chunk || !focused
        if (child.userData.faceGrid) child.visible = visible && this.settings.faceGrid && !this.viewport.renderMode
        if (child.userData.meshVertices) child.visible = visible && this.settings.meshVertices && !this.viewport.renderMode
        if (!(child instanceof THREE.Mesh)) continue
        child.visible = visible
        let triangles = child.children.find(overlay => overlay.userData.meshTriangles)
        if (!triangles && showTriangles) {
          triangles = new THREE.LineSegments(new THREE.WireframeGeometry(child.geometry), this.meshTrianglesMaterial)
          triangles.userData.meshTriangles = true
          triangles.userData.editorOverlay = true
          triangles.renderOrder = 1
          child.add(triangles)
          triangles.updateWorldMatrix(true, false)
        }
        if (triangles) triangles.visible = showTriangles
      }
    }
  }

  frameModel() {
    if (this.modelSuspended) return
    const bounds = this.focusBounds()
    const center = this.focusCenter()
    const size = bounds ? Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z, 8) : 24
    this.viewport.frameLocalBounds(center, size)
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

  async inspect(views: readonly InspectionView[] = defaultInspectionViews) {
    if (this.modelSuspended) throw new Error('Model inspection is unavailable in scene mode. Use viewport capture for a raster scene PNG.')
    const faces = views.filter((name): name is FaceView => (faceViews as readonly string[]).includes(name))
    const isometric = views.filter(name => name.startsWith('iso-'))
    const document = this.document
    if (isometric.length) await this.whenMeshIdle()
    if (this.disposed || this.modelSuspended || document !== this.document) throw new Error('Model changed during inspection')
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
      const directions = isometric.map(name => new THREE.Vector3(name.endsWith('right') ? 1 : -1, 1, name.includes('front') ? 1 : -1))
      let canvases: OffscreenCanvas[]
      const visibility = new Map<THREE.Object3D, boolean>()
      for (const chunk of this.chunkMeshes.values()) for (const child of chunk.children) {
        if (!(child instanceof THREE.Mesh) && !child.userData.layerIsolation) continue
        visibility.set(child, child.visible)
        child.visible = !child.userData.layerIsolation
      }
      this.viewport.renderer.shadowMap.needsUpdate = true
      try { canvases = this.viewport.renderViews(box, directions) }
      finally {
        for (const [object, visible] of visibility) object.visible = visible
        this.viewport.renderer.shadowMap.needsUpdate = true
      }
      isometric.forEach((name, index) => {
        const { x, z } = directions[index]
        images.push({ name, width: 512, height: 512, direction: `camera side (${x},1,${z}), orthographic, +Y up, raster materials`, canvas: canvases[index] })
      })
    }
    return Promise.all(views.map(async name => {
      const { canvas, ...metadata } = images.find(image => image.name === name)!
      return { ...metadata, blob: await canvas.convertToBlob({ type: 'image/png' }) }
    }))
  }

  dispose() {
    if (this.disposed) return
    this.setActive(false)
    this.disposed = true
    this.listeners.abort()
    this.worker.terminate()
    this.clearSelectionPreview()
    this.clearFillPreview()
    this.disposeMaterials()
    this.hover.geometry.dispose(); this.hover.material.dispose()
    for (const geometry of Object.values(this.fillPreviewGeometry)) geometry.dispose()
    this.marqueePreview.material.dispose()
    this.contextMaterial.dispose()
    this.faceGridMaterial.dispose(); this.meshVerticesMaterial.dispose(); this.meshTrianglesMaterial.dispose()
    this.root.clear()
    if (this.ownsViewport) this.viewport.dispose()
  }
}
