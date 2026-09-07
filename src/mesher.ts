import { CHUNK_SIZE, PADDED_SIZE } from './editor'

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  // Global vertex indices, including in worker responses. For a material-local
  // attribute view, subtract that group's vertexStart from its index range.
  indices: Uint16Array | Uint32Array
  faceLines: Float32Array
  groups: {
    start: number
    count: number
    materialIndex: number
    vertexStart: number
    vertexCount: number
    bounds: [number, number, number, number, number, number]
  }[]
  quads: number
}

function forEachFaceMask(voxels: Uint8Array, transparent: Uint8Array, visit: (axis: number, slice: number, mask: Int16Array, opposite: boolean) => void) {
  if (voxels.length !== PADDED_SIZE ** 3 || transparent.length !== 256) throw new RangeError('Invalid padded chunk or transparency table size')
  const strides = [1, PADDED_SIZE, PADDED_SIZE * PADDED_SIZE]
  const origin = 1 + PADDED_SIZE + PADDED_SIZE * PADDED_SIZE
  const mask = new Int16Array(CHUNK_SIZE * CHUNK_SIZE)
  const oppositeMask = new Int16Array(CHUNK_SIZE * CHUNK_SIZE)

  for (let d = 0; d < 3; d++) {
    const stride = strides[d]
    const uStride = strides[(d + 1) % 3]
    const vStride = strides[(d + 2) % 3]
    for (let slice = 0; slice <= CHUNK_SIZE; slice++) {
      let hasOppositeFaces = false
      let n = 0
      for (let vv = 0; vv < CHUNK_SIZE; vv++) {
        let index = origin + slice * stride + vv * vStride
        for (let uu = 0; uu < CHUNK_SIZE; uu++, n++, index += uStride) {
          const behind = voxels[index - stride]
          const inFront = voxels[index]
          // Only emit faces owned by this chunk. Distinct transparent media
          // retain both opposing faces at the exact same integer interface.
          const backFace = slice > 0 && behind > 0 && (inFront === 0 || behind !== inFront && transparent[inFront]) ? behind : 0
          const frontFace = slice < CHUNK_SIZE && inFront > 0 && (behind === 0 || behind !== inFront && transparent[behind]) ? -inFront : 0
          mask[n] = backFace || frontFace
          oppositeMask[n] = backFace && frontFace ? frontFace : 0
          hasOppositeFaces ||= oppositeMask[n] !== 0
        }
      }
      visit(d, slice, mask, false)
      if (hasOppositeFaces) visit(d, slice, oppositeMask, true)
    }
  }
}

function addFaceLine(lines: number[], axis: number, plane: number, u0: number, v0: number, u1: number, v1: number) {
  if (axis === 0) lines.push(plane, u0, v0, plane, u1, v1)
  else if (axis === 1) lines.push(v0, plane, u0, v1, plane, u1)
  else lines.push(u0, v0, plane, u1, v1, plane)
}

function addFaceGrid(lines: number[], axis: number, slice: number, mask: Int16Array) {
  for (let vv = 0; vv < CHUNK_SIZE; vv++) {
    for (let uu = 0; uu < CHUNK_SIZE; uu++) {
      const index = uu + vv * CHUNK_SIZE
      if (!mask[index]) continue
      // Grid lines lie on the surface, not an inset or offset proxy. Opposing
      // coplanar faces share one grid, independent of material and orientation.
      addFaceLine(lines, axis, slice, uu, vv, uu, vv + 1)
      addFaceLine(lines, axis, slice, uu, vv, uu + 1, vv)
      if (uu === CHUNK_SIZE - 1 || !mask[index + 1]) addFaceLine(lines, axis, slice, uu + 1, vv, uu + 1, vv + 1)
      if (vv === CHUNK_SIZE - 1 || !mask[index + CHUNK_SIZE]) addFaceLine(lines, axis, slice, uu, vv + 1, uu + 1, vv + 1)
    }
  }
}

export function meshFaceGrid(voxels: Uint8Array, transparent = new Uint8Array(256)): Float32Array {
  const lines: number[] = []
  forEachFaceMask(voxels, transparent, (axis, slice, mask, opposite) => {
    if (!opposite) addFaceGrid(lines, axis, slice, mask)
  })
  return new Float32Array(lines)
}

// Palette remains an optional argument for existing CPU callers; geometry has
// no color dependency. All coordinates and bounds are chunk-local, with UVs
// anchored to the integer (u, v) coordinates, not the greedy quad's origin.
export function meshChunk(voxels: Uint8Array, _palette?: Uint32Array, faceGrid = false, transparent = new Uint8Array(256)): MeshData {
  const quadsByMaterial = new Map<number, number[]>()
  const faceLines: number[] = []
  let quads = 0

  forEachFaceMask(voxels, transparent, (axis, slice, mask, opposite) => {
    if (faceGrid && !opposite) addFaceGrid(faceLines, axis, slice, mask)
    let n = 0
    for (let vv = 0; vv < CHUNK_SIZE; vv++) {
      for (let uu = 0; uu < CHUNK_SIZE;) {
        const value = mask[n]
        if (!value) {
          uu++; n++
          continue
        }
        let width = 1
        while (uu + width < CHUNK_SIZE && mask[n + width] === value) width++
        let height = 1
        heightLoop: while (vv + height < CHUNK_SIZE) {
          for (let k = 0; k < width; k++) if (mask[n + k + height * CHUNK_SIZE] !== value) break heightLoop
          height++
        }

        const material = Math.abs(value)
        let materialQuads = quadsByMaterial.get(material)
        if (!materialQuads) {
          materialQuads = []
          quadsByMaterial.set(material, materialQuads)
        }
        // Six scalars per quad; expand directly into final typed buffers once
        // group sizes are known, without a vertex remap or temporary indices.
        materialQuads.push(value > 0 ? axis + 1 : -(axis + 1), slice, uu, vv, width, height)
        for (let h = 0; h < height; h++) mask.fill(0, n + h * CHUNK_SIZE, n + h * CHUNK_SIZE + width)
        quads++
        uu += width
        n += width
      }
    }
  })

  const positions = new Float32Array(quads * 12)
  const normals = new Float32Array(quads * 12)
  const uvs = new Float32Array(quads * 8)
  const indices = quads * 4 > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6)
  const groups: MeshData['groups'] = []
  let vertex = 0
  let index = 0
  for (const [materialIndex, materialQuads] of quadsByMaterial) {
    const vertexStart = vertex
    const start = index
    const bounds: MeshData['groups'][number]['bounds'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let q = 0; q < materialQuads.length; q += 6) {
      const signedAxis = materialQuads[q]
      const axis = Math.abs(signedAxis) - 1
      const u = (axis + 1) % 3
      const v = (axis + 2) % 3
      const slice = materialQuads[q + 1]
      const uu = materialQuads[q + 2]
      const vv = materialQuads[q + 3]
      const width = materialQuads[q + 4]
      const height = materialQuads[q + 5]
      bounds[axis] = Math.min(bounds[axis], slice)
      bounds[axis + 3] = Math.max(bounds[axis + 3], slice)
      bounds[u] = Math.min(bounds[u], uu)
      bounds[u + 3] = Math.max(bounds[u + 3], uu + width)
      bounds[v] = Math.min(bounds[v], vv)
      bounds[v + 3] = Math.max(bounds[v + 3], vv + height)
      for (let corner = 0; corner < 4; corner++) {
        const winding = signedAxis > 0 ? corner : 3 - corner
        const cu = uu + (winding === 1 || winding === 2 ? width : 0)
        const cv = vv + (winding >= 2 ? height : 0)
        const offset = (vertex + corner) * 3
        positions[offset + axis] = slice
        positions[offset + u] = cu
        positions[offset + v] = cv
        normals[offset + axis] = signedAxis > 0 ? 1 : -1
        uvs[(vertex + corner) * 2] = cu
        uvs[(vertex + corner) * 2 + 1] = cv
      }
      indices[index++] = vertex
      indices[index++] = vertex + 1
      indices[index++] = vertex + 2
      indices[index++] = vertex
      indices[index++] = vertex + 2
      indices[index++] = vertex + 3
      vertex += 4
    }
    groups.push({ start, count: index - start, materialIndex, vertexStart, vertexCount: vertex - vertexStart, bounds })
  }
  return { positions, normals, uvs, indices, faceLines: new Float32Array(faceLines), groups, quads }
}
