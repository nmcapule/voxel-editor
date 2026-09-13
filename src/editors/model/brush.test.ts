import { describe, expect, test } from 'bun:test'
import { applyBrushModifiers, centerBrushCells, lineBrushCells, noAxes, normalizePattern, placePattern } from './brush'

describe('MagicaVoxel brush geometry', () => {
  const dimensions = { x: 8, y: 8, z: 8 }

  test('builds planar line and centered disc masks', () => {
    expect(lineBrushCells({ x: 1, y: 2, z: 1 }, { x: 5, y: 7, z: 3 }, { x: 0, y: 1, z: 0 })).toEqual([
      { x: 1, y: 2, z: 1 }, { x: 2, y: 2, z: 2 }, { x: 3, y: 2, z: 2 }, { x: 4, y: 2, z: 3 }, { x: 5, y: 2, z: 3 },
    ])
    const disc = centerBrushCells({ x: 3, y: 2, z: 3 }, { x: 5, y: 7, z: 3 }, { x: 0, y: 1, z: 0 }, dimensions)
    expect(disc).toHaveLength(13)
    expect(disc).toContainEqual({ x: 3, y: 2, z: 3 })
    expect(disc).not.toContainEqual({ x: 5, y: 2, z: 5 })
  })

  test('normalizes, anchors, clips, mirrors and expands pattern cells', () => {
    const pattern = normalizePattern([{ x: 4, y: 1, z: 2, color: 5 }, { x: 5, y: 1, z: 2, color: 6 }])
    expect(pattern).toEqual([{ x: 0, y: 0, z: 0, color: 5 }, { x: 1, y: 0, z: 0, color: 6 }])
    expect(placePattern(pattern, { x: 7, y: 2, z: 2 }, dimensions)).toEqual([{ x: 7, y: 2, z: 2, color: 5 }])

    const mirrors = { ...noAxes(), x: true }, axes = { ...noAxes(), y: true }
    expect(applyBrushModifiers([{ x: 1, y: 2, z: 3 }], dimensions, mirrors, axes)).toEqual([
      ...Array.from({ length: 8 }, (_, y) => ({ x: 1, y, z: 3 })),
      ...Array.from({ length: 8 }, (_, y) => ({ x: 6, y, z: 3 })),
    ])
  })
})
