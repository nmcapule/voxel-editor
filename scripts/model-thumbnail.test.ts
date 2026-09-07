import { expect, test } from 'bun:test'
import { crc32, inflateSync } from 'node:zlib'
import { VoxelDocument } from '../src/editor'
import { renderModelThumbnail, THUMBNAIL_SIZE } from './model-thumbnail'

// Independent, deliberately slow CRC oracle: catches the wrong polynomial or byte order.
function referenceCRC(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function decode(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(png.length).toBeLessThan(264 * 1024)
  const chunks: { type: string; data: Buffer }[] = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    expect(offset + length + 12).toBeLessThanOrEqual(png.length)
    expect(png.readUInt32BE(offset + length + 8)).toBe(referenceCRC(png.subarray(offset + 4, offset + 8 + length)))
    chunks.push({ type: png.toString('ascii', offset + 4, offset + 8), data: png.subarray(offset + 8, offset + 8 + length) })
    offset += length + 12
  }
  expect(offset).toBe(png.length)
  expect(chunks.map(chunk => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  expect(chunks[0].data.length).toBe(13)
  expect(chunks[0].data.readUInt32BE(0)).toBe(256)
  expect(chunks[0].data.readUInt32BE(4)).toBe(256)
  expect([...chunks[0].data.subarray(8)]).toEqual([8, 6, 0, 0, 0])
  expect(chunks[2].data.length).toBe(0)
  const raw = inflateSync(chunks[1].data)
  expect(raw.length).toBe(256 * (256 * 4 + 1))
  const rgba = Buffer.alloc(256 * 256 * 4)
  for (let row = 0; row < 256; row++) {
    const start = row * (256 * 4 + 1)
    expect(raw[start]).toBe(0)
    raw.copy(rgba, row * 256 * 4, start + 1, start + 1 + 256 * 4)
  }
  return rgba
}

const pixel = (rgba: Buffer, x: number, y: number) => [...rgba.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)]

test('native PNG CRC matches the standard check vector and independent CRC', () => {
  const bytes = Buffer.from('123456789')
  expect(crc32(bytes)).toBe(0xcbf43926)
  expect(referenceCRC(bytes)).toBe(0xcbf43926)
  expect(crc32(Buffer.alloc(0))).toBe(0)
})

test('PNG is fixed-size RGBA with three isometric faces, fixed shading, and transparent margins', () => {
  expect(THUMBNAIL_SIZE).toBe(256)
  const document = new VoxelDocument()
  document.palette[1] = 0xc86432
  document.setVoxel(2, 3, 4, 1)
  const png = renderModelThumbnail(document)
  const rgba = decode(png)
  expect(pixel(rgba, 128, 65)).toEqual([200, 100, 50, 255])
  expect(pixel(rgba, 180, 156)).toEqual([160, 80, 40, 255])
  expect(pixel(rgba, 75, 156)).toEqual([120, 60, 30, 255])
  for (let i = 0; i < 256; i++) {
    expect(pixel(rgba, i, 15)).toEqual([0, 0, 0, 0])
    expect(pixel(rgba, i, 240)).toEqual([0, 0, 0, 0])
  }
  const translated = new VoxelDocument({ x: 256, y: 256, z: 256 })
  translated.palette[1] = document.palette[1]
  translated.setVoxel(202, 113, 54, 1)
  expect(renderModelThumbnail(translated)).toEqual(png)
})

test('nearest 3D geometry wins along (1,1,1), independent of chunk insertion order', () => {
  const front = new VoxelDocument()
  front.setVoxel(20, 20, 20, 6)
  const expected = renderModelThumbnail(front)
  for (const coordinates of [[2, 20], [20, 2]]) {
    const document = new VoxelDocument()
    for (const value of coordinates) document.setVoxel(value, value, value, value === 20 ? 6 : 5)
    expect(renderModelThumbnail(document)).toEqual(expected)
    document.setVoxel(20, 20, 20, 0)
    expect(renderModelThumbnail(document)).not.toEqual(expected)
  }
})

test('asymmetric geometry and gaps agree with independent per-cube ray intersections', () => {
  const document = new VoxelDocument()
  const cells = [[2, 3, 4, 1], [3, 3, 4, 2], [2, 4, 4, 3], [2, 3, 5, 4], [7, 8, 9, 5], [6, 2, 7, 6]]
  for (const [x, y, z, color] of cells) document.setVoxel(x, y, z, color)
  const rgba = decode(renderModelThumbnail(document))
  const projected: number[][] = []
  for (const [x, y, z] of cells) for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) {
    projected.push([(x + dx - z - dz) / Math.sqrt(2), (2 * (y + dy) - x - dx - z - dz) / Math.sqrt(6)])
  }
  const minU = Math.min(...projected.map(p => p[0])), maxU = Math.max(...projected.map(p => p[0]))
  const minV = Math.min(...projected.map(p => p[1])), maxV = Math.max(...projected.map(p => p[1]))
  const scale = Math.max(maxU - minU, maxV - minV) / 224
  for (let row = 3; row < 256; row += 7) for (let column = 3; column < 256; column += 7) {
    const u = (minU + maxU) / 2 + (column + 0.5 - 128) * scale
    const v = (minV + maxV) / 2 + (128 - row - 0.5) * scale
    const origin = [u / Math.sqrt(2) - v / Math.sqrt(6), 2 * v / Math.sqrt(6), -u / Math.sqrt(2) - v / Math.sqrt(6)]
    let nearest = -Infinity
    let expected = [0, 0, 0, 0]
    for (const cell of cells) {
      const near = origin.map((value, axis) => cell[axis] + 1 - value)
      const far = origin.map((value, axis) => cell[axis] - value)
      const entry = Math.min(...near)
      if (entry <= Math.max(...far) || entry <= nearest) continue
      nearest = entry
      const shade = [0.8, 1, 0.6][near.indexOf(entry)]
      const rgb = document.palette[cell[3]]
      expected = [Math.round((rgb >> 16) * shade), Math.round(((rgb >> 8) & 255) * shade), Math.round((rgb & 255) * shade), 255]
    }
    expect(pixel(rgba, column, row)).toEqual(expected)
  }
})

test('topmost visible overlap wins, hidden bounds are ignored, and locked black stays opaque', () => {
  const document = new VoxelDocument()
  document.setVoxel(2, 3, 4, 5)
  const bottom = renderModelThumbnail(document)
  const upper = document.createLayer()
  document.setVoxel(2, 3, 4, 255)
  upper.locked = true
  document.palette[255] = 0
  document.materials[255].opacity = 0
  document.materials[255].transmission = 1
  document.materials[255].emissiveIntensity = 5
  const black = renderModelThumbnail(document)
  const rgba = decode(black)
  expect(pixel(rgba, 128, 65)).toEqual([0, 0, 0, 255])
  expect(rgba.some((byte, index) => index % 4 !== 3 && byte !== 0)).toBe(false)
  const hidden = document.createLayer()
  document.setVoxel(2, 3, 4, 7)
  document.setVoxel(31, 0, 31, 7)
  hidden.visible = false
  expect(renderModelThumbnail(document)).toEqual(black)
  upper.visible = false
  expect(renderModelThumbnail(document)).toEqual(bottom)
  upper.visible = true
  document.layers.reverse()
  expect(renderModelThumbnail(document)).toEqual(bottom)
})

test('empty and fully hidden models are deterministic, completely transparent PNGs', () => {
  const document = new VoxelDocument()
  const empty = renderModelThumbnail(document)
  expect(decode(empty).every(byte => byte === 0)).toBe(true)
  document.setVoxel(0, 0, 0, 1)
  document.activeLayer.visible = false
  expect(renderModelThumbnail(document)).toEqual(empty)
  expect(renderModelThumbnail(new VoxelDocument({ x: 256, y: 256, z: 256 }))).toEqual(empty)
})

test('256-cubed sparse geometry spanning all 4096 chunks remains bounded', () => {
  const document = new VoxelDocument({ x: 256, y: 256, z: 256 })
  for (let z = 0; z < 256; z += 16) for (let y = 0; y < 256; y += 16) for (let x = 0; x < 256; x += 16) {
    document.setVoxel(x, y, z, 1 + (x + y + z) % 31)
  }
  document.setVoxel(255, 255, 255, 1)
  expect(document.chunks.size).toBe(4096)
  const png = renderModelThumbnail(document)
  expect(decode(png).some((byte, index) => index % 4 === 3 && byte === 255)).toBe(true)
  expect(renderModelThumbnail(document)).toEqual(png)
}, 15_000)
