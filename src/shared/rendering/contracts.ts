import type * as THREE from 'three'
import type { ViewSettings } from './settings'
import type { VoxelDocument } from '../voxel/document'
export interface Vector3Value { x: number; y: number; z: number }

export interface CameraSnapshot {
  projection: ViewSettings['projection']
  position: Vector3Value
  target: Vector3Value
  up: Vector3Value
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
  /** Bounded workspaces use box grids and close-range cameras; world is the default. */
  stage?: 'bounded' | 'world'
  label?: string
  whenReady(): Promise<void>
  isReady?(): boolean
  focusTarget?(): THREE.Vector3
  onViewportChange(): void
  /** Optional orthographic, raster-only model preview. Absent plugins leave normal rendering intact. */
  previewRendererId?: string
  prepareRaster?(frame: PreviewFrame): void
  /** Optional current-camera opaque draw filter. Never used for shadows or secondary views. */
  cullOpaque?(frame: OcclusionFrame): ReadonlySet<THREE.Mesh> | undefined
  onContextLost?(): void
  prepareFullDetail?(signal: AbortSignal): Promise<PreparedSceneContent>
}

export interface OcclusionFrame {
  camera: THREE.Camera
  width: number
  height: number
  /** Currently displayed, supported opaque depth-writing meshes, after raster substitution. */
  opaqueMeshes: ReadonlySet<THREE.Mesh>
}

export interface PreviewFrame {
  renderer: THREE.WebGLRenderer
  camera: THREE.Camera
  light: THREE.DirectionalLight
  settings: ViewSettings
  /** Temporary cheap live shading only; retain PBR packing/resources and restore on the
   * next normal prepare. settings.pbrMaterials remains authoritative; host disables shadows. */
  reducedQuality?: boolean
  /** Borrowed live palette, including maps and Standard environment bindings. Never dispose;
   * cloned preview materials must set visible=true because host surfaces are hidden. */
  materials?: readonly THREE.MeshPhysicalMaterial[]
  width: number
  height: number
}

export interface ModelPreviewRenderer {
  root: THREE.Group
  setDocument(document: VoxelDocument): void
  /** Undefined renders the visible composition; returns whether editing scope changed. */
  setLayerScope(layerId?: number): boolean
  markDirty(ids: Iterable<number>): void
  updatePalette(): void
  prepare(frame: PreviewFrame): void
  dispose(): void
}

export interface ModelPreviewPlugin {
  id: ViewSettings['previewRenderer']
  label: string
  create(document: VoxelDocument): ModelPreviewRenderer
}

export interface ViewportCallbacks {
  onViewStart?(): void
  onViewChange?(view: CameraSnapshot): void
  onPathTracingStatus?(status: string): void
  onFps?(fps?: number): void
  onError?(message: string): void
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
