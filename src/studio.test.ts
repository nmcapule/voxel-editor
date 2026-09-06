import { describe, expect, test } from 'bun:test'
import { VoxelDocument } from './editor'
import { Studio, StudioCommandError } from './studio'
import type { ViewSettings } from './storage'

const settings: ViewSettings = {
  background: '#dfe7ec',
  ambient: 1.2,
  light: 2.4,
  lightAzimuth: 42,
  ambientOcclusion: true,
  shadows: true,
  grid: true,
  faceGrid: false,
  projection: 'orthographic',
  pathTracing: true,
}

describe('studio command kernel', () => {
  test('applies edits, selection, and history through one effect boundary', () => {
    const document = new VoxelDocument()
    document.setVoxel(1, 1, 1, 5)
    const studio = new Studio(document, settings)

    studio.execute({ type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] })
    const painted = studio.execute({ type: 'edit.paint', color: 6 })
    expect(document.getVoxel(1, 1, 1)).toBe(6)
    expect(painted.effects).toMatchObject({ factsChanged: true, save: true })
    expect(painted.effects.dirtyChunks).toContain(0)

    studio.execute({ type: 'history.undo' })
    expect(document.getVoxel(1, 1, 1)).toBe(5)
    expect(studio.selection.cells).toEqual([{ x: 1, y: 1, z: 1 }])
    studio.execute({ type: 'history.redo' })
    expect(document.getVoxel(1, 1, 1)).toBe(6)
  })

  test('targets an explicit layer instead of ambient active state', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    const upper = studio.execute({ type: 'layer.create', name: 'Upper' }).result.layer as { id: number }
    studio.execute({ type: 'layer.activate', id: 1 })
    studio.execute({ type: 'edit.setVoxels', layerId: upper.id, voxels: [{ x: 2, y: 3, z: 4, color: 7 }] })

    expect(studio.document.activeLayerId).toBe(1)
    expect(studio.document.getLayerVoxel(2, 3, 4, upper.id)).toBe(7)
    studio.execute({ type: 'history.undo' })
    expect(studio.document.activeLayerId).toBe(1)
    studio.execute({ type: 'history.redo' })
    expect(studio.document.activeLayerId).toBe(1)
    expect(studio.document.getLayerVoxel(2, 3, 4, upper.id)).toBe(7)
  })

  test('returns stable paginated composition for visible and layered voxels', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 3, y: 0, z: 0, color: 5 }, { x: 1, y: 0, z: 0, color: 6 }] })
    const upper = studio.execute({ type: 'layer.create' }).result.layer as { id: number }
    studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 1, y: 0, z: 0, color: 7 }] })

    expect(studio.composition({ bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 0, z: 0 } } }).voxels).toEqual([
      { x: 1, y: 0, z: 0, color: 7, layerId: upper.id },
      { x: 3, y: 0, z: 0, color: 5, layerId: 1 },
    ])
    expect(studio.composition({ visibility: 'all', bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 0, z: 0 } } }).voxels).toEqual([
      { x: 1, y: 0, z: 0, color: 6, layerId: 1 },
      { x: 3, y: 0, z: 0, color: 5, layerId: 1 },
      { x: 1, y: 0, z: 0, color: 7, layerId: upper.id },
    ])
    expect(studio.composition({ bounds: { min: { x: 100, y: 100, z: 100 }, max: { x: 101, y: 101, z: 101 } } })).toMatchObject({ voxels: [], scanned: 0, nextCursor: null })
  })

  test('cancels a pending paste when a normal selection replaces it', () => {
    const document = new VoxelDocument()
    document.setVoxel(1, 1, 1, 5)
    const studio = new Studio(document, settings)

    studio.execute({ type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] })
    studio.execute({ type: 'clipboard.copy' })
    studio.execute({ type: 'clipboard.paste.begin' })
    studio.execute({ type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] })

    expect(studio.pendingPaste).toBeUndefined()
    expect(studio.selection).toEqual({ cells: [{ x: 1, y: 1, z: 1 }], count: 1, floating: undefined })
  })

  test('requires explicit approval before destructive remote operations', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 31, y: 31, z: 31, color: 5 }] })
    expect(() => studio.execute({ type: 'document.resize', dimensions: { x: 16, y: 16, z: 16 }, anchor: 'origin' })).toThrow(StudioCommandError)
    const resized = studio.execute({ type: 'document.resize', dimensions: { x: 16, y: 16, z: 16 }, anchor: 'origin', allowCrop: true })
    expect(resized.result.cropped).toBe(1)
  })
})
