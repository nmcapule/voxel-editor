import { CHUNK_SIZE, CHUNK_VOLUME, VoxelDocument, chunkCoords, type Dimensions, type PaletteMaterial, type VoxelLayer } from './document'
import { StudioCommandError } from '../errors'
import { record, invalid, integer, optional, stringValue, booleanValue, dimensions, base64 } from '../validation'
import { materialPatch } from './material'
import { parseSettings, type ViewSettings } from '../rendering/settings'

export interface ProjectSnapshot {
  schema: 'voxel-studio/project'
  version: 1
  name: string
  dimensions: Dimensions
  palette: number[]
  paletteOccupied?: number[]
  materials: PaletteMaterial[]
  layers: VoxelLayer[]
  activeLayerId: number
  chunks: { id: number; layerId: number; dataBase64: string }[]
  settings: ViewSettings
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

export function base64ToBytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export function encodeProjectSnapshot(document: VoxelDocument, settings: ViewSettings): ProjectSnapshot {
  const order = new Map(document.layers.map((layer, index) => [layer.id, index]))
  const chunks = [...document.chunks].flatMap(([id, layers]) => [...layers].map(([layerId, data]) => ({ id, layerId, dataBase64: bytesToBase64(data) })))
    .sort((a, b) => a.id - b.id || (order.get(a.layerId) ?? 0) - (order.get(b.layerId) ?? 0))
  return {
    schema: 'voxel-studio/project',
    version: 1,
    name: document.name,
    dimensions: { ...document.dimensions },
    palette: [...document.palette],
    paletteOccupied: Array.from(document.palette, (_color, index) => Number(document.hasPaletteColor(index))),
    materials: document.materials.map(material => ({ ...material })),
    layers: document.layers.map(layer => ({ ...layer })),
    activeLayerId: document.activeLayerId,
    chunks,
    settings: { ...settings },
  }
}

export function parseProjectSnapshot(value: unknown): ProjectSnapshot {
  const input = record(value, 'snapshot')
  if (input.schema !== 'voxel-studio/project' || input.version !== 1) throw new StudioCommandError('unsupported_version', 'Unsupported project snapshot.')
  const palette = Array.isArray(input.palette) ? input.palette.map((color, index) => integer(color, `snapshot.palette[${index}]`, 0, 0xffffff)) : []
  if (palette.length !== 256) throw invalid('snapshot.palette must contain 256 colors.')
  const paletteOccupied = optional(input.paletteOccupied, value => {
    if (!Array.isArray(value) || value.length !== 256) throw invalid('snapshot.paletteOccupied must contain 256 occupancy flags.')
    const flags = Array.from(value, (flag, index) => integer(flag, `snapshot.paletteOccupied[${index}]`, 0, 1))
    if (flags[0] !== 0) throw invalid('snapshot.paletteOccupied[0] must be 0 (empty).')
    return flags
  })
  if (!Array.isArray(input.materials) || input.materials.length !== 256) throw invalid('snapshot.materials must contain 256 materials.')
  const materials = input.materials.map((material, index) => {
    const parsed = materialPatch(material)
    const required = ['name', 'roughness', 'metalness', 'emissiveIntensity', 'opacity', 'transmission', 'ior'] as const
    if (required.some(property => parsed[property] === undefined)) throw invalid(`snapshot.materials[${index}] is incomplete.`)
    return parsed as PaletteMaterial
  })
  if (!Array.isArray(input.layers) || !input.layers.length) throw invalid('snapshot.layers must contain at least one layer.')
  const layerIds = new Set<number>()
  const layers = input.layers.map((layer, index) => {
    const parsed = record(layer, `snapshot.layers[${index}]`)
    const id = integer(parsed.id, `snapshot.layers[${index}].id`, 1, 65535)
    if (layerIds.has(id)) throw invalid(`snapshot.layers contains duplicate id ${id}.`)
    layerIds.add(id)
    return { id, name: stringValue(parsed.name, `snapshot.layers[${index}].name`, 40), visible: booleanValue(parsed.visible, `snapshot.layers[${index}].visible`), locked: booleanValue(parsed.locked, `snapshot.layers[${index}].locked`) }
  })
  const activeLayerId = integer(input.activeLayerId, 'snapshot.activeLayerId', 1, 65535)
  if (!layerIds.has(activeLayerId)) throw invalid('snapshot.activeLayerId must reference a layer.')
  if (!Array.isArray(input.chunks)) throw invalid('snapshot.chunks must be an array.')
  const parsedDimensions = dimensions(input.dimensions, 'snapshot.dimensions')
  const seen = new Set<string>()
  const chunks = input.chunks.map((chunk, index) => {
    const parsed = record(chunk, `snapshot.chunks[${index}]`)
    const id = integer(parsed.id, `snapshot.chunks[${index}].id`, 0, 4095)
    const layerId = integer(parsed.layerId, `snapshot.chunks[${index}].layerId`, 1, 65535)
    if (!layerIds.has(layerId)) throw invalid(`snapshot.chunks[${index}] references an unknown layer.`)
    const key = `${id}:${layerId}`
    if (seen.has(key)) throw invalid(`snapshot.chunks contains duplicate ${key}.`)
    seen.add(key)
    const dataBase64 = base64(parsed.dataBase64, `snapshot.chunks[${index}].dataBase64`, CHUNK_VOLUME)
    const data = base64ToBytes(dataBase64)
    if (data.length !== CHUNK_VOLUME) throw invalid(`snapshot.chunks[${index}] must decode to ${CHUNK_VOLUME} bytes.`)
    const origin = chunkCoords(id)
    if (origin.x * CHUNK_SIZE >= parsedDimensions.x || origin.y * CHUNK_SIZE >= parsedDimensions.y || origin.z * CHUNK_SIZE >= parsedDimensions.z) throw invalid(`snapshot.chunks[${index}] is outside the document.`)
    for (let offset = 0; offset < data.length; offset++) {
      if (!data[offset]) continue
      const x = origin.x * CHUNK_SIZE + offset % CHUNK_SIZE
      const y = origin.y * CHUNK_SIZE + Math.floor(offset / CHUNK_SIZE) % CHUNK_SIZE
      const z = origin.z * CHUNK_SIZE + Math.floor(offset / (CHUNK_SIZE * CHUNK_SIZE))
      if (x >= parsedDimensions.x || y >= parsedDimensions.y || z >= parsedDimensions.z) throw invalid(`snapshot.chunks[${index}] has voxels outside the document.`)
    }
    return { id, layerId, dataBase64 }
  })
  return {
    schema: 'voxel-studio/project',
    version: 1,
    name: stringValue(input.name, 'snapshot.name', 60, true),
    dimensions: parsedDimensions,
    palette,
    paletteOccupied,
    materials,
    layers,
    activeLayerId,
    chunks,
    settings: parseSettings(input.settings),
  }
}

export function decodeProjectSnapshot(value: unknown) {
  const snapshot = parseProjectSnapshot(value)
  const document = new VoxelDocument(snapshot.dimensions, snapshot.name, snapshot.palette, snapshot.materials, snapshot.layers, snapshot.activeLayerId, snapshot.paletteOccupied)
  const chunks = new Map<number, { layerId: number; data: Uint8Array }[]>()
  for (const chunk of snapshot.chunks) {
    const layers = chunks.get(chunk.id) ?? []
    layers.push({ layerId: chunk.layerId, data: base64ToBytes(chunk.dataBase64) })
    chunks.set(chunk.id, layers)
  }
  for (const [id, layers] of chunks) document.replaceChunk(id, layers)
  return { document, settings: snapshot.settings }
}
