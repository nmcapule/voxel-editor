import { VoxelDocument, type Dimensions } from './editor'

export const VOX_EXPORT_WARNING = 'Only visible voxel colors are exported; layers, PBR materials and texture maps are lost. Use a project snapshot for layers/material settings; keep texture files separately.'

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
  const view = new DataView(buffer)
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x20584f56) throw new Error('Invalid or truncated VOX file header.')
  const version = view.getUint32(4, true)
  if (version !== 150 && version !== 200) throw new Error(`Unsupported VOX version: ${version}.`)
  const chunkAt = (offset: number, boundary: number) => {
    if (offset + 12 > boundary) throw new Error('Truncated VOX chunk header.')
    const id = String.fromCharCode(...new Uint8Array(buffer, offset, 4))
    const size = view.getUint32(offset + 4, true)
    const children = view.getUint32(offset + 8, true)
    const content = offset + 12
    const contentEnd = content + size
    const end = contentEnd + children
    if (end > boundary) throw new Error(`Truncated VOX ${id} chunk or invalid byte boundaries.`)
    return { id, size, children, content, contentEnd, end }
  }
  const main = chunkAt(8, buffer.byteLength)
  if (main.id !== 'MAIN' || main.size !== 0 || main.end !== buffer.byteLength) throw new Error('Invalid VOX MAIN chunk boundaries.')

  // MagicaVoxel's default palette: a 6x6x6 RGB cube without black, then four ramps.
  const palette = new Uint32Array(256)
  let colorIndex = 1
  for (let r = 255; r >= 0; r -= 51) for (let g = 255; g >= 0; g -= 51) for (let b = 255; b >= 0; b -= 51) {
    if (r || g || b) palette[colorIndex++] = (r << 16) | (g << 8) | b
  }
  for (const tint of [0xff0000, 0x00ff00, 0x0000ff, 0xffffff]) {
    for (const level of [238, 221, 187, 170, 136, 119, 85, 68, 34, 17]) palette[colorIndex++] = tint & (level * 0x010101)
  }

  let size: Dimensions | undefined
  let source: { size: Dimensions; data: Uint8Array } | undefined
  let models = 0
  let packedModels: number | undefined
  let hasPalette = false
  let hasScene = false
  const boundaries = [main.end]
  let offset = main.contentEnd
  while (boundaries.length) {
    if (offset === boundaries[boundaries.length - 1]) { boundaries.pop(); continue }
    const chunk = chunkAt(offset, boundaries[boundaries.length - 1])
    const { id, content } = chunk
    if (['PACK', 'SIZE', 'XYZI', 'RGBA'].includes(id)) {
      if (boundaries.length !== 1) throw new Error(`VOX ${id} chunks must be direct MAIN children.`)
      if (chunk.children) throw new Error(`Invalid VOX ${id} child chunks.`)
    }
    switch (id) {
      case 'MAIN': throw new Error('Invalid nested VOX MAIN chunk.')
      case 'PACK':
        if (chunk.size !== 4 || packedModels !== undefined) throw new Error('Invalid VOX PACK chunk.')
        packedModels = view.getUint32(content, true)
        if (!packedModels) throw new Error('Invalid VOX PACK model count.')
        break
      case 'SIZE':
        if (chunk.size !== 12 || size) throw new Error('Invalid VOX SIZE chunk or missing XYZI chunk.')
        size = { x: view.getUint32(content, true), y: view.getUint32(content + 4, true), z: view.getUint32(content + 8, true) }
        if (Object.values(size).some(value => value < 1 || value > 256)) throw new Error('VOX source SIZE must be from 1 to 256 on each axis.')
        break
      case 'XYZI': {
        if (!size || chunk.size < 4) throw new Error('Invalid VOX XYZI chunk or missing SIZE chunk.')
        const count = view.getUint32(content, true)
        if (count > size.x * size.y * size.z || chunk.size !== 4 + count * 4) throw new Error('Invalid VOX XYZI voxel count or truncated data.')
        const data = new Uint8Array(buffer, content + 4, count * 4)
        const occupied = new Uint8Array(size.x * size.y * size.z)
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] >= size.x || data[index + 1] >= size.y || data[index + 2] >= size.z) throw new Error('VOX voxel coordinates exceed source SIZE bounds.')
          if (!data[index + 3]) throw new Error('VOX voxel color index 0 is reserved for empty space.')
          const position = data[index] + data[index + 1] * size.x + data[index + 2] * size.x * size.y
          if (occupied[position]) throw new Error('VOX XYZI contains duplicate voxel coordinates.')
          occupied[position] = 1
        }
        source ??= { size, data }
        models++
        size = undefined
        break
      }
      case 'RGBA':
        if (chunk.size !== 1024 || hasPalette) throw new Error('Invalid VOX RGBA palette size or duplicate palette.')
        for (let index = 1; index < 256; index++) palette[index] = importedColor(view.getUint32(content + (index - 1) * 4, true))
        hasPalette = true
        break
      case 'nTRN': case 'nGRP': case 'nSHP': hasScene = true; break
    }
    offset = chunk.contentEnd
    if (chunk.children) boundaries.push(chunk.end)
  }
  if (size) throw new Error('VOX SIZE chunk is missing its XYZI chunk.')
  if (!source) throw new Error('This VOX file does not contain a voxel model.')
  if (packedModels !== undefined && packedModels !== models) throw new Error('VOX PACK model count does not match SIZE/XYZI chunks.')

  // The app's documented front is +Z. Keep the established (x, z, y) mapping,
  // not VOXLoader's scene-space -Y reflection, for external data and internal round-trips.
  const dimensions: Dimensions = { x: source.size.x, y: source.size.z, z: source.size.y }
  // VOX has no unused-slot marker: all 255 entries, including unused black, are authored colors.
  // Explicit occupancy also opts out of legacy app palette/material inference.
  const document = new VoxelDocument(dimensions, name.replace(/\.vox$/i, '') || 'Imported model', palette, undefined, undefined, undefined, new Uint8Array(256).fill(1, 1))
  for (let index = 0; index < source.data.length; index += 4) {
    document.setVoxel(source.data[index], source.data[index + 2], source.data[index + 1], source.data[index + 3])
  }
  const warnings = ['Imported voxel colors only; VOX materials are not preserved. All colors use neutral matte materials.']
  if (models > 1) warnings.unshift(`This file contains ${models} models. The first model was imported.`)
  if (hasScene) warnings.push('Scene transforms and instances were ignored.')
  return {
    document,
    warning: warnings.join(' '),
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
  document.forEachVisibleVoxel(() => visibleVoxels++)
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
  document.forEachVisibleVoxel((x, y, z, color) => {
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
