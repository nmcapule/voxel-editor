import { DEFAULT_SETTINGS, parseSettings, type ViewSettings } from '../../shared/rendering/settings'
import type { LibraryLink } from '../../shared/library/types'
import { VoxelDocument, type Dimensions, type LayerChunkSnapshot, type PaletteMaterial, type VoxelLayer } from '../../shared/voxel/document'

const DATABASE = 'voxel-studio'
const STORE = 'projects'

export interface StoredProject {
  version: 1 | 2 | 3
  name: string
  dimensions: Dimensions
  palette: ArrayBuffer
  paletteOccupied?: ArrayBuffer
  materials?: Partial<PaletteMaterial>[]
  layers?: VoxelLayer[]
  activeLayerId?: number
  chunks: { id: number; data: ArrayBuffer; layerId?: number; layerData?: ArrayBuffer }[]
  settings: ViewSettings
  library?: LibraryLink
}

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export function snapshotProject(document: VoxelDocument, settings: ViewSettings, library?: LibraryLink): StoredProject {
  return {
    version: 3,
    name: document.name,
    dimensions: document.dimensions,
    palette: document.palette.slice().buffer,
    paletteOccupied: Uint8Array.from(document.palette, (_color, index) => Number(document.hasPaletteColor(index))).buffer,
    materials: document.materials.map(material => ({ ...material })),
    layers: document.layers.map(layer => ({ ...layer })),
    activeLayerId: document.activeLayerId,
    chunks: [...document.chunks].flatMap(([id, layers]) => [...layers].map(([layerId, data]) => ({ id, layerId, data: data.slice().buffer }))),
    settings: { ...settings },
    library: library ? { ...library, tags: [...library.tags] } : undefined,
  }
}

export async function saveProjectSnapshot(stored: StoredProject) {
  const db = await database()
  const transaction = db.transaction(STORE, 'readwrite')
  transaction.objectStore(STORE).put(stored, 'current')
  await complete(transaction)
  db.close()
}

export function saveProject(document: VoxelDocument, settings: ViewSettings) {
  return saveProjectSnapshot(snapshotProject(document, settings))
}

export async function loadProject() {
  const db = await database()
  const request = db.transaction(STORE).objectStore(STORE).get('current')
  const stored = await new Promise<StoredProject | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredProject | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return stored ? restoreProjectSnapshot(stored) : undefined
}

export function restoreProjectSnapshot(stored: StoredProject) {
  if (!stored || stored.version !== 1 && stored.version !== 2 && stored.version !== 3) return undefined
  const { roughness, metalness, ...view } = stored.settings as ViewSettings & Partial<PaletteMaterial>
  const settings = parseSettings({ ...DEFAULT_SETTINGS, ...view, pbrMaterials: view.pbrMaterials })
  const materials = stored.materials ?? (roughness === undefined && metalness === undefined ? undefined
    : Array.from({ length: 256 }, () => ({ roughness: roughness ?? 0.68, metalness: metalness ?? 0.02 })))
  const document = new VoxelDocument(stored.dimensions, stored.name, new Uint32Array(stored.palette), materials, stored.version >= 2 ? stored.layers : undefined, stored.activeLayerId, stored.paletteOccupied ? new Uint8Array(stored.paletteOccupied) : undefined)
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
  return { document, settings, library: stored.library }
}

export async function clearProject() {
  const db = await database()
  const transaction = db.transaction(STORE, 'readwrite')
  transaction.objectStore(STORE).delete('current')
  await complete(transaction)
  db.close()
}
