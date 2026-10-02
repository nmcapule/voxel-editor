import { describe, expect, test } from 'bun:test'
import { VoxelDocument } from '../../shared/voxel/document'
import { Studio, type StudioCommand } from './studio'
import { StudioCommandError } from '../../shared/errors'
import { DEFAULT_SETTINGS } from '../../shared/rendering/settings'

const settings = { ...DEFAULT_SETTINGS }

describe('studio command kernel', () => {
  test('tracks actions, brushes and axis modifiers while mapping legacy tools', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    expect(studio.stateSnapshot().editor).toMatchObject({ action: 'attach', brush: 'box', activeTool: 'paint', paintMode: 'fill' })

    studio.execute({ type: 'tool.action', action: 'erase' })
    studio.execute({ type: 'tool.brush', brush: 'line' })
    studio.execute({ type: 'tool.mirror', axis: 'x' })
    studio.execute({ type: 'tool.wholeAxis', axis: 'z', enabled: true })
    expect(studio.stateSnapshot().editor).toMatchObject({
      action: 'erase', brush: 'line', mirrors: { x: true, y: false, z: false }, wholeAxes: { x: false, y: false, z: true }, activeTool: 'sculpt', sculptMode: 'erase',
    })

    studio.execute({ type: 'tool.set', tool: 'paint' })
    studio.execute({ type: 'tool.paintMode', mode: 'fill' })
    expect(studio.stateSnapshot().editor).toMatchObject({ action: 'paint', secondaryTool: 'fill', activeTool: 'paint', paintMode: 'fill' })

    studio.execute({ type: 'tool.action', action: 'attach' })
    studio.execute({ type: 'tool.secondary', tool: 'layer' })
    studio.execute({ type: 'tool.brush', brush: 'line' })
    expect(studio.stateSnapshot().editor).toMatchObject({ action: 'attach', brush: 'line', secondaryTool: null, activeTool: 'paint', paintMode: 'fill' })
    studio.execute({ type: 'tool.auxiliary', tool: 'pick' })
    studio.execute({ type: 'tool.brush', brush: 'line' })
    expect(studio.stateSnapshot().editor).toMatchObject({ auxiliaryTool: null, activeTool: 'paint' })

    studio.execute({ type: 'tool.secondary', tool: 'texture' })
    expect(studio.stateSnapshot().editor).toMatchObject({ action: 'select', brush: 'texture', secondaryTool: null, activeTool: 'select', selectionMode: 'texture' })
    studio.execute({ type: 'tool.brush', brush: 'body' })
    expect(studio.stateSnapshot().editor).toMatchObject({ action: 'select', brush: 'body', secondaryTool: null, activeTool: 'select', selectionMode: 'body' })
    studio.execute({ type: 'tool.selectionMode', mode: 'point' })
    expect(studio.stateSnapshot().editor).toMatchObject({ action: 'select', brush: 'voxel', secondaryTool: null, activeTool: 'select', selectionMode: 'point' })
  })

  test('applies empty and occupied write scopes as single undoable edits', () => {
    const document = new VoxelDocument()
    document.setVoxel(1, 1, 1, 5)
    const studio = new Studio(document, settings)

    expect(studio.execute({ type: 'edit.setVoxels', scope: 'empty', voxels: [
      { x: 1, y: 1, z: 1, color: 6 }, { x: 2, y: 1, z: 1, color: 6 },
    ] }).result.voxelCount).toBe(1)
    expect(document.getVoxel(1, 1, 1)).toBe(5)
    expect(document.getVoxel(2, 1, 1)).toBe(6)

    expect(studio.execute({ type: 'edit.paint', scope: 'occupied', cells: [{ x: 1, y: 1, z: 1 }, { x: 3, y: 1, z: 1 }], color: 7 }).result.voxelCount).toBe(1)
    expect(document.getVoxel(1, 1, 1)).toBe(7)
    expect(document.getVoxel(3, 1, 1)).toBe(0)
    studio.execute({ type: 'history.undo' })
    expect(document.getVoxel(1, 1, 1)).toBe(5)

    const chunks = document.chunks.size
    expect(studio.execute({ type: 'edit.fill', min: { x: 16, y: 16, z: 16 }, max: { x: 20, y: 20, z: 20 }, shape: 'box', scope: 'occupied' }).changed).toBe(false)
    expect(document.chunks.size).toBe(chunks)
  })

  test('enables Pattern only after copying a selection', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    expect(() => studio.execute({ type: 'tool.brush', brush: 'pattern' })).toThrow(StudioCommandError)
    studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 1, y: 1, z: 1, color: 5 }] })
    studio.execute({ type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] })
    studio.execute({ type: 'clipboard.copy' })
    expect(studio.execute({ type: 'tool.brush', brush: 'pattern' })).toMatchObject({ changed: true, result: { brush: 'pattern' } })
  })

  test('miniature settings preview and save without changing render mode, projection or voxel history', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    const original = studio.document
    for (const patch of [{ tiltShift: true }, { tiltShiftStrength: 0.7 }, { tiltShiftFocus: 0.2 }, { tiltShiftWidth: 0.4 }]) {
      expect(studio.execute({ type: 'settings.update', patch })).toMatchObject({ changed: true, effects: { settingsChanged: true, save: true } })
      expect(studio.renderMode).toBe(false)
      expect(studio.settings.projection).toBe(settings.projection)
      expect(studio.document).toBe(original)
      expect(studio.canUndo).toBe(false)
    }
    expect(studio.settings).toMatchObject({ tiltShift: true, tiltShiftStrength: 0.7, tiltShiftFocus: 0.2, tiltShiftWidth: 0.4 })
  })

  test('camera and transient editor activity do not invalidate a document revision', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 1, y: 1, z: 1, color: 5 }] })
    const revision = studio.revision

    // view.set and view.frame report their changes through recordChange.
    expect(studio.recordChange({ view: { position: { x: 30, y: 20, z: 30 } } })).toMatchObject({ changed: true, revision })
    expect(studio.recordChange({ view: { position: { x: 40, y: 25, z: 40 } } })).toMatchObject({ changed: true, revision })
    for (const command of [
      { type: 'tool.set', tool: 'paint' },
      { type: 'tool.selectionMode', mode: 'body' },
      { type: 'palette.activate', index: 6 },
      { type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] },
      { type: 'clipboard.copy' },
      { type: 'clipboard.paste.begin' },
      { type: 'clipboard.paste.cancel' },
      { type: 'renderMode.set', enabled: true },
    ] satisfies StudioCommand[]) {
      expect(studio.execute(command)).toMatchObject({ changed: true, revision })
    }
    expect(studio.stateSnapshot().revision).toBe(revision)
    expect(studio.composition().revision).toBe(revision)
    expect(studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 2, y: 1, z: 1, color: 6 }] }).revision).toBe(revision + 1)
  })

  test('project edits still advance revisions while no-ops and failures do not', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    const voxel = { x: 1, y: 1, z: 1, color: 5 }
    for (const command of [
      { type: 'edit.setVoxels', voxels: [voxel] },
      { type: 'history.undo' },
      { type: 'history.redo' },
      { type: 'document.rename', name: 'Tower' },
      { type: 'palette.setColor', index: 5, color: 0x123456 },
      { type: 'material.update', index: 5, patch: { roughness: 0.8 } },
      { type: 'layer.create', name: 'Details' },
      { type: 'layer.visibility', id: 2, visible: false },
      { type: 'layer.lock', id: 2, locked: true },
      { type: 'settings.update', patch: { grid: true } },
      { type: 'document.new' },
    ] satisfies StudioCommand[]) {
      const before = studio.revision
      expect(studio.execute(command)).toMatchObject({ changed: true, revision: before + 1 })
    }
    const beforeMap = studio.revision
    expect(studio.recordChange({ index: 5, map: 'map' }, { mutation: true })).toHaveProperty('revision', beforeMap + 1)
    const revision = studio.revision
    expect(studio.execute({ type: 'edit.setVoxels', voxels: [] })).toMatchObject({ changed: false, revision })
    expect(studio.execute({ type: 'history.undo' })).toMatchObject({ changed: false, revision })
    expect(() => studio.execute({ type: 'layer.delete', id: 1 })).toThrow()
    expect(studio.revision).toBe(revision)
  })

  test('applies covered active-layer paint, selection, and history through one effect boundary', () => {
    const document = new VoxelDocument()
    document.setVoxel(1, 1, 1, 5)
    const upper = document.createLayer()
    document.setVoxel(1, 1, 1, 7)
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)

    studio.execute({ type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] })
    const painted = studio.execute({ type: 'edit.paint', color: 6 })
    expect(document.getLayerVoxel(1, 1, 1)).toBe(6)
    expect(document.getLayerVoxel(1, 1, 1, upper.id)).toBe(7)
    expect(painted.effects).toMatchObject({ factsChanged: true, save: true })
    expect(painted.effects.dirtyChunks).toContain(0)

    studio.execute({ type: 'history.undo' })
    expect(document.getLayerVoxel(1, 1, 1)).toBe(5)
    expect(document.getLayerVoxel(1, 1, 1, upper.id)).toBe(7)
    expect(studio.selection.cells).toEqual([{ x: 1, y: 1, z: 1 }])
    studio.execute({ type: 'history.redo' })
    expect(document.getLayerVoxel(1, 1, 1)).toBe(6)
    expect(document.getLayerVoxel(1, 1, 1, upper.id)).toBe(7)
    expect(studio.selection.cells).toEqual([{ x: 1, y: 1, z: 1 }])
  })

  test('targets an explicit layer instead of ambient active state', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    const upper = studio.execute({ type: 'layer.create', name: 'Upper' }).result.layer as { id: number }
    studio.execute({ type: 'layer.activate', id: 1 })
    studio.execute({ type: 'edit.setVoxels', layerId: upper.id, voxels: [{ x: 2, y: 3, z: 4, color: 7 }] })

    expect(studio.document.activeLayerId).toBe(1)
    expect(studio.document.getLayerVoxel(2, 3, 4, upper.id)).toBe(7)
    studio.execute({ type: 'history.undo' })
    expect(studio.document.activeLayerId).toBe(1)
    studio.execute({ type: 'history.redo' })
    expect(studio.document.activeLayerId).toBe(1)
    expect(studio.document.getLayerVoxel(2, 3, 4, upper.id)).toBe(7)
  })

  test('selects exact active-layer occupancy under overlaps and rejects other-layer-only cells', () => {
    const document = new VoxelDocument()
    const cell = { x: 1, y: 1, z: 1 }
    const other = { x: 2, y: 1, z: 1 }
    document.setVoxel(cell.x, cell.y, cell.z, 5)
    const upper = document.createLayer()
    document.setVoxel(cell.x, cell.y, cell.z, 7)
    document.setVoxel(other.x, other.y, other.z, 5)
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)

    const outcome = studio.execute({ type: 'selection.set', cells: [cell, cell, other, { x: 0, y: 0, z: 0 }, { x: 32, y: 1, z: 1 }] })
    expect(document.getVisibleVoxelLayer(cell.x, cell.y, cell.z)).toBe(upper.id)
    expect(outcome.result.selection).toEqual({ cells: [cell], count: 1, floating: undefined })
    expect(studio.selection.cells).toEqual([cell])
    studio.execute({ type: 'selection.set', cells: [cell], additive: true })
    expect(studio.selection.count).toBe(0)
  })

  test.each(['point', 'surface', 'texture', 'body'] as const)('resolves %s selection through covered active-layer cells only', mode => {
    const document = new VoxelDocument()
    const active = document.createLayer()
    const voxels = [
      { x: 1, y: 1, z: 1, color: 5 },
      { x: 2, y: 1, z: 1, color: 5 },
      { x: 3, y: 1, z: 1, color: 5 },
      { x: 4, y: 1, z: 1, color: 6 },
      { x: 3, y: 0, z: 1, color: 5 },
      { x: 6, y: 1, z: 1, color: 5 },
    ]
    for (const voxel of voxels) document.setVoxel(voxel.x, voxel.y, voxel.z, voxel.color)
    document.createLayer()
    // Cover the seed, a connecting cell, its outward face, and a body cell.
    for (const cell of [voxels[0], voxels[1], { x: 2, y: 2, z: 1 }, voxels[4]]) document.setVoxel(cell.x, cell.y, cell.z, 7)
    const other = { x: 5, y: 1, z: 1 }
    document.setVoxel(other.x, other.y, other.z, 5)
    document.setActiveLayer(active.id)
    const studio = new Studio(document, settings, { selectionMode: mode })
    const cells = voxels.map(({ color: _color, ...cell }) => cell)
    const normal = { x: 0, y: 1, z: 0 }

    for (const cell of [cells[0], cells[2]]) {
      studio.execute({ type: 'selection.resolve', cell, normal, mode: cell === cells[0] ? mode : undefined })
      const expected = mode === 'point' ? [cell]
        : mode === 'surface' ? cells.slice(0, 4)
        : mode === 'texture' ? [cells[0], cells[1], cells[2], cells[4]]
        : cells.slice(0, 5)
      expect(new Set(studio.selection.cells)).toEqual(new Set(expected))
      expect(studio.selection.count).toBe(expected.length)
      expect(studio.execute({ type: 'selection.resolve', cell: other, normal, additive: true }).changed).toBe(false)
      expect(new Set(studio.selection.cells)).toEqual(new Set(expected))
      studio.execute({ type: 'selection.resolve', cell, normal, additive: true })
      expect(studio.selection.count).toBe(0)
    }
    studio.execute({ type: 'selection.set', cells: [cells[0]] })
    studio.execute({ type: 'selection.resolve', cell: other, normal })
    expect(studio.selection.count).toBe(0)
  })

  test.each([
    [17, [273, 272, 274, 257, 289, 17, 529]],
    [0, [0, 1, 16, 256]],
    [63, [819, 818, 803, 563]],
  ] as const)('visibility at %i only dirties layer chunks and bounded face neighbors, not raw data', (coordinate, expected) => {
    const document = new VoxelDocument({ x: 64, y: 64, z: 64 })
    document.setVoxel(coordinate, coordinate, coordinate, 5)
    const other = document.createLayer()
    document.setVoxel(32, 32, 32, 6)
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)
    for (const visible of [false, true]) {
      const revision = studio.revision
      const outcome = studio.execute({ type: 'layer.visibility', id: 1, visible })
      expect(new Set(outcome.effects.dirtyChunks)).toEqual(new Set(expected))
      expect(outcome).toMatchObject({ changed: true, revision: revision + 1, effects: { rawDirtyChunks: [], save: true } })
      expect(document.getLayerVoxel(coordinate, coordinate, coordinate)).toBe(5)
      expect(document.getLayerVoxel(32, 32, 32, other.id)).toBe(6)
      expect(studio.execute({ type: 'layer.visibility', id: 1, visible })).toMatchObject({ changed: false, effects: {} })
    }
    const empty = document.createLayer()
    expect(studio.execute({ type: 'layer.visibility', id: empty.id, visible: false }).effects).toMatchObject({ dirtyChunks: [], rawDirtyChunks: [], save: true })
  })

  test('layer activation focuses only when clearing selected or pasted content', () => {
    const document = new VoxelDocument()
    const cell = { x: 1, y: 1, z: 1 }
    document.setVoxel(1, 1, 1, 5)
    document.createLayer()
    const studio = new Studio(document, settings)
    expect(studio.execute({ type: 'layer.activate', id: 1 }).effects).toMatchObject({ selectionChanged: true, selectionFocus: false, save: true })
    for (const paste of [false, true]) {
      studio.execute({ type: 'selection.set', cells: [cell] })
      if (paste) {
        studio.execute({ type: 'clipboard.copy' })
        studio.execute({ type: 'clipboard.paste.begin' })
      }
      expect(studio.execute({ type: 'layer.activate', id: 1 }).effects).toMatchObject({ selectionChanged: true, selectionFocus: true, save: false })
      expect(studio.selection.count).toBe(0)
      expect(studio.pendingPaste).toBeUndefined()
    }
    expect(studio.execute({ type: 'layer.activate', id: 2 }).effects.selectionFocus).toBe(false)
    expect(studio.execute({ type: 'layer.activate', id: 2 }).changed).toBe(false)
  })

  test('keeps covered selections when another layer is hidden or shown', () => {
    const document = new VoxelDocument()
    const cell = { x: 1, y: 1, z: 1 }
    document.setVoxel(cell.x, cell.y, cell.z, 5)
    const upper = document.createLayer()
    document.setVoxel(cell.x, cell.y, cell.z, 7)
    upper.visible = false
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)
    studio.execute({ type: 'selection.set', cells: [cell] })
    const selection = studio.selection

    for (const visible of [true, false, true]) {
      expect(studio.execute({ type: 'layer.visibility', id: upper.id, visible }).effects.selectionChanged).toBe(false)
      expect(studio.selection).toEqual(selection)
    }
    expect(studio.execute({ type: 'layer.visibility', id: 1, visible: false }).effects.selectionChanged).toBe(true)
    expect(studio.selection.count).toBe(0)
    studio.execute({ type: 'layer.visibility', id: 1, visible: true })
    expect(studio.selection.count).toBe(0)
  })

  test.each(['locked', 'hidden'] as const)('protects a %s active layer without confusing visibility and editability', state => {
    const document = new VoxelDocument()
    const cell = { x: 1, y: 1, z: 1 }
    const voxel = { ...cell, color: 5 }
    document.setVoxel(cell.x, cell.y, cell.z, voxel.color)
    document.createLayer()
    document.setVoxel(cell.x, cell.y, cell.z, 7)
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)
    studio.execute({ type: 'selection.set', cells: [cell] })
    studio.execute({ type: 'clipboard.copy' })
    studio.execute(state === 'locked' ? { type: 'layer.lock', id: 1, locked: true } : { type: 'layer.visibility', id: 1, visible: false })
    const before = studio.composition({ visibility: 'all' }).voxels
    const revision = studio.revision
    const normal = { x: 1, y: 0, z: 0 }
    const expected = state === 'locked' ? [cell] : []

    studio.execute({ type: 'selection.set', cells: [cell] })
    expect(studio.selection.cells).toEqual(expected)
    for (const mode of ['point', 'surface', 'texture', 'body'] as const) {
      studio.execute({ type: 'selection.resolve', cell, normal, mode })
      expect(studio.selection.cells).toEqual(expected)
    }
    if (state === 'locked') {
      studio.execute({ type: 'clipboard.copy' })
      expect(studio.clipboard).toEqual([voxel])
    }
    for (const command of [
      { type: 'edit.paint', cells: [cell], color: 6 },
      { type: 'edit.erase', cells: [cell] },
      { type: 'edit.setVoxels', voxels: [{ ...cell, color: 6 }] },
      { type: 'edit.fill', min: cell, max: cell, shape: 'box', color: 6 },
      { type: 'edit.move', cells: [cell], normal, distance: 1 },
      { type: 'edit.pushPull', cells: [cell], normal, distance: 1 },
      { type: 'clipboard.paste.begin' },
    ] satisfies StudioCommand[]) expect(() => studio.execute(command)).toThrow(state)
    expect(() => studio.execute({ type: 'clipboard.cut' })).toThrow(StudioCommandError)
    expect(studio.composition({ visibility: 'all' }).voxels).toEqual(before)
    expect(studio.revision).toBe(revision)
    expect(studio.canUndo).toBe(false)
  })

  test.each([
    { type: 'edit.paint', color: 6 },
    { type: 'edit.erase' },
    { type: 'edit.setVoxels', voxels: [{ x: 1, y: 1, z: 1, color: 6 }] },
    { type: 'edit.fill', min: { x: 1, y: 1, z: 1 }, max: { x: 1, y: 1, z: 1 }, shape: 'box', color: 6 },
    { type: 'edit.move', normal: { x: 1, y: 0, z: 0 }, distance: 2 },
    { type: 'edit.pushPull', normal: { x: 1, y: 0, z: 0 }, distance: 2 },
  ] satisfies StudioCommand[])('preserves covered active selection for explicit nonactive $type and history', command => {
    const document = new VoxelDocument()
    const cell = { x: 1, y: 1, z: 1 }
    document.setVoxel(cell.x, cell.y, cell.z, 5)
    const upper = document.createLayer()
    document.setVoxel(cell.x, cell.y, cell.z, 7)
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)
    studio.execute({ type: 'layer.lock', id: 1, locked: true })
    studio.execute({ type: 'selection.set', cells: [cell] })
    const untouched = studio.composition({ visibility: 'layer', layerId: 1 }).voxels
    const before = studio.composition({ visibility: 'layer', layerId: upper.id }).voxels

    expect(studio.execute({ ...command, layerId: upper.id }).changed).toBe(true)
    const after = studio.composition({ visibility: 'layer', layerId: upper.id }).voxels
    expect(after).not.toEqual(before)
    expect(studio.selection.cells).toEqual([cell])
    expect(document.activeLayerId).toBe(1)
    expect(studio.composition({ visibility: 'layer', layerId: 1 }).voxels).toEqual(untouched)
    for (const type of ['history.undo', 'history.redo'] as const) {
      studio.execute({ type })
      expect(studio.composition({ visibility: 'layer', layerId: upper.id }).voxels).toEqual(type === 'history.undo' ? before : after)
      expect(studio.composition({ visibility: 'layer', layerId: 1 }).voxels).toEqual(untouched)
      expect(studio.selection.cells).toEqual([cell])
      expect(document.activeLayerId).toBe(1)
    }
  })

  test.each(['edit.move', 'edit.pushPull'] as const)('%s overwrites same-layer destinations across multiple steps with covered selection history', type => {
    const document = new VoxelDocument()
    const cell = { x: 1, y: 1, z: 1 }
    const destination = { x: 4, y: 1, z: 1 }
    document.setVoxel(1, 1, 1, 5)
    document.setVoxel(3, 1, 1, 6)
    document.setVoxel(4, 1, 1, 8)
    const upper = document.createLayer()
    for (let x = 1; x <= 4; x++) document.setVoxel(x, 1, 1, 7)
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)
    studio.execute({ type: 'selection.set', cells: [cell] })
    const untouched = studio.composition({ visibility: 'layer', layerId: upper.id }).voxels

    expect(studio.execute({ type, normal: { x: 1, y: 0, z: 0 }, distance: 3 }).result).toEqual({ distance: 3, selection: [destination] })
    const after = type === 'edit.move' ? [0, 0, 6, 5] : [5, 5, 5, 5]
    expect([1, 2, 3, 4].map(x => document.getLayerVoxel(x, 1, 1))).toEqual(after)
    expect(studio.selection.cells).toEqual([destination])
    expect(studio.composition({ visibility: 'layer', layerId: upper.id }).voxels).toEqual(untouched)
    for (const history of ['history.undo', 'history.redo'] as const) {
      studio.execute({ type: history })
      expect([1, 2, 3, 4].map(x => document.getLayerVoxel(x, 1, 1))).toEqual(history === 'history.undo' ? [5, 0, 6, 8] : after)
      expect(studio.selection.cells).toEqual(history === 'history.undo' ? [cell] : [destination])
      expect(studio.composition({ visibility: 'layer', layerId: upper.id }).voxels).toEqual(untouched)
      expect(document.activeLayerId).toBe(1)
    }
  })

  test('push-pull advances stepped volume fronts equally, preserves full selection history, and shrinks one cell per step', () => {
    const document = new VoxelDocument()
    const columns = (heights: number[]) => heights.flatMap((height, index) => Array.from({ length: height }, (_, y) => ({ x: index + 1, y: y + 1, z: 1 })))
    const cells = columns([2, 4])
    for (const cell of cells) document.setVoxel(cell.x, cell.y, cell.z, 4 + cell.y)
    const studio = new Studio(document, settings)
    const normal = { x: 0, y: 1, z: 0 }
    const fronts = [{ x: 1, y: 2, z: 1 }, { x: 2, y: 4, z: 1 }]
    const colors = () => [1, 2].map(x => Array.from({ length: 7 }, (_, y) => document.getLayerVoxel(x, y + 1, 1)))

    for (const distance of [2, -2]) {
      const selected = distance > 0 ? cells : columns([4, 6])
      studio.execute({ type: 'selection.set', cells: selected })
      const before = studio.composition().voxels
      const endpoints = fronts.map(cell => ({ ...cell, y: cell.y + (distance > 0 ? 2 : 0) }))
      expect(studio.execute({ type: 'edit.pushPull', normal, distance }).result).toEqual({ distance, selection: endpoints })
      expect(studio.selection.cells).toEqual(endpoints)
      expect(colors()).toEqual(distance > 0
        ? [[5, 6, 6, 6, 0, 0, 0], [5, 6, 7, 8, 8, 8, 0]]
        : [[5, 6, 0, 0, 0, 0, 0], [5, 6, 7, 8, 0, 0, 0]])
      const after = studio.composition().voxels
      for (const type of ['history.undo', 'history.redo'] as const) {
        studio.execute({ type })
        expect(studio.composition().voxels).toEqual(type === 'history.undo' ? before : after)
        expect(studio.selection.cells).toEqual(type === 'history.undo' ? selected : endpoints)
      }
    }

    studio.execute({ type: 'selection.set', cells })
    expect(studio.execute({ type: 'edit.pushPull', normal, distance: -1 }).result).toEqual({
      distance: -1, selection: fronts.map(cell => ({ ...cell, y: cell.y - 1 })),
    })
    expect(colors()).toEqual([[5, 0, 0, 0, 0, 0, 0], [5, 6, 7, 0, 0, 0, 0]])
    expect(studio.execute({ type: 'edit.pushPull', normal, distance: -1 }).result).toEqual({
      distance: -1, selection: [{ x: 2, y: 2, z: 1 }],
    })
    expect(colors()).toEqual([[0, 0, 0, 0, 0, 0, 0], [5, 6, 0, 0, 0, 0, 0]])
  })

  test.each(['clipboard.copy', 'clipboard.cut'] as const)('pastes %s colors into covered cells and restores selection through history', type => {
    const document = new VoxelDocument()
    const cells = [{ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }]
    const destinations = cells.map(cell => ({ ...cell, x: cell.x + 4 }))
    const voxels = cells.map((cell, index) => ({ ...cell, color: 5 + index }))
    for (const voxel of voxels) document.setVoxel(voxel.x, voxel.y, voxel.z, voxel.color)
    document.setVoxel(5, 1, 1, 8)
    const upper = document.createLayer()
    for (const cell of [...cells, ...destinations]) document.setVoxel(cell.x, cell.y, cell.z, 7)
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)
    const untouched = studio.composition({ visibility: 'layer', layerId: upper.id }).voxels
    const original = studio.composition({ visibility: 'layer', layerId: 1 }).voxels
    studio.execute({ type: 'selection.set', cells })
    studio.execute({ type })
    expect(studio.clipboard).toEqual(voxels)
    const selectionBefore = type === 'clipboard.copy' ? cells : []
    expect(studio.selection.cells).toEqual(selectionBefore)
    const before = studio.composition({ visibility: 'layer', layerId: 1 }).voxels
    expect(studio.composition({ visibility: 'layer', layerId: upper.id }).voxels).toEqual(untouched)

    studio.execute({ type: 'clipboard.paste.begin' })
    for (const visible of [false, true]) studio.execute({ type: 'layer.visibility', id: upper.id, visible })
    expect(studio.selection).toEqual({ cells, count: 2, floating: true })
    studio.execute({ type: 'clipboard.paste.place', offset: { x: 4, y: 0, z: 0 } })
    expect(studio.pendingPaste).toBeUndefined()
    expect(studio.selection).toEqual({ cells: destinations, count: 2, floating: undefined })
    expect(destinations.map(cell => document.getLayerVoxel(cell.x, cell.y, cell.z))).toEqual([5, 6])
    const after = studio.composition({ visibility: 'layer', layerId: 1 }).voxels
    expect(studio.composition({ visibility: 'layer', layerId: upper.id }).voxels).toEqual(untouched)
    for (const history of ['history.undo', 'history.redo'] as const) {
      studio.execute({ type: history })
      expect(studio.composition({ visibility: 'layer', layerId: 1 }).voxels).toEqual(history === 'history.undo' ? before : after)
      expect(studio.selection.cells).toEqual(history === 'history.undo' ? selectionBefore : destinations)
      expect(studio.composition({ visibility: 'layer', layerId: upper.id }).voxels).toEqual(untouched)
      expect(document.activeLayerId).toBe(1)
    }
    if (type === 'clipboard.cut') {
      studio.execute({ type: 'history.undo' })
      studio.execute({ type: 'history.undo' })
      expect(studio.composition({ visibility: 'layer', layerId: 1 }).voxels).toEqual(original)
      expect(studio.selection.cells).toEqual(cells)
      studio.execute({ type: 'history.redo' })
      expect(studio.composition({ visibility: 'layer', layerId: 1 }).voxels).toEqual(before)
      expect(studio.selection.count).toBe(0)
      expect(studio.composition({ visibility: 'layer', layerId: upper.id }).voxels).toEqual(untouched)
    }
  })

  test('preserves floating paste on unrelated visibility changes and cancels when its destination is hidden', () => {
    const document = new VoxelDocument()
    const cell = { x: 1, y: 1, z: 1 }
    document.setVoxel(cell.x, cell.y, cell.z, 5)
    const upper = document.createLayer()
    document.setVoxel(cell.x, cell.y, cell.z, 7)
    document.setActiveLayer(1)
    const studio = new Studio(document, settings)
    studio.execute({ type: 'selection.set', cells: [cell] })
    studio.execute({ type: 'clipboard.cut' })
    studio.execute({ type: 'clipboard.paste.begin' })
    const paste = studio.pendingPaste
    const before = studio.composition({ visibility: 'all' }).voxels

    for (const visible of [false, true]) {
      expect(studio.execute({ type: 'layer.visibility', id: upper.id, visible }).effects.selectionChanged).toBe(false)
      expect(studio.pendingPaste).toBe(paste)
      expect(studio.selection).toEqual({ cells: [cell], count: 1, floating: true })
    }
    expect(studio.execute({ type: 'layer.visibility', id: 1, visible: false }).effects).toMatchObject({ selectionChanged: true, selectionFocus: true, toolsChanged: true })
    expect(studio.pendingPaste).toBeUndefined()
    expect(studio.selection.count).toBe(0)
    expect(studio.selection.floating).toBeFalsy()
    studio.execute({ type: 'layer.visibility', id: 1, visible: true })
    expect(() => studio.execute({ type: 'clipboard.paste.place', offset: { x: 4, y: 0, z: 0 } })).toThrow('There is no pending paste.')
    expect(studio.composition({ visibility: 'all' }).voxels).toEqual(before)
  })

  test('returns stable paginated composition for visible and layered voxels', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 3, y: 0, z: 0, color: 5 }, { x: 1, y: 0, z: 0, color: 6 }] })
    const upper = studio.execute({ type: 'layer.create' }).result.layer as { id: number }
    studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 1, y: 0, z: 0, color: 7 }] })

    expect(studio.composition({ bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 0, z: 0 } } }).voxels).toEqual([
      { x: 1, y: 0, z: 0, color: 7, layerId: upper.id },
      { x: 3, y: 0, z: 0, color: 5, layerId: 1 },
    ])
    expect(studio.composition({ visibility: 'all', bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 0, z: 0 } } }).voxels).toEqual([
      { x: 1, y: 0, z: 0, color: 6, layerId: 1 },
      { x: 3, y: 0, z: 0, color: 5, layerId: 1 },
      { x: 1, y: 0, z: 0, color: 7, layerId: upper.id },
    ])
    expect(studio.composition({ bounds: { min: { x: 100, y: 100, z: 100 }, max: { x: 101, y: 101, z: 101 } } })).toMatchObject({ voxels: [], scanned: 0, nextCursor: null })
  })

  test('cancels a pending paste when a normal selection replaces it', () => {
    const document = new VoxelDocument()
    document.setVoxel(1, 1, 1, 5)
    const studio = new Studio(document, settings)

    studio.execute({ type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] })
    studio.execute({ type: 'clipboard.copy' })
    studio.execute({ type: 'clipboard.paste.begin' })
    studio.execute({ type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] })

    expect(studio.pendingPaste).toBeUndefined()
    expect(studio.selection).toEqual({ cells: [{ x: 1, y: 1, z: 1 }], count: 1, floating: undefined })
  })

  test('requires explicit approval before destructive remote operations', () => {
    const studio = new Studio(new VoxelDocument(), settings)
    studio.execute({ type: 'edit.setVoxels', voxels: [{ x: 31, y: 31, z: 31, color: 5 }] })
    expect(() => studio.execute({ type: 'document.resize', dimensions: { x: 16, y: 16, z: 16 }, anchor: 'origin' })).toThrow(StudioCommandError)
    const resized = studio.execute({ type: 'document.resize', dimensions: { x: 16, y: 16, z: 16 }, anchor: 'origin', allowCrop: true })
    expect(resized.result.cropped).toBe(1)
  })
})
