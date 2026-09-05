import { VOXLoader } from 'three/addons/loaders/VOXLoader.js'
import { VoxelDocument, type Dimensions } from './editor'

export interface VoxImport {
  document: VoxelDocument
  warning?: string
}

function importedColor(value: number) {
  const red = value & 255
  const green = (value >>> 8) & 255
  const blue = (value >>> 16) & 255
  return (red << 16) | (green << 8) | blue
}

export function importVox(buffer: ArrayBuffer, name = 'Imported model'): VoxImport {
  const result = new VOXLoader().parse(buffer)
  if (!result?.chunks.length || !result.chunks[0].data) throw new Error('This VOX file does not contain a voxel model.')
  const source = result.chunks[0]
  const dimensions: Dimensions = { x: source.size.x, y: source.size.z, z: source.size.y }
  if (dimensions.x > 256 || dimensions.y > 256 || dimensions.z > 256) throw new Error('Voxel Studio supports models up to 256 voxels on each axis.')
  const palette = new Uint32Array(256)
  for (let index = 1; index < 256; index++) palette[index] = importedColor(source.palette[index] ?? 0xffffffff)
  const document = new VoxelDocument(dimensions, name.replace(/\.vox$/i, '') || 'Imported model', palette)
  for (let index = 0; index < source.data.length; index += 4) {
    document.setVoxel(source.data[index], source.data[index + 2], source.data[index + 1], source.data[index + 3])
  }
  return {
    document,
    warning: result.chunks.length > 1 ? `This file contains ${result.chunks.length} models. The first model was imported.` : undefined,
  }
}

function writeId(view: DataView, offset: number, id: string) {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, id.charCodeAt(i))
}

function writeChunkHeader(view: DataView, offset: number, id: string, size: number) {
  writeId(view, offset, id)
  view.setUint32(offset + 4, size, true)
  view.setUint32(offset + 8, 0, true)
}

export function exportVox(document: VoxelDocument) {
  let visibleVoxels = 0
  document.forEachVoxel((_x, _y, _z, _color, layerId) => { if (document.getLayer(layerId)?.visible) visibleVoxels++ })
  const voxelBytes = visibleVoxels * 4
  const childrenSize = 24 + 16 + voxelBytes + 12 + 1024
  const buffer = new ArrayBuffer(20 + childrenSize)
  const view = new DataView(buffer)
  writeId(view, 0, 'VOX ')
  view.setUint32(4, 150, true)
  writeChunkHeader(view, 8, 'MAIN', 0)
  view.setUint32(16, childrenSize, true)

  let offset = 20
  writeChunkHeader(view, offset, 'SIZE', 12)
  view.setUint32(offset + 12, document.dimensions.x, true)
  view.setUint32(offset + 16, document.dimensions.z, true)
  view.setUint32(offset + 20, document.dimensions.y, true)
  offset += 24

  writeChunkHeader(view, offset, 'XYZI', 4 + voxelBytes)
  view.setUint32(offset + 12, visibleVoxels, true)
  offset += 16
  document.forEachVoxel((x, y, z, color, layerId) => {
    if (!document.getLayer(layerId)?.visible) return
    view.setUint8(offset++, x)
    view.setUint8(offset++, z)
    view.setUint8(offset++, y)
    view.setUint8(offset++, color)
  })

  writeChunkHeader(view, offset, 'RGBA', 1024)
  offset += 12
  for (let index = 1; index <= 256; index++) {
    const hex = index < 256 ? document.palette[index] : 0
    view.setUint8(offset++, (hex >> 16) & 255)
    view.setUint8(offset++, (hex >> 8) & 255)
    view.setUint8(offset++, hex & 255)
    view.setUint8(offset++, 255)
  }
  return buffer
}
