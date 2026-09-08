import { expect, spyOn, test } from 'bun:test'
import * as THREE from 'three'
import { ModelOcclusion } from './occlusion'
import { VoxelDocument, chunkId } from '../../shared/voxel/document'
import { meshChunk } from '../../shared/voxel/mesher'

type Quad = [signedAxis: number, plane: number, u0: number, v0: number, u1: number, v1: number]

function surface(...quads: Quad[]) {
  const positions: number[] = [], indices: number[] = []
  for (const [signedAxis, plane, u0, v0, u1, v1] of quads) {
    const axis = Math.abs(signedAxis) - 1, u = (axis + 1) % 3, v = (axis + 2) % 3, vertex = positions.length / 3
    for (let corner = 0; corner < 4; corner++) {
      const winding = signedAxis > 0 ? corner : 3 - corner, point = [0, 0, 0]
      point[axis] = plane
      point[u] = winding === 1 || winding === 2 ? u1 : u0
      point[v] = winding >= 2 ? v1 : v0
      positions.push(...point)
    }
    indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  return new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial())
}

function detail(x = 0, y = 0, z = -4, size = 2) {
  const geometry = new THREE.BoxGeometry(size, size, size)
  geometry.computeBoundingBox()
  const mesh = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial())
  mesh.position.set(x, y, z)
  mesh.updateMatrixWorld(true)
  return mesh
}

function camera(perspective = false, near = 0.1) {
  const camera = perspective ? new THREE.PerspectiveCamera(60, 1, near, 200) : new THREE.OrthographicCamera(-24, 24, 24, -24, near, 200)
  camera.position.set(0, 0, 40)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  return camera
}

function setup(meshes: THREE.Mesh[], ids = meshes.map((_, index) => index)) {
  const occlusion = new ModelOcclusion(), opaqueMeshes = new Set(meshes)
  meshes.forEach((mesh, index) => occlusion.register(mesh, ids[index]))
  const frame = { camera: camera(), width: 1000, height: 1000, opaqueMeshes }
  return { occlusion, frame, cull: () => occlusion.cull(frame) }
}

test('real mesher material-local quads merge across chunk and palette seams, returning only eligible surface identities', () => {
  const document = new VoxelDocument({ x: 32, y: 16, z: 16 })
  for (let x = 0; x < 32; x++) for (let y = 0; y < 16; y++) document.setVoxel(x, y, 8, x % 16 < 8 ? 1 : 2)
  const meshes: THREE.Mesh[] = [], ids: number[] = []
  for (let cx = 0; cx < 2; cx++) {
    const id = chunkId(cx, 0, 0), data = meshChunk(document.paddedChunk(id))
    for (const group of data.groups) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.subarray(group.vertexStart * 3, (group.vertexStart + group.vertexCount) * 3), 3))
      geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(group.start, group.start + group.count).map(index => index - group.vertexStart), 1))
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...group.bounds.slice(0, 3)), new THREE.Vector3(...group.bounds.slice(3)))
      const mesh = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial())
      mesh.position.set(cx * 16 - 16, -8, 0)
      mesh.updateMatrixWorld(true)
      meshes.push(mesh); ids.push(id)
    }
  }
  const rear = detail(), rearMaterial = detail(0, 2, -4), ghost = detail(100)
  const { occlusion, frame, cull } = setup([...meshes, rear, rearMaterial, ghost], [...ids, 100, 100, 100])
  frame.opaqueMeshes.delete(ghost)
  for (const perspective of [false, true]) {
    frame.camera = camera(perspective)
    expect(cull()).toEqual(new Set([rear, rearMaterial]))
    expect(occlusion.lastFrame).toMatchObject({ candidates: 3, occluders: 1, culledChunks: 1, culledMeshes: 2 })
    expect(occlusion.lastFrame.milliseconds).toBeGreaterThanOrEqual(0)
  }
})

test('gaps, holes with covered corners, L shapes, disconnected rectangles, and partial exposure remain visible', () => {
  const cases: { quads: Quad[]; rear: THREE.Mesh }[] = [
    { quads: [[3, 0, -8, -8, -1, 8], [3, 0, 1, -8, 8, 8]], rear: detail(0, 0, -4, 4) },
    { quads: [[3, 0, -8, -8, -1, 8], [3, 0, 1, -8, 8, 8], [3, 0, -1, -8, 1, -1], [3, 0, -1, 1, 1, 8]], rear: detail(0, 0, -4, 4) },
    { quads: [[3, 0, -8, -8, 0, 8], [3, 0, 0, -8, 8, 0]], rear: detail(4, 4) },
    { quads: [[3, 0, -8, -8, -2, -2], [3, 0, 2, 2, 8, 8]], rear: detail() },
    { quads: [[3, 0, -8, -8, 8, 8]], rear: detail(8, 0) },
  ]
  for (const { quads, rear } of cases) {
    const { cull } = setup([...quads.map(quad => surface(quad)), rear])
    expect(cull().has(rear)).toBe(false)
  }
})

test('coalescing uses exact voxel edges, never an epsilon that bridges a small gap', () => {
  const left = surface([3, 0, -8, -8, 0, 8]), right = surface([3, 0, 0, -8, 8, 8]), rear = detail()
  const { occlusion, cull } = setup([left, right, rear])
  expect(cull()).toEqual(new Set([rear]))
  right.position.x = 1e-6
  right.updateMatrixWorld(true)
  expect(cull().size).toBe(0)
  expect(occlusion.lastFrame.rebuilds).toBe(1)
  right.position.x = 0
  const parent = new THREE.Group()
  parent.position.set(0.5, 0.5, 0.5)
  parent.add(left, right, rear)
  parent.updateMatrixWorld(true)
  expect(cull()).toEqual(new Set([rear]))
})

test('unit quads merge across materials before the area cutoff; empty caches skip camera work but still track eligibility', () => {
  const tiles = Array.from({ length: 16 }, (_, index) => {
    const x = index % 4, y = Math.floor(index / 4)
    return surface([3, 0, x, y, x + 1, y + 1])
  })
  const rear = detail(2, 2, -4, 1), { occlusion, frame, cull } = setup([...tiles, rear])
  const cameraWork = spyOn(frame.camera.matrixWorldInverse, 'determinant')
  try {
    expect(cull()).toEqual(new Set([rear]))
    expect(occlusion.lastFrame).toMatchObject({ rectangles: 1, occluders: 1 })
    expect(cameraWork).toHaveBeenCalledTimes(1)
    cameraWork.mockClear()
    frame.opaqueMeshes.delete(tiles[0])
    expect(cull().size).toBe(0)
    expect(occlusion.lastFrame).toMatchObject({ candidates: 16, rectangles: 0, occluders: 0, culledMeshes: 0, rebuilds: 1 })
    expect(cull().size).toBe(0)
    expect(occlusion.lastFrame.rebuilds).toBe(0)
    expect(cameraWork).not.toHaveBeenCalled()
    frame.opaqueMeshes.add(tiles[0])
    expect(cull()).toEqual(new Set([rear]))
    expect(occlusion.lastFrame).toMatchObject({ rectangles: 1, rebuilds: 1 })
    expect(cameraWork).toHaveBeenCalledTimes(1)
  } finally { cameraWork.mockRestore() }
})

test('both signed face directions and projected windings work on every axis, but backfaces never block', () => {
  for (const perspective of [false, true]) for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const blocker = surface([sign * (axis + 1), 0, -8, -8, 8, 8]), rear = detail(0, 0, 0)
    rear.position.setComponent(axis, -sign * 4)
    rear.updateMatrixWorld(true)
    const { occlusion, frame, cull } = setup([blocker, rear])
    frame.camera = camera(perspective)
    frame.camera.position.set(0, 0, 0).setComponent(axis, sign * 40)
    frame.camera.up.set(0, axis === 1 ? 0 : 1, axis === 1 ? 1 : 0)
    frame.camera.lookAt(0, 0, 0)
    frame.camera.updateMatrixWorld(true)
    expect(cull()).toEqual(new Set([rear]))
    blocker.geometry = surface([-sign * (axis + 1), 0, -8, -8, 8, 8]).geometry
    occlusion.register(blocker, 0)
    expect(cull().size).toBe(0)
    expect(occlusion.lastFrame.occluders).toBe(0)
  }
})

test('orthographic negative near planes use ray direction, including blockers behind the camera position', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail()
  const { frame, cull } = setup([blocker, rear])
  frame.camera = camera(false, -100)
  frame.camera.position.z = -2
  frame.camera.lookAt(0, 0, -10)
  frame.camera.updateMatrixWorld(true)
  expect(cull()).toEqual(new Set([rear]))
  frame.camera.lookAt(0, 0, 10)
  frame.camera.updateMatrixWorld(true)
  expect(cull().size).toBe(0)
})

test('world-plane separation and all eight projected box corners reject front-side and diamond-AABB false positives', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail(), inFront = detail(-5, 0, 1)
  const { frame, cull } = setup([blocker, rear, inFront])
  frame.camera = camera(true)
  frame.camera.position.set(15, 0, 20)
  frame.camera.lookAt(0, 0, 0)
  frame.camera.updateMatrixWorld(true)
  expect(cull()).toEqual(new Set([rear]))

  const exposed = detail(9, 0, -4, 0.5), rolled = setup([blocker, exposed])
  rolled.frame.camera.rotation.z = Math.PI / 4
  rolled.frame.camera.updateMatrixWorld(true)
  expect(rolled.cull().size).toBe(0)
  const touching = surface([3, 0, -1, -1, 1, 1]), tie = setup([blocker, touching])
  expect(tie.cull().size).toBe(0)
  touching.position.z = -1e-6
  touching.updateMatrixWorld(true)
  expect(tie.cull().size).toBe(0)
})

test('near-clipped and near-crossing occluders fail open for perspective and orthographic cameras', () => {
  for (const perspective of [false, true]) {
    const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail(0, 0, -8)
    const { occlusion, frame, cull } = setup([blocker, rear])
    frame.camera = camera(perspective, 12)
    frame.camera.position.set(8, 0, 12)
    frame.camera.lookAt(0, 0, 0)
    frame.camera.updateMatrixWorld(true)
    expect(cull().size).toBe(0)
    expect(occlusion.lastFrame.occluders).toBe(0)
    frame.camera.position.set(0, 0, 5)
    frame.camera.lookAt(0, 0, 0)
    frame.camera.updateMatrixWorld(true)
    expect(cull().size).toBe(0)
  }
})

test('perspective containment checks mixed box corners, not just the projected min/max diagonal', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail(2, 2, -7, 10)
  const { frame, cull } = setup([blocker, rear])
  frame.camera = camera(true)
  frame.camera.position.set(12, 8, 20)
  frame.camera.lookAt(0, 0, 0)
  frame.camera.updateMatrixWorld(true)
  const bounds = rear.geometry.boundingBox!.clone().translate(rear.position)
  // Both diagonal corners' sight lines hit the blocker; a mixed far corner misses it.
  for (const point of [bounds.min, bounds.max]) {
    const hit = point.clone().sub(frame.camera.position).multiplyScalar(20 / (20 - point.z)).add(frame.camera.position)
    expect(Math.abs(hit.x)).toBeLessThan(8)
    expect(Math.abs(hit.y)).toBeLessThan(8)
  }
  expect(12 + (bounds.max.x - 12) * 20 / (20 - bounds.min.z)).toBeGreaterThan(8)
  expect(cull().size).toBe(0)
})

test('eye/near/far crossings, camera-inside, degenerate bounds and nonfinite data stay visible', () => {
  const blocker = surface([3, -4, -8, -8, 8, 8])
  const eye = detail(0, 0, 0, 2), near = detail(0, 0, -1, 1), far = detail(0, 0, -199, 4)
  const line = detail(), invalid = detail(), crossing = detail(0, 0, -4, 2)
  line.geometry.boundingBox!.max.x = line.geometry.boundingBox!.min.x
  line.geometry.boundingBox!.max.y = line.geometry.boundingBox!.min.y
  invalid.geometry.boundingBox!.max.z = NaN
  const { frame, cull } = setup([blocker, eye, near, far, line, invalid, crossing])
  frame.camera = camera(true, 1)
  frame.camera.position.set(0, 0, 0)
  frame.camera.lookAt(0, 0, -1)
  frame.camera.updateMatrixWorld(true)
  expect(cull().size).toBe(0)
  frame.width = NaN
  expect(cull().size).toBe(0)
  frame.width = 1000
  frame.camera.projectionMatrix.elements[0] = Infinity
  expect(cull().size).toBe(0)
})

test('camera motion, projection, zoom and drawing-buffer pixel dimensions are evaluated each time without rebuilding geometry', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail()
  const { occlusion, frame, cull } = setup([blocker, rear])
  frame.camera = camera(true)
  expect(cull()).toEqual(new Set([rear]))
  expect(occlusion.lastFrame.rebuilds).toBe(1)
  frame.camera.position.set(100, 0, 10)
  frame.camera.lookAt(0, 0, 0)
  frame.camera.updateMatrixWorld(true)
  expect(cull().size).toBe(0)
  expect(occlusion.lastFrame.rebuilds).toBe(0)
  frame.camera = camera()
  expect(cull()).toEqual(new Set([rear]))
  expect(occlusion.lastFrame.rebuilds).toBe(0)

  const closeToEdge = detail(6.9, 0, -4), margin = setup([blocker, closeToEdge])
  expect(margin.cull()).toEqual(new Set([closeToEdge]))
  margin.frame.camera.zoom = 0.1
  margin.frame.camera.updateProjectionMatrix()
  expect(margin.cull().size).toBe(0)
  margin.frame.camera.zoom = 1
  margin.frame.camera.updateProjectionMatrix()
  expect(margin.cull()).toEqual(new Set([closeToEdge]))
  margin.frame.width = 100
  expect(margin.cull().size).toBe(0)
  margin.frame.width = 2000
  expect(margin.cull()).toEqual(new Set([closeToEdge]))
  margin.frame.height = 0
  expect(margin.cull().size).toBe(0)
  expect(margin.occlusion.lastFrame.rebuilds).toBe(0)
})

test('ordinary camera inverse roundoff and off-axis views work; projective view matrices fail open', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail(), { occlusion, frame, cull } = setup([blocker, rear])
  let rounded = false
  for (const perspective of [false, true]) {
    frame.camera = camera(perspective)
    frame.camera.setViewOffset(1000, 1000, 100, 50, 800, 900)
    for (let index = 0; index < 32; index++) {
      frame.camera.position.set(Math.sin(index) * 10, Math.cos(index * 0.3) * 5, 40)
      frame.camera.lookAt(0, 0, 0)
      frame.camera.updateMatrixWorld(true)
      rounded ||= frame.camera.matrixWorldInverse.elements[15] !== 1
      expect(cull()).toEqual(new Set([rear]))
    }
    frame.camera.matrixWorldInverse.elements[3] = 0.001
    expect(cull().size).toBe(0)
  }
  expect(rounded).toBe(true)
  expect(occlusion.lastFrame.rebuilds).toBe(0)
})

test('all selected merged-rectangle sources stay drawn even behind another selected blocker', () => {
  const front = surface([3, 8, -8, -8, 8, 8]), left = surface([3, 0, -8, -8, 0, 8]), right = surface([3, 0, 0, -8, 8, 8])
  const rear = detail(), ownerSibling = detail(0, 0, -2)
  const { occlusion, frame, cull } = setup([front, left, right, rear, ownerSibling], [0, 1, 2, 3, 1])
  frame.camera = camera(true)
  expect(cull()).toEqual(new Set([rear]))
  expect(occlusion.lastFrame.occluders).toBe(2)
})

test('only the bounded selected occluders pin owners; unselected blocker meshes remain candidates', () => {
  const front = Array.from({ length: 32 }, () => surface([3, 8, -8, -8, 8, 8]))
  const smaller = surface([3, 0, -4, -4, 4, 4]), rear = detail()
  const { occlusion, cull } = setup([...front, smaller, rear])
  expect(cull()).toEqual(new Set([smaller, rear]))
  expect(occlusion.lastFrame.occluders).toBe(32)
})

test('eligibility is the registered intersection, detects same-set mutations, and never reads or mutates authored materials', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail(), unregistered = surface([3, 2, -8, -8, 8, 8])
  const { occlusion, frame, cull } = setup([blocker, rear])
  Object.assign(blocker.material, { transparent: true, opacity: 0.2, depthWrite: false, visible: false })
  const material = blocker.material, before = material.toJSON()
  expect(cull()).toEqual(new Set([rear])) // The pipeline supplied a supported opaque substitute.
  expect(material.toJSON()).toEqual(before)
  expect(blocker.material).toBe(material)
  frame.opaqueMeshes = new Set([rear, blocker, unregistered])
  expect(cull()).toEqual(new Set([rear]))
  expect(occlusion.lastFrame.rebuilds).toBe(0)
  frame.opaqueMeshes.delete(blocker)
  expect(cull().size).toBe(0)
  expect(occlusion.lastFrame.rebuilds).toBe(1)
  frame.opaqueMeshes.add(blocker)
  expect(cull()).toEqual(new Set([rear]))
  frame.opaqueMeshes.delete(rear)
  expect(cull().size).toBe(0)
  expect(occlusion.lastFrame.candidates).toBe(1)
})

test('normal and isolation surface identities never borrow absent normal/ghost blockers or bounds', () => {
  const normal = surface([3, 0, -8, -8, 8, 8]), isolated = surface([3, 0, -8, -8, -2, 8]), ghost = surface([3, 2, -8, -8, 8, 8]), rear = detail()
  const { frame, cull } = setup([normal, isolated, ghost, rear], [0, 0, 0, 1])
  frame.opaqueMeshes = new Set([normal, rear])
  expect(cull()).toEqual(new Set([rear]))
  frame.opaqueMeshes = new Set([isolated, rear])
  expect(cull().size).toBe(0)
  frame.opaqueMeshes = new Set([normal, rear])
  expect(cull()).toEqual(new Set([rear]))
})

test('registration, replacement, remove and clear invalidate geometry and release old sources', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail()
  const { occlusion, cull } = setup([blocker, rear])
  expect(cull()).toEqual(new Set([rear]))
  const original = blocker.geometry
  blocker.geometry = surface([3, 0, -8, -8, -2, 8]).geometry
  expect(cull().size).toBe(0) // Unannounced geometry is not allowed to use the old cache.
  occlusion.register(blocker, 0)
  expect(cull().size).toBe(0)
  blocker.geometry = original
  occlusion.register(blocker, 0)
  expect(cull()).toEqual(new Set([rear]))
  expect(occlusion.lastFrame.rebuilds).toBe(1)
  occlusion.remove(blocker)
  expect(cull().size).toBe(0)
  occlusion.register(blocker, 0)
  expect(cull()).toEqual(new Set([rear]))
  occlusion.clear()
  expect(cull().size).toBe(0)
  expect(occlusion.lastFrame).toMatchObject({ candidates: 0, rectangles: 0, scannedQuads: 0 })
  occlusion.register(blocker, 0); occlusion.register(rear, 1)
  expect(cull()).toEqual(new Set([rear]))
  occlusion.register(rear, 0) // Chunk ownership changes also rebuild the bounds/pinning.
  expect(cull().size).toBe(0)
})

test('attribute replacement/version, bounds and partial draw-range changes cannot reuse a blocker cache', () => {
  for (const change of [
    (geometry: THREE.BufferGeometry) => geometry.setAttribute('position', geometry.getAttribute('position').clone()),
    (geometry: THREE.BufferGeometry) => { geometry.getAttribute('position').needsUpdate = true },
    (geometry: THREE.BufferGeometry) => geometry.setIndex(geometry.index!.clone()),
    (geometry: THREE.BufferGeometry) => { geometry.index!.needsUpdate = true },
    (geometry: THREE.BufferGeometry) => { geometry.boundingBox!.max.x++ },
    (geometry: THREE.BufferGeometry) => geometry.setDrawRange(0, 3),
  ]) {
    const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail(), { cull } = setup([blocker, rear])
    expect(cull()).toEqual(new Set([rear]))
    change(blocker.geometry)
    expect(cull().size).toBe(0)
  }
})

test('malformed, noninteger, oversized, incomplete and nonplanar quads are never promoted to filled blockers', () => {
  for (const change of [
    (geometry: THREE.BufferGeometry) => { geometry.index!.setX(2, 3) },
    (geometry: THREE.BufferGeometry) => { geometry.getAttribute('position').setZ(3, 1) },
    (geometry: THREE.BufferGeometry) => { geometry.getAttribute('position').setX(0, -7.5) },
    (geometry: THREE.BufferGeometry) => { geometry.getAttribute('position').setX(1, 9); geometry.getAttribute('position').setX(2, 9) },
    (geometry: THREE.BufferGeometry) => { geometry.getAttribute('position').setX(0, NaN) },
    (geometry: THREE.BufferGeometry) => { geometry.boundingBox = null },
    (geometry: THREE.BufferGeometry) => geometry.setDrawRange(0, 3),
  ]) {
    const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail()
    change(blocker.geometry)
    const { occlusion, cull } = setup([blocker, rear])
    expect(cull().size).toBe(0)
    expect(occlusion.lastFrame.occluders).toBe(0)
  }
})

test('current installed translation matrices govern both blockers and tight chunk-union bounds', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail(), exposed = detail(12)
  const { occlusion, frame, cull } = setup([blocker, rear, exposed], [0, 1, 1])
  expect(cull().size).toBe(0)
  frame.opaqueMeshes.delete(exposed)
  expect(cull()).toEqual(new Set([rear]))
  blocker.position.x = 100
  expect(cull()).toEqual(new Set([rear])) // position is not the installed world matrix yet.
  expect(occlusion.lastFrame.rebuilds).toBe(0)
  blocker.updateMatrixWorld(true)
  expect(cull().size).toBe(0)
  blocker.position.x = 0
  blocker.updateMatrixWorld(true)
  expect(cull()).toEqual(new Set([rear]))
  const parent = new THREE.Group()
  parent.position.set(12, 0, 0)
  parent.add(rear)
  parent.updateMatrixWorld(true)
  expect(cull().size).toBe(0)
})

test('scale, rotation, reflection, shear and nonfinite world transforms fail open for every role and chunk sibling', () => {
  const matrices = [new THREE.Matrix4().makeScale(2, 1, 1), new THREE.Matrix4().makeScale(-1, 1, 1),
    new THREE.Matrix4().makeRotationY(Math.PI / 2), new THREE.Matrix4().makeRotationZ(1e-10), new THREE.Matrix4().makeShear(0.1, 0, 0, 0, 0, 0)]
  const nonfinite = new THREE.Matrix4(); nonfinite.elements[12] = NaN; matrices.push(nonfinite)
  for (const matrix of matrices) for (const role of ['blocker', 'candidate']) {
    const blocker = surface([3, 0, -8, -8, 8, 8]), rear = detail(), sibling = detail(0, 2)
    const { cull } = setup([blocker, rear, sibling], [0, 1, 1])
    expect(cull()).toEqual(new Set([rear, sibling]))
    ;(role === 'blocker' ? blocker : rear).matrixWorld.copy(matrix)
    expect(cull().size).toBe(0)
  }
})

test('huge geometry extraction is bounded; unscanned occluders are omitted without losing candidates', () => {
  const huge = surface(...Array.from({ length: 4096 }, (): Quad => [3, 0, 0, 0, 1, 1]), [3, 0, -8, -8, 8, 8]), rear = detail()
  const reads = spyOn(huge.geometry.getAttribute('position'), 'getX')
  const { occlusion, cull, frame } = setup([huge, rear])
  expect(reads.mock.calls.length).toBeLessThanOrEqual(2048 * 4)
  expect(cull().size).toBe(0)
  expect(occlusion.lastFrame.rectangles).toBe(0)
  expect(occlusion.lastFrame.scannedQuads).toBeLessThanOrEqual(2048 + 6)
  const before = reads.mock.calls.length
  cull(); cull()
  expect(reads.mock.calls.length).toBe(before)
  reads.mockRestore()
  const blocker = surface([3, 8, -16, -16, 0, 0], [3, 8, 0, -16, 16, 0], [3, 8, -16, 0, 0, 16], [3, 8, 0, 0, 16, 16])
  occlusion.register(blocker, 2); frame.opaqueMeshes.add(blocker)
  expect(cull()).toEqual(new Set([huge, rear]))
})

test('global extraction and merged-descriptor budgets omit overflow blockers, and remove reclaims scan capacity', () => {
  const geometry = surface(...Array.from({ length: 2048 }, (): Quad => [-3, 0, 0, 0, 4, 4])).geometry
  const meshes = Array.from({ length: 32 }, () => new THREE.Mesh(geometry))
  const blocker = surface([3, 8, -8, -8, 8, 8]), rear = detail()
  const { occlusion, cull } = setup([...meshes, blocker, rear])
  expect(cull().size).toBe(0)
  expect(occlusion.lastFrame).toMatchObject({ candidates: 34, scannedQuads: 65_536, rectangles: 8192, occluders: 0 })
  occlusion.remove(meshes[0])
  occlusion.register(blocker, 32)
  expect(cull().has(rear)).toBe(true)
  expect(occlusion.lastFrame.rectangles).toBeLessThanOrEqual(8192)
  expect(occlusion.lastFrame.scannedQuads).toBeLessThanOrEqual(65_536)
})

test('4096 chunks are supported and candidate overflow stays visible', () => {
  const blocker = surface([3, 0, -8, -8, 8, 8]), geometry = detail().geometry
  const details = Array.from({ length: 4096 }, () => {
    const mesh = new THREE.Mesh(geometry)
    mesh.position.z = -4
    mesh.updateMatrixWorld(true)
    return mesh
  })
  const { occlusion, cull } = setup([blocker, ...details])
  const hidden = cull()
  expect(occlusion.lastFrame).toMatchObject({ candidates: 4096, culledChunks: 4095, culledMeshes: 4095 })
  expect(hidden.has(details[4095])).toBe(false)
  expect(hidden.has(blocker)).toBe(false)
})
