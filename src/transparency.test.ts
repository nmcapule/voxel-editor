import { describe, expect, test } from 'bun:test'
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { CHUNK_SIZE, VoxelDocument, chunkCoords } from './editor'
import { meshChunk } from './mesher'

const glass = 31
const water = 12
const solid = 3

function traceMaterials(document: VoxelDocument, origin: Vector3, direction: Vector3) {
  const transparent = Uint8Array.from(document.materials, material => Number(material.opacity < 1 || material.transmission > 0))
  const geometry = new BufferGeometry()
  const positions: number[] = []
  const indices: number[] = []
  const center = new Vector3(document.dimensions.x / 2, 0, document.dimensions.z / 2)
  for (const id of document.chunks.keys()) {
    const mesh = meshChunk(document.paddedChunk(id, true), document.palette, false, transparent)
    const chunk = chunkCoords(id)
    const vertexOffset = positions.length / 3
    for (const group of mesh.groups) geometry.addGroup(indices.length + group.start, group.count, group.materialIndex)
    for (let i = 0; i < mesh.positions.length; i += 3) {
      positions.push(
        mesh.positions[i] + chunk.x * CHUNK_SIZE - center.x,
        mesh.positions[i + 1] + chunk.y * CHUNK_SIZE,
        mesh.positions[i + 2] + chunk.z * CHUNK_SIZE - center.z,
      )
    }
    for (const index of mesh.indices) indices.push(index + vertexOffset)
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  const bvh = new MeshBVH(geometry, { indirect: true })
  const ray = new Ray(origin.clone().sub(center), direction.clone().normalize())
  try {
    // Check all hits before stepping so BVH tie order cannot hide coincident opposing faces.
    const hits = bvh.raycast(ray, DoubleSide)
    expect(hits.some((hit, i) => hits.slice(i + 1).some(other =>
      Math.abs(hit.distance - other.distance) < 1e-6 && hit.face!.normal.dot(other.face!.normal) < -0.99,
    )), 'opposing coplanar faces along the ray').toBe(false)

    const materials: number[] = []
    // Straight transmitted paths: reproduce FirstHit, FrontSide rejection and stepRayOrigin,
    // not BSDF sampling. Four ordinary plus ten transmissive traversals match the renderer.
    for (let traversal = 0; traversal < 14; traversal++) {
      const hit = bvh.raycastFirst(ray, DoubleSide)
      if (!hit) return materials
      const face = hit.face!
      const frontFace = face.normal.dot(ray.direction) < 0
      const group = geometry.groups.find(group => hit.faceIndex! * 3 >= group.start && hit.faceIndex! * 3 < group.start + group.count)!
      const material = group.materialIndex!
      if (frontFace) {
        materials.push(material)
        if (!transparent[material]) return materials
      }
      const epsilon = (Math.max(Math.abs(hit.point.x), Math.abs(hit.point.y), Math.abs(hit.point.z)) + 1) * 1e-4
      ray.origin.copy(hit.point).addScaledVector(face.normal, frontFace ? -epsilon : epsilon)
    }
    throw new Error('Traversal budget exhausted')
  } finally {
    geometry.dispose()
  }
}

describe.each([['X', 0], ['Y', 1], ['Z', 2]] as const)('%s transparency interfaces', (_axis, component) => {
  const locations = [
    ['within chunk', 8, 6],
    ['across chunk', 16, 6],
    ['near y=255', 254, 255],
    ['high chunk seam', component === 1 ? 240 : 16, 255],
  ] as const

  test.each(locations.flatMap(([name, boundary, height]) =>
    ([1, -1] as const).map(sign => [name, sign, boundary, height] as const),
  ))('%s, direction %i: both transparent materials precede the solid', (_name, sign, boundary, height) => {
    const document = new VoxelDocument({ x: 256, y: 256, z: 256 })
    const cell = new Vector3(6, height, 6)
    for (const [coordinate, material] of [
      [boundary - 1, glass],
      [boundary, water],
      [sign > 0 ? boundary + 1 : boundary - 2, solid],
    ]) {
      cell.setComponent(component, coordinate)
      document.setVoxel(cell.x, cell.y, cell.z, material)
    }
    const origin = cell.clone().add(new Vector3(0.37, 0.43, 0.61))
    origin.setComponent(component, sign > 0 ? boundary - 1.5 : boundary + 1.5)
    const direction = new Vector3().setComponent(component, sign)
    expect(traceMaterials(document, origin, direction)).toEqual(sign > 0 ? [glass, water, solid] : [water, glass, solid])
  })
})

test.each([[8, 8, 8], [15, 15, 15], [15, 254, 15]])('solid-surrounded water at (%i, %i, %i) retains every wall and floor', (x, y, z) => {
  const document = new VoxelDocument({ x: 256, y: 256, z: 256 })
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    document.setVoxel(x + dx, y + dy, z + dz, dx || dy || dz ? solid : water)
  }
  const origin = new Vector3(x + 0.37, y + 0.43, z + 0.61)
  for (const component of [0, 1, 2]) for (const sign of [-1, 1]) {
    expect(traceMaterials(document, origin, new Vector3().setComponent(component, sign))).toEqual([solid])
  }
})

test('an oblique ray at an inset interface does not hit the same water twice', () => {
  const document = new VoxelDocument()
  document.setVoxel(0, 0, 0, water)
  document.setVoxel(1, 0, 0, glass)
  expect(traceMaterials(document, new Vector3(1.185, 2, 0.43), new Vector3(-0.2, -1, 0))).toEqual([water])
})
