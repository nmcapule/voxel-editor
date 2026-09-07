import type { ProjectSnapshot } from '../voxel/snapshot'

export interface ModelSummary {
  id: string
  name: string
  tags: string[]
  version: number
  createdAt: string
  updatedAt: string
  dimensions: ProjectSnapshot['dimensions']
  voxelCount: number
}
export interface LibraryLink {
  id: string
  version: number
  tags: string[]
  dirty: boolean
}
export interface SceneSummary {
  id: string
  name: string
  tags: string[]
  version: number
  createdAt: string
  updatedAt: string
  instanceCount: number
  assetCount: number
  voxelCount: number
}
