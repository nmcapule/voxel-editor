import { describe, expect, test } from 'bun:test'
import { VoxelDocument } from '../../shared/voxel/document'
import { inspectionViews } from './inspection'
import { PROTOCOL, SerialCommandQueue, parseRequest } from './protocol'
import { decodeProjectSnapshot, encodeProjectSnapshot, parseProjectSnapshot } from '../../shared/voxel/snapshot'
import { restoreProjectSnapshot, snapshotProject } from './storage'
import { DEFAULT_SETTINGS, SKYBOX_PRESETS, type SkyboxPreset } from '../../shared/rendering/settings'

const settings = { ...DEFAULT_SETTINGS }

describe('scripting protocol', () => {
  test('Cube sprites PBR validates and round-trips independently of progressive PBR, defaulting off for old saves', () => {
    expect(DEFAULT_SETTINGS.cubeSpritesPbr).toBe(false)
    const document = new VoxelDocument()
    for (const cubeSpritesPbr of [false, true, undefined]) {
      const expected = { ...settings, previewRenderer: 'cube-sprites' as const, cubeSpritesPbr: cubeSpritesPbr ?? false, pathTracing: true }
      const snapshot = encodeProjectSnapshot(document, expected), stored = snapshotProject(document, expected)
      if (cubeSpritesPbr === undefined) {
        Reflect.deleteProperty(snapshot.settings, 'cubeSpritesPbr')
        Reflect.deleteProperty(stored.settings, 'cubeSpritesPbr')
      } else {
        expect(parseRequest({ protocol: PROTOCOL, id: 'pbr', command: { type: 'settings.update', patch: { cubeSpritesPbr } } }).command).toEqual({ type: 'settings.update', patch: { cubeSpritesPbr } })
      }
      expect(decodeProjectSnapshot(JSON.parse(JSON.stringify(snapshot))).settings).toEqual(expected)
      expect(restoreProjectSnapshot(structuredClone(stored))!.settings).toEqual(expected)
    }
    for (const cubeSpritesPbr of [null, 0, 1, 'true', [], {}]) {
      expect(() => parseRequest({ protocol: PROTOCOL, id: 'pbr', command: { type: 'settings.update', patch: { cubeSpritesPbr } } })).toThrow('cubeSpritesPbr')
      expect(() => parseProjectSnapshot({ ...encodeProjectSnapshot(document, settings), settings: { ...settings, cubeSpritesPbr } })).toThrow('cubeSpritesPbr')
      expect(() => restoreProjectSnapshot({ ...snapshotProject(document, settings), settings: { ...settings, cubeSpritesPbr } } as any)).toThrow('cubeSpritesPbr')
    }
  })

  test('preview renderer IDs validate without requiring an installed plugin', () => {
    const parse = (previewRenderer: unknown) => parseRequest({ protocol: PROTOCOL, id: 'renderer', command: { type: 'settings.update', patch: { previewRenderer } } }).command
    for (const previewRenderer of ['standard', 'cube-sprites'] as const) expect(parse(previewRenderer)).toEqual({ type: 'settings.update', patch: { previewRenderer } })
    const document = new VoxelDocument(), snapshot = encodeProjectSnapshot(document, settings), stored = snapshotProject(document, settings)
    for (const previewRenderer of [null, false, 0, '', 'Cube sprites', 'cube-sprites ', 'unknown', 'toString', '__proto__', [], {}]) {
      expect(() => parse(previewRenderer)).toThrow('command.patch.previewRenderer must be one of')
      expect(() => parseProjectSnapshot({ ...snapshot, settings: { ...settings, previewRenderer } })).toThrow('previewRenderer')
      expect(() => restoreProjectSnapshot({ ...stored, settings: { ...settings, previewRenderer } } as typeof stored)).toThrow('previewRenderer')
    }
    expect(() => parse(undefined)).toThrow('must change at least one setting')
  })

  test('preview renderer preferences round-trip and old snapshots default to Standard', () => {
    expect(DEFAULT_SETTINGS.previewRenderer).toBe('standard')
    const document = new VoxelDocument()
    document.setVoxel(1, 2, 3, 5)
    for (const previewRenderer of ['standard', 'cube-sprites', undefined] as const) {
      const expected = { ...settings, previewRenderer: previewRenderer ?? 'standard', projection: 'perspective' as const, pathTracing: true }
      const snapshot = encodeProjectSnapshot(document, expected), stored = snapshotProject(document, expected)
      if (previewRenderer === undefined) {
        Reflect.deleteProperty(snapshot.settings, 'previewRenderer')
        Reflect.deleteProperty(stored.settings, 'previewRenderer')
      }
      const decoded = decodeProjectSnapshot(JSON.parse(JSON.stringify(snapshot)))
      expect(decoded.settings).toEqual(expected)
      expect(encodeProjectSnapshot(decoded.document, decoded.settings)).toEqual({ ...snapshot, settings: expected })
      for (const version of [1, 2, 3] as const) {
        const recovered = restoreProjectSnapshot(structuredClone({ ...stored, version }))!
        expect(recovered.settings).toEqual(expected)
        expect(snapshotProject(recovered.document, recovered.settings)).toEqual({ ...stored, settings: expected })
      }
    }
  })

  test('skybox settings accept only preset keys at command and persistence boundaries', () => {
    expect(SKYBOX_PRESETS).toEqual({ solid: 'Solid color', daylight: 'Daylight', overcast: 'Overcast', sunset: 'Sunset', night: 'Night' })
    const parse = (skybox: unknown) => parseRequest({ protocol: PROTOCOL, id: 'skybox', command: { type: 'settings.update', patch: { skybox } } }).command
    for (const skybox of Object.keys(SKYBOX_PRESETS) as SkyboxPreset[]) expect(parse(skybox)).toEqual({ type: 'settings.update', patch: { skybox } })
    const document = new VoxelDocument(), snapshot = encodeProjectSnapshot(document, settings), stored = snapshotProject(document, settings)
    for (const skybox of [null, false, 0, NaN, '', 'Daylight', 'daylight ', 'unknown', 'toString', '__proto__', [], {}]) {
      expect(() => parse(skybox)).toThrow('command.patch.skybox must be one of')
      expect(() => parseProjectSnapshot({ ...snapshot, settings: { ...settings, skybox } })).toThrow('skybox')
      expect(() => restoreProjectSnapshot({ ...stored, settings: { ...settings, skybox } } as typeof stored)).toThrow('skybox')
    }
    expect(() => parse(undefined)).toThrow('must change at least one setting')
  })

  test('skybox presets and legacy solid defaults round-trip without resetting model settings', () => {
    expect(DEFAULT_SETTINGS.skybox).toBe('solid')
    const document = new VoxelDocument()
    document.setVoxel(1, 2, 3, 5)
    for (const skybox of ['solid', 'daylight', 'overcast', 'sunset', 'night', undefined] as const) {
      const expected = { ...settings, skybox: skybox ?? 'solid', background: '#243648', ambient: 0.7, light: 3.1, lightAzimuth: -72, tiltShift: true, tiltShiftStrength: 0.8, tiltShiftFocus: 0.3, tiltShiftWidth: 0.1 }
      const snapshot = encodeProjectSnapshot(document, expected), stored = snapshotProject(document, expected)
      if (skybox === undefined) {
        Reflect.deleteProperty(snapshot.settings, 'skybox')
        Reflect.deleteProperty(stored.settings, 'skybox')
      }
      const decoded = decodeProjectSnapshot(JSON.parse(JSON.stringify(snapshot)))
      expect(decoded.settings).toEqual(expected)
      expect(encodeProjectSnapshot(decoded.document, decoded.settings)).toEqual({ ...snapshot, settings: expected })
      for (const version of [1, 2, 3] as const) {
        const recovered = restoreProjectSnapshot(structuredClone({ ...stored, version }))!
        expect(recovered.settings).toEqual(expected)
        expect(snapshotProject(recovered.document, recovered.settings)).toEqual({ ...stored, settings: expected })
      }
    }
  })

  test('miniature photography patches accept only booleans and finite fractions', () => {
    const parse = (patch: unknown) => parseRequest({ protocol: PROTOCOL, id: 'miniature', command: { type: 'settings.update', patch } }).command
    for (const value of [false, true]) expect(parse({ tiltShift: value })).toEqual({ type: 'settings.update', patch: { tiltShift: value } })
    for (const value of [null, 0, 1, NaN, 'false', 'true', [], {}]) expect(() => parse({ tiltShift: value })).toThrow('tiltShift must be a boolean')
    for (const key of ['tiltShiftStrength', 'tiltShiftFocus', 'tiltShiftWidth']) {
      for (const value of [0, 0.01, 0.5, 1]) expect(parse({ [key]: value })).toEqual({ type: 'settings.update', patch: { [key]: value } })
      for (const value of [null, NaN, Infinity, -Infinity, -0.01, 1.01, true, false, '0.5', [], {}]) {
        expect(() => parse({ [key]: value })).toThrow(`${key} must be a finite number from 0 to 1`)
      }
    }
    for (const patch of [null, [], {}, { tiltShiftStrength: undefined }, { tiltShiftEnabled: true }]) expect(() => parse(patch)).toThrow()
  })

  test('miniature photography persists in project snapshots and local recovery with legacy defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ tiltShift: false, tiltShiftStrength: 0.5, tiltShiftFocus: 0.5, tiltShiftWidth: 0.3 })
    const document = new VoxelDocument()
    document.setVoxel(1, 2, 3, 5)
    const enabled = { ...settings, tiltShift: true, tiltShiftStrength: 0.81, tiltShiftFocus: 0, tiltShiftWidth: 1 }
    const snapshot = encodeProjectSnapshot(document, enabled), stored = snapshotProject(document, enabled)
    const decoded = decodeProjectSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(decoded.settings).toEqual(enabled)
    expect(encodeProjectSnapshot(decoded.document, decoded.settings)).toEqual(snapshot)
    const recovered = restoreProjectSnapshot(structuredClone(stored))!
    expect(recovered.settings).toEqual(enabled)
    expect(snapshotProject(recovered.document, recovered.settings)).toEqual(stored)
    expect(snapshot.version).toBe(1)
    expect(stored.version).toBe(3)

    const keys = ['tiltShift', 'tiltShiftStrength', 'tiltShiftFocus', 'tiltShiftWidth'] as const
    for (const missing of [...keys.map(key => [key]), keys]) {
      const legacy = structuredClone(snapshot), legacyStored = structuredClone(stored), expected = { ...enabled }
      for (const key of missing) {
        Reflect.deleteProperty(legacy.settings, key)
        Reflect.deleteProperty(legacyStored.settings, key)
        Reflect.set(expected, key, DEFAULT_SETTINGS[key])
      }
      expect(decodeProjectSnapshot(legacy).settings).toEqual(expected)
      for (const version of [1, 2, 3] as const) expect(restoreProjectSnapshot({ ...legacyStored, version })!.settings).toEqual(expected)
    }
    for (const key of keys) for (const value of key === 'tiltShift' ? [null, 0, 'false', NaN, []] : [null, NaN, Infinity, -0.01, 1.01, '0.5', true, {}]) {
      const invalid = { ...enabled, [key]: value }
      expect(() => parseProjectSnapshot({ ...snapshot, settings: invalid })).toThrow(key)
      expect(() => restoreProjectSnapshot({ ...stored, settings: invalid })).toThrow(key)
    }
    for (const key of ['background', 'ambient', 'light', 'lightAzimuth', 'ambientOcclusion', 'shadows', 'grid', 'faceGrid', 'projection', 'pathTracing']) {
      const incomplete = structuredClone(snapshot)
      Reflect.deleteProperty(incomplete.settings, key)
      expect(() => parseProjectSnapshot(incomplete)).toThrow('snapshot.settings is incomplete')
    }
    const legacy = structuredClone(stored)
    for (const key of keys) Reflect.deleteProperty(legacy.settings, key)
    Object.assign(legacy.settings, { roughness: 0.4, metalness: 0.2 })
    legacy.materials = undefined
    const restored = restoreProjectSnapshot({ ...legacy, version: 1 })!
    expect(restored.settings).toEqual(settings)
    expect(restored.document.materials[5]).toMatchObject({ roughness: 0.4, metalness: 0.2 })
  })

  test('mesh overlay settings updates accept only booleans', () => {
    for (const flag of ['meshVertices', 'meshTriangles'] as const) {
      const parse = (value: unknown) => parseRequest({ protocol: PROTOCOL, id: flag, command: { type: 'settings.update', patch: { [flag]: value } } }).command
      for (const value of [false, true]) {
        expect(parse(value)).toEqual({ type: 'settings.update', patch: { [flag]: value } })
      }
      for (const value of [null, 0, 1, 'false', 'true', [], {}]) {
        expect(() => parse(value)).toThrow(`command.patch.${flag} must be a boolean`)
      }
    }
  })

  test('mesh overlays round-trip through snapshots and default to false in older projects', () => {
    const document = new VoxelDocument()
    const enabled = { ...settings, meshVertices: true, meshTriangles: true }
    const snapshot = encodeProjectSnapshot(document, enabled)
    expect(snapshot.settings).toEqual(enabled)
    expect(parseProjectSnapshot(snapshot).settings).toEqual(enabled)
    const decoded = decodeProjectSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(decoded.settings).toEqual(enabled)
    expect(encodeProjectSnapshot(decoded.document, decoded.settings)).toEqual(snapshot)
    const stored = snapshotProject(document, enabled)
    expect(stored.settings).toEqual(enabled)
    expect(restoreProjectSnapshot(structuredClone(stored))!.settings).toEqual(enabled)

    for (const missing of [['meshVertices'], ['meshTriangles'], ['meshVertices', 'meshTriangles']] as const) {
      const legacy = structuredClone(snapshot), legacyStored = structuredClone(stored), expected = { ...enabled }
      for (const flag of missing) {
        Reflect.deleteProperty(legacy.settings, flag)
        Reflect.deleteProperty(legacyStored.settings, flag)
        expected[flag] = false
      }
      expect(parseProjectSnapshot(legacy).settings).toEqual(expected)
      expect(decodeProjectSnapshot(legacy).settings).toEqual(expected)
      for (const version of [1, 2, 3] as const) {
        expect(restoreProjectSnapshot({ ...legacyStored, version })!.settings).toEqual(expected)
      }
    }
    for (const flag of ['meshVertices', 'meshTriangles'] as const) {
      for (const value of [null, 0, 1, 'false', 'true', [], {}]) {
        expect(() => parseProjectSnapshot({ ...snapshot, settings: { ...snapshot.settings, [flag]: value } })).toThrow(flag)
      }
    }
  })

  test('validates inspection views while leaving omitted defaults to the renderer', () => {
    const parse = (command: unknown) => parseRequest({ protocol: PROTOCOL, id: 'inspect', command }).command
    expect(parse({ type: 'view.inspect' })).toEqual({ type: 'view.inspect', views: undefined })
    expect(parse({ type: 'view.inspect', views: inspectionViews })).toEqual({ type: 'view.inspect', views: inspectionViews })
    expect(parse({ type: 'view.inspect', views: ['top', 'front'] })).toEqual({ type: 'view.inspect', views: ['top', 'front'] })
    for (const views of [[], null, 'front', {}, [1], ['FRONT'], ['unknown'], ['front', 'front'], [...inspectionViews, 'front']]) {
      expect(() => parse({ type: 'view.inspect', views })).toThrow('command.views')
    }
    expect(parse({ type: 'view.capture' })).toEqual({ type: 'view.capture' })
  })

  test('serializes commands and recovers after a rejected command', async () => {
    const order: string[] = []
    let release = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const queue = new SerialCommandQueue(async (value: number) => {
      order.push(`start ${value}`)
      if (value === 1) await blocked
      if (value === 2) throw new Error('failed')
      order.push(`end ${value}`)
      return value
    })

    const first = queue.dispatch(1)
    const second = queue.dispatch(2)
    const third = queue.dispatch(3)
    await Promise.resolve()
    expect(order).toEqual(['start 1'])
    release()
    expect(await first).toBe(1)
    await expect(second).rejects.toThrow('failed')
    expect(await third).toBe(3)
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'start 3', 'end 3'])
  })

  test('validates the complete request before execution', () => {
    expect(parseRequest({
      protocol: PROTOCOL,
      id: 'paint-1',
      ifRevision: 3,
      command: { type: 'edit.setVoxels', layerId: 1, voxels: [{ x: 1, y: 2, z: 3, color: 5 }] },
    })).toMatchObject({ id: 'paint-1', ifRevision: 3 })
    expect(() => parseRequest({ protocol: PROTOCOL, id: 'bad', command: { type: 'edit.move', normal: { x: 1, y: 1, z: 0 }, distance: 1 } })).toThrow('axis-aligned')
    expect(() => parseRequest({ protocol: 'voxel-studio/2', id: 'bad', command: { type: 'state.get' } })).toThrow('protocol')
    expect(() => parseRequest({ protocol: PROTOCOL, id: 'bad', command: { type: 'palette.setColor', index: 2.5, color: 0 } })).toThrow('integer')
  })

  test('never executes an aborted command waiting behind another operation', async () => {
    const gate = Promise.withResolvers<void>()
    const executed: number[] = []
    const queue = new SerialCommandQueue(async (value: number) => {
      if (value === 1) await gate.promise
      executed.push(value)
    })
    const first = queue.dispatch(1)
    const controller = new AbortController()
    const canceled = queue.dispatch(2, controller.signal).catch(error => error)
    controller.abort(new Error('Stopped'))
    gate.resolve()
    await first
    expect(await canceled).toMatchObject({ message: 'Stopped' })
    await queue.dispatch(3)
    expect(executed).toEqual([1, 3])
  })

  test('round-trips deterministic lossless project snapshots', () => {
    const document = new VoxelDocument({ x: 32, y: 16, z: 16 }, 'Layers')
    document.setVoxel(20, 1, 1, 5)
    document.setVoxel(1, 1, 1, 6)
    const upper = document.createLayer()
    document.setVoxel(1, 1, 1, 7)
    upper.visible = false

    const snapshot = encodeProjectSnapshot(document, settings)
    expect(snapshot.chunks.map(chunk => chunk.id)).toEqual([...snapshot.chunks.map(chunk => chunk.id)].sort((a, b) => a - b))
    const restored = decodeProjectSnapshot(snapshot)
    expect(restored.document.voxelCount).toBe(3)
    expect(restored.document.getLayerVoxel(1, 1, 1, upper.id)).toBe(7)
    expect(restored.document.getVisibleVoxel(1, 1, 1)).toBe(6)
    expect(restored.settings).toEqual(settings)

    snapshot.chunks[0].dataBase64 = ''
    expect(restored.document.voxelCount).toBe(3)
  })
})
