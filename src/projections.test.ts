import { expect, spyOn, test } from 'bun:test'
import { VoxelDocument } from './editor'
import { faceViews, projectFaces, type FaceView } from './projections'

function pixel(face: ReturnType<typeof projectFaces>[number], u: number, v: number) {
  const offset = (u + v * face.width) * 4
  return [...face.rgba.slice(offset, offset + 4)]
}

test('all six faces retain non-cubic extents and exact pixel axes', () => {
  const document = new VoxelDocument({ x: 17, y: 19, z: 23 })
  document.palette[1] = 0x12abef
  document.palette[2] = 0x345678
  document.setVoxel(2, 3, 5, 1)
  document.setVoxel(16, 18, 22, 2)
  const faces = projectFaces(document)
  expect(faces.map(face => face.name)).toEqual(['front', 'back', 'left', 'right', 'top', 'bottom'])
  const expected = [
    [17, 19, 2, 15, 16, 0, '+Z (max z)', 'u=x, v=Y-1-y'],
    [17, 19, 14, 15, 0, 0, '-Z (min z)', 'u=X-1-x, v=Y-1-y'],
    [23, 19, 5, 15, 22, 0, '-X (min x)', 'u=z, v=Y-1-y'],
    [23, 19, 17, 15, 0, 0, '+X (max x)', 'u=Z-1-z, v=Y-1-y'],
    [17, 23, 2, 5, 16, 22, '+Y (max y)', 'u=x, v=z'],
    [17, 23, 2, 17, 16, 0, '-Y (min y)', 'u=x, v=Z-1-z'],
  ] as const
  faces.forEach((face, index) => {
    const [width, height, u, v, edgeU, edgeV, direction, pixelAxes] = expected[index]
    expect(face).toMatchObject({ width, height, direction, pixelAxes })
    expect(face.rgba).toBeInstanceOf(Uint8ClampedArray)
    const rgba = new Uint8ClampedArray(width * height * 4)
    rgba.set([0x12, 0xab, 0xef, 255], (u + v * width) * 4)
    rgba.set([0x34, 0x56, 0x78, 255], (edgeU + edgeV * width) * 4)
    expect(face.rgba).toEqual(rgba)
  })
})

test.each(['x', 'y', 'z'] as const)('nearest occupied voxel wins along %s in both directions and chunk orders', axis => {
  for (const coordinates of [[0, 15, 16, 31], [31, 16, 15, 0]]) {
    const document = new VoxelDocument()
    document.palette[1] = 0x123456
    document.palette[2] = 0xabcdef
    for (const coordinate of coordinates) {
      const cell = { x: 2, y: 3, z: 5, [axis]: coordinate }
      document.setVoxel(cell.x, cell.y, cell.z, coordinate === 0 ? 1 : coordinate === 31 ? 2 : 3)
    }
    const faces = projectFaces(document)
    const expected: [FaceView, number, number, number[]][] = axis === 'x'
      ? [['left', 5, 28, [0x12, 0x34, 0x56, 255]], ['right', 26, 28, [0xab, 0xcd, 0xef, 255]]]
      : axis === 'y'
        ? [['bottom', 2, 26, [0x12, 0x34, 0x56, 255]], ['top', 2, 5, [0xab, 0xcd, 0xef, 255]]]
        : [['back', 29, 28, [0x12, 0x34, 0x56, 255]], ['front', 2, 28, [0xab, 0xcd, 0xef, 255]]]
    for (const [name, u, v, rgba] of expected) {
      expect(pixel(faces.find(face => face.name === name)!, u, v)).toEqual(rgba)
    }
  }
})

test('visible layer composition includes locked layers and ignores material transparency', () => {
  const document = new VoxelDocument({ x: 16, y: 16, z: 16 })
  document.palette[1] = 0x123456
  document.palette[2] = 0xabcdef
  document.setVoxel(2, 3, 5, 1)
  const upper = document.createLayer()
  document.setVoxel(2, 3, 5, 2)
  upper.locked = true
  document.materials[2].opacity = 0
  document.materials[2].transmission = 1
  const hidden = document.createLayer()
  document.setVoxel(2, 3, 5, 3)
  document.setVoxel(2, 3, 15, 3)
  hidden.visible = false
  const positions = [[2, 12], [13, 12], [5, 12], [10, 12], [2, 5], [2, 10]]
  for (const visible of [true, false]) {
    upper.visible = visible
    projectFaces(document).forEach((face, index) => {
      expect(pixel(face, ...positions[index] as [number, number])).toEqual(visible
        ? [0xab, 0xcd, 0xef, 255] : [0x12, 0x34, 0x56, 255])
    })
  }
  upper.visible = true
  document.setVoxel(2, 3, 4, 1, document.layers[0].id)
  expect(pixel(projectFaces(document, ['front'])[0], 2, 12)).toEqual([0xab, 0xcd, 0xef, 255])
})

test('empty and fully hidden documents produce full-sized transparent images', () => {
  const document = new VoxelDocument({ x: 17, y: 19, z: 23 })
  for (const hidden of [false, true]) {
    if (hidden) {
      document.setVoxel(1, 2, 3, 1)
      document.activeLayer.visible = false
    }
    const faces = projectFaces(document)
    expect(faces.map(face => [face.width, face.height])).toEqual([[17, 19], [17, 19], [23, 19], [23, 19], [17, 23], [17, 23]])
    for (const face of faces) expect(face.rgba).toEqual(new Uint8ClampedArray(face.width * face.height * 4))
  }
})

test('black palette RGB is occupied, not empty', () => {
  const document = new VoxelDocument()
  document.palette[255] = 0
  document.setVoxel(0, 0, 0, 1)
  document.setVoxel(0, 0, 31, 255)
  const [front] = projectFaces(document, ['front'])
  expect(pixel(front, 0, 31)).toEqual([0, 0, 0, 255])
  expect(pixel(front, 1, 31)).toEqual([0, 0, 0, 0])
})

test('requested faces preserve order and use one visible traversal', () => {
  const document = new VoxelDocument()
  document.setVoxel(2, 3, 5, 1)
  const traversal = spyOn(document, 'forEachVisibleVoxel')
  try {
    const views = ['bottom', 'front', 'left'] as const
    expect(projectFaces(document, views).map(face => face.name)).toEqual([...views])
    expect(traversal).toHaveBeenCalledTimes(1)
    traversal.mockClear()
    expect(projectFaces(document).map(face => face.name)).toEqual([...faceViews])
    expect(traversal).toHaveBeenCalledTimes(1)
    traversal.mockClear()
    expect(projectFaces(document, [])).toEqual([])
    expect(traversal).not.toHaveBeenCalled()
  } finally {
    traversal.mockRestore()
  }
})
