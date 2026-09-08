import * as THREE from 'three'
import type { OcclusionFrame } from '../../shared/rendering/contracts'
import { CHUNK_SIZE } from '../../shared/voxel/document'

const MAX_CHUNKS = 4096
const MAX_FRAME_MESHES = 65_536
const MAX_SOURCE_QUADS = 65_536
const MAX_MESH_QUADS = 2048
const MAX_RECTANGLES = 8192
const MAX_OCCLUDERS = 32
const MAX_COORDINATE = 1_000_000
const EPSILON = 1e-7
// One pixel of outward candidate padding plus one pixel of inward blocker padding.
const PIXEL_MARGIN = 2

interface Entry {
  mesh: THREE.Mesh
  chunkId: number
  signature: string
  bounds: THREE.Box3
  // Six integers per face: signed axis, plane, u0, v0, u1, v1. No borrowed buffers.
  faces: Int32Array
  scanned: number
  eligible: boolean
  valid: boolean
  translation: number[]
}

interface Source { entry: Entry; next?: Source }
interface Rectangle {
  axis: number
  sign: number
  plane: number
  u0: number
  v0: number
  u1: number
  v1: number
  first: Source
  last: Source
}
interface Candidate { bounds: THREE.Box3; meshes: THREE.Mesh[]; valid: boolean }
interface Projected { rectangle: Rectangle; edges: Float64Array; area: number }

function geometrySignature(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position'), index = geometry.index
  if (!(position instanceof THREE.BufferAttribute) || !index || position.itemSize !== 3 || index.itemSize !== 1
    || position.normalized || index.normalized || position.count % 4 || index.count !== position.count / 4 * 6) return ''
  return `${geometry.id}:${position.id}:${position.version}:${position.count}:${index.id}:${index.version}:${geometry.drawRange.start}:${geometry.drawRange.count}`
}

function validBounds(bounds: THREE.Box3) {
  let dimensions = 0
  for (let axis = 0; axis < 3; axis++) {
    const min = bounds.min.getComponent(axis), max = bounds.max.getComponent(axis)
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || Math.max(Math.abs(min), Math.abs(max)) > MAX_COORDINATE) return false
    dimensions += Number(max > min)
  }
  return dimensions >= 2 // Planar surface bounds are valid; lines and points are not.
}

function translationOnly(matrix: THREE.Matrix4) {
  const e = matrix.elements
  // Exact, not epsilon-based: even a small ignored rotation/scale can expose a surface.
  return e.every(Number.isFinite) && e[0] === 1 && e[5] === 1 && e[10] === 1 && e[15] === 1
    && e[1] === 0 && e[2] === 0 && e[3] === 0 && e[4] === 0 && e[6] === 0 && e[7] === 0
    && e[8] === 0 && e[9] === 0 && e[11] === 0
    && Math.max(Math.abs(e[12]), Math.abs(e[13]), Math.abs(e[14])) <= MAX_COORDINATE
}

function coalesce(rectangles: Rectangle[], horizontal: boolean) {
  const lo = horizontal ? 'u0' : 'v0', hi = horizontal ? 'u1' : 'v1'
  const acrossLo = horizontal ? 'v0' : 'u0', acrossHi = horizontal ? 'v1' : 'u1'
  rectangles.sort((a, b) => a.axis - b.axis || a.sign - b.sign || a.plane - b.plane
    || a[acrossLo] - b[acrossLo] || a[acrossHi] - b[acrossHi] || a[lo] - b[lo] || a[hi] - b[hi])
  let count = 0
  for (const rectangle of rectangles) {
    const previous = rectangles[count - 1]
    // Only exact full voxel edges, including after translation. Never round gaps away.
    if (previous && previous.axis === rectangle.axis && previous.sign === rectangle.sign && previous.plane === rectangle.plane
      && previous[acrossLo] === rectangle[acrossLo] && previous[acrossHi] === rectangle[acrossHi] && previous[hi] === rectangle[lo]) {
      previous[hi] = rectangle[hi]
      previous.last.next = rectangle.first
      previous.last = rectangle.last
    } else rectangles[count++] = rectangle
  }
  rectangles.length = count
}

function project(x: number, y: number, z: number, matrix: number[], width: number, height: number, points: Float64Array, offset: number) {
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]
  const depth = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  const margin = EPSILON * Math.max(1, Math.abs(w))
  if (!Number.isFinite(w) || !Number.isFinite(depth) || w <= margin || depth <= -w + margin || depth >= w - margin) return false
  const sx = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w * width / 2
  const sy = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w * height / 2
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || Math.max(Math.abs(sx), Math.abs(sy)) > 10_000_000) return false
  points[offset] = sx
  points[offset + 1] = sy
  return true
}

/** Current-camera draw filter, not a shadow/secondary-view visibility cache.
 * Call after updating camera projection/view and mesh world matrices. Re-register
 * installed geometry/attribute edits; unannounced replacements fail open.
 * opaqueMeshes is authoritative, including temporary pipeline material substitutions.
 */
export class ModelOcclusion {
  private entries = new Map<THREE.Mesh, Entry>()
  private candidates = new Map<number, Candidate>()
  private rectangles: Rectangle[] = []
  private scanned = 0
  private dirty = true
  private stats = { candidates: 0, occluders: 0, culledChunks: 0, culledMeshes: 0, milliseconds: 0, rebuilds: 0, rectangles: 0, scannedQuads: 0 }
  get lastFrame(): Readonly<typeof this.stats> { return this.stats }

  register(mesh: THREE.Mesh, chunkId: number): void {
    this.remove(mesh)
    // Normal + isolation, with up to 256 palette surfaces each, for 4096 chunks.
    if (!Number.isSafeInteger(chunkId) || this.entries.size >= MAX_CHUNKS * 512) return
    const geometry = mesh.geometry, signature = geometrySignature(geometry)
    const bounds = geometry.boundingBox?.clone() ?? new THREE.Box3()
    const faces: number[] = []
    let scanned = 0
    if (signature && validBounds(bounds) && geometry.drawRange.start === 0 && geometry.drawRange.count >= geometry.index!.count) {
      const position = geometry.getAttribute('position'), index = geometry.index!
      const limit = Math.min(position.count / 4, MAX_MESH_QUADS, MAX_SOURCE_QUADS - this.scanned)
      const corners = Array.from({ length: 4 }, () => new THREE.Vector3())
      const edge = new THREE.Vector3(), normal = new THREE.Vector3(), min = new THREE.Vector3(), max = new THREE.Vector3()
      for (let quad = 0; quad < limit; quad++) {
        scanned++
        const vertex = quad * 4
        if (index.getX(quad * 6) !== vertex || index.getX(quad * 6 + 1) !== vertex + 1 || index.getX(quad * 6 + 2) !== vertex + 2
          || index.getX(quad * 6 + 3) !== vertex || index.getX(quad * 6 + 4) !== vertex + 2 || index.getX(quad * 6 + 5) !== vertex + 3) continue
        min.set(Infinity, Infinity, Infinity); max.set(-Infinity, -Infinity, -Infinity)
        for (let corner = 0; corner < 4; corner++) {
          corners[corner].fromBufferAttribute(position, vertex + corner)
          min.min(corners[corner]); max.max(corners[corner])
        }
        if (!corners.every(point => [point.x, point.y, point.z].every(value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_COORDINATE))) continue
        const axis = min.x === max.x ? 0 : min.y === max.y ? 1 : min.z === max.z ? 2 : -1
        if (axis < 0) continue
        const u = (axis + 1) % 3, v = (axis + 2) % 3
        const u0 = min.getComponent(u), v0 = min.getComponent(v), u1 = max.getComponent(u), v1 = max.getComponent(v)
        if (u1 <= u0 || v1 <= v0 || u1 - u0 > CHUNK_SIZE || v1 - v0 > CHUNK_SIZE) continue
        normal.subVectors(corners[1], corners[0]).cross(edge.subVectors(corners[2], corners[1]))
        const sign = Math.sign(normal.getComponent(axis))
        let mask = 0, rectangular = sign !== 0
        for (let corner = 0; corner < 4; corner++) {
          const point = corners[corner], next = corners[(corner + 1) % 4]
          const cu = point.getComponent(u), cv = point.getComponent(v)
          rectangular &&= (cu === u0 || cu === u1) && (cv === v0 || cv === v1)
            && Number(cu !== next.getComponent(u)) + Number(cv !== next.getComponent(v)) === 1
          mask |= 1 << (Number(cu === u1) + 2 * Number(cv === v1))
        }
        if (rectangular && mask === 15) faces.push(sign * (axis + 1), min.getComponent(axis), u0, v0, u1, v1)
      }
    }
    this.scanned += scanned
    this.entries.set(mesh, { mesh, chunkId, signature, bounds, faces: new Int32Array(faces), scanned, eligible: false, valid: false, translation: [0, 0, 0] })
  }

  remove(mesh: THREE.Mesh): void {
    const entry = this.entries.get(mesh)
    if (entry) this.scanned -= entry.scanned
    this.entries.delete(mesh)
    // Drop provenance immediately so a discarded mesh's buffers cannot stay alive here.
    this.rectangles = []
    this.candidates.clear()
    this.dirty = true
  }

  clear(): void {
    this.entries.clear()
    this.rectangles = []
    this.candidates.clear()
    this.scanned = 0
    this.dirty = true
  }

  cull({ camera, width, height, opaqueMeshes }: OcclusionFrame): ReadonlySet<THREE.Mesh> {
    const started = performance.now(), hidden = new Set<THREE.Mesh>()
    Object.assign(this.stats, { candidates: 0, occluders: 0, culledChunks: 0, culledMeshes: 0, milliseconds: 0, rebuilds: 0, rectangles: 0, scannedQuads: this.scanned })
    try {
      // ponytail: deterministic work ceilings; overflow stays drawn. Profile before raising them.
      if (this.entries.size > MAX_FRAME_MESHES || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return hidden
      for (const entry of this.entries.values()) {
        const { mesh } = entry, matrix = mesh.matrixWorld.elements
        const eligible = opaqueMeshes.has(mesh)
        const valid = eligible && !!entry.signature && entry.signature === geometrySignature(mesh.geometry)
          && !!mesh.geometry.boundingBox?.equals(entry.bounds) && validBounds(entry.bounds) && translationOnly(mesh.matrixWorld)
        if (eligible !== entry.eligible || valid !== entry.valid || valid && entry.translation.some((value, axis) => value !== matrix[12 + axis])) this.dirty = true
        entry.eligible = eligible
        entry.valid = valid
        if (valid) for (let axis = 0; axis < 3; axis++) entry.translation[axis] = matrix[12 + axis]
      }
      if (this.dirty) {
        this.candidates.clear()
        this.rectangles = []
        const translation = new THREE.Vector3()
        for (const entry of this.entries.values()) {
          if (!entry.eligible) continue
          let candidate = this.candidates.get(entry.chunkId)
          if (!candidate) {
            if (this.candidates.size === MAX_CHUNKS) continue
            candidate = { bounds: new THREE.Box3(), meshes: [], valid: true }
            this.candidates.set(entry.chunkId, candidate)
          }
          candidate.meshes.push(entry.mesh)
          candidate.valid &&= entry.valid
          if (!entry.valid) continue
          candidate.bounds.union(entry.bounds.clone().translate(translation.fromArray(entry.translation)))
          for (let face = 0; face < entry.faces.length; face += 6) {
            const axis = Math.abs(entry.faces[face]) - 1, u = (axis + 1) % 3, v = (axis + 2) % 3
            const source: Source = { entry }
            this.rectangles.push({ axis, sign: Math.sign(entry.faces[face]), plane: entry.faces[face + 1] + entry.translation[axis],
              u0: entry.faces[face + 2] + entry.translation[u], v0: entry.faces[face + 3] + entry.translation[v],
              u1: entry.faces[face + 4] + entry.translation[u], v1: entry.faces[face + 5] + entry.translation[v], first: source, last: source })
          }
        }
        // Four bounded sorting passes, not pairwise merging or a fixed-point loop.
        for (let pass = 0; pass < 4; pass++) coalesce(this.rectangles, pass % 2 === 0)
        this.rectangles = this.rectangles.filter(rectangle => (rectangle.u1 - rectangle.u0) * (rectangle.v1 - rectangle.v0) >= 16)
        this.rectangles.sort((a, b) => (b.u1 - b.u0) * (b.v1 - b.v0) - (a.u1 - a.u0) * (a.v1 - a.v0))
        this.rectangles.length = Math.min(this.rectangles.length, MAX_RECTANGLES)
        this.dirty = false
        this.stats.rebuilds = 1
      }
      this.stats.candidates = this.candidates.size
      this.stats.rectangles = this.rectangles.length
      if (!this.rectangles.length) return hidden
      const perspective = camera instanceof THREE.PerspectiveCamera
      if (!perspective && !(camera instanceof THREE.OrthographicCamera) || camera.coordinateSystem !== THREE.WebGLCoordinateSystem || camera.reversedDepth) return hidden
      const projection = camera.projectionMatrix.elements, view = camera.matrixWorldInverse, ve = view.elements, determinant = view.determinant()
      // Standard Three camera projections only; off-axis perspective/view offsets are fine.
      if (!projection.every(Number.isFinite) || !ve.every(Number.isFinite) || !Number.isFinite(determinant) || !determinant
        || ve[3] !== 0 || ve[7] !== 0 || ve[11] !== 0 || ve[15] <= EPSILON
        || projection[0] <= 0 || projection[5] <= 0 || projection[10] >= 0
        || [1, 2, 3, 4, 6, 7].some(index => projection[index] !== 0)
        || projection[11] !== (perspective ? -1 : 0) || projection[15] !== (perspective ? 0 : 1)
        || (perspective ? projection[12] !== 0 || projection[13] !== 0 || projection[14] >= 0 : projection[8] !== 0 || projection[9] !== 0)) return hidden
      const cameraWorld = view.clone().invert()
      if (!cameraWorld.elements.every(Number.isFinite) || cameraWorld.elements[15] <= EPSILON) return hidden
      // Matrix inversion can leave affine w slightly different from 1. Use the actual eye.
      const cameraPosition = new THREE.Vector3().setFromMatrixPosition(cameraWorld).divideScalar(cameraWorld.elements[15])
      const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, view).elements
      const points = new Float64Array(16), world = [0, 0, 0], selected: Projected[] = []
      let smallest = 0
      for (const rectangle of this.rectangles) {
        const { axis, sign, plane, u0, v0, u1, v1 } = rectangle
        const facing = sign * (perspective ? cameraPosition.getComponent(axis) - plane : cameraWorld.elements[8 + axis])
        if (facing <= EPSILON || !Number.isFinite(facing)) continue
        const u = (axis + 1) % 3, v = (axis + 2) % 3
        let valid = true
        for (let corner = 0; corner < 4; corner++) {
          world[axis] = plane
          world[u] = corner === 1 || corner === 2 ? u1 : u0
          world[v] = corner >= 2 ? v1 : v0
          valid &&= project(world[0], world[1], world[2], matrix, width, height, points, corner * 2)
        }
        if (!valid) continue
        let area = 0
        for (let corner = 0; corner < 4; corner++) {
          const next = (corner + 1) % 4
          area += points[corner * 2] * points[next * 2 + 1] - points[next * 2] * points[corner * 2 + 1]
        }
        const winding = Math.sign(area)
        area = Math.abs(area) / 2
        if (!Number.isFinite(area) || area < 256 || selected.length === MAX_OCCLUDERS && area <= selected[smallest].area) continue
        const edges = new Float64Array(12)
        for (let corner = 0; corner < 4; corner++) {
          const next = (corner + 1) % 4, opposite = (corner + 2) % 4
          const dx = points[next * 2] - points[corner * 2], dy = points[next * 2 + 1] - points[corner * 2 + 1]
          const length = Math.hypot(dx, dy), nx = -dy * winding / length, ny = dx * winding / length
          const constant = -nx * points[corner * 2] - ny * points[corner * 2 + 1]
          valid &&= length > EPSILON && Number.isFinite(constant) && nx * points[opposite * 2] + ny * points[opposite * 2 + 1] + constant > EPSILON
          edges[corner * 3] = nx; edges[corner * 3 + 1] = ny; edges[corner * 3 + 2] = constant
        }
        if (!valid) continue
        const occluder = { rectangle, edges, area }
        if (selected.length < MAX_OCCLUDERS) selected.push(occluder)
        else selected[smallest] = occluder
        smallest = 0
        for (let index = 1; index < selected.length; index++) if (selected[index].area < selected[smallest].area) smallest = index
      }
      this.stats.occluders = selected.length
      if (!selected.length) return hidden
      const pinned = new Set<number>()
      for (const { rectangle } of selected) for (let source: Source | undefined = rectangle.first; source; source = source.next) pinned.add(source.entry.chunkId)
      for (const [chunkId, candidate] of this.candidates) {
        const { bounds } = candidate
        if (!candidate.valid || pinned.has(chunkId) || !validBounds(bounds) || bounds.containsPoint(cameraPosition)) continue
        let valid = true
        for (let corner = 0; corner < 8; corner++) {
          valid &&= project(corner & 1 ? bounds.max.x : bounds.min.x, corner & 2 ? bounds.max.y : bounds.min.y,
            corner & 4 ? bounds.max.z : bounds.min.z, matrix, width, height, points, corner * 2)
        }
        if (!valid) continue
        for (const { rectangle, edges } of selected) {
          const { axis, sign, plane } = rectangle
          const extreme = (sign > 0 ? bounds.max : bounds.min).getComponent(axis)
          const margin = 1e-4 * Math.max(1, Math.abs(plane), Math.abs(extreme))
          if (sign * (extreme - plane) >= -margin) continue
          let inside = true
          for (let corner = 0; corner < 8 && inside; corner++) for (let edge = 0; edge < 4 && inside; edge++) {
            inside = edges[edge * 3] * points[corner * 2] + edges[edge * 3 + 1] * points[corner * 2 + 1] + edges[edge * 3 + 2] > PIXEL_MARGIN
          }
          if (!inside) continue
          for (const mesh of candidate.meshes) hidden.add(mesh)
          this.stats.culledChunks++
          break
        }
      }
      this.stats.culledMeshes = hidden.size
      return hidden
    } finally { this.stats.milliseconds = performance.now() - started }
  }
}
