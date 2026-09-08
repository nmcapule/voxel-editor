import { describe, expect, spyOn, test } from 'bun:test'
import { Box3, Frustum, Matrix4, Ray, Vector3 } from 'three'
import { VoxelDocument, chunkCoords, resizeVoxelDocument, type Vec3 } from '../../shared/voxel/document'
import { encodeProjectSnapshot } from '../../shared/voxel/snapshot'
import { createScene, instanceMatrix, parseSceneAsset, parseSceneManifest, SceneDocument } from './document'
import { deactivateSceneRecovery, getSceneChunkCacheStats, hasSceneBlob, loadSceneAsset, loadSceneChunk, loadSceneRecovery, putSceneAsset, putSceneBlob, saveSceneDocumentRecovery, saveSceneRecovery } from './storage'
import { describeSceneChunk, validateSceneChunkDescriptor } from './chunks'
import type { SceneAsset, SceneChunk, SceneCommand, SceneInstance, SceneManifest } from './types'
import { DEFAULT_SETTINGS } from '../../shared/rendering/settings'

const settings = { ...DEFAULT_SETTINGS }
const hash = 'a'.repeat(64)
const zero = { x: 0, y: 0, z: 0 }, unit = { x: 1, y: 1, z: 1 }, rotation = { x: 0, y: 0, z: 0, w: 1 }
const fullLod = new Array<number>(64).fill(80)
const { chunks: _empty, ...header } = encodeProjectSnapshot(new VoxelDocument({ x: 256, y: 256, z: 256 }, 'Black model'), settings)
header.palette[80] = 0; header.paletteOccupied![80] = 1

function chunk(id = 0, layerId = 1, blob = hash): SceneChunk {
  const origin = chunkCoords(id)
  const min = { x: origin.x * 16, y: origin.y * 16, z: origin.z * 16 }
  return { id, layerId, blob, count: 4096, colors: [80], lod: fullLod, bounds: { min, max: { x: min.x + 16, y: min.y + 16, z: min.z + 16 } } }
}
function asset(id = 'asset', chunks = [chunk()]): SceneAsset {
  const min = { x: 256, y: 256, z: 256 }, max = { ...zero }
  for (const chunk of chunks) for (const axis of ['x', 'y', 'z'] as const) { min[axis] = Math.min(min[axis], chunk.bounds.min[axis]); max[axis] = Math.max(max[axis], chunk.bounds.max[axis]) }
  return { id, revision: 0, model: header, chunks, pivot: { x: 8, y: 8, z: 8 }, bounds: chunks.length ? { min, max } : undefined, voxelCount: chunks.reduce((n, chunk) => n + chunk.count, 0), source: { id: 'library-model', version: 3 } }
}
function instance(id = 'instance', assetId = 'asset', position: Vec3 = { ...zero }, layerId = 1): SceneInstance {
  return { id, assetId, name: id.slice(0, 60), layerId, position, scale: { ...unit }, rotation: { ...rotation } }
}
function fixture(instances = [instance()], assets = [asset()]): SceneManifest {
  return { ...createScene(settings), assets, instances }
}

describe('scene boundary', () => {
  test('fog and sun marker settings round-trip independently in scenes and child models with legacy defaults', () => {
    const manifest = structuredClone(fixture())
    manifest.settings = { ...settings, fogDensity: 1.35, fogSpread: 0.65, fogColor: '#aBc123', showSun: false }
    manifest.assets[0].model.settings = { ...settings, fogDensity: 0, fogSpread: 1, fogColor: '#000000', showSun: true }
    const keys = ['fogDensity', 'fogSpread', 'fogColor', 'showSun'] as const
    for (const missing of [[], ...keys.map(key => [key]), keys]) {
      const legacy = structuredClone(manifest), expected = structuredClone(manifest)
      for (const key of missing) {
        Reflect.deleteProperty(legacy.settings, key)
        Reflect.deleteProperty(legacy.assets[0].model.settings, key)
        Reflect.set(expected.settings, key, DEFAULT_SETTINGS[key])
        Reflect.set(expected.assets[0].model.settings, key, DEFAULT_SETTINGS[key])
      }
      const restored = new SceneDocument(JSON.parse(JSON.stringify(legacy))).snapshot()
      expect(restored).toEqual(expected)
      expect(createScene(restored.settings).settings).toEqual(expected.settings)
      expect(parseSceneManifest(JSON.parse(JSON.stringify(restored)))).toEqual(expected)
      expect(restored.version).toBe(1)
    }
  })

  test('fog and sun marker patches validate atomically and undo without changing scene geometry', () => {
    const scene = new SceneDocument(fixture()), before = scene.snapshot(), updates = scene.index.updateCount
    for (const [key, invalid] of [
      ['fogDensity', [null, NaN, Infinity, -Infinity, -0.01, 3.01, false, '1', [], {}]],
      ['fogSpread', [null, NaN, Infinity, -Infinity, -0.01, 1.01, true, '0.25', [], {}]],
      ['fogColor', [null, 0, true, '', '#fff', '#ffffffff', '#gggggg', 'ffffff', '#123456\n', [], {}]],
      ['showSun', [null, 0, 1, NaN, 'false', 'true', [], {}]],
    ] as const) for (const value of invalid) {
      const patch = { ambient: 0, [key]: value }, invalidSettings = { ...settings, ...patch }
      expect(() => scene.execute({ type: 'scene.settings', patch })).toThrow(key)
      expect(() => parseSceneManifest({ ...before, settings: invalidSettings })).toThrow(key)
      expect(() => parseSceneAsset({ ...before.assets[0], model: { ...header, settings: invalidSettings } })).toThrow(key)
      expect(scene.snapshot()).toBe(before)
      expect(scene.canUndo).toBe(false)
      expect(scene.index.updateCount).toBe(updates)
    }
    for (const patch of [
      { fogDensity: 0, fogSpread: 0, fogColor: '#000000', showSun: false },
      { fogDensity: 3, fogSpread: 1, fogColor: '#ffffff', showSun: true },
      { fogDensity: 1.35, fogSpread: 0.65, fogColor: '#aBc123', showSun: false },
    ]) {
      const previous = scene.data.settings, expected = { ...before.settings, ...patch }
      expect(scene.execute({ type: 'scene.settings', patch })).toMatchObject({ changed: true, instanceIds: [], assetIds: [] })
      expect(scene.data.settings).toEqual(expected)
      scene.execute({ type: 'history.undo' })
      expect(scene.data.settings).toEqual(previous)
      scene.execute({ type: 'history.redo' })
      expect(scene.data.settings).toEqual(expected)
      expect(scene.execute({ type: 'scene.settings', patch }).changed).toBe(false)
      expect(scene.data.assets).toBe(before.assets)
      expect(scene.data.instances).toBe(before.instances)
      expect(scene.data.layers).toBe(before.layers)
      expect(scene.index.updateCount).toBe(updates)
    }
  })

  test('volumetric lighting round-trips independently in scenes and child models with legacy defaults', () => {
    for (const volumetricLighting of [false, true, undefined]) {
      const manifest = structuredClone(fixture())
      manifest.settings = { ...settings, volumetricLighting: volumetricLighting ?? false, shadows: false }
      manifest.assets[0].model.settings = { ...settings, volumetricLighting: volumetricLighting === undefined ? false : !volumetricLighting }
      const expected = structuredClone(manifest)
      if (volumetricLighting === undefined) {
        Reflect.deleteProperty(manifest.settings, 'volumetricLighting')
        Reflect.deleteProperty(manifest.assets[0].model.settings, 'volumetricLighting')
      }
      const restored = new SceneDocument(JSON.parse(JSON.stringify(manifest))).snapshot()
      expect(restored).toEqual(expected)
      expect(createScene(restored.settings).settings).toEqual(expected.settings)
      expect(parseSceneManifest(JSON.parse(JSON.stringify(restored)))).toEqual(expected)
    }
  })

  test('volumetric lighting validates atomically and scene undo leaves geometry untouched', () => {
    const scene = new SceneDocument({ ...fixture(), settings: { ...settings, shadows: false } })
    const before = scene.snapshot(), updates = scene.index.updateCount
    for (const volumetricLighting of [null, 0, 1, NaN, 'false', 'true', [], {}]) {
      const invalid = { ...before.settings, volumetricLighting }
      expect(() => scene.execute({ type: 'scene.settings', patch: { volumetricLighting, ambient: 0 } } as SceneCommand)).toThrow('volumetricLighting')
      expect(() => parseSceneManifest({ ...before, settings: invalid })).toThrow('volumetricLighting')
      expect(() => parseSceneAsset({ ...before.assets[0], model: { ...header, settings: invalid } })).toThrow('volumetricLighting')
      expect(scene.snapshot()).toBe(before)
      expect(scene.canUndo).toBe(false)
    }
    for (const volumetricLighting of [true, false]) {
      const previous = scene.data.settings, patch = { volumetricLighting }
      expect(scene.execute({ type: 'scene.settings', patch })).toMatchObject({ changed: true, instanceIds: [], assetIds: [] })
      expect(scene.data.settings).toEqual({ ...before.settings, volumetricLighting })
      scene.execute({ type: 'history.undo' })
      expect(scene.data.settings).toEqual(previous)
      scene.execute({ type: 'history.redo' })
      expect(scene.data.settings).toEqual({ ...before.settings, volumetricLighting })
      expect(scene.execute({ type: 'scene.settings', patch }).changed).toBe(false)
      expect(scene.data.assets).toBe(before.assets)
      expect(scene.data.instances).toBe(before.instances)
      expect(scene.data.layers).toBe(before.layers)
      expect(scene.index.updateCount).toBe(updates)
    }
  })

  test('legacy scene PBR stays on while child models retain their own renderer migration', () => {
    for (const previewRenderer of ['standard', 'cube-sprites'] as const) for (const pbrMaterials of [undefined, false, true]) {
      const manifest = structuredClone(fixture())
      const saved = { ...settings, previewRenderer, cubeSpritesPbr: false, pbrMaterials }
      if (pbrMaterials === undefined) Reflect.deleteProperty(saved, 'pbrMaterials')
      manifest.settings = saved as typeof settings
      manifest.assets[0].model.settings = { ...saved } as typeof settings
      const parsed = parseSceneManifest(manifest)
      expect(parsed.settings.pbrMaterials).toBe(pbrMaterials ?? true)
      expect(parsed.assets[0].model.settings.pbrMaterials).toBe(pbrMaterials ?? previewRenderer === 'standard')
      expect(parsed.settings).not.toHaveProperty('cubeSpritesPbr')
      expect(parseSceneManifest(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
    }
  })

  test('skybox presets round-trip in scenes and child models with legacy solid defaults', () => {
    for (const skybox of ['solid', 'daylight', 'overcast', 'sunset', 'night', undefined] as const) {
      const expected = { ...settings, skybox: skybox ?? 'solid', background: '#243648', ambient: 0.7, light: 3.1, lightAzimuth: -72, tiltShift: true, tiltShiftStrength: 0.8, tiltShiftFocus: 0.3, tiltShiftWidth: 0.1 }
      const manifest = structuredClone(fixture())
      manifest.settings = { ...expected }
      manifest.assets[0].model.settings = { ...expected, skybox: skybox === undefined ? 'solid' : 'night' }
      const childSettings = { ...manifest.assets[0].model.settings }
      if (skybox === undefined) {
        Reflect.deleteProperty(manifest.settings, 'skybox')
        Reflect.deleteProperty(manifest.assets[0].model.settings, 'skybox')
      }
      const restored = new SceneDocument(JSON.parse(JSON.stringify(manifest))).snapshot()
      expect(restored.settings).toEqual(expected)
      expect(restored.assets[0].model.settings).toEqual(childSettings)
      expect(new SceneDocument(JSON.parse(JSON.stringify(restored))).snapshot()).toEqual(restored)
      expect(restored.version).toBe(1)
    }
  })

  test('skybox commands reject invalid presets atomically and preserve settings through undo', () => {
    const scene = new SceneDocument(fixture()), before = scene.snapshot()
    for (const skybox of [null, false, 0, '', 'Daylight', 'unknown', 'toString', '__proto__', [], {}]) {
      expect(() => scene.execute({ type: 'scene.settings', patch: { skybox, ambient: 0 } } as SceneCommand)).toThrow('skybox')
      expect(() => parseSceneManifest({ ...before, settings: { ...settings, skybox } })).toThrow('skybox')
      expect(() => parseSceneAsset({ ...before.assets[0], model: { ...header, settings: { ...settings, skybox } } })).toThrow('skybox')
      expect(scene.snapshot()).toBe(before)
      expect(scene.canUndo).toBe(false)
    }
    for (const skybox of ['daylight', 'overcast', 'sunset', 'night', 'solid'] as const) {
      const previous = scene.data.settings
      expect(scene.execute({ type: 'scene.settings', patch: { skybox } })).toMatchObject({ changed: true, instanceIds: [], assetIds: [] })
      expect(scene.data.settings).toEqual({ ...settings, skybox })
      expect(scene.data.assets).toBe(before.assets)
      expect(scene.data.instances).toBe(before.instances)
      scene.execute({ type: 'history.undo' })
      expect(scene.data.settings).toEqual(previous)
      scene.execute({ type: 'history.redo' })
      expect(scene.data.settings).toEqual({ ...settings, skybox })
      expect(scene.execute({ type: 'scene.settings', patch: { skybox } }).changed).toBe(false)
    }
  })

  test('miniature settings round-trip and legacy fields default without weakening required settings', () => {
    const enabled = { ...settings, tiltShift: true, tiltShiftStrength: 0.9, tiltShiftFocus: 1, tiltShiftWidth: 0 }
    const manifest = { ...fixture(), settings: enabled }
    manifest.assets = manifest.assets.map(asset => ({ ...asset, model: { ...asset.model, settings: enabled } }))
    const restored = new SceneDocument(JSON.parse(JSON.stringify(manifest))).snapshot()
    expect(restored).toEqual(manifest)
    expect(createScene(enabled).settings).toEqual(enabled)
    const keys = ['tiltShift', 'tiltShiftStrength', 'tiltShiftFocus', 'tiltShiftWidth'] as const
    for (const missing of [...keys.map(key => [key]), keys]) {
      const legacy = structuredClone(manifest), expected = { ...enabled }
      for (const key of missing) {
        Reflect.deleteProperty(legacy.settings, key)
        Reflect.deleteProperty(legacy.assets[0].model.settings, key)
        Reflect.set(expected, key, DEFAULT_SETTINGS[key])
      }
      const parsed = parseSceneManifest(legacy)
      expect(parsed.settings).toEqual(expected)
      expect(parsed.assets[0].model.settings).toEqual(expected)
    }
    for (const key of ['background', 'ambient', 'light', 'lightAzimuth', 'ambientOcclusion', 'shadows', 'grid', 'faceGrid', 'projection', 'pathTracing']) {
      const incomplete = structuredClone(manifest)
      Reflect.deleteProperty(incomplete.settings, key)
      expect(() => parseSceneManifest(incomplete)).toThrow('settings is incomplete')
    }
  })

  test('miniature commands validate patches atomically and are undoable without changing scene geometry', () => {
    const scene = new SceneDocument(fixture()), before = scene.snapshot()
    for (const key of ['tiltShift', 'tiltShiftStrength', 'tiltShiftFocus', 'tiltShiftWidth']) {
      for (const value of key === 'tiltShift' ? [null, NaN, 0, 1, 'false', 'true', [], {}] : [null, NaN, Infinity, -Infinity, -0.01, 1.01, false, true, '0.5', [], {}]) {
        expect(() => scene.execute({ type: 'scene.settings', patch: { [key]: value } })).toThrow(key)
        expect(() => parseSceneManifest({ ...before, settings: { ...settings, [key]: value } })).toThrow(key)
        expect(scene.snapshot()).toBe(before)
        expect(scene.canUndo).toBe(false)
      }
    }
    for (const patch of [null, [], {}, { unknown: true }]) expect(() => scene.execute({ type: 'scene.settings', patch } as SceneCommand)).toThrow()
    const enabled = { tiltShift: true, tiltShiftStrength: 1, tiltShiftFocus: 0, tiltShiftWidth: 0.01 }
    expect(scene.execute({ type: 'scene.settings', patch: enabled })).toMatchObject({ changed: true, instanceIds: [], assetIds: [] })
    expect(scene.data.settings).toEqual({ ...settings, ...enabled })
    expect(scene.data.instances).toBe(before.instances)
    expect(scene.data.assets).toBe(before.assets)
    expect(scene.data.settings.projection).toBe(settings.projection)
    scene.execute({ type: 'history.undo' })
    expect(scene.data.settings).toEqual(settings)
    expect(scene.canUndo).toBe(false)
    scene.execute({ type: 'history.redo' })
    expect(scene.data.settings).toEqual({ ...settings, ...enabled })
    expect(scene.execute({ type: 'scene.settings', patch: enabled }).changed).toBe(false)
  })

  test('normalizes finite quaternions robustly, including extreme magnitudes', () => {
    for (const magnitude of [2, Number.MIN_VALUE, Number.MAX_VALUE]) {
      const manifest = fixture()
      manifest.instances[0].rotation = { x: magnitude, y: 0, z: 0, w: magnitude }
      const q = parseSceneManifest(manifest).instances[0].rotation
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12)
      expect(q.x).toBeCloseTo(Math.SQRT1_2, 12)
    }
  })

  test('rejects invalid references, bounded metadata, counts, and transforms', () => {
    const cases: ((scene: SceneManifest) => void)[] = [
      scene => { scene.extent.x = 16385 }, scene => { scene.extent.y = 0 },
      scene => { scene.instances[0].position.x = 8193 }, scene => { scene.instances[0].position.y = -1 },
      scene => { scene.instances[0].position.z = -8193 }, scene => { scene.instances[0].position.y = Infinity },
      scene => { scene.instances[0].scale.x = 0 }, scene => { scene.instances[0].scale.y = 256.01 },
      scene => { scene.instances[0].scale.z = -1 }, scene => { scene.instances[0].rotation.w = NaN },
      scene => { scene.instances[0].rotation = { ...zero, w: 0 } },
      scene => { scene.instances[0].assetId = 'missing' }, scene => { scene.instances[0].layerId = 2 },
      scene => { scene.instances.push(scene.instances[0]) }, scene => { scene.assets.push(scene.assets[0]) },
      scene => { scene.layers.push(scene.layers[0]) }, scene => { scene.layers = [] }, scene => { scene.activeLayerId = 2 },
      scene => { scene.instances = new Array(10001) }, scene => { scene.instances = new Array(1) },
      scene => { scene.assets = new Array(10001) }, scene => { scene.layers = new Array(10001) },
      scene => { scene.assets[0].chunks[0].blob = '../blob' }, scene => { scene.assets[0].chunks[0].layerId = 2 },
      scene => { scene.assets[0].chunks[0].count = 4097 }, scene => { scene.assets[0].voxelCount = 0 },
      scene => { scene.assets[0].chunks[0].bounds.max.x = 17 }, scene => { scene.assets[0].bounds!.max.x = 15 },
      scene => { scene.assets[0].chunks[0].colors = [0] }, scene => { scene.assets[0].chunks[0].lod = Array(64).fill(0) },
      scene => { scene.assets[0].chunks[0].lod = Array(65).fill(80) }, scene => { scene.assets[0].chunks[0].lod[0] = 4 },
      scene => { scene.assets[0].chunks.push(scene.assets[0].chunks[0]) },
      scene => { scene.assets[0].model.palette = new Array(1000000) }, scene => { scene.assets[0].model.palette = new Array(256) },
      scene => { scene.assets[0].model.materials = new Array(256) }, scene => { scene.assets[0].model.layers = new Array(10001) },
      scene => { scene.assets[0].chunks = new Array(262145) }, scene => { scene.assets[0].pivot.x = 257 },
      scene => { scene.assets[0].source!.version = -1 }, scene => { scene.name = 'a'.repeat(10000) },
      scene => { scene.settings.ambient = NaN }, scene => { Object.assign(scene, { unbounded: new Array(1000000) }) },
      scene => { Object.assign(scene.assets[0].model, { chunks: new Array(1000000) }) },
    ]
    for (const mutate of cases) {
      const scene = structuredClone(fixture())
      mutate(scene)
      expect(() => parseSceneManifest(scene)).toThrow()
    }
    expect(() => parseSceneManifest(null)).toThrow()
    expect(() => parseSceneManifest({ ...fixture(), version: 2 })).toThrow()
  })

  test('allows edge pivots and protruding conservative bounds without clipping', () => {
    const scene = new SceneDocument(fixture([instance('edge', 'asset', { x: -8192, y: 0, z: 8192 })]))
    const bounds = scene.index.bounds.get('edge')!
    expect(bounds.min.toArray()).toEqual([-8200, -8, 8184])
    expect(bounds.max.toArray()).toEqual([-8184, 8, 8200])
    expect(scene.index.queryBox(new Box3(new Vector3(-8200, -8, 8193), new Vector3(-8199, -7, 8194)))).toEqual(['edge'])
  })
})

describe('scene document and sparse world index', () => {
  test('a transform updates one membership and preserves every untouched record', () => {
    const scene = new SceneDocument(fixture([instance('a'), instance('b', 'asset', { x: 1024, y: 32, z: 0 })]))
    const before = scene.snapshot(), otherBounds = scene.index.bounds.get('b'), updates = scene.index.updateCount
    const moved = { ...scene.instances.get('a')!, position: { x: 512, y: 32, z: 0 } }
    scene.execute({ type: 'instances.transform', transforms: [{ id: moved.id, position: moved.position, rotation: moved.rotation, scale: moved.scale }] })
    expect(scene.index.updateCount - updates).toBe(1)
    expect(scene.data.assets).toBe(before.assets)
    expect(scene.data.layers).toBe(before.layers)
    expect(scene.instances.get('b')).toBe(before.instances[1])
    expect(scene.index.bounds.get('b')).toBe(otherBounds)
    expect(before.instances[0].position.x).toBe(0)
    expect(scene.index.queryBox(new Box3(new Vector3(-10, -10, -10), new Vector3(10, 10, 10)))).toEqual([])
    expect(scene.index.queryBox(new Box3(new Vector3(500, 20, -10), new Vector3(530, 40, 10)))).toEqual(['a'])
    expect([...scene.index.membership.get('a')!].every(key => !scene.index.cells.get(key)?.has('missing'))).toBe(true)
  })

  test('make unique shares descriptors, copies metadata, and invalidates only its instance', () => {
    const scene = new SceneDocument(fixture([instance('a'), instance('b')]))
    const original = scene.assets.get('asset')!, updates = scene.index.updateCount
    const result = scene.execute({ type: 'instance.unique', id: 'a' })
    const id = scene.instances.get('a')!.assetId, copy = scene.assets.get(id)!
    expect(result.instanceIds).toEqual(['a'])
    expect(scene.index.updateCount - updates).toBe(1)
    expect(copy.chunks).toBe(original.chunks)
    expect(copy.model).not.toBe(original.model)
    expect(copy.model.materials).not.toBe(original.model.materials)
    expect(copy.source).toEqual(original.source)
    expect(scene.assetInstances.get('asset')).toEqual(new Set(['b']))
    expect(scene.assetInstances.get(id)).toEqual(new Set(['a']))
    scene.execute({ type: 'history.undo' })
    expect(scene.instances.get('a')!.assetId).toBe('asset')
    expect(scene.assets.has(id)).toBe(false)
    scene.execute({ type: 'history.redo' })
    expect(scene.instances.get('a')!.assetId).toBe(id)
  })

  test('asset updates touch only reverse refs and are never reverted by scene history', () => {
    const scene = new SceneDocument(fixture([instance('a'), instance('b'), instance('other', 'other-asset')], [asset(), asset('other-asset')]))
    scene.execute({ type: 'selection.set', ids: ['b'] })
    scene.execute({ type: 'instances.transform', transforms: [{ id: 'a', position: { x: 512, y: 0, z: 0 }, scale: unit, rotation }] })
    scene.execute({ type: 'instance.unique', id: 'a' })
    const unique = scene.assets.get(scene.instances.get('a')!.assetId)!
    const updates = scene.index.updateCount
    const edited = { ...unique, revision: 1, model: { ...unique.model, name: 'Edited independently' } }
    scene.execute({ type: 'asset.update', asset: edited })
    expect(scene.index.updateCount - updates).toBe(1)
    expect(scene.assets.get('asset')!.model.name).toBe('Black model')
    scene.execute({ type: 'history.undo' })
    expect(scene.instances.get('a')!.assetId).toBe('asset')
    scene.execute({ type: 'history.redo' })
    expect(scene.assets.get(unique.id)!.model.name).toBe('Edited independently')
    expect(scene.assets.get(unique.id)!.revision).toBe(1)
    scene.execute({ type: 'history.undo' })
    scene.execute({ type: 'history.undo' })
    expect(scene.instances.get('a')!.position.x).toBe(0)
    expect(scene.selection).toEqual(['b'])
    const count = scene.index.updateCount
    const shared = scene.assets.get('asset')!
    const changed = scene.execute({ type: 'asset.update', asset: { ...shared, revision: 1, pivot: { x: 0, y: 0, z: 0 } } })
    expect(new Set(changed.instanceIds)).toEqual(new Set(['a', 'b']))
    expect(scene.index.updateCount - count).toBe(2)
    scene.execute({ type: 'history.redo' })
    expect(scene.assets.get('asset')!.pivot).toEqual(zero)
  })

  test('asset creation history restores the latest editor revision', () => {
    const scene = new SceneDocument(createScene(settings))
    scene.execute({ type: 'asset.add', asset: asset() })
    scene.execute({ type: 'asset.update', asset: { ...scene.assets.get('asset')!, revision: 9, model: { ...header, name: 'Latest model' } } })
    scene.execute({ type: 'history.undo' })
    expect(scene.assets.size).toBe(0)
    scene.execute({ type: 'history.redo' })
    expect(scene.assets.get('asset')!.revision).toBe(9)
    expect(scene.assets.get('asset')!.model.name).toBe('Latest model')
  })

  test('placement and layer creation undo restore selection; model-only updates add no history', () => {
    const scene = new SceneDocument(fixture())
    const asset = scene.assets.get('asset')!
    scene.execute({ type: 'asset.update', asset: { ...asset, revision: 1 } })
    expect(scene.canUndo).toBe(false)
    const bytes = scene.historyBytes
    expect(() => scene.execute({ type: 'asset.update', asset })).toThrow('advance')
    expect(scene.historyBytes).toBe(bytes)
    scene.execute({ type: 'selection.set', ids: ['instance'] })
    scene.execute({ type: 'layer.create', name: 'New layer' })
    expect(scene.data.activeLayerId).toBe(2)
    scene.execute({ type: 'instance.place', assetId: 'asset', position: zero })
    const id = scene.selection[0]
    expect(scene.instances.get(id)!.layerId).toBe(2)
    scene.execute({ type: 'history.undo' })
    expect(scene.selection).toEqual([])
    expect(scene.instances.has(id)).toBe(false)
    scene.execute({ type: 'history.undo' })
    expect(scene.data.activeLayerId).toBe(1)
    expect(scene.selection).toEqual(['instance'])
    expect(scene.data.layers).toHaveLength(1)
  })

  test('selection, visibility, locked layers and all mutation entry points are enforced atomically', () => {
    const manifest = fixture([instance('a'), instance('b', 'asset', zero, 2)])
    manifest.layers.push({ id: 2, name: 'Locked', visible: true, locked: true })
    const scene = new SceneDocument(manifest)
    scene.execute({ type: 'selection.set', ids: ['a', 'b'] })
    scene.execute({ type: 'layer.activate', id: 2 })
    expect(scene.data.activeLayerId).toBe(2)
    const commands: SceneCommand[] = [
      { type: 'instance.place', assetId: 'asset', position: zero },
      { type: 'instances.insert', instances: [instance('new', 'asset', zero, 2)] },
      { type: 'instances.transform', transforms: [{ id: 'a', position: { x: 100, y: 0, z: 0 }, scale: unit, rotation }, { id: 'b', position: zero, scale: unit, rotation }] },
      { type: 'instances.delete', ids: ['a', 'b'] }, { type: 'instances.layer', ids: ['a'], layerId: 2 },
      { type: 'instances.layer', ids: ['b'], layerId: 1 }, { type: 'instance.unique', id: 'b' },
      { type: 'layer.rename', id: 2, name: 'No' }, { type: 'layer.delete', id: 2, allowNonEmpty: true },
      { type: 'asset.add', asset: asset('new-asset') },
    ]
    for (const command of commands) {
      const before = scene.data, updates = scene.index.updateCount
      expect(() => scene.execute(command)).toThrow('hidden or locked')
      expect(scene.data).toBe(before)
      expect(scene.index.updateCount).toBe(updates)
    }
    scene.execute({ type: 'selection.set', ids: ['b'] })
    scene.execute({ type: 'layer.visibility', id: 2, visible: false })
    expect(scene.selection).toEqual([])
    expect(scene.index.bounds.has('b')).toBe(false)
    expect(() => scene.execute({ type: 'selection.set', ids: ['b'] })).toThrow('Hidden')
    scene.execute({ type: 'history.undo' })
    expect(scene.selection).toEqual(['b'])
    expect(scene.index.bounds.has('b')).toBe(true)
    scene.execute({ type: 'layer.lock', id: 2, locked: false })
    expect(scene.execute({ type: 'instances.delete', ids: ['b'] }).changed).toBe(true)
  })

  test('model-editor asset updates propagate to locked and hidden copies without mutating their instances', () => {
    const manifest = fixture([instance('editing'), instance('locked', 'asset', zero, 2), instance('hidden', 'asset', zero, 3)])
    manifest.layers.push({ id: 2, name: 'Locked', visible: true, locked: true }, { id: 3, name: 'Hidden', visible: false, locked: true })
    const scene = new SceneDocument(manifest), before = scene.snapshot()
    scene.execute({ type: 'selection.set', ids: ['editing'] })
    const copy = { ...scene.assets.get('asset')!, revision: 1, chunks: [{ ...chunk(), blob: 'b'.repeat(64), colors: [5], lod: Array(64).fill(5) }] }
    const change = scene.execute({ type: 'asset.update', asset: copy })
    expect(new Set(change.instanceIds)).toEqual(new Set(['editing', 'locked', 'hidden']))
    expect(scene.data.instances).toBe(before.instances)
    expect(scene.data.layers).toBe(before.layers)
    expect(scene.assets.get('asset')!.chunks[0].colors).toEqual([5])
    expect(scene.index.bounds.has('hidden')).toBe(false)
    expect(scene.canUndo).toBe(false)
    expect(() => scene.execute({ type: 'instances.transform', transforms: [{ id: 'locked', position: { x: 1, y: 0, z: 0 }, rotation, scale: unit }] })).toThrow('hidden or locked')
    expect(() => scene.execute({ type: 'instances.delete', ids: ['hidden'] })).toThrow('hidden or locked')
    scene.execute({ type: 'layer.visibility', id: 1, visible: false })
    expect(scene.execute({ type: 'asset.update', asset: { ...scene.assets.get('asset')!, revision: 2 } }).changed).toBe(true)
  })

  test('layer delete and undo preserve ordering, selection and current asset edits', () => {
    const manifest = fixture([instance('a'), instance('b', 'asset', zero, 2), instance('c')])
    manifest.layers.push({ id: 2, name: 'Second', visible: true, locked: false })
    const scene = new SceneDocument(manifest)
    scene.execute({ type: 'layer.activate', id: 2 })
    scene.execute({ type: 'selection.set', ids: ['b', 'c'] })
    expect(() => scene.execute({ type: 'layer.delete', id: 2 })).toThrow('removes 1')
    scene.execute({ type: 'layer.delete', id: 2, allowNonEmpty: true })
    expect(scene.selection).toEqual(['c'])
    expect(scene.index.bounds.has('b')).toBe(false)
    scene.execute({ type: 'asset.update', asset: { ...scene.assets.get('asset')!, revision: 1, model: { ...header, name: 'Not undone' } } })
    scene.execute({ type: 'history.undo' })
    expect(scene.data.instances.map(instance => instance.id)).toEqual(['a', 'b', 'c'])
    expect(scene.data.layers.map(layer => layer.id)).toEqual([1, 2])
    expect(scene.selection).toEqual(['b', 'c'])
    expect(scene.data.activeLayerId).toBe(2)
    expect(scene.assets.get('asset')!.model.name).toBe('Not undone')
  })

  test('ray/frustum/box queries deduplicate cells and handle rotated oversized bounds', () => {
    const manifest = fixture([instance('near', 'asset', { x: 256, y: 20, z: 0 }), instance('far', 'asset', { x: 1024, y: 20, z: 0 }), instance('huge', 'asset', { x: 4096, y: 4096, z: 4096 })])
    manifest.instances[2].scale = { x: 256, y: 256, z: 256 }
    manifest.instances[2].rotation = { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) }
    const scene = new SceneDocument(manifest)
    expect(scene.index.oversized).toEqual(new Set(['huge']))
    const ray = new Ray(new Vector3(0, 20, 0), new Vector3(1, 0, 0))
    expect(scene.index.queryRay(ray)).toEqual([{ id: 'near', distance: 248 }, { id: 'far', distance: 1016 }])
    expect(scene.index.queryRay(ray, 500).map(hit => hit.id)).toEqual(['near'])
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().makeOrthographic(200, 300, 50, 0, -20, 20))
    expect(scene.index.queryFrustum(frustum)).toEqual(['near'])
    expect(scene.index.queryBox(scene.index.bounds.get('huge')!.clone())).toContain('huge')
    scene.execute({ type: 'instances.delete', ids: ['huge'] })
    expect(scene.index.oversized.size).toBe(0)
    expect(scene.index.membership.has('huge')).toBe(false)
  })

  test('history is bounded across undo and redo, and new edits discard redo', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `instance-${i}-${'a'.repeat(90)}`)
    const scene = new SceneDocument(fixture(ids.map(id => instance(id))))
    scene.execute({ type: 'selection.set', ids })
    for (let i = 0; i < 100; i++) {
      scene.execute({ type: 'scene.rename', name: `Revision ${i}` })
      expect(scene.historyBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    }
    const bytes = scene.historyBytes
    let undone = 0
    while (scene.canUndo) { scene.execute({ type: 'history.undo' }); undone++ }
    expect(undone).toBeGreaterThan(0)
    expect(undone).toBeLessThan(100)
    expect(scene.historyBytes).toBe(bytes)
    expect(scene.selection).toEqual(ids)
    scene.execute({ type: 'history.redo' })
    scene.execute({ type: 'scene.rename', name: 'New branch' })
    expect(scene.canRedo).toBe(false)
    expect(scene.historyBytes).toBeLessThan(bytes)
  })

  test('10,000 instances are legal; insertion at the limit and mixed invalid transforms are atomic', () => {
    const scene = new SceneDocument(fixture(Array.from({ length: 10000 }, (_, i) => instance(`i${i}`))))
    expect(() => scene.execute({ type: 'instance.place', assetId: 'asset', position: zero })).toThrow('capacity')
    const before = scene.data, updates = scene.index.updateCount
    expect(() => scene.execute({ type: 'instances.transform', transforms: [{ id: 'i0', position: { x: 10, y: 0, z: 0 }, rotation, scale: unit }, { id: 'i1', position: { x: 99999, y: 0, z: 0 }, rotation, scale: unit }] })).toThrow()
    expect(scene.data).toBe(before)
    expect(scene.index.updateCount).toBe(updates)
  })

  test('100M represented repeated voxels and 100M unique descriptor voxels never hydrate', () => {
    const fetch = spyOn(globalThis, 'fetch')
    const scan = spyOn(VoxelDocument.prototype, 'forEachVoxel')
    try {
      const full = asset('full', Array.from({ length: 4096 }, (_, i) => chunk(i)))
      const repeated = new SceneDocument(fixture(Array.from({ length: 6 }, (_, i) => instance(`r${i}`, 'full')), [full]))
      expect(repeated.data.instances.reduce((n, instance) => n + repeated.assets.get(instance.assetId)!.voxelCount, 0)).toBeGreaterThanOrEqual(100_000_000)
      let serial = 0
      const assets = Array.from({ length: 7 }, (_, i) => asset(`unique${i}`, Array.from({ length: i < 6 ? 4096 : 1 }, (_, id) => chunk(id, 1, (++serial).toString(16).padStart(64, '0')))))
      const unique = new SceneDocument(fixture(assets.map(asset => instance(`i-${asset.id}`, asset.id)), assets))
      expect(unique.data.assets.reduce((n, asset) => n + asset.voxelCount, 0)).toBeGreaterThanOrEqual(100_000_000)
      expect(new Set(unique.data.assets.flatMap(asset => asset.chunks.map(chunk => chunk.blob))).size).toBe(serial)
      const updates = unique.index.updateCount, descriptors = unique.assets.get('unique1')!.chunks
      unique.execute({ type: 'instances.transform', transforms: [{ id: 'i-unique0', position: { x: 256, y: 0, z: 0 }, rotation, scale: unit }] })
      expect(unique.index.updateCount - updates).toBe(1)
      expect(unique.assets.get('unique1')!.chunks).toBe(descriptors)
      expect(fetch).not.toHaveBeenCalled()
      expect(scan).not.toHaveBeenCalled()
    } finally { fetch.mockRestore(); scan.mockRestore() }
  })

  test('bounded metadata admits 100M 255-color voxels and 300M monochrome voxels', () => {
    for (const [assetCount, colors] of [[6, Array.from({ length: 255 }, (_, i) => i + 1)], [18, [80]]] as const) {
      let serial = 0
      const assets = Array.from({ length: assetCount }, (_, i) => asset(`large${i}`, Array.from({ length: 4096 }, (_, id) => ({ ...chunk(id, 1, (++serial).toString(16).padStart(64, '0')), colors: [...colors] }))))
      const scene = new SceneDocument(fixture(assets.map(asset => instance(`i-${asset.id}`, asset.id)), assets))
      expect(scene.data.assets.reduce((n, asset) => n + asset.voxelCount, 0)).toBeGreaterThanOrEqual(assetCount === 6 ? 100_000_000 : 300_000_000)
      const before = scene.data.assets, updates = scene.index.updateCount
      scene.execute({ type: 'instances.transform', transforms: [{ id: 'i-large0', position: { x: 32, y: 0, z: 0 }, scale: unit, rotation }] })
      expect(scene.data.assets).toBe(before)
      expect(scene.index.updateCount - updates).toBe(1)
    }
  }, 20000)

  test('undo and redo reject capacity growth atomically after independent asset edits', () => {
    const colors = Array.from({ length: 255 }, (_, i) => i + 1)
    const assets = Array.from({ length: 9 }, (_, i) => asset(`large${i}`, Array.from({ length: 4096 }, (_, id) => ({ ...chunk(id), colors }))))
    const instances = Array.from({ length: 1000 }, (_, i) => instance(`i${i}`, `large${i % assets.length}`))
    for (const redo of [false, true]) {
      const scene = new SceneDocument(fixture(redo ? [] : instances, assets))
      if (redo) {
        scene.execute({ type: 'instances.insert', instances })
        scene.execute({ type: 'history.undo' })
      } else scene.execute({ type: 'instances.delete', ids: instances.map(instance => instance.id) })
      const original = scene.assets.get('large0')!
      const grown = {
        ...original, revision: 1,
        model: { ...original.model, layers: [...original.model.layers, { id: 2, name: 'Growth', visible: true, locked: false }] },
        chunks: [...original.chunks, ...Array.from({ length: 300 }, (_, id) => ({ ...chunk(id, 2), colors }))],
        voxelCount: original.voxelCount + 300 * 4096,
      }
      scene.execute({ type: 'asset.update', asset: grown })
      const before = scene.data, selection = scene.selection, bytes = scene.historyBytes, updates = scene.index.updateCount
      const history = [scene.canUndo, scene.canRedo]
      expect(() => scene.execute({ type: redo ? 'history.redo' : 'history.undo' })).toThrow('capacity')
      expect(scene.data).toBe(before)
      expect(scene.selection).toBe(selection)
      expect(scene.instances.size).toBe(0)
      expect(scene.historyBytes).toBe(bytes)
      expect(scene.index.updateCount).toBe(updates)
      expect([scene.canUndo, scene.canRedo]).toEqual(history)
      scene.execute({ type: 'asset.update', asset: { ...original, revision: 2 } })
      scene.execute({ type: redo ? 'history.redo' : 'history.undo' })
      expect(scene.instances.size).toBe(1000)
    }
  }, 20000)
})

describe('scene chunk metadata and hydration boundary', () => {
  test('4x4x4 LOD uses occupied majorities and preserves authored black palette indices', () => {
    const bytes = new Uint8Array(4096)
    bytes[0] = 2; bytes[1] = bytes[2] = 80
    bytes[15 + 15 * 16 + 15 * 256] = 80
    const result = describeSceneChunk(1, 3, bytes, hash)!
    expect(result.count).toBe(4)
    expect(result.colors).toEqual([2, 80])
    expect(result.bounds).toEqual({ min: { x: 16, y: 0, z: 0 }, max: { x: 32, y: 16, z: 16 } })
    expect(result.lod[0]).toBe(80)
    expect(result.lod[63]).toBe(80)
    expect(result.lod.filter(Boolean)).toHaveLength(2)
    expect(describeSceneChunk(0, 1, new Uint8Array(4096), hash)).toBeUndefined()
    expect(() => describeSceneChunk(0, 1, new Uint8Array(4095), hash)).toThrow()
    expect(parseSceneAsset(asset('lod', [{ ...result, layerId: 1 }])).chunks[0]).toBeDefined()
  })

  test('shared descriptor validation requires exact bounds and translates cached blob metadata origins', () => {
    const bytes = new Uint8Array(4096)
    bytes[1 + 2 * 16 + 3 * 256] = 80
    const actual = describeSceneChunk(0, 1, bytes, hash)!
    const descriptor = describeSceneChunk(513, 4, bytes, hash)!
    expect(() => validateSceneChunkDescriptor(descriptor, actual)).not.toThrow()
    const mutations: ((chunk: SceneChunk) => void)[] = [
      chunk => { chunk.bounds.min.x-- }, chunk => { chunk.bounds.max.y++ }, chunk => { chunk.bounds.max.z-- },
      chunk => { chunk.blob = 'b'.repeat(64) }, chunk => { chunk.count++ }, chunk => { chunk.colors = [5] },
      chunk => { chunk.lod[0] = 5 }, chunk => { chunk.lod = chunk.lod.slice(1) },
    ]
    for (const mutate of mutations) {
      const bad = structuredClone(descriptor)
      mutate(bad)
      expect(() => validateSceneChunkDescriptor(bad, actual)).toThrow('does not match')
    }
    expect(() => validateSceneChunkDescriptor(descriptor, undefined)).toThrow('does not match')
  })

  test('non-persisting exports work without IndexedDB and cannot inherit a concurrent persistence failure', async () => {
    const idb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { throw new DOMException('Storage unavailable', 'SecurityError') } } })
    const bytes = new Uint8Array(4096)
    bytes[42] = 80
    const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => new Response(bytes), { preconnect() {} }))
    try {
      const [normal, exported] = await Promise.allSettled([loadSceneChunk(hash), loadSceneChunk(hash, { persist: false })])
      expect(normal.status).toBe('rejected')
      expect(exported.status).toBe('fulfilled')
      if (exported.status === 'fulfilled') { expect(exported.value[42]).toBe(80); exported.value[42] = 5 }
      expect(fetch).toHaveBeenCalledTimes(1)
      expect((await loadSceneChunk(hash, { persist: false }))[42]).toBe(80)
      await expect(loadSceneChunk('e'.repeat(64), { persist: false })).rejects.toThrow('SHA-256 mismatch')
      fetch.mockImplementation(Object.assign(async () => new Response(new Uint8Array(4097)), { preconnect() {} }))
      await expect(loadSceneChunk('d'.repeat(64), { persist: false })).rejects.toThrow('exceeds 4096')
    } finally {
      fetch.mockRestore()
      if (idb) Object.defineProperty(globalThis, 'indexedDB', idb)
      else Reflect.deleteProperty(globalThis, 'indexedDB')
    }
  })

  test('metadata-only saves reuse descriptors and preserve pivot/source without reading any bytes', async () => {
    const document = new VoxelDocument({ x: 256, y: 256, z: 256 }, 'Metadata edit', header.palette, header.materials, header.layers, 1, header.paletteOccupied)
    document.chunks.set(0, new Map([[1, new Uint8Array(4096).fill(80)]]))
    const previous = asset()
    const source = structuredClone(previous.source)
    const next = await putSceneAsset(document, settings, previous, [])
    expect(next.chunks[0]).toBe(previous.chunks[0])
    expect(next.voxelCount).toBe(4096)
    expect(next.pivot).toEqual(previous.pivot)
    expect(next.source).toEqual(source)
    expect(next.revision).toBe(1)
    expect(next.model.name).toBe('Metadata edit')
    document.chunks.clear()
    const empty = await putSceneAsset(document, settings, next, [])
    expect(empty.chunks).toEqual([])
    expect(empty.bounds).toBeUndefined()
    expect(empty.voxelCount).toBe(0)
    expect(next.chunks[0]).toBe(previous.chunks[0])
    const resized = resizeVoxelDocument(document, { x: 32, y: 48, z: 64 }, 'center').document
    expect((await putSceneAsset(resized, settings, empty, [])).pivot).toEqual({ x: 16, y: 0, z: 32 })
  })

  test('new and resized assets keep model Y unshifted and center X/Z', async () => {
    const document = new VoxelDocument({ x: 32, y: 48, z: 64 })
    const created = await putSceneAsset(document, settings)
    expect(created.pivot).toEqual({ x: 16, y: 0, z: 32 })
    const placed = instance('floor', created.id)
    expect(new Vector3(16, 0, 32).applyMatrix4(instanceMatrix(placed, created)).toArray()).toEqual([0, 0, 0])
    expect(new Vector3(16, 12, 32).applyMatrix4(instanceMatrix(placed, created)).y).toBe(12)
    const resized = resizeVoxelDocument(document, { x: 64, y: 96, z: 128 }, 'center').document
    const updated = await putSceneAsset(resized, settings, { ...created, pivot: { x: 3, y: 7, z: 4 } }, [])
    expect(updated.pivot).toEqual({ x: 32, y: 0, z: 64 })
  })

  test('100M unique voxel bytes cannot enter the model editor; rejection precedes IDB or fetch', async () => {
    let n = 0
    const chunks = Array.from({ length: 6 }, (_, layer) => Array.from({ length: 4096 }, (_, id) => chunk(id, layer + 1, (++n).toString(16).padStart(64, '0')))).flat()
    const input = asset('too-large', chunks)
    input.model = { ...header, layers: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `Layer ${i + 1}`, visible: true, locked: false })) }
    await expect(loadSceneAsset(input)).rejects.toThrow('72 MiB')
  })

  test('20-layer inputs hit the owned-array budget before copying or processing descriptors', async () => {
    const layers = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Layer ${i + 1}`, visible: true, locked: false }))
    const document = new VoxelDocument(header.dimensions, 'Layer budget', header.palette, header.materials, layers)
    const bytes = new Uint8Array(4096).fill(80)
    for (let id = 0; id < 1000; id++) document.chunks.set(id, new Map(layers.map(layer => [layer.id, bytes])))
    const copies = spyOn(Uint8Array, 'from')
    try {
      await expect(putSceneAsset(document, settings)).rejects.toThrow('72 MiB')
      expect(copies).not.toHaveBeenCalled()
    } finally { copies.mockRestore() }
    const input = asset('layer-budget', layers.flatMap(layer => Array.from({ length: 1000 }, (_, id) => chunk(id, layer.id))))
    input.model = { ...header, layers }
    Object.defineProperty(input.chunks[0], 'blob', { get() { throw new Error('Chunk metadata should not be read') } })
    await expect(loadSceneAsset(input)).rejects.toThrow('72 MiB')
  })

  test('invalid blobs and recovery context reject before persistence', async () => {
    await expect(putSceneBlob('../bad', new Uint8Array(4096))).rejects.toThrow('SHA-256')
    await expect(putSceneBlob(hash, new Uint8Array(4095))).rejects.toThrow('4096')
    await expect(putSceneBlob(hash, new Uint8Array(4096))).rejects.toThrow('mismatch')
    await expect(loadSceneChunk(hash.toUpperCase())).rejects.toThrow('SHA-256')
    await expect(saveSceneRecovery(fixture(), { editingAssetId: 'unknown' })).rejects.toThrow('unknown asset')
    await expect(saveSceneRecovery(fixture(), { selection: ['unknown'] })).rejects.toThrow('selection')
    await expect(loadSceneAsset(asset('empty', []))).resolves.toMatchObject({ document: { voxelCount: 0 } })
  })
})

test('100M-voxel trusted autosaves visit no untouched chunk metadata and write only the changed instance', async () => {
  // This request stub checks write locality; real browser checks cover IDB transaction semantics.
  const originalIdb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  const stores = new Map<string, Map<string, unknown>>(), writes: string[] = []
  let quotaExceeded = false
  const result = (value: unknown) => {
    const pending = { result: structuredClone(value), onsuccess: undefined as (() => void) | undefined }
    queueMicrotask(() => pending.onsuccess?.())
    return pending
  }
  const db = {
    onversionchange: undefined as (() => void) | undefined,
    close() {},
    transaction() {
      const tx = {
        oncomplete: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        abort() { tx.onabort?.() },
        objectStore(name: string) {
          const stored = stores.get(name) ?? new Map<string, unknown>()
          stores.set(name, stored)
          return {
            get(key: unknown) { return result(stored.get(JSON.stringify(key))) },
            getKey(key: unknown) { return result(stored.has(JSON.stringify(key)) ? key : undefined) },
            put(value: unknown, key: unknown) {
              if (name === 'blobs' && quotaExceeded) throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
              writes.push(name); stored.set(JSON.stringify(key), structuredClone(value))
            },
            delete(key: unknown) { stored.delete(JSON.stringify(key)) },
          }
        },
      }
      setTimeout(() => tx.oncomplete?.(), 0)
      return tx
    },
  }
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() {
    const pending = { result: db, onsuccess: undefined as (() => void) | undefined }
    queueMicrotask(() => pending.onsuccess?.())
    return pending
  } } })
  const restores: (() => void)[] = []
  try {
    let serial = 0
    const assets = Array.from({ length: 6 }, (_, i) => asset(`unique${i}`, Array.from({ length: 4096 }, (_, id) => chunk(id, 1, (++serial).toString(16).padStart(64, '0')))))
    const scene = new SceneDocument(fixture(assets.map(asset => instance(`i-${asset.id}`, asset.id)), assets))
    expect(scene.data.assets.reduce((n, asset) => n + asset.voxelCount, 0)).toBeGreaterThanOrEqual(100_000_000)
    await saveSceneDocumentRecovery(scene)
    for (const asset of scene.data.assets) {
      const descriptor = Object.getOwnPropertyDescriptor(asset, 'chunks')!
      Object.defineProperty(asset, 'chunks', { configurable: true, get() { throw new Error('Untouched chunk metadata accessed') } })
      restores.push(() => Object.defineProperty(asset, 'chunks', descriptor))
    }
    writes.length = 0
    const updates = scene.index.updateCount
    scene.execute({ type: 'instances.transform', transforms: [{ id: 'i-unique0', position: { x: 256, y: 0, z: 0 }, rotation, scale: unit }] })
    await saveSceneDocumentRecovery(scene, { selection: ['i-unique0'] })
    expect(scene.index.updateCount - updates).toBe(1)
    expect(writes).toEqual(['instances', 'scenes', 'meta'])
    expect(writes).not.toContain('assets')
    expect(writes).not.toContain('blobs')
    await expect(saveSceneRecovery(scene.snapshot())).rejects.toThrow('Untouched chunk metadata accessed')
    writes.length = 0
    scene.execute({ type: 'history.undo' })
    await saveSceneDocumentRecovery(scene)
    expect(writes).toEqual(['instances', 'scenes', 'meta'])
    for (const restore of restores.splice(0)) restore()

    const sky = new SceneDocument(createScene({ ...settings, skybox: 'sunset', background: '#243648', ambient: 0.7, light: 3.1, lightAzimuth: -72, tiltShift: true }))
    await saveSceneDocumentRecovery(sky)
    expect((await loadSceneRecovery())!.scene.settings).toEqual(sky.data.settings)
    const skyRow = stores.get('scenes')!.get(JSON.stringify(sky.data.id)) as SceneManifest
    Reflect.deleteProperty(skyRow.settings, 'skybox')
    const legacySky = new SceneDocument((await loadSceneRecovery())!.scene)
    expect(legacySky.data.settings).toEqual({ ...sky.data.settings, skybox: 'solid' })
    await saveSceneDocumentRecovery(legacySky)
    expect((await loadSceneRecovery())!.scene.settings).toEqual(legacySky.data.settings)

    const volumetric = new SceneDocument(createScene({ ...settings, volumetricLighting: true, shadows: false }))
    await saveSceneDocumentRecovery(volumetric)
    expect((await loadSceneRecovery())!.scene.settings).toEqual(volumetric.data.settings)
    const volumetricRow = stores.get('scenes')!.get(JSON.stringify(volumetric.data.id)) as SceneManifest
    Reflect.deleteProperty(volumetricRow.settings, 'volumetricLighting')
    expect((await loadSceneRecovery())!.scene.settings).toEqual({ ...volumetric.data.settings, volumetricLighting: false })
    Reflect.set(volumetricRow.settings, 'volumetricLighting', 'true')
    await expect(loadSceneRecovery()).rejects.toThrow('volumetricLighting')

    const miniature = new SceneDocument(createScene({ ...settings, tiltShift: true, tiltShiftStrength: 0.85, tiltShiftFocus: 0.7, tiltShiftWidth: 0.2 }))
    await saveSceneDocumentRecovery(miniature)
    expect((await loadSceneRecovery())!.scene.settings).toEqual(miniature.data.settings)
    const miniatureRow = stores.get('scenes')!.get(JSON.stringify(miniature.data.id)) as SceneManifest
    for (const key of ['tiltShift', 'tiltShiftStrength', 'tiltShiftFocus', 'tiltShiftWidth']) Reflect.deleteProperty(miniatureRow.settings, key)
    expect((await loadSceneRecovery())!.scene.settings).toEqual(settings)
    miniatureRow.settings.tiltShiftStrength = NaN
    await expect(loadSceneRecovery()).rejects.toThrow('tiltShiftStrength')

    const raw = fixture()
    await saveSceneRecovery(raw)
    raw.assets[0] = { ...raw.assets[0], model: structuredClone(raw.assets[0].model) }
    await saveSceneRecovery(raw)
    raw.assets[0].model.name = 'In-place boundary input'
    raw.revision++
    await saveSceneRecovery(raw)
    expect((await loadSceneRecovery())!.scene.assets[0].model.name).toBe('In-place boundary input')
    const boundary = structuredClone(fixture()), captured = saveSceneRecovery(boundary)
    boundary.assets[0].chunks[0].count = 9000
    boundary.assets[0].chunks[0].lod[0] = 0
    await captured
    const recovered = (await loadSceneRecovery())!.scene.assets[0].chunks[0]
    expect(recovered.count).toBe(4096)
    expect(recovered.lod[0]).toBe(80)

    const editor = new SceneDocument((await loadSceneRecovery())!.scene)
    const row = stores.get('scenes')!.get(JSON.stringify(editor.data.id)) as Record<string, unknown>
    row.saveId = crypto.randomUUID(); row.revision = editor.data.revision + 1; row.name = 'Other tab'
    editor.execute({ type: 'scene.rename', name: 'Local same-revision edit' })
    const local = editor.data
    writes.length = 0
    await expect(saveSceneDocumentRecovery(editor)).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(editor.data).toBe(local)
    editor.execute({ type: 'scene.rename', name: 'Local higher-revision edit' })
    await expect(saveSceneDocumentRecovery(editor)).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(writes).toEqual([])
    expect(row.name).toBe('Other tab')
    expect(editor.data.name).toBe('Local higher-revision edit')
    const reloaded = new SceneDocument((await loadSceneRecovery())!.scene)
    reloaded.execute({ type: 'scene.rename', name: 'Explicitly reloaded' })
    const firstSave = saveSceneDocumentRecovery(reloaded)
    reloaded.execute({ type: 'scene.rename', name: 'Queued later edit' })
    await Promise.all([firstSave, saveSceneDocumentRecovery(reloaded)])
    expect((await loadSceneRecovery())!.scene.name).toBe('Queued later edit')

    const collision = structuredClone(reloaded.snapshot())
    collision.id = crypto.randomUUID()
    const { assets: copiedAssets, instances: copiedInstances, ...copiedHeader } = collision
    const collisionHeader = { ...copiedHeader, saveId: crypto.randomUUID() as string, context: {}, assetIds: copiedAssets.map(asset => asset.id), instanceIds: copiedInstances.map(instance => instance.id) }
    stores.get('scenes')!.set(JSON.stringify(collision.id), collisionHeader)
    for (const asset of copiedAssets) stores.get('assets')!.set(JSON.stringify([collision.id, asset.id]), asset)
    for (const instance of copiedInstances) stores.get('instances')!.set(JSON.stringify([collision.id, instance.id]), instance)
    writes.length = 0
    await expect(saveSceneRecovery(collision)).rejects.toMatchObject({ code: 'storage_conflict' })
    expect(writes).toEqual([])
    stores.get('meta')!.set(JSON.stringify('active'), collision.id)
    const token = collisionHeader.saveId
    collisionHeader.saveId = ''
    await expect(loadSceneRecovery()).rejects.toMatchObject({ code: 'storage_conflict' })
    await expect(saveSceneRecovery(collision)).rejects.toMatchObject({ code: 'storage_conflict' })
    collisionHeader.saveId = token
    const claimed = new SceneDocument((await loadSceneRecovery())!.scene)
    claimed.execute({ type: 'scene.rename', name: 'Owned after load' })
    await saveSceneDocumentRecovery(claimed)
    stores.get('scenes')!.delete(JSON.stringify(claimed.data.id))
    await expect(saveSceneDocumentRecovery(claimed)).rejects.toMatchObject({ code: 'storage_conflict' })
    await saveSceneRecovery({ ...collision, id: crypto.randomUUID() })

    const cacheBefore = getSceneChunkCacheStats(), gate = Promise.withResolvers<void>(), bytes = new Uint8Array(4096)
    bytes[0] = 80; bytes[71] = 169
    const blob = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { await gate.promise; return new Response(bytes) }, { preconnect() {} }))
    try {
      const first = loadSceneChunk(blob), second = loadSceneChunk(blob)
      expect(getSceneChunkCacheStats().inflight).toBe(cacheBefore.inflight + 1)
      gate.resolve()
      const [a, b] = await Promise.all([first, second])
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(getSceneChunkCacheStats()).toEqual({ bytes: cacheBefore.bytes + 4096, inflight: cacheBefore.inflight })
      a[0] = 2
      expect(b[0]).toBe(80)
      const reported = getSceneChunkCacheStats()
      reported.bytes = 0
      expect(getSceneChunkCacheStats().bytes).toBe(cacheBefore.bytes + 4096)
    } finally { fetch.mockRestore() }

    const quotaBytes = new Uint8Array(4096)
    quotaBytes[23] = 80
    const quotaHash = new Bun.CryptoHasher('sha256').update(quotaBytes).digest('hex')
    const quotaFetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => new Response(quotaBytes), { preconnect() {} }))
    try {
      quotaExceeded = true; writes.length = 0
      const [normal, exported] = await Promise.allSettled([loadSceneChunk(quotaHash), loadSceneChunk(quotaHash, { persist: false })])
      expect(normal.status).toBe('rejected')
      expect(exported.status).toBe('fulfilled')
      expect(quotaFetch).toHaveBeenCalledTimes(1)
      expect(writes).not.toContain('blobs')
      expect(await hasSceneBlob(quotaHash)).toBe(false)
      expect((await loadSceneChunk(quotaHash, { persist: false }))[23]).toBe(80)
      quotaExceeded = false
      await loadSceneChunk(quotaHash)
      expect(await hasSceneBlob(quotaHash)).toBe(true)
      expect(quotaFetch).toHaveBeenCalledTimes(1)

      const descriptor = describeSceneChunk(0, 1, quotaBytes, quotaHash)!
      const inflated = { ...descriptor, bounds: { min: { ...descriptor.bounds.min, y: 0 }, max: { ...descriptor.bounds.max, y: 3 } } }
      await expect(loadSceneAsset(asset('inflated-bounds', [inflated]))).rejects.toThrow('does not match')
    } finally { quotaExceeded = false; quotaFetch.mockRestore() }
  } finally {
    for (const restore of restores) restore()
    await deactivateSceneRecovery()
    db.onversionchange?.()
    if (originalIdb) Object.defineProperty(globalThis, 'indexedDB', originalIdb)
    else Reflect.deleteProperty(globalThis, 'indexedDB')
  }
})
