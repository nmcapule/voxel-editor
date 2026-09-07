import type * as THREE from 'three'
import type { ViewSettings } from './settings'
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
  prepareFullDetail?(signal: AbortSignal): Promise<PreparedSceneContent>
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
