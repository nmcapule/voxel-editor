import { CHUNK_SIZE, PADDED_SIZE } from './editor'

// Thin-sheet interfaces must survive the path tracer's position-scaled ray offset
// (up to 0.0257 in the 256-voxel workspace). Keep them out of exterior greedy merges.
const INTERFACE_FLAG = 256
const INTERFACE_INSET = 0.03
const U_MIN = 512, U_MAX = 1024, V_MIN = 2048, V_MAX = 4096

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  uvs: Float32Array
  indices: Uint16Array | Uint32Array
  faceLines: Float32Array
  groups: { start: number; count: number; materialIndex: number }[]
  quads: number
}

function paddedIndex(x: number, y: number, z: number) {
  return (x + 1) + (y + 1) * PADDED_SIZE + (z + 1) * PADDED_SIZE * PADDED_SIZE
}

function linearChannel(channel: number) {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function addFaceLine(lines: number[], axis: number, plane: number, u0: number, v0: number, u1: number, v1: number) {
  if (axis === 0) lines.push(plane, u0, v0, plane, u1, v1)
  else if (axis === 1) lines.push(v0, plane, u0, v1, plane, u1)
  else lines.push(u0, v0, plane, u1, v1, plane)
}

export function meshChunk(voxels: Uint8Array, palette: Uint32Array, faceGrid = false, transparent = new Uint8Array(256)): MeshData {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const faceLines: number[] = []
  const indicesByMaterial = new Map<number, number[]>()
  const dims = [CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE]
  let quads = 0

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3
    const v = (d + 2) % 3
    const mask = new Int16Array(CHUNK_SIZE * CHUNK_SIZE)
    const oppositeMask = new Int16Array(CHUNK_SIZE * CHUNK_SIZE)

    for (let slice = 0; slice <= CHUNK_SIZE; slice++) {
      let hasOppositeFaces = false
      let n = 0
      for (let vv = 0; vv < dims[v]; vv++) {
        for (let uu = 0; uu < dims[u]; uu++) {
          const point = [0, 0, 0]
          point[d] = slice
          point[u] = uu
          point[v] = vv
          const behindPoint = [...point]
          behindPoint[d]--
          const behind = voxels[paddedIndex(behindPoint[0], behindPoint[1], behindPoint[2])]
          const inFront = voxels[paddedIndex(point[0], point[1], point[2])]

          const materialBoundary = behind > 0 && inFront > 0 && transparent[behind] !== transparent[inFront]
          const transparentBoundary = behind > 0 && inFront > 0 && behind !== inFront && transparent[behind] && transparent[inFront]
          oppositeMask[n] = 0
          if (transparentBoundary) {
            mask[n] = slice === 0 ? -(inFront | INTERFACE_FLAG) : behind | INTERFACE_FLAG
            oppositeMask[n] = slice > 0 && slice < CHUNK_SIZE ? -(inFront | INTERFACE_FLAG) : 0
            hasOppositeFaces ||= oppositeMask[n] !== 0
          } else if (slice === 0) mask[n] = inFront > 0 && (behind === 0 || materialBoundary && !transparent[inFront]) ? -inFront : 0
          else if (slice === CHUNK_SIZE) mask[n] = behind > 0 && (inFront === 0 || materialBoundary && !transparent[behind]) ? behind : 0
          else if (materialBoundary) {
            mask[n] = transparent[behind] ? -inFront : behind
          } else if (behind > 0 && inFront === 0) mask[n] = behind
          else if (inFront > 0 && behind === 0) mask[n] = -inFront
          else mask[n] = 0
          // Trim adjoining exterior edges too, so an inset interface has no overlapping lip.
          for (const faceMask of oppositeMask[n] ? [mask, oppositeMask] : [mask]) {
            const value = faceMask[n]
            const material = Math.abs(value) & 255
            if (!value || !transparent[material]) continue
            const cell = [...point]
            if (value > 0) cell[d]--
            let flags = 0
            for (const [axis, direction, flag] of [[u, -1, U_MIN], [u, 1, U_MAX], [v, -1, V_MIN], [v, 1, V_MAX]]) {
              cell[axis] += direction
              const neighbor = voxels[paddedIndex(cell[0], cell[1], cell[2])]
              if (neighbor > 0 && neighbor !== material && transparent[neighbor]) flags |= flag
              cell[axis] -= direction
            }
            faceMask[n] = Math.sign(value) * (Math.abs(value) | flags)
          }
          n++
        }
      }

      for (const faceMask of hasOppositeFaces ? [mask, oppositeMask] : [mask]) {
        if (faceGrid && faceMask === mask) {
          for (let vv = 0; vv < dims[v]; vv++) {
            for (let uu = 0; uu < dims[u]; uu++) {
              const index = uu + vv * dims[u]
              const value = faceMask[index]
              if (!value) continue
              const plane = slice + (value > 0 ? 0.002 : -0.002)
              addFaceLine(faceLines, d, plane, uu, vv, uu, vv + 1)
              addFaceLine(faceLines, d, plane, uu, vv, uu + 1, vv)
              const right = faceMask[index + 1]
              const top = faceMask[index + dims[u]]
              if (uu === dims[u] - 1 || !right || (right > 0) !== (value > 0)) addFaceLine(faceLines, d, plane, uu + 1, vv, uu + 1, vv + 1)
              if (vv === dims[v] - 1 || !top || (top > 0) !== (value > 0)) addFaceLine(faceLines, d, plane, uu, vv + 1, uu + 1, vv + 1)
            }
          }
        }

        n = 0
        for (let vv = 0; vv < dims[v]; vv++) {
          for (let uu = 0; uu < dims[u];) {
            const colorValue = faceMask[n]
            if (!colorValue) {
              uu++; n++
              continue
            }

            let width = 1
            while (uu + width < dims[u] && faceMask[n + width] === colorValue) width++
            let height = 1
            heightLoop: while (vv + height < dims[v]) {
              for (let k = 0; k < width; k++) if (faceMask[n + k + height * dims[u]] !== colorValue) break heightLoop
              height++
            }

            const point = [0, 0, 0]
            const du = [0, 0, 0]
            const dv = [0, 0, 0]
            point[d] = slice; point[u] = uu; point[v] = vv
            if (Math.abs(colorValue) & INTERFACE_FLAG) point[d] -= Math.sign(colorValue) * INTERFACE_INSET
            const flags = Math.abs(colorValue)
            point[u] += flags & U_MIN ? INTERFACE_INSET : 0
            point[v] += flags & V_MIN ? INTERFACE_INSET : 0
            du[u] = width - ((flags & U_MIN ? 1 : 0) + (flags & U_MAX ? 1 : 0)) * INTERFACE_INSET
            dv[v] = height - ((flags & V_MIN ? 1 : 0) + (flags & V_MAX ? 1 : 0)) * INTERFACE_INSET
            const corners = [
              point,
              [point[0] + du[0], point[1] + du[1], point[2] + du[2]],
              [point[0] + du[0] + dv[0], point[1] + du[1] + dv[1], point[2] + du[2] + dv[2]],
              [point[0] + dv[0], point[1] + dv[1], point[2] + dv[2]],
            ]
            if (colorValue < 0) corners.reverse()

            const vertex = positions.length / 3
            for (const corner of corners) {
              positions.push(corner[0], corner[1], corner[2])
              uvs.push(corner[u] - point[u], corner[v] - point[v])
            }
            const materialIndex = Math.abs(colorValue) & 255
            const materialIndices = indicesByMaterial.get(materialIndex) ?? []
            materialIndices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3)
            indicesByMaterial.set(materialIndex, materialIndices)

            const normal = [0, 0, 0]
            normal[d] = colorValue > 0 ? 1 : -1
            for (let i = 0; i < 4; i++) normals.push(normal[0], normal[1], normal[2])

            const hex = palette[materialIndex] ?? 0xffffff
            const r = linearChannel((hex >> 16) & 255)
            const g = linearChannel((hex >> 8) & 255)
            const b = linearChannel(hex & 255)
            for (let i = 0; i < 4; i++) colors.push(r, g, b, 1)

            for (let h = 0; h < height; h++) for (let w = 0; w < width; w++) faceMask[n + w + h * dims[u]] = 0
            quads++
            uu += width
            n += width
          }
        }
      }
    }
  }

  const indices: number[] = []
  const groups: MeshData['groups'] = []
  for (const [materialIndex, materialIndices] of indicesByMaterial) {
    groups.push({ start: indices.length, count: materialIndices.length, materialIndex })
    for (const index of materialIndices) indices.push(index)
  }
  const IndexArray = positions.length / 3 > 65535 ? Uint32Array : Uint16Array
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    indices: new IndexArray(indices),
    faceLines: new Float32Array(faceLines),
    groups,
    quads,
  }
}
