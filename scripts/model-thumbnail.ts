import { crc32, deflateSync } from 'node:zlib'
import type { VoxelDocument } from '../src/shared/voxel/document'

export const THUMBNAIL_SIZE = 256

function pngChunk(type: string, data = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, 4, 'ascii')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}

export function renderModelThumbnail(document: VoxelDocument) {
  const size = THUMBNAIL_SIZE
  const stride = size * 4 + 1
  const pixels = Buffer.alloc(stride * size) // PNG filter 0 followed by RGBA on each row.
  const { x: X, y: Y, z: Z } = document.dimensions
  const field = new Uint8Array(X * Y * Z) // Palette indices, not RGB: occupied black must survive.
  const right = 1 / Math.sqrt(2), up = 1 / Math.sqrt(6)
  let minX = X, minY = Y, minZ = Z, maxX = 0, maxY = 0, maxZ = 0
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
  document.forEachVisibleVoxel((x, y, z, color) => {
    field[x + X * (y + Y * z)] = color
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x + 1); maxY = Math.max(maxY, y + 1); maxZ = Math.max(maxZ, z + 1)
    // Project occupied cubes, not the empty corners of their world-space bounding box.
    const u = (x - z) * right, v = (2 * y - x - z) * up
    minU = Math.min(minU, u - right); maxU = Math.max(maxU, u + right)
    minV = Math.min(minV, v - 2 * up); maxV = Math.max(maxV, v + 2 * up)
  })

  if (minU !== Infinity) {
    const scale = Math.max(maxU - minU, maxV - minV) / (size - 32)
    const centerU = (minU + maxU) / 2, centerV = (minV + maxV) / 2
    for (let row = 0; row < size; row++) {
      const v = centerV + (size / 2 - row - 0.5) * scale
      for (let column = 0; column < size; column++) {
        const u = centerU + (column + 0.5 - size / 2) * scale
        // Orthographic camera at +(1,1,1), Y up. Trace q + t*(1,1,1) with decreasing t.
        const qx = u * right - v * up, qy = 2 * v * up, qz = -u * right - v * up
        const enterX = maxX - qx, enterY = maxY - qy, enterZ = maxZ - qz
        const enter = Math.min(enterX, enterY, enterZ)
        if (enter <= Math.max(minX - qx, minY - qy, minZ - qz)) continue
        const px = qx + enter, py = qy + enter, pz = qz + enter
        let x = Math.floor(px - 1e-7), y = Math.floor(py - 1e-7), z = Math.floor(pz - 1e-7)
        let nextX = px - x, nextY = py - y, nextZ = pz - z
        let face = enterX <= enterY && enterX <= enterZ ? 0 : enterY <= enterZ ? 1 : 2
        // Each step decreases at least one coordinate: at most X+Y+Z (768) cells per pixel.
        while (x >= minX && y >= minY && z >= minZ) {
          const color = field[x + X * (y + Y * z)]
          if (color) {
            const rgb = document.palette[color]
            const shade = face === 0 ? 0.8 : face === 1 ? 1 : 0.6
            const offset = row * stride + 1 + column * 4
            pixels[offset] = Math.round(((rgb >> 16) & 255) * shade)
            pixels[offset + 1] = Math.round(((rgb >> 8) & 255) * shade)
            pixels[offset + 2] = Math.round((rgb & 255) * shade)
            pixels[offset + 3] = 255
            break
          }
          const next = Math.min(nextX, nextY, nextZ) + 1e-9
          // Cross tied edges together; zero-area neighboring cells must not occlude the ray.
          face = nextX <= next ? 0 : nextY <= next ? 1 : 2
          if (nextX <= next) { x--; nextX++ }
          if (nextY <= next) { y--; nextY++ }
          if (nextZ <= next) { z--; nextZ++ }
        }
      }
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6 // 8-bit RGBA, no interlacing.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND'),
  ])
}
