import { expect, test } from 'bun:test'
import { chunkId, PADDED_SIZE, VoxelDocument } from '../../src/shared/voxel/document'
import { CubeSprites, packChunk } from './index'

test('sprite cells preserve palette indices and visible layers, and cull enclosed cells across chunk seams', () => {
  const document = new VoxelDocument({ x: 32, y: 16, z: 16 })
  document.palette[7] = 0
  document.setVoxel(15, 5, 5, 7)
  let cells = packChunk(document.paddedChunk(chunkId(0, 0, 0), true))
  const payloads = () => [...packChunk(document.paddedChunk(0, true))].map(cell => cell & 0xfffff)
  expect([...cells]).toEqual([15 | 5 << 4 | 5 << 8 | 7 << 12])
  for (const [x, y, z] of [[14, 5, 5], [16, 5, 5], [15, 4, 5], [15, 6, 5], [15, 5, 4], [15, 5, 6]]) document.setVoxel(x, y, z, 3)
  expect(payloads()).not.toContain(cells[0])
  document.setVoxel(16, 5, 5, 0)
  expect(payloads()).toContain(cells[0])
  expect([...packChunk(document.paddedChunk(0, true))].find(cell => (cell & 0xfffff) === cells[0])! >>> 20).toBe(61)
  document.activeLayer.visible = false
  expect(packChunk(document.paddedChunk(0, true))).toHaveLength(0)
  document.activeLayer.visible = true
  const layer = document.createLayer()
  document.setVoxel(15, 5, 5, 12)
  expect(payloads()).toContain(15 | 5 << 4 | 5 << 8 | 12 << 12)
  layer.visible = false
  expect(payloads()).toContain(cells[0])
  expect(packChunk(new Uint8Array(PADDED_SIZE ** 3))).toHaveLength(0)
  expect(() => packChunk(new Uint8Array(1))).toThrow('padded')
  const sprites = new CubeSprites(document)
  sprites.dispose(); sprites.dispose()
  expect(() => sprites.setDocument(document)).toThrow('disposed')
})
