import {
  EditSession,
  History,
  VoxelDocument,
  connectedBodyVoxels,
  connectedSurfaceVoxels,
  croppedVoxelCount,
  dirtyChunks,
  moveVoxels,
  pushPull,
  resizeVoxelDocument,
  type Dimensions,
  type FillShape,
  type PaletteMaterial,
  type ResizeAnchor,
  type Vec3,
} from './editor'
import type { ViewSettings } from './storage'

export type Tool = 'select' | 'paint' | 'sculpt' | 'layer'
export type PaintMode = 'paint' | 'fill'
export type SculptMode = 'push' | 'move' | 'erase'
export type AuxiliaryTool = 'pick'
export type SelectionMode = 'point' | 'surface' | 'texture' | 'body'
export type PbrMap = 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap'
export type SelectionState = { cells: Vec3[]; count: number; floating?: boolean }
export type ClipboardVoxel = Vec3 & { color: number }

export interface StudioPreferences {
  selectionMode?: SelectionMode
  activeColor?: number
  recentColors?: number[]
}

export type MaterialPatch = Partial<PaletteMaterial>

export type StudioCommand =
  | { type: 'document.new'; dimensions?: Dimensions; name?: string }
  | { type: 'document.rename'; name: string }
  | { type: 'document.resize'; dimensions: Dimensions; anchor: ResizeAnchor; allowCrop?: boolean }
  | { type: 'edit.paint'; cells?: Vec3[]; color?: number; layerId?: number }
  | { type: 'edit.erase'; cells?: Vec3[]; layerId?: number }
  | { type: 'edit.setVoxels'; voxels: ClipboardVoxel[]; layerId?: number }
  | { type: 'edit.fill'; min: Vec3; max: Vec3; color?: number; shape: FillShape; axis?: keyof Vec3; layerId?: number }
  | { type: 'edit.move'; cells?: Vec3[]; normal: Vec3; distance: number; layerId?: number }
  | { type: 'edit.pushPull'; cells?: Vec3[]; normal: Vec3; distance: number; layerId?: number }
  | { type: 'history.undo' }
  | { type: 'history.redo' }
  | { type: 'selection.set'; cells: Vec3[]; additive?: boolean; floating?: boolean; focus?: boolean }
  | { type: 'selection.resolve'; cell: Vec3; normal: Vec3; mode?: SelectionMode; additive?: boolean; focus?: boolean }
  | { type: 'selection.clear'; focus?: boolean }
  | { type: 'clipboard.copy' }
  | { type: 'clipboard.cut' }
  | { type: 'clipboard.paste.begin' }
  | { type: 'clipboard.paste.place'; offset: Vec3 }
  | { type: 'clipboard.paste.cancel' }
  | { type: 'layer.create'; name?: string }
  | { type: 'layer.activate'; id: number }
  | { type: 'layer.rename'; id: number; name: string }
  | { type: 'layer.visibility'; id: number; visible: boolean }
  | { type: 'layer.lock'; id: number; locked: boolean }
  | { type: 'layer.delete'; id: number; allowNonEmpty?: boolean }
  | { type: 'palette.activate'; index: number }
  | { type: 'palette.duplicate'; source?: number; name?: string }
  | { type: 'palette.setColor'; index: number; color: number }
  | { type: 'material.update'; index: number; patch: MaterialPatch }
  | { type: 'tool.set'; tool: Tool }
  | { type: 'tool.selectionMode'; mode: SelectionMode }
  | { type: 'tool.paintMode'; mode: PaintMode }
  | { type: 'tool.sculptMode'; mode: SculptMode }
  | { type: 'tool.auxiliary'; tool?: AuxiliaryTool }
  | { type: 'tool.fill'; shape?: FillShape; depth?: number }
  | { type: 'settings.update'; patch: Partial<ViewSettings> }
  | { type: 'renderMode.set'; enabled: boolean }

export interface StudioEffects {
  dirtyChunks?: number[]
  documentReplaced?: boolean
  preserveMaterials?: boolean
  selectionChanged?: boolean
  selectionFocus?: boolean
  paletteChanged?: boolean
  activeColorChanged?: boolean
  materialChanged?: number[]
  settingsChanged?: boolean
  toolsChanged?: boolean
  factsChanged?: boolean
  preferencesChanged?: boolean
  clearPbrMaps?: boolean
  save?: boolean
  announcement?: string
}

export interface StudioOutcome {
  changed: boolean
  revision: number
  result: Record<string, unknown>
  effects: StudioEffects
}

export class StudioCommandError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
  }
}

function copyCells(cells: Vec3[]) {
  return cells.map(cell => ({ ...cell }))
}

function cellKey(cell: Vec3, dimensions: Dimensions) {
  return cell.x + cell.y * dimensions.x + cell.z * dimensions.x * dimensions.y
}

function sameCells(a: Vec3[], b: Vec3[]) {
  if (a.length !== b.length) return false
  const keys = new Set(a.map(cell => `${cell.x},${cell.y},${cell.z}`))
  return b.every(cell => keys.has(`${cell.x},${cell.y},${cell.z}`))
}

export class Studio {
  document: VoxelDocument
  settings: ViewSettings
  revision = 0
  activeTool: Tool = 'select'
  paintMode: PaintMode = 'paint'
  sculptMode: SculptMode = 'push'
  fillShape: FillShape = 'box'
  fillDepth = 1
  auxiliaryTool?: AuxiliaryTool
  selectionMode: SelectionMode
  activeColor: number
  recentColors: number[]
  renderMode = false
  selection: SelectionState = { cells: [], count: 0 }
  clipboard: ClipboardVoxel[] = []
  pendingPaste?: { voxels: ClipboardVoxel[]; selectionBefore: Vec3[]; layerId: number }
  readonly loadedPbrMaps = new Map<number, Map<PbrMap, string>>()
  private history = new History()

  constructor(document: VoxelDocument, settings: ViewSettings, preferences: StudioPreferences = {}) {
    this.document = document
    this.settings = { ...settings }
    this.selectionMode = preferences.selectionMode ?? 'point'
    const fallbackColor = document.palette[5] ? 5 : Math.max(1, document.palette.findIndex((color, index) => index > 0 && Boolean(color)))
    this.activeColor = this.validColor(preferences.activeColor) ? preferences.activeColor : fallbackColor
    this.recentColors = [...new Set([this.activeColor, ...(preferences.recentColors ?? [5, 6, 12, 14, 3, 2]).filter(color => this.validColor(color))])].slice(0, 6)
  }

  get canUndo() { return this.history.canUndo }
  get canRedo() { return this.history.canRedo }

  execute(command: StudioCommand): StudioOutcome {
    switch (command.type) {
      case 'document.new': {
        const next = new VoxelDocument(command.dimensions ?? this.document.dimensions, command.name)
        return this.replaceDocument(next)
      }
      case 'document.rename': {
        const name = command.name.trim().slice(0, 60) || 'Untitled'
        if (name === this.document.name) return this.unchanged()
        this.document.name = name
        return this.changed({ save: true, factsChanged: true }, { name })
      }
      case 'document.resize': {
        if (!command.allowCrop) {
          const cropped = croppedVoxelCount(this.document, command.dimensions, command.anchor)
          if (cropped) throw new StudioCommandError('confirmation_required', `Resize would remove ${cropped} voxels.`, { cropped, revision: this.revision })
        }
        const resized = resizeVoxelDocument(this.document, command.dimensions, command.anchor)
        return this.replaceDocument(resized.document, true, { cropped: resized.cropped })
      }
      case 'edit.paint':
        return this.setCells(command.cells ?? this.selection.cells, command.color ?? this.activeColor, command.layerId, 'Painted')
      case 'edit.erase':
        return this.setCells(command.cells ?? this.selection.cells, 0, command.layerId, 'Erased', [])
      case 'edit.setVoxels':
        return this.setVoxels(command.voxels, command.layerId)
      case 'edit.fill':
        return this.fill(command)
      case 'edit.move':
        return this.transform(command.cells ?? this.selection.cells, command.normal, command.distance, true, command.layerId)
      case 'edit.pushPull':
        return this.transform(command.cells ?? this.selection.cells, command.normal, command.distance, false, command.layerId)
      case 'history.undo':
        return this.restoreHistory(false)
      case 'history.redo':
        return this.restoreHistory(true)
      case 'selection.set': {
        const cells = command.additive ? this.mergeSelection(command.cells) : command.cells
        return this.updateSelection(cells, command.floating === true, command.focus === true)
      }
      case 'selection.resolve':
        return this.resolveSelection(command)
      case 'selection.clear':
        return this.updateSelection([], false, command.focus === true)
      case 'clipboard.copy':
        return this.copySelection()
      case 'clipboard.cut': {
        this.clipboard = this.selectedVoxels()
        const erased = this.setCells(this.selection.cells, 0, undefined, 'Cut', [])
        erased.effects.toolsChanged = true
        return erased
      }
      case 'clipboard.paste.begin':
        return this.beginPaste()
      case 'clipboard.paste.place':
        return this.placePaste(command.offset)
      case 'clipboard.paste.cancel':
        return this.cancelPaste()
      case 'layer.create': {
        const layer = this.document.createLayer()
        if (command.name) this.document.renameLayer(layer.id, command.name)
        this.pendingPaste = undefined
        this.selection = { cells: [], count: 0 }
        return this.changed({ factsChanged: true, toolsChanged: true, selectionChanged: true, selectionFocus: true, save: true, announcement: `${layer.name} created` }, { layer: { ...layer } })
      }
      case 'layer.activate':
        return this.activateLayer(command.id)
      case 'layer.rename': {
        if (!this.document.renameLayer(command.id, command.name)) return this.unchanged()
        const layer = this.document.getLayer(command.id)!
        return this.changed({ factsChanged: true, toolsChanged: true, save: true, announcement: `Layer renamed to ${layer.name}` }, { layer: { ...layer } })
      }
      case 'layer.visibility':
        return this.setLayerVisibility(command.id, command.visible)
      case 'layer.lock': {
        const layer = this.requireLayer(command.id)
        if (layer.locked === command.locked) return this.unchanged()
        layer.locked = command.locked
        return this.changed({ factsChanged: true, toolsChanged: true, save: true, announcement: `${layer.name} ${layer.locked ? 'locked' : 'unlocked'}` }, { layer: { ...layer } })
      }
      case 'layer.delete':
        return this.deleteLayer(command.id, command.allowNonEmpty === true)
      case 'palette.activate':
        return this.activateColor(command.index)
      case 'palette.duplicate':
        return this.duplicateColor(command.source ?? this.activeColor, command.name)
      case 'palette.setColor': {
        this.requireColorIndex(command.index)
        const color = command.color & 0xffffff
        if (this.document.palette[command.index] === color) return this.unchanged()
        this.document.palette[command.index] = color
        return this.changed({ paletteChanged: true, save: true }, { index: command.index, color })
      }
      case 'material.update':
        return this.updateMaterial(command.index, command.patch)
      case 'tool.set':
        return this.setTool(command.tool)
      case 'tool.selectionMode': {
        if (this.selectionMode === command.mode) return this.unchanged()
        this.selectionMode = command.mode
        return this.changed({ toolsChanged: true, preferencesChanged: true, announcement: `${command.mode} selection mode` }, { mode: command.mode })
      }
      case 'tool.paintMode': {
        if (this.paintMode === command.mode && !this.auxiliaryTool) return this.unchanged()
        this.paintMode = command.mode
        this.auxiliaryTool = undefined
        return this.changed({ toolsChanged: true, announcement: `${command.mode === 'paint' ? 'Paint' : 'Volume'} operation selected` }, { mode: command.mode })
      }
      case 'tool.sculptMode':
        return this.setSculptMode(command.mode)
      case 'tool.auxiliary': {
        const next = this.auxiliaryTool === command.tool ? undefined : command.tool
        if (next === this.auxiliaryTool) return this.unchanged()
        this.auxiliaryTool = next
        return this.changed({ toolsChanged: true }, { tool: next ?? null })
      }
      case 'tool.fill': {
        const shape = command.shape ?? this.fillShape
        const depth = command.depth === undefined ? this.fillDepth : Math.max(1, Math.min(256, Math.round(command.depth)))
        if (shape === this.fillShape && depth === this.fillDepth) return this.unchanged()
        this.fillShape = shape
        this.fillDepth = depth
        return this.changed({ toolsChanged: true, announcement: command.shape ? `${shape} volume shape selected` : undefined }, { shape, depth })
      }
      case 'settings.update': {
        const next = { ...this.settings, ...command.patch }
        if (JSON.stringify(next) === JSON.stringify(this.settings)) return this.unchanged()
        this.settings = next
        return this.changed({ settingsChanged: true, save: true }, { settings: { ...this.settings } })
      }
      case 'renderMode.set': {
        if (this.renderMode === command.enabled) return this.unchanged()
        const selectionChanged = command.enabled && Boolean(this.pendingPaste)
        if (selectionChanged) {
          this.pendingPaste = undefined
          this.selection = { cells: [], count: 0 }
        }
        this.renderMode = command.enabled
        return this.changed({ toolsChanged: true, selectionChanged, selectionFocus: selectionChanged, announcement: `Render mode ${command.enabled ? 'on' : 'off'}` }, { enabled: command.enabled })
      }
    }
  }

  replaceDocument(document: VoxelDocument, preserveMaterials = false, result: Record<string, unknown> = {}, settings?: ViewSettings) {
    const settingsChanged = settings !== undefined
    this.document = document
    if (settings) this.settings = { ...settings }
    this.history = new History()
    this.pendingPaste = undefined
    this.clipboard = []
    this.selection = { cells: [], count: 0 }
    if (!preserveMaterials) {
      this.activeColor = this.firstColor()
      this.recentColors = [this.activeColor]
      this.loadedPbrMaps.clear()
    }
    return this.changed({ documentReplaced: true, preserveMaterials, selectionChanged: true, selectionFocus: true, paletteChanged: true, factsChanged: true, toolsChanged: true, preferencesChanged: true, clearPbrMaps: !preserveMaterials, settingsChanged, save: true }, result)
  }

  recordChange(result: Record<string, unknown> = {}, effects: StudioEffects = {}) {
    return this.changed(effects, result)
  }

  stateSnapshot() {
    const layerCounts = new Map<number, number>()
    let visibleVoxelCount = 0
    this.document.forEachVoxel((_x, _y, _z, _color, layerId) => layerCounts.set(layerId, (layerCounts.get(layerId) ?? 0) + 1))
    this.document.forEachVisibleVoxel(() => visibleVoxelCount++)
    return {
      revision: this.revision,
      document: {
        name: this.document.name,
        dimensions: { ...this.document.dimensions },
        layerVoxelCount: this.document.voxelCount,
        visibleVoxelCount,
        chunkCount: this.document.chunks.size,
        bounds: this.document.bounds(true),
        activeLayerId: this.document.activeLayerId,
        layers: this.document.layers.map((layer, order) => ({ ...layer, order, voxelCount: layerCounts.get(layer.id) ?? 0 })),
      },
      editor: {
        activeTool: this.activeTool,
        paintMode: this.paintMode,
        sculptMode: this.sculptMode,
        fillShape: this.fillShape,
        fillDepth: this.fillDepth,
        auxiliaryTool: this.auxiliaryTool ?? null,
        selectionMode: this.selectionMode,
        activeColor: this.activeColor,
        recentColors: [...this.recentColors],
        selection: { ...this.selection, cells: copyCells(this.selection.cells) },
        clipboardCount: this.clipboard.length,
        pendingPaste: Boolean(this.pendingPaste),
        canUndo: this.canUndo,
        canRedo: this.canRedo,
        renderMode: this.renderMode,
      },
      settings: { ...this.settings },
      palette: Array.from({ length: 255 }, (_, offset) => offset + 1).filter(index => this.document.palette[index]).map(index => ({
        index,
        color: this.document.palette[index],
        material: { ...this.document.materials[index] },
        maps: Object.fromEntries(this.loadedPbrMaps.get(index) ?? []),
      })),
    }
  }

  composition(query: { visibility?: 'composited' | 'all' | 'layer'; layerId?: number; bounds?: { min: Vec3; max: Vec3 }; cursor?: number; limit?: number } = {}) {
    const visibility = query.visibility ?? 'composited'
    const layers = visibility === 'all' ? this.document.layers : visibility === 'layer' ? [this.requireLayer(query.layerId ?? this.document.activeLayerId)] : [undefined]
    const min = query.bounds?.min ?? { x: 0, y: 0, z: 0 }
    const max = query.bounds?.max ?? { x: this.document.dimensions.x - 1, y: this.document.dimensions.y - 1, z: this.document.dimensions.z - 1 }
    const requestedFrom = { x: Math.min(min.x, max.x), y: Math.min(min.y, max.y), z: Math.min(min.z, max.z) }
    const requestedTo = { x: Math.max(min.x, max.x), y: Math.max(min.y, max.y), z: Math.max(min.z, max.z) }
    const from = { x: Math.max(0, requestedFrom.x), y: Math.max(0, requestedFrom.y), z: Math.max(0, requestedFrom.z) }
    const to = { x: Math.min(this.document.dimensions.x - 1, requestedTo.x), y: Math.min(this.document.dimensions.y - 1, requestedTo.y), z: Math.min(this.document.dimensions.z - 1, requestedTo.z) }
    if (from.x > to.x || from.y > to.y || from.z > to.z) return { revision: this.revision, visibility, bounds: { min: requestedFrom, max: requestedTo }, voxels: [], scanned: 0, nextCursor: null }
    const width = to.x - from.x + 1
    const height = to.y - from.y + 1
    const depth = to.z - from.z + 1
    const plane = width * height
    const volume = plane * depth
    const total = volume * layers.length
    const limit = Math.max(1, Math.min(65_536, Math.round(query.limit ?? 4096)))
    let cursor = Math.max(0, Math.min(total, Math.round(query.cursor ?? 0)))
    const voxels: (ClipboardVoxel & { layerId: number })[] = []
    let scanned = 0
    while (cursor < total && voxels.length < limit && scanned < 1_000_000) {
      const layerIndex = Math.floor(cursor / volume)
      const offset = cursor % volume
      const z = from.z + Math.floor(offset / plane)
      const row = offset % plane
      const y = from.y + Math.floor(row / width)
      const x = from.x + row % width
      const layer = layers[layerIndex]
      const color = layer ? this.document.getLayerVoxel(x, y, z, layer.id) : this.document.getVisibleVoxel(x, y, z)
      if (color) voxels.push({ x, y, z, color, layerId: layer?.id ?? this.document.getVisibleVoxelLayer(x, y, z) })
      cursor++
      scanned++
    }
    return { revision: this.revision, visibility, bounds: { min: from, max: to }, voxels, scanned, nextCursor: cursor < total ? cursor : null }
  }

  private validColor(index: unknown): index is number {
    return Number.isInteger(index) && Number(index) > 0 && Number(index) < 256 && Boolean(this.document.palette[Number(index)])
  }

  private firstColor() {
    return Math.max(1, this.document.palette.findIndex((color, index) => index > 0 && Boolean(color)))
  }

  private requireColorIndex(index: number) {
    if (!Number.isInteger(index) || index < 1 || index > 255) throw new StudioCommandError('invalid_argument', 'Color index must be an integer from 1 to 255.')
  }

  private requireLayer(id: number) {
    const layer = this.document.getLayer(id)
    if (!layer) throw new StudioCommandError('not_found', `Layer ${id} does not exist.`)
    return layer
  }

  private editableLayer(id: number) {
    const layer = this.requireLayer(id)
    if (!layer.visible || layer.locked) throw new StudioCommandError('not_editable', `${layer.name} is ${layer.locked ? 'locked' : 'hidden'}.`)
    return layer
  }

  private changed(effects: StudioEffects, result: Record<string, unknown> = {}): StudioOutcome {
    this.revision++
    return { changed: true, revision: this.revision, effects, result }
  }

  private unchanged(result: Record<string, unknown> = {}): StudioOutcome {
    return { changed: false, revision: this.revision, effects: {}, result: { changed: false, ...result } }
  }

  private selectionState(cells: Vec3[], floating = false): SelectionState {
    const unique = new Map<number, Vec3>()
    for (const cell of cells) {
      if (!this.document.contains(cell.x, cell.y, cell.z)) continue
      if (!floating && this.document.getVisibleVoxelLayer(cell.x, cell.y, cell.z) !== this.document.activeLayerId) continue
      unique.set(cellKey(cell, this.document.dimensions), { ...cell })
    }
    const next = [...unique.values()]
    return { cells: next, count: next.length, floating: floating || undefined }
  }

  private updateSelection(cells: Vec3[], floating: boolean, focus: boolean) {
    const pasteChanged = Boolean(this.pendingPaste) && !floating
    if (pasteChanged) this.pendingPaste = undefined
    const next = this.selectionState(cells, floating)
    if (!pasteChanged && sameCells(next.cells, this.selection.cells) && Boolean(this.selection.floating) === floating) return this.unchanged({ selection: { ...this.selection, cells: copyCells(this.selection.cells) } })
    this.selection = next
    return this.changed({ selectionChanged: true, selectionFocus: focus, toolsChanged: true, announcement: next.count ? `${next.count} ${next.count === 1 ? 'voxel' : 'voxels'} selected` : 'Selection cleared' }, { selection: { ...this.selection, cells: copyCells(next.cells) } })
  }

  private mergeSelection(cells: Vec3[]) {
    const next = new Map(this.selection.cells.map(cell => [cellKey(cell, this.document.dimensions), cell]))
    const incoming = cells.filter(cell => this.document.contains(cell.x, cell.y, cell.z))
    const remove = incoming.length > 0 && incoming.every(cell => next.has(cellKey(cell, this.document.dimensions)))
    for (const cell of incoming) remove ? next.delete(cellKey(cell, this.document.dimensions)) : next.set(cellKey(cell, this.document.dimensions), cell)
    return [...next.values()]
  }

  private resolveSelection(command: Extract<StudioCommand, { type: 'selection.resolve' }>) {
    const color = this.document.getVisibleVoxel(command.cell.x, command.cell.y, command.cell.z)
    if (!color || this.document.getVisibleVoxelLayer(command.cell.x, command.cell.y, command.cell.z) !== this.document.activeLayerId) {
      return command.additive ? this.unchanged() : this.updateSelection([], false, command.focus === true)
    }
    const mode = command.mode ?? this.selectionMode
    const cells = mode === 'point' ? [command.cell]
      : mode === 'surface' ? connectedSurfaceVoxels(this.document, command.cell, command.normal)
      : mode === 'texture' ? connectedBodyVoxels(this.document, command.cell, color)
      : connectedBodyVoxels(this.document, command.cell)
    return this.updateSelection(command.additive ? this.mergeSelection(cells) : cells, false, command.focus === true)
  }

  private setCells(cells: Vec3[], color: number, layerId = this.document.activeLayerId, verb = 'Updated', selectionAfter?: Vec3[]) {
    if (!cells.length) throw new StudioCommandError('invalid_state', `Select voxels before ${verb.toLowerCase()}.`)
    this.editableLayer(layerId)
    const activeLayerId = this.document.activeLayerId
    const before = copyCells(this.selection.cells)
    const session = new EditSession(this.document, layerId)
    for (const cell of cells) session.set(cell.x, cell.y, cell.z, color)
    const edit = session.commit()
    if (!edit) return this.unchanged({ voxelCount: 0 })
    const selectionChanged = selectionAfter !== undefined && layerId === activeLayerId
    const next = selectionChanged ? this.selectionState(selectionAfter!).cells : before
    this.history.push(edit, before, next, activeLayerId, activeLayerId)
    if (selectionChanged) this.selection = this.selectionState(next)
    const count = cells.length
    return this.changed({ dirtyChunks: [...dirtyChunks(this.document, edit.changes.map(change => change.id))], factsChanged: true, selectionChanged, selectionFocus: selectionChanged, toolsChanged: selectionChanged, save: true, announcement: `${verb} ${count} ${count === 1 ? 'voxel' : 'voxels'}` }, { voxelCount: count })
  }

  private setVoxels(voxels: ClipboardVoxel[], layerId = this.document.activeLayerId) {
    if (!voxels.length) return this.unchanged({ voxelCount: 0 })
    this.editableLayer(layerId)
    const session = new EditSession(this.document, layerId)
    let count = 0
    for (const voxel of voxels) if (session.set(voxel.x, voxel.y, voxel.z, voxel.color)) count++
    const edit = session.commit()
    if (!edit) return this.unchanged({ voxelCount: 0 })
    this.history.push(edit, this.selection.cells, this.selection.cells, this.document.activeLayerId, this.document.activeLayerId)
    return this.changed({ dirtyChunks: [...dirtyChunks(this.document, edit.changes.map(change => change.id))], factsChanged: true, save: true, announcement: `Updated ${count} ${count === 1 ? 'voxel' : 'voxels'}` }, { voxelCount: count })
  }

  private fill(command: Extract<StudioCommand, { type: 'edit.fill' }>) {
    const layerId = command.layerId ?? this.document.activeLayerId
    this.editableLayer(layerId)
    const session = new EditSession(this.document, layerId)
    session.fillShape(command.min, command.max, command.color ?? this.activeColor, command.shape, command.axis)
    const edit = session.commit()
    if (!edit) return this.unchanged({ voxelCount: 0 })
    this.history.push(edit, this.selection.cells, this.selection.cells, this.document.activeLayerId, this.document.activeLayerId)
    return this.changed({ dirtyChunks: [...dirtyChunks(this.document, edit.changes.map(change => change.id))], factsChanged: true, save: true, announcement: `${command.shape} volume filled` }, { changedChunks: edit.changes.length })
  }

  private transform(cells: Vec3[], normal: Vec3, distance: number, move: boolean, layerId = this.document.activeLayerId) {
    if (!cells.length) throw new StudioCommandError('invalid_state', 'Select voxels before sculpting.')
    this.editableLayer(layerId)
    const targets = cells.filter(cell => this.document.getLayerVoxel(cell.x, cell.y, cell.z, layerId))
    if (!targets.length) return this.unchanged({ distance: 0 })
    const activeLayerId = this.document.activeLayerId
    const before = copyCells(this.selection.cells)
    const session = new EditSession(this.document, layerId)
    const amount = move ? moveVoxels(this.document, session, targets, normal, distance, layerId) : pushPull(this.document, session, targets, normal, distance, layerId)
    const edit = session.commit()
    if (!edit) return this.unchanged({ distance: 0 })
    const next = layerId === activeLayerId ? this.selectionState(targets.map(cell => ({ x: cell.x + normal.x * amount, y: cell.y + normal.y * amount, z: cell.z + normal.z * amount }))).cells : before
    const selectionChanged = !sameCells(before, next)
    this.history.push(edit, before, next, activeLayerId, activeLayerId)
    this.selection = this.selectionState(next)
    const verb = move ? 'Moved' : amount > 0 ? 'Pulled' : 'Pushed'
    return this.changed({ dirtyChunks: [...dirtyChunks(this.document, edit.changes.map(change => change.id))], factsChanged: true, selectionChanged, selectionFocus: selectionChanged, toolsChanged: selectionChanged, save: true, announcement: `${verb} ${Math.abs(amount)} ${Math.abs(amount) === 1 ? 'voxel' : 'voxels'}` }, { distance: amount, selection: copyCells(next) })
  }

  private restoreHistory(redo: boolean) {
    const result = redo ? this.history.redo(this.document) : this.history.undo(this.document)
    if (!result) return this.unchanged()
    if (result.layerId !== undefined) this.document.setActiveLayer(result.layerId)
    this.selection = this.selectionState(result.selection)
    return this.changed({ dirtyChunks: [...dirtyChunks(this.document, result.ids)], factsChanged: true, selectionChanged: true, selectionFocus: true, toolsChanged: true, save: true, announcement: redo ? 'Redo' : 'Undo' }, { selection: copyCells(this.selection.cells) })
  }

  private copySelection(report = true) {
    const copied = this.selectedVoxels()
    if (!copied.length) return this.unchanged()
    this.clipboard = copied
    return this.changed({ toolsChanged: true, announcement: report ? `Copied ${copied.length} ${copied.length === 1 ? 'voxel' : 'voxels'}` : undefined }, { voxelCount: copied.length })
  }

  private selectedVoxels() {
    if (!this.selection.count || this.selection.floating) throw new StudioCommandError('invalid_state', 'Select placed voxels before copying.')
    const copied: ClipboardVoxel[] = []
    for (const cell of this.selection.cells) {
      const color = this.document.getLayerVoxel(cell.x, cell.y, cell.z)
      if (color) copied.push({ ...cell, color })
    }
    return copied
  }

  private beginPaste() {
    if (this.pendingPaste) throw new StudioCommandError('invalid_state', 'Place or cancel the current paste first.')
    if (!this.clipboard.length) throw new StudioCommandError('invalid_state', 'Copy or cut voxels before pasting.')
    this.editableLayer(this.document.activeLayerId)
    const voxels = this.clipboard.filter(cell => this.document.contains(cell.x, cell.y, cell.z)).map(cell => ({ ...cell }))
    if (!voxels.length) throw new StudioCommandError('invalid_state', 'The copied voxels are outside this canvas.')
    this.pendingPaste = { voxels, selectionBefore: copyCells(this.selection.cells), layerId: this.document.activeLayerId }
    this.activeTool = 'sculpt'
    this.sculptMode = 'move'
    this.selection = { cells: voxels.map(({ color: _color, ...cell }) => cell), count: voxels.length, floating: true }
    return this.changed({ selectionChanged: true, selectionFocus: true, toolsChanged: true, announcement: `Pasted ${voxels.length} ${voxels.length === 1 ? 'voxel' : 'voxels'}; drag to place` }, { voxelCount: voxels.length })
  }

  private placePaste(offset: Vec3) {
    if (!this.pendingPaste) throw new StudioCommandError('invalid_state', 'There is no pending paste.')
    const paste = this.pendingPaste
    this.editableLayer(paste.layerId)
    const session = new EditSession(this.document, paste.layerId)
    const placements = paste.voxels.map(voxel => ({ x: voxel.x + offset.x, y: voxel.y + offset.y, z: voxel.z + offset.z, color: voxel.color })).filter(voxel => this.document.contains(voxel.x, voxel.y, voxel.z))
    for (const voxel of placements) session.set(voxel.x, voxel.y, voxel.z, voxel.color)
    const next = placements.map(({ color: _color, ...cell }) => cell)
    const edit = session.commit()
    this.pendingPaste = undefined
    this.selection = this.selectionState(next)
    this.history.push(edit, paste.selectionBefore, next, paste.layerId)
    const effects: StudioEffects = { selectionChanged: true, selectionFocus: true, toolsChanged: true, announcement: `Placed ${next.length} ${next.length === 1 ? 'voxel' : 'voxels'}` }
    if (edit) {
      effects.dirtyChunks = [...dirtyChunks(this.document, edit.changes.map(change => change.id))]
      effects.factsChanged = true
      effects.save = true
    }
    return this.changed(effects, { voxelCount: next.length })
  }

  private cancelPaste(clearSelection = true) {
    if (!this.pendingPaste) return this.unchanged()
    this.pendingPaste = undefined
    if (clearSelection) this.selection = { cells: [], count: 0 }
    return this.changed({ selectionChanged: clearSelection, selectionFocus: clearSelection, toolsChanged: true, announcement: 'Paste canceled' })
  }

  private activateLayer(id: number) {
    const layer = this.requireLayer(id)
    const activeChanged = this.document.activeLayerId !== id
    const pasteChanged = Boolean(this.pendingPaste)
    const selectionChanged = this.selection.count > 0
    if (!activeChanged && !pasteChanged && !selectionChanged) return this.unchanged()
    this.pendingPaste = undefined
    this.document.setActiveLayer(id)
    this.selection = { cells: [], count: 0 }
    return this.changed({ selectionChanged: true, selectionFocus: true, factsChanged: true, toolsChanged: true, save: activeChanged, announcement: `${layer.name} active` }, { layer: { ...layer } })
  }

  private setLayerVisibility(id: number, visible: boolean) {
    const layer = this.requireLayer(id)
    if (layer.visible === visible) return this.unchanged()
    layer.visible = visible
    const previous = this.selection.cells
    const next = previous.filter(cell => this.document.getVisibleVoxelLayer(cell.x, cell.y, cell.z) === this.document.activeLayerId)
    this.selection = { cells: next, count: next.length }
    return this.changed({ dirtyChunks: [...dirtyChunks(this.document, this.document.chunks.keys())], selectionChanged: !sameCells(previous, next), selectionFocus: true, factsChanged: true, toolsChanged: true, save: true, announcement: `${layer.name} ${visible ? 'shown' : 'hidden'}` }, { layer: { ...layer } })
  }

  private deleteLayer(id: number, allowNonEmpty: boolean) {
    const layer = this.requireLayer(id)
    if (this.document.layers.length === 1) throw new StudioCommandError('invalid_state', 'The last layer cannot be deleted.')
    const count = this.document.layerVoxelCount(id)
    if (count && !allowNonEmpty) throw new StudioCommandError('confirmation_required', `Deleting ${layer.name} would remove ${count} voxels.`, { voxelCount: count })
    const ids = [...this.document.chunks.keys()]
    this.document.deleteLayer(id)
    this.history.clear()
    this.pendingPaste = undefined
    this.selection = { cells: [], count: 0 }
    return this.changed({ dirtyChunks: [...dirtyChunks(this.document, ids)], selectionChanged: true, selectionFocus: true, factsChanged: true, toolsChanged: true, save: true, announcement: `${layer.name} deleted` }, { voxelCount: count })
  }

  private activateColor(index: number) {
    if (!this.validColor(index)) throw new StudioCommandError('not_found', `Color ${index} is not in the palette.`)
    if (this.activeColor === index) return this.unchanged()
    this.activeColor = index
    this.recentColors = [index, ...this.recentColors.filter(color => color !== index)].slice(0, 6)
    return this.changed({ activeColorChanged: true, toolsChanged: true, preferencesChanged: true, announcement: `Color ${index} selected` }, { index })
  }

  private duplicateColor(source: number, name?: string) {
    if (!this.validColor(source)) throw new StudioCommandError('not_found', `Color ${source} is not in the palette.`)
    const free = Array.from({ length: 255 }, (_, index) => index + 1).find(index => !this.document.palette[index])
    if (!free) throw new StudioCommandError('limit_exceeded', 'The 255-color palette is full.')
    this.document.palette[free] = this.document.palette[source]
    this.document.materials[free] = { ...this.document.materials[source], name: (name?.trim() || `${this.document.materials[source].name} copy`).slice(0, 40) }
    this.activeColor = free
    this.recentColors = [free, ...this.recentColors].slice(0, 6)
    return this.changed({ paletteChanged: true, activeColorChanged: true, materialChanged: [free], toolsChanged: true, preferencesChanged: true, save: true }, { index: free })
  }

  private updateMaterial(index: number, patch: MaterialPatch) {
    this.requireColorIndex(index)
    const material = this.document.materials[index]
    const next = { ...material, ...patch }
    next.name = next.name.trim().slice(0, 40) || `Color ${index}`
    const ranges = { roughness: [0, 1], metalness: [0, 1], emissiveIntensity: [0, 5], opacity: [0, 1], transmission: [0, 1], ior: [1, 2.5] } as const
    for (const property of Object.keys(ranges) as (keyof typeof ranges)[]) {
      const value = next[property]
      const [min, max] = ranges[property]
      if (!Number.isFinite(value) || value < min || value > max) throw new StudioCommandError('invalid_argument', `${property} must be between ${min} and ${max}.`)
    }
    if (JSON.stringify(next) === JSON.stringify(material)) return this.unchanged()
    this.document.materials[index] = next
    return this.changed({ materialChanged: [index], save: true }, { index, material: { ...next } })
  }

  private setTool(tool: Tool) {
    let selectionChanged = false
    if (this.pendingPaste && tool !== 'sculpt') {
      this.pendingPaste = undefined
      this.selection = { cells: [], count: 0 }
      selectionChanged = true
    }
    if (this.activeTool === tool && !this.auxiliaryTool && !selectionChanged) return this.unchanged()
    this.activeTool = tool
    this.auxiliaryTool = undefined
    return this.changed({ toolsChanged: true, selectionChanged, selectionFocus: selectionChanged, announcement: `${tool === 'paint' ? 'Place' : tool[0].toUpperCase() + tool.slice(1)} tool selected` }, { tool })
  }

  private setSculptMode(mode: SculptMode) {
    let selectionChanged = false
    if (this.pendingPaste && mode !== 'move') {
      this.pendingPaste = undefined
      this.selection = { cells: [], count: 0 }
      selectionChanged = true
    }
    if (this.sculptMode === mode && !selectionChanged) return this.unchanged()
    this.sculptMode = mode
    return this.changed({ toolsChanged: true, selectionChanged, selectionFocus: selectionChanged, announcement: `${mode === 'push' ? 'Push/Pull' : mode[0].toUpperCase() + mode.slice(1)} operation selected` }, { mode })
  }
}
