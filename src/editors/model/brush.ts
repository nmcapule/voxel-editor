import { voxelLine, type Dimensions, type Vec3 } from '../../shared/voxel/document'

export type ModelAction = 'attach' | 'erase' | 'paint' | 'select' | 'move'
export type BrushMode = 'voxel' | 'face' | 'box' | 'line' | 'center' | 'texture' | 'body' | 'pattern'
export type BrushAxis = keyof Vec3
export type AxisToggles = Record<BrushAxis, boolean>
export type PatternVoxel = Vec3 & { color: number }

export const noAxes = (): AxisToggles => ({ x: false, y: false, z: false })

function key(cell: Vec3) {
  return `${cell.x},${cell.y},${cell.z}`
}

export function centerBrushCells(center: Vec3, edge: Vec3, normal: Vec3, dimensions: Dimensions) {
  const plane = (['x', 'y', 'z'] as const).filter(axis => normal[axis] === 0)
  const radius = Math.max(...plane.map(axis => Math.abs(edge[axis] - center[axis])))
  const cells: Vec3[] = []
  for (let a = -radius; a <= radius; a++) for (let b = -radius; b <= radius; b++) {
    if (a * a + b * b > radius * radius) continue
    const cell = { ...center, [plane[0]]: center[plane[0]] + a, [plane[1]]: center[plane[1]] + b }
    if (cell.x >= 0 && cell.y >= 0 && cell.z >= 0 && cell.x < dimensions.x && cell.y < dimensions.y && cell.z < dimensions.z) cells.push(cell)
  }
  return cells
}

export function lineBrushCells(from: Vec3, to: Vec3, normal: Vec3) {
  const axis = (['x', 'y', 'z'] as const).find(candidate => normal[candidate] !== 0)
  const end = { ...to }
  if (axis) end[axis] = from[axis]
  return voxelLine(from, end)
}

export function normalizePattern(voxels: PatternVoxel[]) {
  if (!voxels.length) return []
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const voxel of voxels) for (const axis of ['x', 'y', 'z'] as const) {
    min[axis] = Math.min(min[axis], voxel[axis])
    max[axis] = Math.max(max[axis], voxel[axis])
  }
  const center = { x: Math.floor((min.x + max.x) / 2), y: Math.floor((min.y + max.y) / 2), z: Math.floor((min.z + max.z) / 2) }
  return voxels.map(voxel => ({ ...voxel, x: voxel.x - center.x, y: voxel.y - center.y, z: voxel.z - center.z }))
}

export function placePattern(pattern: PatternVoxel[], anchor: Vec3, dimensions: Dimensions) {
  return pattern.map(voxel => ({ ...voxel, x: voxel.x + anchor.x, y: voxel.y + anchor.y, z: voxel.z + anchor.z }))
    .filter(voxel => voxel.x >= 0 && voxel.y >= 0 && voxel.z >= 0 && voxel.x < dimensions.x && voxel.y < dimensions.y && voxel.z < dimensions.z)
}

export function applyBrushModifiers<T extends Vec3>(cells: T[], dimensions: Dimensions, mirrors: AxisToggles, wholeAxes: AxisToggles, limit = Infinity) {
  let result = cells.slice(0, limit)
  for (const axis of ['x', 'y', 'z'] as const) {
    if (!mirrors[axis]) continue
    const source = [...result]
    for (const cell of source) {
      if (result.length >= limit) break
      result.push({ ...cell, [axis]: dimensions[axis] - 1 - cell[axis] })
    }
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    if (!wholeAxes[axis]) continue
    const expanded: T[] = []
    outer: for (const cell of result) for (let coordinate = 0; coordinate < dimensions[axis]; coordinate++) {
      expanded.push({ ...cell, [axis]: coordinate })
      if (expanded.length >= limit) break outer
    }
    result = expanded
  }
  return [...new Map(result.map(cell => [key(cell), cell])).values()]
}
