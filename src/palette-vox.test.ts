import { describe, expect, test } from 'bun:test'
import { VOXLoader } from 'three/addons/loaders/VOXLoader.js'
import { CHUNK_SIZE, CHUNK_VOLUME, DEFAULT_PALETTE, EditSession, PADDED_SIZE, VoxelDocument, chunkCoords, chunkId, moveRange, moveVoxels, pushPull, pushPullRange, resizeVoxelDocument } from './editor'
import { decodeProjectSnapshot, encodeProjectSnapshot, parseProjectSnapshot } from './protocol'
import { projectFaces } from './projections'
import { restoreProjectSnapshot, snapshotProject, type ViewSettings } from './storage'
import { Studio } from './studio'
import { exportVox, importVox, VOX_EXPORT_WARNING } from './vox'

const settings: ViewSettings = {
  background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42,
  ambientOcclusion: true, shadows: true, grid: true, faceGrid: false, meshVertices: false,
  projection: 'orthographic', pathTracing: true,
}

function words(...values: number[]) {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value, true))
  return bytes
}

function chunk(id: string, content = new Uint8Array(0), children: Uint8Array[] = []) {
  const childrenSize = children.reduce((sum, child) => sum + child.length, 0)
  const bytes = new Uint8Array(12 + content.length + childrenSize)
  bytes.set([...id].map(character => character.charCodeAt(0)))
  bytes.set(words(content.length, childrenSize), 4)
  bytes.set(content, 12)
  let offset = 12 + content.length
  for (const child of children) { bytes.set(child, offset); offset += child.length }
  return bytes
}

function file(chunks: Uint8Array[], version = 150) {
  const main = chunk('MAIN', undefined, chunks)
  const bytes = new Uint8Array(8 + main.length)
  bytes.set([86, 79, 88, 32])
  bytes.set(words(version), 4)
  bytes.set(main, 8)
  return bytes.buffer
}

function model(size = [3, 5, 7], voxels = [2, 4, 6, 1]) {
  return [chunk('SIZE', words(...size)), chunk('XYZI', new Uint8Array([...words(voxels.length / 4), ...voxels]))]
}

describe('palette occupancy', () => {
  test('authored, unused and hidden referenced black survive activation and duplicate', () => {
    const document = new VoxelDocument()
    const studio = new Studio(document, settings)
    expect(studio.execute({ type: 'palette.setColor', index: 34, color: 0 })).toMatchObject({ changed: true, revision: 1 })
    expect(studio.execute({ type: 'palette.setColor', index: 34, color: 0 })).toMatchObject({ changed: false, revision: 1 })
    expect(studio.execute({ type: 'palette.activate', index: 34 })).toMatchObject({ changed: true, revision: 1 })
    expect(studio.execute({ type: 'palette.duplicate' }).result.index).toBe(35)
    expect(studio.execute({ type: 'palette.duplicate' }).result.index).toBe(36)
    const hidden = document.createLayer()
    document.setVoxel(1, 2, 3, 37)
    hidden.visible = false
    expect(studio.execute({ type: 'palette.duplicate', source: 6 }).result.index).toBe(38)
    for (const index of [34, 35, 36, 37]) {
      expect(document.hasPaletteColor(index)).toBe(true)
      expect(document.palette[index]).toBe(0)
      expect(studio.stateSnapshot().palette.find(color => color.index === index)?.color).toBe(0)
    }
    expect(document.hasPaletteColor(0)).toBe(false)
    expect(document.hasPaletteColor(39)).toBe(false)
    expect(new VoxelDocument(undefined, undefined, [0, 0]).hasPaletteColor(1)).toBe(true)
    const preferred = new Studio(document, settings, { activeColor: 34, recentColors: [35, 36, 37] })
    expect(preferred.activeColor).toBe(34)
    expect(preferred.recentColors).toEqual([34, 35, 36, 37])
    // This is the eyedropper's shared command boundary; picking itself belongs to the renderer.
    const revision = studio.revision
    expect(studio.execute({ type: 'palette.activate', index: document.getVoxel(1, 2, 3) })).toMatchObject({ changed: true, revision })
  })

  test('black survives clipboard/history, fill, chunk copies and cropped resize', () => {
    const document = new VoxelDocument()
    const studio = new Studio(document, settings)
    studio.execute({ type: 'palette.setColor', index: 34, color: 0 })
    expect(studio.execute({ type: 'edit.fill', min: { x: 1, y: 2, z: 3 }, max: { x: 2, y: 2, z: 3 }, color: 35, shape: 'box' }).effects.paletteChanged).toBe(true)
    expect(document.hasPaletteColor(35)).toBe(true)
    studio.execute({ type: 'selection.set', cells: [{ x: 1, y: 2, z: 3 }] })
    studio.execute({ type: 'clipboard.copy' })
    studio.execute({ type: 'clipboard.paste.begin' })
    studio.execute({ type: 'clipboard.paste.place', offset: { x: 3, y: 0, z: 0 } })
    expect(document.getVoxel(4, 2, 3)).toBe(35)
    studio.execute({ type: 'history.undo' })
    expect(document.getVoxel(4, 2, 3)).toBe(0)
    studio.execute({ type: 'history.redo' })
    expect(document.getVoxel(4, 2, 3)).toBe(35)
    const copy = new VoxelDocument(document.dimensions, document.name, document.palette, document.materials, document.layers, document.activeLayerId, document.paletteOccupied)
    for (const id of document.chunks.keys()) copy.replaceChunk(id, document.copyChunk(id))
    expect(encodeProjectSnapshot(copy, settings)).toEqual(encodeProjectSnapshot(document, settings))
    const hidden = document.createLayer()
    document.setVoxel(31, 31, 31, 36)
    hidden.visible = false
    const resized = resizeVoxelDocument(document, { x: 16, y: 16, z: 16 }, 'origin')
    expect(resized.cropped).toBe(1)
    for (const index of [34, 35, 36]) expect(resized.document.hasPaletteColor(index)).toBe(true)
    expect(resized.document.paletteOccupied).not.toBe(document.paletteOccupied)
    expect(resized.document.materials).toEqual(document.materials)
    expect(projectFaces(resized.document, ['front'])[0].rgba.slice((4 + (15 - 2) * 16) * 4, (5 + (15 - 2) * 16) * 4)).toEqual(new Uint8ClampedArray([0, 0, 0, 255]))
  })

  test('autosave and protocol snapshots persist unused black without changing schema versions', () => {
    const document = new VoxelDocument()
    const studio = new Studio(document, settings)
    studio.execute({ type: 'palette.setColor', index: 34, color: 0 })
    document.palette[32] = 0
    document.palette[33] = 0
    const hidden = document.createLayer()
    document.setVoxel(1, 2, 3, 32)
    hidden.visible = false
    const stored = snapshotProject(document, settings)
    const snapshot = encodeProjectSnapshot(document, settings)
    expect(stored.version).toBe(3)
    expect(snapshot.version).toBe(1)
    for (const restored of [restoreProjectSnapshot(structuredClone(stored))!.document, decodeProjectSnapshot(JSON.parse(JSON.stringify(snapshot))).document]) {
      expect(encodeProjectSnapshot(restored, settings)).toEqual(snapshot)
      expect(new Studio(restored, settings).execute({ type: 'palette.duplicate', source: 34 }).result.index).toBe(35)
      expect(restored.palette[32]).toBe(0)
      expect(restored.getLayerVoxel(1, 2, 3, hidden.id)).toBe(32)
    }
    delete snapshot.paletteOccupied
    expect(decodeProjectSnapshot(snapshot).document.hasPaletteColor(32)).toBe(true)
    // Legacy full-length palettes cannot prove zero-valued slots are unused.
    for (const version of [1, 2, 3] as const) {
      const legacy = { ...stored, version, paletteOccupied: undefined }
      if (version === 2) legacy.chunks = stored.chunks.map(value => ({ ...value, layerData: new Uint16Array(CHUNK_VOLUME).fill(hidden.id).buffer }))
      const restored = restoreProjectSnapshot(legacy)!.document
      expect(restored.hasPaletteColor(32)).toBe(true)
      expect(restored.palette[32]).toBe(0)
      expect(new Studio(restored, settings).execute({ type: 'palette.duplicate', source: 5 }).result.index).toBe(33)
    }
  })

  test('local recovery keeps the server association with its matching document', () => {
    const document = new VoxelDocument(undefined, 'Library model')
    const library = { id: crypto.randomUUID(), version: 3, tags: ['props'], dirty: true }
    const stored = snapshotProject(document, settings, library)
    library.tags.push('later')
    library.version++
    const restored = restoreProjectSnapshot(structuredClone(stored))!
    expect(restored.document.name).toBe('Library model')
    expect(restored.library).toEqual({ id: library.id, version: 3, tags: ['props'], dirty: true })
    expect(restoreProjectSnapshot(snapshotProject(new VoxelDocument(), settings))!.library).toBeUndefined()
  })

  test('validates optional snapshot occupancy at the protocol boundary', () => {
    const snapshot = encodeProjectSnapshot(new VoxelDocument(), settings)
    for (const flags of [null, [], new Array(256), Array(256).fill(2), Array(256).fill(0.5), [1, ...Array(255).fill(0)]]) {
      expect(() => parseProjectSnapshot({ ...snapshot, paletteOccupied: flags })).toThrow('paletteOccupied')
    }
    expect(parseProjectSnapshot({ ...snapshot, paletteOccupied: undefined }).paletteOccupied).toBeUndefined()
  })

  test('palette refreshes when edits or material authoring first allocate a black slot', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    expect(studio.execute({ type: 'edit.paint', cells: [{ x: 1, y: 1, z: 1 }], color: 34 })).toMatchObject({ revision: 1, effects: { paletteChanged: true } })
    expect(studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 1, y: 1, z: 1, color: 35 }] })).toMatchObject({ revision: 2, effects: { paletteChanged: true } })
    expect(studio.execute({ type: 'edit.paint', cells: [{ x: 2, y: 1, z: 1 }], color: 34 })).toMatchObject({ revision: 3, effects: { paletteChanged: false } })
    expect(studio.execute({ type: 'material.update', index: 36, patch: { name: 'Black' } })).toMatchObject({ revision: 4, effects: { paletteChanged: true } })
    expect(studio.execute({ type: 'material.update', index: 36, patch: { roughness: 0.3 } })).toMatchObject({ revision: 5, effects: { paletteChanged: false } })
    expect(studio.execute({ type: 'palette.duplicate', source: 35 }).result.index).toBe(37)
    const revision = studio.revision
    expect(studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 3, y: 1, z: 1, color: 38 }, { x: 3, y: 1, z: 1, color: 0 }] })).toMatchObject({ changed: false, revision })
    expect(studio.document.hasPaletteColor(38)).toBe(false)
    const canceled = new EditSession(studio.document)
    canceled.set(3, 1, 1, 38)
    canceled.cancel()
    expect(studio.document.hasPaletteColor(38)).toBe(false)
  })

  test('successful map loads reserve black slots, preserve metadata, and advance the revision once', async () => {
    const studio = new Studio(new VoxelDocument(), settings)
    const gate = Promise.withResolvers<void>()
    const pending = studio.loadPbrMap(34, 'map', 'albedo.png', () => gate.promise)
    expect(studio.document.hasPaletteColor(34)).toBe(false)
    expect(studio.loadedPbrMaps.has(34)).toBe(false)
    expect(studio.revision).toBe(0)
    gate.resolve()
    expect(await pending).toMatchObject({ changed: true, revision: 1, result: { index: 34, map: 'map' }, effects: { mutation: true, paletteChanged: true, save: true } })
    expect(studio.document.paletteOccupied[34]).toBe(1)
    expect(studio.document.palette[34]).toBe(0)
    const maps = studio.loadedPbrMaps.get(34)!
    expect([...maps]).toEqual([['map', 'albedo.png']])
    expect(await studio.loadPbrMap(34, 'normalMap', 'normal.png', async () => {})).toMatchObject({ revision: 2, effects: { mutation: true, paletteChanged: false, save: false } })
    expect(studio.loadedPbrMaps.get(34)).toBe(maps)
    expect([...maps]).toEqual([['map', 'albedo.png'], ['normalMap', 'normal.png']])
    expect(await studio.loadPbrMap(34, 'map', 'replacement.png', async () => {})).toMatchObject({ revision: 3, effects: { paletteChanged: false, save: false } })
    expect([...maps]).toEqual([['map', 'replacement.png'], ['normalMap', 'normal.png']])
    expect(restoreProjectSnapshot(snapshotProject(studio.document, settings))!.document.hasPaletteColor(34)).toBe(true)
    expect(studio.execute({ type: 'palette.duplicate', source: 5 }).result.index).toBe(35)
    expect(studio.execute({ type: 'palette.duplicate', source: 34 }).result.index).toBe(36)
    expect(studio.loadedPbrMaps.has(35)).toBe(false)
    expect(studio.loadedPbrMaps.has(36)).toBe(false)
    expect(studio.stateSnapshot().palette.find(color => color.index === 34)?.maps).toEqual({ map: 'replacement.png', normalMap: 'normal.png' })
  })

  test('failed map loads leave occupancy, existing metadata and revisions untouched', async () => {
    const studio = new Studio(new VoxelDocument(), settings)
    const failure = async () => { throw new Error('Image decode failed') }
    await expect(studio.loadPbrMap(34, 'map', 'broken.png', failure)).rejects.toThrow('Image decode failed')
    expect(studio.document.hasPaletteColor(34)).toBe(false)
    expect(studio.loadedPbrMaps.has(34)).toBe(false)
    expect(studio.revision).toBe(0)
    await studio.loadPbrMap(34, 'map', 'albedo.png', async () => {})
    const maps = studio.loadedPbrMaps.get(34)!
    await expect(studio.loadPbrMap(34, 'map', 'broken.png', failure)).rejects.toThrow('Image decode failed')
    expect(studio.document.hasPaletteColor(34)).toBe(true)
    expect(studio.loadedPbrMaps.get(34)).toBe(maps)
    expect([...maps]).toEqual([['map', 'albedo.png']])
    expect(studio.revision).toBe(1)
  })
})

describe('data-only VOX boundary', () => {
  test('matches every supported default palette color without an RGBA chunk', () => {
    const bytes = file(model())
    const expected = new VOXLoader().parse(bytes).chunks[0].palette
    const imported = importVox(bytes).document
    for (let index = 1; index < 256; index++) {
      const rgba = expected[index]
      expect(imported.palette[index]).toBe(((rgba & 255) << 16) | (rgba & 0xff00) | ((rgba >>> 16) & 255))
      expect(imported.hasPaletteColor(index)).toBe(true)
    }
    expect(importVox(file(model(), 200)).document.palette).toEqual(imported.palette)
  })

  test('preserves external black and asymmetric coordinates using the documented app axes', () => {
    const rgba = new Uint8Array(1024)
    rgba.set([0x12, 0xab, 0xef, 255], 6 * 4)
    const imported = importVox(file([...model([3, 5, 7], [2, 4, 6, 1, 0, 1, 2, 7]), chunk('RGBA', rgba)]), 'Axes.vox')
    const document = imported.document
    expect(document.name).toBe('Axes')
    expect(document.dimensions).toEqual({ x: 16, y: 16, z: 16 })
    expect(document.getVoxel(2, 6, 4)).toBe(1)
    expect(document.getVoxel(0, 2, 1)).toBe(7)
    expect(document.getVoxel(2, 6, 0)).toBe(0)
    expect(document.palette[1]).toBe(0)
    expect(document.palette[7]).toBe(0x12abef)
    expect(document.hasPaletteColor(255)).toBe(true)
    const front = projectFaces(document, ['front'])[0]
    expect([...front.rgba.slice((2 + 9 * 16) * 4, (3 + 9 * 16) * 4)]).toEqual([0, 0, 0, 255])
    const studio = new Studio(document, settings, { activeColor: 7 })
    expect(studio.execute({ type: 'palette.activate', index: 1 }).changed).toBe(true)
    expect(() => studio.execute({ type: 'palette.duplicate', source: 1 })).toThrow('palette is full')
    expect(document.palette[255]).toBe(0)
    const roundtrip = importVox(exportVox(document)).document
    expect(roundtrip.palette).toEqual(document.palette)
    expect(roundtrip.paddedChunk(0)).toEqual(document.paddedChunk(0))
  })

  test('never infers water or emission from app RGB values and warns about lossy materials', () => {
    const document = new VoxelDocument()
    document.setVoxel(1, 2, 3, 12)
    const imported = importVox(exportVox(document))
    expect(imported.document.palette.slice(0, DEFAULT_PALETTE.length)).toEqual(DEFAULT_PALETTE)
    for (const index of [12, 31, 32, 33]) expect(imported.document.materials[index]).toMatchObject({ roughness: 0.68, metalness: 0.02, opacity: 1, transmission: 0, emissiveIntensity: 0 })
    expect(imported.warning).toContain('materials are not preserved')
    expect(VOX_EXPORT_WARNING).toContain('PBR materials and texture maps are lost')
    expect(VOX_EXPORT_WARNING).toContain('project snapshot')
    const legacy = new VoxelDocument(undefined, undefined, DEFAULT_PALETTE.slice(0, -2))
    expect(legacy.palette[32]).toBe(DEFAULT_PALETTE[32])
  })

  test('keeps internal non-cubic roundtrips and flattens only highest visible voxels', () => {
    const document = new VoxelDocument({ x: 17, y: 19, z: 23 })
    document.setVoxel(16, 18, 22, 5)
    document.setVoxel(2, 3, 4, 6)
    const upper = document.createLayer()
    document.setVoxel(2, 3, 4, 40)
    const hidden = document.createLayer()
    document.setVoxel(1, 1, 1, 41)
    hidden.visible = false
    const bytes = exportVox(document)
    const view = new DataView(bytes)
    expect([32, 36, 40].map(offset => view.getUint32(offset, true))).toEqual([17, 23, 19])
    const records = new Uint8Array(bytes, 60, view.getUint32(56, true) * 4)
    expect([...records]).toEqual([16, 22, 18, 5, 2, 4, 3, 40])
    const imported = importVox(bytes).document
    expect(imported.dimensions).toEqual(document.dimensions)
    expect(imported.voxelCount).toBe(2)
    expect(imported.getVoxel(2, 3, 4)).toBe(40)
    expect(imported.palette[40]).toBe(0)
    expect(imported.getVoxel(1, 1, 1)).toBe(0)
    expect(document.getLayerVoxel(2, 3, 4, upper.id)).toBe(40)
  })

  test('imports only the first model and ignores scene/material data without building Three objects', () => {
    // Empty scene payloads would fail VOXLoader's graph parser, but are opaque here.
    const imported = importVox(file([chunk('PACK', words(2)), ...model(), ...model([1, 1, 1], [0, 0, 0, 2]), chunk('nTRN'), chunk('MATL')]))
    expect(imported.document.voxelCount).toBe(1)
    expect(imported.document.getVoxel(2, 6, 4)).toBe(1)
    expect(imported.warning).toContain('2 models. The first model was imported.')
    expect(imported.warning).toContain('Scene transforms and instances were ignored')
    expect(imported.warning).toContain('materials are not preserved')
    expect(importVox(file([chunk('TEST', undefined, [chunk('META', words(1))]), ...model()])).document.voxelCount).toBe(1)
  })

  test('rejects core chunks nested in opaque extensions instead of sharing MAIN model state', () => {
    const [size, xyzi] = model()
    expect(() => importVox(file([chunk('TEST', undefined, [size]), xyzi]))).toThrow('direct MAIN children')
    expect(() => importVox(file([chunk('TEST', undefined, model([1, 1, 1], [0, 0, 0, 2])), ...model()]))).toThrow('direct MAIN children')
    for (const nested of [xyzi, chunk('PACK', words(1)), chunk('RGBA', new Uint8Array(1024))]) {
      expect(() => importVox(file([size, chunk('TEST', undefined, [nested]), xyzi]))).toThrow('direct MAIN children')
      expect(() => importVox(file([chunk('TEST', undefined, [chunk('META', undefined, [nested])]), ...model()]))).toThrow('direct MAIN children')
    }
    // Core-looking bytes in opaque content are not child chunks and must not affect the model.
    const opaque = chunk('TEST', size, [chunk('META', words(123))])
    expect(importVox(file([opaque, ...model()])).document.getVoxel(2, 6, 4)).toBe(1)
    const malformed = chunk('TEST', undefined, [chunk('META', words(123))])
    new DataView(malformed.buffer).setUint32(16, 8, true)
    expect(() => importVox(file([malformed, ...model()]))).toThrow('byte boundaries')
  })

  test('rejects duplicate XYZI coordinates even when the record count fits source volume', () => {
    for (const color of [1, 2]) {
      expect(() => importVox(file(model([2, 1, 1], [0, 0, 0, 1, 0, 0, 0, color])))).toThrow('duplicate voxel coordinates')
    }
    const unique = model([2, 1, 1], [0, 0, 0, 1, 1, 0, 0, 2])
    const imported = importVox(file([chunk('PACK', words(2)), ...unique, ...unique]))
    expect(imported.document.voxelCount).toBe(2)
    expect(imported.document.getVoxel(0, 0, 0)).toBe(1)
    expect(imported.document.getVoxel(1, 0, 0)).toBe(2)
    expect(imported.warning).toContain('2 models')
    expect(() => importVox(file([...unique, ...model([2, 1, 1], [1, 0, 0, 1, 1, 0, 0, 2])]))).toThrow('duplicate voxel coordinates')
  })

  test('rejects zero/oversized source dimensions and coordinates before workspace normalization', () => {
    for (const axis of [0, 1, 2]) {
      for (const invalid of [0, 257, 0xffffffff]) {
        const size = [3, 5, 7]; size[axis] = invalid
        expect(() => importVox(file(model(size)))).toThrow('source SIZE')
      }
      const voxel = [0, 0, 0, 1]; voxel[axis] = [3, 5, 7][axis]
      expect(() => importVox(file(model([3, 5, 7], voxel)))).toThrow('source SIZE bounds')
    }
    expect(importVox(file(model([256, 256, 256], [255, 255, 255, 255]))).document.getVoxel(255, 255, 255)).toBe(255)
    expect(importVox(file(model([1, 1, 1], []))).document.voxelCount).toBe(0)
  })

  test('rejects truncated bytes, inconsistent chunk lengths/counts, and invalid model ordering', () => {
    const valid = file([...model(), chunk('RGBA', new Uint8Array(1024))])
    for (let length = 0; length < valid.byteLength; length++) expect(() => importVox(valid.slice(0, length))).toThrow()
    const invalidChunks = [
      [], [chunk('SIZE', words(3, 5, 7))], [model()[1]], [model()[0], ...model()],
      [chunk('SIZE', words(3, 5)), model()[1]],
      [model()[0], chunk('XYZI', words(1))],
      [model()[0], chunk('XYZI', new Uint8Array([...words(0), 0, 0, 0, 1]))],
      [model()[0], chunk('XYZI', words(0xffffffff))],
      model([1, 1, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
      model([1, 1, 1], [0, 0, 0, 0]),
      [chunk('PACK', words(2)), ...model()], [chunk('PACK', words(0)), ...model()],
      [...model(), chunk('RGBA', new Uint8Array(1023))],
      [...model(), chunk('RGBA', new Uint8Array(1025))],
      [...model(), chunk('RGBA', new Uint8Array(1024)), chunk('RGBA', new Uint8Array(1024))],
      [...model(), chunk('TEST', undefined, [new Uint8Array(11)])],
      [...model(), chunk('SIZE', words(1, 1, 1), [chunk('TEST')])],
    ]
    for (const chunks of invalidChunks) expect(() => importVox(file(chunks))).toThrow()
    for (const offset of [12, 16, 24, 28, 48, 52]) {
      const bytes = valid.slice(0)
      new DataView(bytes).setUint32(offset, 0xffffffff, true)
      expect(() => importVox(bytes)).toThrow()
    }
    const trailing = new Uint8Array(valid.byteLength + 1); trailing.set(new Uint8Array(valid))
    expect(() => importVox(trailing.buffer)).toThrow('MAIN')
    expect(() => importVox(file(model(), 149))).toThrow('version')
  })
})

test('paddedChunk is byte-identical to the reference composition including partial chunks and all halos', () => {
  const document = new VoxelDocument({ x: 35, y: 33, z: 37 })
  document.createLayer()
  document.createLayer()
  document.layers[1].visible = false
  for (let z = 0; z < 37; z++) for (let y = 0; y < 33; y++) for (let x = 0; x < 35; x++) {
    for (const layer of document.layers) {
      if ((x * 13 + y * 7 + z * 3 + layer.id) % (layer.id + 2) === 0) document.setVoxel(x, y, z, 33 + layer.id, layer.id)
    }
  }
  // Ensure out-of-document cells in a partial stored chunk never leak into the halo.
  document.chunks.get(chunkId(2, 2, 2))!.get(1)![CHUNK_VOLUME - 1] = 99
  for (const visibleOnly of [false, true]) {
    for (let cz = 0; cz < 3; cz++) for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) {
      const id = chunkId(cx, cy, cz)
      const origin = chunkCoords(id)
      const expected = new Uint8Array(PADDED_SIZE ** 3)
      let index = 0
      for (let z = -1; z <= CHUNK_SIZE; z++) for (let y = -1; y <= CHUNK_SIZE; y++) for (let x = -1; x <= CHUNK_SIZE; x++) {
        const wx = origin.x * CHUNK_SIZE + x, wy = origin.y * CHUNK_SIZE + y, wz = origin.z * CHUNK_SIZE + z
        expected[index++] = visibleOnly ? document.getVisibleVoxel(wx, wy, wz) : document.getVoxel(wx, wy, wz)
      }
      expect(document.paddedChunk(id, visibleOnly)).toEqual(expected)
    }
  }
  document.layers.forEach(layer => { layer.visible = false })
  expect(document.paddedChunk(chunkId(1, 1, 1), true)).toEqual(new Uint8Array(PADDED_SIZE ** 3))
  expect(new VoxelDocument().paddedChunk(0, true)).toEqual(new Uint8Array(PADDED_SIZE ** 3))
})

test('range helpers and shared transforms safely reject zero and non-axis normals', () => {
  const document = new VoxelDocument()
  const cells = [{ x: 1, y: 2, z: 3 }]
  document.setVoxel(1, 2, 3, 5)
  for (const normal of [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0.5, y: 0.5, z: 0 }, { x: NaN, y: 0, z: 0 }, { x: Infinity, y: 0, z: 0 }]) {
    expect(moveRange(document, cells, normal)).toEqual({ pull: 0, push: 0 })
    expect(pushPullRange(document, cells, normal)).toEqual({ pull: 0, push: 0 })
    expect(pushPullRange(document, [{ x: 0, y: 0, z: 0 }], normal)).toEqual({ pull: 0, push: 0 })
    const edit = new EditSession(document)
    expect(moveVoxels(document, edit, cells, normal, 3)).toBe(0)
    expect(pushPull(document, edit, cells, normal, 3)).toBe(0)
    expect(edit.commit()).toBeUndefined()
    const studio = new Studio(document, settings)
    expect(studio.execute({ type: 'edit.move', cells, normal, distance: 3 })).toMatchObject({ changed: false, revision: 0 })
  }
  expect(moveRange(document, cells, { x: -1, y: 0, z: 0 })).toEqual({ pull: 1, push: 30 })
  expect(pushPullRange(document, cells, { x: 0, y: 1, z: 0 })).toEqual({ pull: 29, push: 1 })
  expect(moveRange(document, [], { x: 0, y: 0, z: 1 })).toEqual({ pull: 0, push: 0 })
})
