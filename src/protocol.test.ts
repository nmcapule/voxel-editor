import { describe, expect, test } from 'bun:test'
import { VoxelDocument } from './editor'
import { inspectionViews } from './inspection'
import { PROTOCOL, SerialCommandQueue, decodeProjectSnapshot, encodeProjectSnapshot, parseRequest } from './protocol'
import type { ViewSettings } from './storage'

const settings: ViewSettings = {
  background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42,
  ambientOcclusion: true, shadows: true, grid: true, faceGrid: false,
  projection: 'orthographic', pathTracing: true,
}

describe('scripting protocol', () => {
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
