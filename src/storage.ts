import { VoxelDocument, type Dimensions, type LayerChunkSnapshot, type PaletteMaterial, type VoxelLayer } from './editor'

const DATABASE = 'voxel-studio'
const STORE = 'projects'

export interface ViewSettings {
  background: string
  ambient: number
  light: number
  lightAzimuth: number
  ambientOcclusion: boolean
  shadows: boolean
  grid: boolean
  faceGrid: boolean
  projection: 'orthographic' | 'perspective'
  pathTracing: boolean
}

interface StoredProject {
  version: 1 | 2 | 3
  name: string
  dimensions: Dimensions
  palette: ArrayBuffer
  materials?: Partial<PaletteMaterial>[]
  layers?: VoxelLayer[]
  activeLayerId?: number
  chunks: { id: number; data: ArrayBuffer; layerId?: number; layerData?: ArrayBuffer }[]
  settings: ViewSettings
}

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function complete(request: IDBRequest) {
  return new Promise<void>((resolve, reject) => {
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function saveProject(document: VoxelDocument, settings: ViewSettings) {
  const db = await database()
  const stored: StoredProject = {
    version: 3,
    name: document.name,
    dimensions: document.dimensions,
    palette: document.palette.slice().buffer,
    materials: document.materials.map(material => ({ ...material })),
    layers: document.layers.map(layer => ({ ...layer })),
    activeLayerId: document.activeLayerId,
    chunks: [...document.chunks].flatMap(([id, layers]) => [...layers].map(([layerId, data]) => ({ id, layerId, data: data.slice().buffer }))),
    settings,
  }
  await complete(db.transaction(STORE, 'readwrite').objectStore(STORE).put(stored, 'current'))
  db.close()
}

export async function loadProject() {
  const db = await database()
  const request = db.transaction(STORE).objectStore(STORE).get('current')
  const stored = await new Promise<StoredProject | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredProject | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  if (!stored || stored.version !== 1 && stored.version !== 2 && stored.version !== 3) return undefined
  const legacy = stored.settings as ViewSettings & Partial<PaletteMaterial>
  const materials = stored.materials ?? (legacy.roughness === undefined && legacy.metalness === undefined ? undefined
    : Array.from({ length: 256 }, () => ({ roughness: legacy.roughness ?? 0.68, metalness: legacy.metalness ?? 0.02 })))
  const document = new VoxelDocument(stored.dimensions, stored.name, new Uint32Array(stored.palette), materials, stored.version >= 2 ? stored.layers : undefined, stored.activeLayerId)
  if (stored.version === 3) {
    const chunks = new Map<number, LayerChunkSnapshot[]>()
    for (const chunk of stored.chunks) {
      if (!Number.isInteger(chunk.layerId)) continue
      const layers = chunks.get(chunk.id) ?? []
      layers.push({ layerId: chunk.layerId!, data: new Uint8Array(chunk.data) })
      chunks.set(chunk.id, layers)
    }
    for (const [id, layers] of chunks) document.replaceChunk(id, layers)
  } else {
    for (const chunk of stored.chunks) document.replaceLegacyChunk(chunk.id, new Uint8Array(chunk.data), stored.version === 2 && chunk.layerData ? new Uint16Array(chunk.layerData) : undefined)
  }
  return { document, settings: stored.settings }
}

export async function clearProject() {
  const db = await database()
  await complete(db.transaction(STORE, 'readwrite').objectStore(STORE).delete('current'))
  db.close()
}
