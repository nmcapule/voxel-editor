import type { Dimensions, Vec3, VoxelLayer } from '../../shared/voxel/document'
import type { ProjectSnapshot } from '../../shared/voxel/snapshot'
import type { CameraSnapshot } from '../../shared/rendering/contracts'
import type { LibraryLink } from '../../shared/library/types'
import type { ViewSettings } from '../../shared/rendering/settings'

export const SCENE_EXTENT = 16_384
export const MAX_SCENE_INSTANCES = 10_000
export const WORLD_CELL_SIZE = 256
export const SCENE_CPU_BUDGET = 64 * 1024 * 1024
export const SCENE_GEOMETRY_BUDGET = 128 * 1024 * 1024

export type Quaternion = { x: number; y: number; z: number; w: number }
export type SceneBounds = { min: Vec3; max: Vec3 }

export interface SceneChunk {
  id: number
  layerId: number
  blob: string
  count: number
  bounds: SceneBounds
  colors: number[]
  /** A 4x4x4 preview of this 16x16x16 source chunk, in x/y/z order. */
  lod: number[]
}

export interface SceneAsset {
  id: string
  revision: number
  model: Omit<ProjectSnapshot, 'chunks'>
  chunks: SceneChunk[]
  pivot: Vec3
  bounds?: SceneBounds
  voxelCount: number
  source?: { id: string; version: number }
}

export interface SceneTransform {
  position: Vec3
  rotation: Quaternion
  scale: Vec3
}

export interface SceneInstance extends SceneTransform {
  id: string
  assetId: string
  name: string
  layerId: number
}

export interface SceneManifest {
  schema: 'voxel-studio/scene'
  version: 1
  id: string
  name: string
  revision: number
  extent: Dimensions
  settings: ViewSettings
  layers: VoxelLayer[]
  activeLayerId: number
  assets: SceneAsset[]
  instances: SceneInstance[]
}

export interface SceneRecoveryContext {
  editingAssetId?: string
  view?: CameraSnapshot
  selection?: string[]
  library?: LibraryLink
}

export type SceneTool = 'select' | 'place' | 'transform' | 'layer'
export type TransformMode = 'translate' | 'rotate' | 'scale'

export type SceneCommand =
  | { type: 'scene.rename'; name: string }
  | { type: 'scene.settings'; patch: Partial<ViewSettings> }
  | { type: 'asset.add' | 'asset.update'; asset: SceneAsset }
  | { type: 'instance.place'; assetId: string; position: Vec3; rotation?: Quaternion; scale?: Vec3 }
  | { type: 'instances.insert'; instances: SceneInstance[] }
  | { type: 'instances.transform'; transforms: (SceneTransform & { id: string })[] }
  | { type: 'instances.delete'; ids: string[] }
  | { type: 'instances.layer'; ids: string[]; layerId: number }
  | { type: 'instance.unique'; id: string }
  | { type: 'selection.set'; ids: string[] }
  | { type: 'layer.create'; name?: string }
  | { type: 'layer.activate'; id: number }
  | { type: 'layer.rename'; id: number; name: string }
  | { type: 'layer.visibility'; id: number; visible: boolean }
  | { type: 'layer.lock'; id: number; locked: boolean }
  | { type: 'layer.delete'; id: number; allowNonEmpty?: boolean }
  | { type: 'history.undo' | 'history.redo' }

export interface SceneChange {
  changed: boolean
  instanceIds: string[]
  assetIds: string[]
  selectionChanged: boolean
}

export interface SceneStats {
  residentBytes: number
  geometryBytes: number
  activeInstances: number
  pending: number
  triangles: number
  representedVoxels: number
  detail: string
}
