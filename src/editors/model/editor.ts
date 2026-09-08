import './style.css'
import { icon } from '../../shared/ui/icons'
import { materialCube, modelMarkup } from './ui'
import { escapeHtml, listen } from '../../shared/ui/dom'
import { DEFAULT_SETTINGS, type ViewSettings } from '../../shared/rendering/settings'
import { StudioCommandError } from '../../shared/errors'
import { base64ToBytes, bytesToBase64, decodeProjectSnapshot, encodeProjectSnapshot } from '../../shared/voxel/snapshot'
import { VoxelDocument, type Dimensions, type FillShape, type ResizeAnchor, type Vec3 } from '../../shared/voxel/document'
import { mountModelLibrary } from './library'
import { SerialCommandQueue, type RemoteCommand } from './protocol'
import { VoxelRenderer } from './renderer'
import { type CameraSnapshot } from '../../shared/rendering/contracts'
import { Studio, type AuxiliaryTool, type PaintMode, type PbrMap, type SculptMode, type SelectionMode, type SelectionState, type StudioCommand, type StudioEffects, type StudioOutcome, type Tool } from './studio'
import { loadProject, saveProjectSnapshot, snapshotProject } from './storage'
import { type LibraryLink } from '../../shared/library/types'
import { exportVox, importVox, VOX_EXPORT_WARNING } from '../../shared/voxel/vox'

type PaletteFilter = 'all' | 'opaque' | 'transparent' | 'metal' | 'emissive'
type StoredToolState = { selectionMode?: unknown; activeColor?: unknown; recentColors?: unknown }

function readLocalStorage(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}

function writeLocalStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* Preferences remain usable for this session. */ }
}

export type CommandSource = 'ui' | 'renderer' | 'remote' | 'assistant'
export type ModelResult = { changed: boolean; revision: number; result: unknown }
export type ModelSession = { controller: Studio; library?: LibraryLink; view: CameraSnapshot; maps?: Map<string, Extract<RemoteCommand, { type: 'material.map.set' }>> }
export type ModelCommandEvent = { source: CommandSource; command: RemoteCommand; outcome: StudioOutcome }
export type ModelDispatch = (command: RemoteCommand, source?: CommandSource, ifRevision?: number, viewVersion?: number, signal?: AbortSignal) => Promise<ModelResult>
export interface ModelEditorOptions {
  viewportRoot?: HTMLElement
  keyboardRoot?: HTMLElement
  dispatch?: ModelDispatch
  onCommand?(event: ModelCommandEvent): void
  onViewChange?(view: CameraSnapshot): boolean
  onSave?(effects?: StudioEffects): boolean
  flushOwner?(): Promise<void> | undefined
  ownerSaveStatus?(): { state: 'saved' | 'saving' | 'error'; text: string; title: string } | undefined
  busy?(): boolean
  notify?(message: string, tone?: 'normal' | 'warning'): void
  menuActions?: { action: string; label: string; hidden?: boolean; run(): Promise<void> }[]
}

export async function mountModelEditor(app: HTMLElement, options: ModelEditorOptions = {}) {
  app.classList.add('editor-surface', 'editor-mount')
  const lifetime = new AbortController()
  let disposed = false
  let disposal: Promise<void> | undefined
  let activating = false
  let visible = true
  const on = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, listener: (event: HTMLElementEventMap[K]) => void) => listen(lifetime.signal, target, type, listener)
  let restored: Awaited<ReturnType<typeof loadProject>>
  let storageError = ''
  try {
    restored = await loadProject()
  } catch {
    storageError = 'Local autosave is unavailable. Export a VOX file before leaving.'
  }

  let voxelDocument = restored?.document ?? new VoxelDocument()
  let settings: ViewSettings = { ...DEFAULT_SETTINGS, ...restored?.settings }
  let libraryLink: LibraryLink | undefined = restored?.library
  let libraryGeneration = 0
  let libraryChanges = 0
  const storedToolState: StoredToolState = (() => {
    try {
      const parsed: unknown = JSON.parse(readLocalStorage('voxel-studio-tool-state') ?? '{}')
      return parsed && typeof parsed === 'object' ? parsed as StoredToolState : {}
    } catch { return {} }
  })()
  const isSelectionMode = (value: unknown): value is SelectionMode => typeof value === 'string' && ['point', 'surface', 'texture', 'body'].includes(value)
  const isPaletteColor = (value: unknown): value is number => voxelDocument.hasPaletteColor(value)
  const defaultActiveColor = voxelDocument.hasPaletteColor(5) ? 5 : Math.max(1, voxelDocument.palette.findIndex((_color, index) => voxelDocument.hasPaletteColor(index)))
  let activeTool: Tool = 'select'
  let paintMode: PaintMode = 'paint'
  let sculptMode: SculptMode = 'push'
  let fillShape: FillShape = 'box'
  let fillDepth = 1
  let auxiliaryTool: AuxiliaryTool | undefined
  let selectionMode: SelectionMode = isSelectionMode(storedToolState.selectionMode) ? storedToolState.selectionMode : 'point'
  let activeColor = isPaletteColor(storedToolState.activeColor) ? storedToolState.activeColor : defaultActiveColor
  let paletteView: 'grid' | 'list' = readLocalStorage('voxel-studio-palette-view') === 'list' ? 'list' : 'grid'
  let paletteFilter: PaletteFilter = 'all'
  let renderMode = false
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveRevision = 0
  let saveState: 'saved' | 'saving' | 'error' = storageError ? 'error' : 'saved'
  let pendingSave = Promise.resolve()
  const storedRecentColors = Array.isArray(storedToolState.recentColors) ? storedToolState.recentColors : [5, 6, 12, 14, 3, 2]
  let recentColors = [...new Set([activeColor, ...storedRecentColors.filter(isPaletteColor)])].slice(0, 6)
  let selection: SelectionState = { cells: [], count: 0 }
  let clipboard: (Vec3 & { color: number })[] = []
  let pendingPaste: Studio['pendingPaste']
  let studioController = new Studio(voxelDocument, settings, { selectionMode, activeColor, recentColors })
  let loadedPbrMaps = studioController.loadedPbrMaps
  let renderer!: VoxelRenderer
  let editorGeneration = 0
  const sessionMaps = new WeakMap<Studio, Map<string, Extract<RemoteCommand, { type: 'material.map.set' }>>>()

  app.innerHTML = modelMarkup(Boolean(options.viewportRoot), options.menuActions)

  const studio = app.querySelector<HTMLElement>('.model-editor')!
  const projectName = app.querySelector<HTMLInputElement>('#project-name')!
  const stagePanel = app.querySelector<HTMLElement>('#stage-panel')!
  const layerPanel = app.querySelector<HTMLElement>('#layer-panel')!
  const toast = app.querySelector<HTMLElement>('#toast')!
  const announcer = app.querySelector<HTMLElement>('#announcer')!
  const welcome = app.querySelector<HTMLElement>('#welcome')!
  const saveStatus = app.querySelector<HTMLElement>('#save-status')!
  const resizeForm = app.querySelector<HTMLFormElement>('#resize-form')!
  const fileInput = app.querySelector<HTMLInputElement>('#file-input')!
  const fillOptions = app.querySelector<HTMLElement>('#fill-options')!
  const layerList = app.querySelector<HTMLElement>('#layer-list')!
  const toolPopups = [...app.querySelectorAll<HTMLElement>('.tool-popup, .layer-panel')]
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let hoverPopupTimer: ReturnType<typeof setTimeout> | undefined
  let shortcutPrefix: 'q' | 'w' | 's' | undefined
  let shortcutTimer: ReturnType<typeof setTimeout> | undefined

  if (readLocalStorage('voxel-studio-guide') === 'seen') welcome.hidden = true

  function colorHex(index: number) {
    return `#${(voxelDocument.palette[index] || 0).toString(16).padStart(6, '0')}`
  }

  function formatNumber(value: number) {
    return new Intl.NumberFormat().format(value)
  }

  function showToast(message: string, tone: 'normal' | 'warning' = 'normal') {
    if (disposed) return
    if (options.notify) { options.notify(message, tone); return }
    if (toastTimer) clearTimeout(toastTimer)
    toast.textContent = message
    toast.dataset.tone = tone
    toast.hidden = false
    toastTimer = setTimeout(() => { toast.hidden = true }, 4200)
  }

  function announce(message: string) {
    announcer.textContent = ''
    requestAnimationFrame(() => { if (!disposed) announcer.textContent = message })
  }

  function dismissGuide() {
    welcome.hidden = true
    writeLocalStorage('voxel-studio-guide', 'seen')
  }

  function updateSaveStatus() {
    if (disposed) return
    const owner = options.ownerSaveStatus?.()
    if (owner) {
      saveStatus.dataset.state = owner.state
      saveStatus.querySelector('span')!.textContent = owner.text
      saveStatus.title = owner.title
      return
    }
    saveStatus.dataset.state = saveState
    saveStatus.querySelector('span')!.textContent = saveState === 'saving' ? 'Saving locally…' : saveState === 'error' ? 'Local save failed' : libraryLink && !libraryLink.dirty ? 'Saved to server' : 'Saved locally'
    saveStatus.title = libraryLink?.dirty ? 'Local recovery saved. Use Save model to update the server copy.' : 'Local autosave is separate from the shared server library.'
  }

  function queueSave(effects?: StudioEffects) {
    if (disposed) return
    if (options.onSave?.(effects)) return
    if (storageError) return
    if (saveTimer) clearTimeout(saveTimer)
    saveState = 'saving'
    updateSaveStatus()
    const revision = ++saveRevision
    saveTimer = setTimeout(() => { void persistSave(revision).catch(commandFailed) }, 420)
  }

  async function persistSave(revision: number) {
    saveTimer = undefined
    const owner = options.flushOwner?.()
    if (owner) return owner
    const snapshot = snapshotProject(voxelDocument, settings, libraryLink)
    pendingSave = pendingSave.catch(() => {}).then(() => saveProjectSnapshot(snapshot)).then(() => {
      if (revision === saveRevision) { saveState = 'saved'; updateSaveStatus() }
    }).catch(error => {
      saveState = 'error'
      updateSaveStatus()
      showToast('Autosave failed. Export a VOX file to keep this model.', 'warning')
      throw error
    })
    return pendingSave
  }

  async function flushSave() {
    do {
      const owner = options.flushOwner?.()
      if (owner) { await owner; return }
      if (storageError) throw new StudioCommandError('save_failed', storageError)
      clearTimeout(saveTimer)
      if (saveState !== 'saved') await persistSave(saveRevision)
      else await pendingSave
    } while (saveState === 'saving')
  }

  function syncStudioState() {
    voxelDocument = studioController.document
    settings = studioController.settings
    activeTool = studioController.activeTool
    paintMode = studioController.paintMode
    sculptMode = studioController.sculptMode
    fillShape = studioController.fillShape
    fillDepth = studioController.fillDepth
    auxiliaryTool = studioController.auxiliaryTool
    selectionMode = studioController.selectionMode
    activeColor = studioController.activeColor
    recentColors = studioController.recentColors
    renderMode = studioController.renderMode
    selection = studioController.selection
    clipboard = studioController.clipboard
    pendingPaste = studioController.pendingPaste
  }

  function applyStudioEffects(command: RemoteCommand, outcome: StudioOutcome, source: CommandSource) {
    if (disposed) return
    const effects = outcome.effects
    syncStudioState()
    if (!effects.documentReplaced) renderer.refreshLayerScope()
    if (effects.documentReplaced && command.type !== 'document.resize') {
      libraryLink = undefined
      libraryGeneration++
    }
    if (effects.save) {
      libraryChanges++
      if (libraryLink) libraryLink = { ...libraryLink, dirty: true }
    }
    if (effects.documentReplaced) {
      if (effects.clearPbrMaps) sessionMaps.get(studioController)?.clear()
      renderer.setDocument(voxelDocument, effects.preserveMaterials)
      renderer.setActiveColor(activeColor)
    } else {
      if (effects.dirtyChunks) renderer.markDirty(effects.dirtyChunks)
      if (effects.paletteChanged) renderer.updatePalette()
      for (const index of effects.materialChanged ?? []) renderer.updatePaletteMaterial(index)
    }
    if (effects.settingsChanged) renderer.setSettings(settings)
    if (effects.activeColorChanged) renderer.setActiveColor(activeColor)
    if (effects.selectionChanged && !(source === 'renderer' && command.type === 'selection.set') && !effects.documentReplaced) renderer.applySelection(selection, effects.selectionFocus)
    if (command.type === 'tool.set' || command.type === 'clipboard.paste.begin') {
      studio.dataset.tool = activeTool
      app.querySelector('#context-title')!.textContent = toolCopy[activeTool][0]
      renderer.setTool(activeTool)
      renderer.setAuxiliary(auxiliaryTool)
    }
    if (command.type === 'tool.paintMode') {
      app.querySelector('#context-title')!.textContent = toolCopy[activeTool][0]
      renderer.setPaintMode(paintMode)
      renderer.setAuxiliary(auxiliaryTool)
    }
    if (command.type === 'tool.sculptMode' || command.type === 'clipboard.paste.begin') renderer.setSculptMode(sculptMode)
    if (command.type === 'tool.selectionMode') renderer.setSelectionMode(selectionMode)
    if (command.type === 'tool.auxiliary') renderer.setAuxiliary(auxiliaryTool)
    if (command.type === 'tool.auxiliary') app.querySelector('#context-title')!.textContent = auxiliaryTool ? 'Eyedropper' : toolCopy[activeTool][0]
    if (command.type === 'tool.fill') { renderer.setFillShape(fillShape); renderer.setFillDepth(fillDepth) }
    if (command.type === 'renderMode.set') {
      studio.dataset.renderMode = String(renderMode)
      app.querySelectorAll<HTMLElement>('.tool-dock, .context-dock').forEach(element => { element.inert = renderMode })
      app.querySelector<HTMLButtonElement>('[data-action="render"]')!.setAttribute('aria-pressed', String(renderMode))
      renderer.setRenderMode(renderMode)
    }
    if (effects.preferencesChanged) persistToolState()
    if (effects.factsChanged || effects.documentReplaced) renderDocumentFacts()
    if (effects.paletteChanged || effects.activeColorChanged || effects.documentReplaced) {
      renderPalette()
      renderPaletteMaterial()
    } else if (effects.materialChanged && (source === 'remote' || source === 'assistant')) {
      renderPalette()
      renderPaletteMaterial()
    }
    if (effects.settingsChanged) renderSettings()
    if (effects.toolsChanged || effects.selectionChanged) renderToolControls()
    if (effects.save) queueSave(effects)
    if (effects.announcement) announce(effects.announcement)
  }

  function executeStudioCommand(command: StudioCommand, source: CommandSource = 'ui') {
    const outcome = studioController.execute(command)
    applyStudioEffects(command, outcome, source)
    emitCommandEvent(command, source, outcome)
    return outcome
  }

  function emitCommandEvent(command: RemoteCommand, source: CommandSource, outcome: StudioOutcome) {
    if (!disposed) options.onCommand?.({ command, source, outcome })
  }

  type QueuedCommand = { command: RemoteCommand; source: CommandSource; ifRevision?: number; viewVersion?: number; editorGeneration: number }

  let rendererViewVersion = 0

  async function execute(command: RemoteCommand, source: CommandSource = 'ui', ifRevision?: number, viewVersion?: number): Promise<ModelResult> {
    if (disposed) throw new StudioCommandError('invalid_state', 'The model editor has been disposed.')
    if (ifRevision !== undefined && ifRevision !== studioController.revision) throw new StudioCommandError('revision_conflict', `Expected revision ${ifRevision}, current revision is ${studioController.revision}.`, { expected: ifRevision, actual: studioController.revision })
    switch (command.type) {
      case 'state.get':
        return { changed: false, revision: studioController.revision, result: { ...studioController.stateSnapshot(), view: renderer.getView(), mesh: renderer.meshState(), saveState: options.ownerSaveStatus?.()?.state ?? saveState } }
      case 'composition.get': {
        const { type: _type, ...query } = command
        return { changed: false, revision: studioController.revision, result: studioController.composition(query) }
      }
      case 'project.snapshot.get':
        return { changed: false, revision: studioController.revision, result: encodeProjectSnapshot(voxelDocument, settings) }
      case 'project.snapshot.replace': {
        if (voxelDocument.voxelCount && !command.allowReplace) throw new StudioCommandError('confirmation_required', 'Replacing the project requires allowReplace.', { voxelCount: voxelDocument.voxelCount })
        const decoded = decodeProjectSnapshot(command.snapshot)
        const outcome = studioController.replaceDocument(decoded.document, false, {}, decoded.settings)
        applyStudioEffects(command, outcome, source)
        emitCommandEvent(command, source, outcome)
        return { changed: true, revision: outcome.revision, result: { voxelCount: decoded.document.voxelCount } }
      }
      case 'view.get':
        return { changed: false, revision: studioController.revision, result: renderer.getView() }
      case 'view.set': {
        if (source !== 'renderer' || viewVersion === rendererViewVersion) renderer.setView(command.view)
        const outcome = studioController.recordChange({ view: renderer.getView() })
        emitCommandEvent(command, source, outcome)
        return { changed: true, revision: outcome.revision, result: outcome.result }
      }
      case 'view.frame': {
        renderer.frameModel()
        const outcome = studioController.recordChange({ view: renderer.getView() })
        emitCommandEvent(command, source, outcome)
        return { changed: true, revision: outcome.revision, result: outcome.result }
      }
      case 'view.inspect': {
        const revision = studioController.revision
        const inspected = await renderer.inspect(command.views)
        const images = await Promise.all(inspected.map(async ({ blob, ...metadata }) => ({
          ...metadata, mime: 'image/png', dataBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
        })))
        return { changed: false, revision, result: { revision, images } }
      }
      case 'view.capture': {
        const { blob, view } = await renderer.capture()
        return { changed: false, revision: studioController.revision, result: { mime: 'image/png', dataBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), view, revision: studioController.revision } }
      }
      case 'io.vox.import': {
        if (voxelDocument.voxelCount && !command.allowReplace) throw new StudioCommandError('confirmation_required', 'Importing a VOX file requires allowReplace.', { voxelCount: voxelDocument.voxelCount })
        const bytes = base64ToBytes(command.dataBase64)
        const imported = importVox(bytes.buffer, command.name)
        const outcome = studioController.replaceDocument(imported.document)
        applyStudioEffects(command, outcome, source)
        emitCommandEvent(command, source, outcome)
        return { changed: true, revision: outcome.revision, result: { voxelCount: imported.document.voxelCount, warning: imported.warning ?? null } }
      }
      case 'io.vox.export':
        return { changed: false, revision: studioController.revision, result: { mime: 'application/octet-stream', filename: filename('vox'), dataBase64: bytesToBase64(new Uint8Array(exportVox(voxelDocument))), warning: VOX_EXPORT_WARNING } }
      case 'material.map.set': {
        const bytes = base64ToBytes(command.dataBase64)
        const outcome = await studioController.loadPbrMap(command.index, command.map, command.name,
          () => renderer.setPbrMap(command.index, command.map, new Blob([bytes], { type: command.mime })))
        const maps = sessionMaps.get(studioController) ?? new Map()
        maps.set(`${command.index}:${command.map}`, command)
        sessionMaps.set(studioController, maps)
        if (activeColor === command.index) renderPaletteMaterial()
        applyStudioEffects(command, outcome, source)
        emitCommandEvent(command, source, outcome)
        return { changed: true, revision: outcome.revision, result: outcome.result }
      }
      case 'material.map.clear': {
        const retained = sessionMaps.get(studioController)
        for (const [key, map] of retained ?? []) if (map.index === command.index && (!command.map || command.map === map.map)) retained!.delete(key)
        const maps = loadedPbrMaps.get(command.index)
        const mutation = command.map ? maps?.has(command.map) : Boolean(maps?.size)
        renderer.clearPbrMaps(command.index, command.map)
        if (command.map) maps?.delete(command.map)
        else loadedPbrMaps.delete(command.index)
        if (maps && !maps.size) loadedPbrMaps.delete(command.index)
        if (activeColor === command.index) renderPaletteMaterial()
        const outcome = studioController.recordChange({ index: command.index, map: command.map ?? null }, { mutation, announcement: `PBR texture ${command.map ? 'map' : 'maps'} cleared for color ${command.index}` })
        applyStudioEffects(command, outcome, source)
        emitCommandEvent(command, source, outcome)
        return { changed: true, revision: outcome.revision, result: outcome.result }
      }
      case 'save.flush':
        await flushSave()
        return { changed: false, revision: studioController.revision, result: { saveState } }
      default: {
        const outcome = executeStudioCommand(command, source)
        return { changed: outcome.changed, revision: outcome.revision, result: { changed: outcome.changed, ...outcome.result } }
      }
    }
  }

  const localQueue = new SerialCommandQueue<QueuedCommand, ModelResult>(queued => {
    if (queued.editorGeneration !== editorGeneration) throw new StudioCommandError('revision_conflict', 'The active editor changed before this command ran. Retry in the current editor.')
    return execute(queued.command, queued.source, queued.ifRevision, queued.viewVersion)
  })
  const dispatchApplicationCommand: ModelDispatch = (command, source = 'ui', ifRevision, viewVersion, signal) => {
    if (disposed || disposal || options.busy?.() && command.type !== 'save.flush') return Promise.reject(new StudioCommandError('invalid_state', 'Wait for the current editor operation to finish.'))
    return options.dispatch ? options.dispatch(command, source, ifRevision, viewVersion, signal)
      : localQueue.dispatch({ command, source, ifRevision, viewVersion, editorGeneration }, signal)
  }

  function commandFailed(error: unknown) {
    const message = error instanceof Error ? error.message : 'The command could not be completed.'
    showToast(message, error instanceof StudioCommandError && error.code === 'invalid_state' ? 'normal' : 'warning')
  }

  function runStudioCommand(command: StudioCommand, source: CommandSource = 'ui') {
    return dispatchApplicationCommand(command, source).catch(error => {
      commandFailed(error)
      return undefined
    })
  }

  function persistToolState() {
    writeLocalStorage('voxel-studio-tool-state', JSON.stringify({ selectionMode, activeColor, recentColors }))
  }

  function paletteIndices(filter: PaletteFilter = paletteFilter) {
    const indices: number[] = []
    for (let index = 1; index < 256; index++) {
      if (!voxelDocument.hasPaletteColor(index)) continue
      const material = voxelDocument.materials[index]
      if (filter === 'opaque' && (material.opacity < 1 || material.transmission > 0)) continue
      if (filter === 'transparent' && material.opacity >= 1 && material.transmission === 0) continue
      if (filter === 'metal' && material.metalness < 0.5) continue
      if (filter === 'emissive' && material.emissiveIntensity === 0) continue
      indices.push(index)
    }
    return indices
  }

  function selectColor(index: number) {
    void runStudioCommand({ type: 'palette.activate', index }).then(outcome => {
      if (outcome?.changed) announce(`Color ${index}, ${colorHex(index)}`)
    })
  }

  function materialSummary(index: number) {
    const material = voxelDocument.materials[index]
    const emissive = material.emissiveIntensity ? ` · E ${material.emissiveIntensity.toFixed(1)}` : ''
    const transparent = material.transmission ? ` · T ${Math.round(material.transmission * 100)}%`
      : material.opacity < 1 ? ` · O ${Math.round(material.opacity * 100)}%` : ''
    return `R ${material.roughness.toFixed(2)} · M ${material.metalness.toFixed(2)}${emissive}${transparent}`
  }

  function materialPreviewStyle(index: number) {
    const material = voxelDocument.materials[index]
    const highlight = 1 + (14 + (1 - material.roughness) * 24 + material.metalness * 18 + material.emissiveIntensity * 6) / 100
    const opacity = Math.max(0.35, material.opacity * (1 - material.transmission * 0.45))
    return `--swatch:${colorHex(index)};--preview-highlight:${highlight};--preview-opacity:${opacity};--preview-glow:${material.emissiveIntensity ? colorHex(index) : 'transparent'}`
  }

  function renderMaterialPreview() {
    const material = voxelDocument.materials[activeColor]
    const preview = app.querySelector<HTMLElement>('#material-preview')!
    preview.style.cssText = materialPreviewStyle(activeColor)
    preview.dataset.transparent = String(material.opacity < 1 || material.transmission > 0)
    preview.title = `${material.name}: change swatch color`
  }

  function renderPalette() {
    const focusedPalette = document.activeElement instanceof HTMLButtonElement ? document.activeElement.closest<HTMLElement>('.quick-palette') : null
    const focusedColor = (document.activeElement as HTMLElement | null)?.dataset.color
    const activeMaterial = voxelDocument.materials[activeColor]
    for (const activeSwatch of app.querySelectorAll<HTMLButtonElement>('.active-swatch')) {
      activeSwatch.style.cssText = materialPreviewStyle(activeColor)
      activeSwatch.dataset.transparent = String(activeMaterial.opacity < 1 || activeMaterial.transmission > 0)
      activeSwatch.setAttribute('aria-label', `Open ${activeMaterial.name} in palette`)
      activeSwatch.title = `${activeMaterial.name}, ${colorHex(activeColor)}: open full palette`
    }
    const recentMaterials = recentColors.filter(index => index !== activeColor && voxelDocument.hasPaletteColor(index)).map(index =>
      `<button type="button" data-color="${index}" data-transparent="${voxelDocument.materials[index].opacity < 1 || voxelDocument.materials[index].transmission > 0}" aria-label="Use ${escapeHtml(voxelDocument.materials[index].name)}, ${colorHex(index)}" aria-pressed="${index === activeColor}" style="${materialPreviewStyle(index)}">${materialCube}</button>`,
    ).join('')
    for (const quickPalette of app.querySelectorAll<HTMLElement>('.quick-palette')) quickPalette.innerHTML = recentMaterials
    if (focusedColor) (focusedPalette?.querySelector<HTMLButtonElement>(`[data-color="${focusedColor}"]`)
      ?? focusedPalette?.parentElement?.querySelector<HTMLButtonElement>('.active-swatch'))?.focus({ preventScroll: true })
    const palette = app.querySelector<HTMLElement>('#palette-grid')!
    palette.dataset.view = paletteView
    const filteredMaterials = paletteIndices()
    palette.innerHTML = filteredMaterials.length ? filteredMaterials.map(index => {
      const material = voxelDocument.materials[index]
      return `<button type="button" data-color="${index}" data-transparent="${material.opacity < 1 || material.transmission > 0}" aria-label="Use ${escapeHtml(material.name)}, color ${index}, ${colorHex(index)}" aria-pressed="${index === activeColor}" style="${materialPreviewStyle(index)}">
        ${materialCube}<span class="swatch-copy"><strong>${escapeHtml(material.name)}</strong><small>${materialSummary(index)}</small></span><span class="swatch-index">${index}</span>
      </button>`
    }).join('') : '<p class="palette-empty">No materials match this filter.</p>'
    if (focusedColor && !focusedPalette) palette.querySelector<HTMLButtonElement>(`[data-color="${focusedColor}"]`)?.focus({ preventScroll: true })
    app.querySelectorAll<HTMLButtonElement>('[data-palette-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paletteView === paletteView)))
    app.querySelectorAll<HTMLButtonElement>('[data-palette-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paletteFilter === paletteFilter)))
    app.querySelector('#active-index')!.textContent = `Color ${activeColor}`
    const value = colorHex(activeColor)
    app.querySelector<HTMLInputElement>('#color-input')!.value = value
    app.querySelector<HTMLInputElement>('#hex-input')!.value = value.toUpperCase()
    app.querySelector<HTMLInputElement>('#material-name')!.value = activeMaterial.name
    app.querySelector('#paint-material-name')!.textContent = activeMaterial.name
    app.querySelector('#paint-material-value')!.textContent = value.toUpperCase()
    app.querySelector<HTMLElement>('#paint-tool-swatch')!.style.background = value
    renderMaterialPreview()
    renderToolControls()
  }

  const toolCopy: Record<Tool, [string, string]> = {
    select: ['Select', 'Choose voxels before changing them.'],
    paint: ['Place', 'Release over a voxel to paint its resolved selection.'],
    sculpt: ['Sculpt', 'Reshape the current selection.'],
    layer: ['Layer', 'Choose the active layer from the model.'],
  }

  const selectionCopy: Record<SelectionMode, string> = {
    point: 'Click one voxel or drag a 3D box.',
    surface: 'Click a connected exposed surface.',
    texture: 'Click contiguous voxels with the same texture.',
    body: 'Click a contiguous voxel body.',
  }

  const selectionLabels: Record<SelectionMode, string> = {
    point: 'Point',
    surface: 'Surface',
    texture: 'Texture',
    body: 'Body',
  }

  const paintLabels: Record<PaintMode, string> = {
    paint: 'Paint',
    fill: 'Volume',
  }

  const sculptCopy: Record<SculptMode, [string, string]> = {
    push: ['Push/Pull', 'Drag along a face normal to add or remove complete layers.'],
    move: ['Move', 'Drag along a face normal. Overlapping voxels are replaced on release.'],
    erase: ['Erase', 'Remove the resolved selection.'],
  }

  function renderToolControls() {
    app.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === activeTool)))
    app.querySelectorAll<HTMLButtonElement>('[data-selection-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.selectionMode === selectionMode)))
    app.querySelectorAll<HTMLButtonElement>('[data-paint-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paintMode === paintMode)))
    app.querySelectorAll<HTMLButtonElement>('[data-sculpt-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sculptMode === sculptMode)))
    app.querySelectorAll<HTMLButtonElement>('[data-fill-shape]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fillShape === fillShape)))
    app.querySelectorAll<HTMLButtonElement>('[data-auxiliary]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.auxiliary === auxiliaryTool)))
    const editable = voxelDocument.activeLayer.visible && !voxelDocument.activeLayer.locked
    app.querySelectorAll<HTMLButtonElement>('[data-clipboard-action]').forEach(button => {
      const action = button.dataset.clipboardAction
      button.disabled = action === 'paste' ? selection.floating === true || !clipboard.length || !editable
        : selection.floating === true || !selection.count || action === 'cut' && !editable
    })
    fillOptions.hidden = activeTool !== 'paint' || paintMode !== 'fill'
    app.querySelector('#select-tool-mode')!.textContent = selectionLabels[selectionMode]
    app.querySelector('#paint-tool-mode')!.textContent = auxiliaryTool ? 'Eyedropper' : paintMode === 'paint' ? voxelDocument.materials[activeColor].name : paintLabels[paintMode]
    app.querySelector('#sculpt-tool-mode')!.textContent = sculptCopy[sculptMode][0]
    app.querySelector('#layer-tool-mode')!.textContent = voxelDocument.activeLayer.name
    app.querySelector('button[data-tool="paint"] > svg')!.outerHTML = icon(auxiliaryTool ? 'pick' : paintMode)
    app.querySelector('button[data-tool="sculpt"] > svg')!.outerHTML = icon(sculptMode === 'push' ? 'push' : sculptMode)
    const count = formatNumber(selection.count)
    const copy = selection.floating ? `${count} pasted ${selection.count === 1 ? 'voxel' : 'voxels'} · drag to place or press Escape to cancel`
      : auxiliaryTool === 'pick' ? 'Choose a color directly from the model.'
      : activeTool === 'select' ? selection.count ? `${count} selected` : selectionCopy[selectionMode]
      : activeTool === 'paint' && paintMode === 'fill' ? `${fillShape} · ${fillDepth} ${fillDepth === 1 ? 'voxel' : 'voxels'} deep · drag on the model or guide grid`
      : activeTool === 'paint' ? selection.count ? `${count} selected · click to paint` : `${selectionLabels[selectionMode]} scope · release to select and paint`
      : activeTool === 'layer' ? 'Click a voxel to make its layer active.'
      : selection.count ? `${count} selected · ${sculptCopy[sculptMode][0]}` : `${selectionMode} · select before ${sculptCopy[sculptMode][0]}`
    app.querySelector('#context-copy')!.textContent = copy
  }

  function renderLayers() {
    const focusedButton = document.activeElement instanceof HTMLButtonElement && layerList.contains(document.activeElement) ? document.activeElement : undefined
    const focusedLayer = focusedButton?.closest<HTMLElement>('[data-layer-id]')?.dataset.layerId
    const focusedAction = focusedButton?.dataset.layerAction
    const counts = new Map<number, number>()
    voxelDocument.forEachVoxel((_x, _y, _z, _color, layerId) => counts.set(layerId, (counts.get(layerId) ?? 0) + 1))
    layerList.innerHTML = voxelDocument.layers.toReversed().map(layer => {
      const name = escapeHtml(layer.name)
      const count = counts.get(layer.id) ?? 0
      return `<div class="layer-row" data-active="${layer.id === voxelDocument.activeLayerId}" data-layer-id="${layer.id}" role="listitem">
        <button type="button" class="layer-active" data-layer-action="select" aria-label="Make ${name} active" aria-pressed="${layer.id === voxelDocument.activeLayerId}"><span></span></button>
        <label class="layer-name"><span class="sr-only">Layer name</span><input type="text" maxlength="40" value="${name}" data-layer-name="${layer.id}" aria-label="Rename ${name}"><small>${formatNumber(count)} ${count === 1 ? 'voxel' : 'voxels'}</small></label>
        <button type="button" data-layer-action="visibility" aria-label="${layer.visible ? 'Hide' : 'Show'} ${name}" aria-pressed="${layer.visible}" title="${layer.visible ? 'Hide' : 'Show'} layer">${icon(layer.visible ? 'eye' : 'eye-off')}</button>
        <button type="button" data-layer-action="lock" aria-label="${layer.locked ? 'Unlock' : 'Lock'} ${name}" aria-pressed="${layer.locked}" title="${layer.locked ? 'Unlock' : 'Lock'} layer">${icon(layer.locked ? 'lock' : 'unlock')}</button>
        <button type="button" data-layer-action="delete" aria-label="Delete ${name}" title="Delete layer" ${voxelDocument.layers.length === 1 ? 'disabled' : ''}>${icon('trash')}</button>
      </div>`
    }).join('')
    if (focusedLayer && focusedAction) (layerList.querySelector<HTMLButtonElement>(`[data-layer-id="${focusedLayer}"] [data-layer-action="${focusedAction}"]`)
      ?? layerList.querySelector<HTMLButtonElement>('[data-active="true"] [data-layer-action="select"]'))?.focus({ preventScroll: true })
  }

  function closeToolPopups() {
    for (const popup of toolPopups) if (popup.matches(':popover-open')) popup.hidePopover()
  }

  function popupForTrigger(trigger: HTMLButtonElement) {
    const id = trigger.getAttribute('popovertarget')
    return id ? app.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null
  }

  function showToolPopup(tool: Tool) {
    clearHoverPopupTimer()
    const trigger = app.querySelector<HTMLButtonElement>(`.tool-dock button[data-tool="${tool}"]`)
    const popup = trigger && popupForTrigger(trigger)
    if (!trigger || !popup) return
    trigger.focus({ preventScroll: true })
    if (!popup.matches(':popover-open')) popup.showPopover()
    ;(popup.querySelector<HTMLElement>('.tool-mode-list [aria-pressed="true"]')
      ?? popup.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)'))?.focus({ preventScroll: true })
  }

  function clearHoverPopupTimer() {
    if (hoverPopupTimer) clearTimeout(hoverPopupTimer)
    hoverPopupTimer = undefined
  }

  function scheduleHoverPopupClose(trigger: HTMLButtonElement, popup: HTMLElement) {
    clearHoverPopupTimer()
    hoverPopupTimer = setTimeout(() => {
      hoverPopupTimer = undefined
      if (!trigger.matches(':hover') && !popup.matches(':hover, :focus-within') && popup.matches(':popover-open')) popup.hidePopover()
    }, 140)
  }

  for (const trigger of app.querySelectorAll<HTMLButtonElement>('.tool-dock button[data-tool][popovertarget]')) {
    const popup = popupForTrigger(trigger)
    if (!popup) continue
    on(trigger, 'pointerenter', event => {
      if (event.pointerType !== 'mouse') return
      clearHoverPopupTimer()
      if (!popup.matches(':popover-open')) popup.showPopover()
    })
    on(trigger, 'pointerleave', event => { if (event.pointerType === 'mouse') scheduleHoverPopupClose(trigger, popup) })
    on(popup, 'pointerenter', clearHoverPopupTimer)
    on(popup, 'pointerleave', event => { if (event.pointerType === 'mouse') scheduleHoverPopupClose(trigger, popup) })
  }

  function setTool(tool: Tool) {
    closePanel()
    runStudioCommand({ type: 'tool.set', tool })
  }

  function setPaintMode(mode: PaintMode) {
    runStudioCommand({ type: 'tool.paintMode', mode })
  }

  function setSculptMode(mode: SculptMode) {
    runStudioCommand({ type: 'tool.sculptMode', mode })
  }

  function setFillShape(shape: FillShape) {
    runStudioCommand({ type: 'tool.fill', shape })
  }

  function setAuxiliary(tool?: AuxiliaryTool) {
    runStudioCommand({ type: 'tool.auxiliary', tool })
  }

  function clearShortcutPrefix() {
    if (shortcutTimer) clearTimeout(shortcutTimer)
    shortcutTimer = undefined
    shortcutPrefix = undefined
  }

  function armShortcut(prefix: 'q' | 'w' | 's') {
    clearShortcutPrefix()
    shortcutPrefix = prefix
    shortcutTimer = setTimeout(clearShortcutPrefix, 1500)
    announce(prefix === 'q' ? 'Select selected. Press 1 for Point, 2 for Surface, 3 for Texture, or 4 for Body.'
      : prefix === 'w' ? 'Place selected. Press 1 for Paint, 2 for Volume, or 3 for Eyedropper.'
      : 'Sculpt selected. Press 1 for Push Pull, 2 for Move, or 3 for Erase.')
  }

  function runShortcutChord(prefix: 'q' | 'w' | 's', key: string) {
    if (prefix === 'q') {
      const mode = ({ 1: 'point', 2: 'surface', 3: 'texture', 4: 'body' } as const)[key as '1' | '2' | '3' | '4']
      if (!mode) return false
      runStudioCommand({ type: 'tool.selectionMode', mode })
      return true
    }
    if (prefix === 'w') {
      if (key === '1') setPaintMode('paint')
      else if (key === '2') setPaintMode('fill')
      else if (key === '3') setAuxiliary('pick')
      else return false
      return true
    }
    if (key === '1') setSculptMode('push')
    else if (key === '2') setSculptMode('move')
    else if (key === '3') setSculptMode('erase')
    else return false
    return true
  }

  function renderDocumentFacts() {
    if (document.activeElement !== projectName) projectName.value = voxelDocument.name
    const dimensions = voxelDocument.dimensions
    app.querySelector('#dimension-readout')!.textContent = `${dimensions.x} × ${dimensions.y} × ${dimensions.z}`
    for (const axis of ['x', 'y', 'z'] as const) (resizeForm.elements.namedItem(axis) as HTMLInputElement).value = String(dimensions[axis])
    app.querySelector('#voxel-count')!.textContent = `${formatNumber(voxelDocument.voxelCount)} ${voxelDocument.voxelCount === 1 ? 'voxel' : 'voxels'}`
    app.querySelector('#panel-voxel-count')!.textContent = formatNumber(voxelDocument.voxelCount)
    app.querySelector('#chunk-count')!.textContent = formatNumber(voxelDocument.chunks.size)
    app.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled = !studioController.canUndo
    app.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled = !studioController.canRedo
    renderLayers()
  }

  function renderSettings() {
    app.querySelector<HTMLSelectElement>('#projection')!.value = settings.projection
    app.querySelector<HTMLSelectElement>('#skybox')!.value = settings.skybox
    app.querySelector('#background-label')!.textContent = settings.skybox === 'solid' ? 'Backdrop' : 'Ground color'
    app.querySelector<HTMLElement>('#skybox-help')!.hidden = settings.skybox === 'solid'
    app.querySelector<HTMLInputElement>('#background')!.value = settings.background
    app.querySelector<HTMLInputElement>('#ambient')!.value = String(settings.ambient)
    app.querySelector<HTMLInputElement>('#light')!.value = String(settings.light)
    app.querySelector<HTMLInputElement>('#azimuth')!.value = String(settings.lightAzimuth)
    app.querySelector<HTMLInputElement>('#ambient-occlusion')!.checked = settings.ambientOcclusion
    app.querySelector<HTMLInputElement>('#shadows')!.checked = settings.shadows
    app.querySelector<HTMLInputElement>('#grid')!.checked = settings.grid
    app.querySelector<HTMLInputElement>('#face-grid')!.checked = settings.faceGrid
    app.querySelector<HTMLInputElement>('#mesh-vertices')!.checked = settings.meshVertices
    app.querySelector<HTMLInputElement>('#mesh-triangles')!.checked = settings.meshTriangles
    app.querySelector<HTMLInputElement>('#path-tracing')!.checked = settings.pathTracing
    app.querySelector<HTMLInputElement>('#tilt-shift')!.checked = settings.tiltShift
    app.querySelector<HTMLElement>('#tilt-shift-controls')!.hidden = !settings.tiltShift
    for (const key of ['tiltShiftStrength', 'tiltShiftFocus', 'tiltShiftWidth'] as const) {
      const input = app.querySelector<HTMLInputElement>(`#${key}`)!
      input.value = String(settings[key])
      const percent = `${Math.round(settings[key] * 100)}%`
      input.setAttribute('aria-valuetext', percent)
      app.querySelector(`#${key}-output`)!.textContent = percent
    }
    app.querySelector('#ambient-output')!.textContent = settings.ambient.toFixed(1)
    app.querySelector('#light-output')!.textContent = settings.light.toFixed(1)
    app.querySelector('#azimuth-output')!.textContent = `${settings.lightAzimuth}°`
  }

  function renderPbrMapCount() {
    const count = loadedPbrMaps.get(activeColor)?.size ?? 0
    app.querySelector('#pbr-map-count')!.textContent = count ? `${count} of 4 loaded` : 'No maps'
  }

  function renderPaletteMaterial() {
    const material = voxelDocument.materials[activeColor]
    for (const property of ['roughness', 'metalness', 'emissiveIntensity', 'opacity', 'transmission', 'ior'] as const) {
      const value = material[property]
      const label = property === 'ior' ? 'index of refraction' : property === 'emissiveIntensity' ? 'emission' : property
      const input = app.querySelector<HTMLInputElement>(`#${property}`)!
      input.value = String(value)
      input.setAttribute('aria-label', `${material.name} ${label}`)
      app.querySelector(`#${property}-output`)!.textContent = value.toFixed(2)
    }
    app.querySelector<HTMLInputElement>('#material-name')!.value = material.name
    app.querySelector('#material-color')!.textContent = material.name
    renderMaterialPreview()
    const maps = loadedPbrMaps.get(activeColor)
    app.querySelectorAll<HTMLInputElement>('[data-pbr-map]').forEach(input => {
      input.value = ''
      app.querySelector<HTMLElement>(`[data-pbr-name="${input.dataset.pbrMap}"]`)!.textContent = maps?.get(input.dataset.pbrMap as PbrMap) ?? 'No file'
    })
    renderPbrMapCount()
  }

  async function loadPbrMap(input: HTMLInputElement) {
    const file = input.files?.[0]
    const map = input.dataset.pbrMap as PbrMap
    if (!file) return
    const generation = editorGeneration
    const color = activeColor
    const label = app.querySelector<HTMLElement>(`[data-pbr-name="${map}"]`)!
    input.disabled = true
    label.textContent = 'Loading...'
    try {
      const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
      if (generation !== editorGeneration) throw new Error('The editor changed while the texture was loading.')
      await dispatchApplicationCommand({ type: 'material.map.set', index: color, map, name: file.name, mime: file.type || 'application/octet-stream', dataBase64 })
    } catch {
      if (activeColor === color) renderPaletteMaterial()
      showToast(`${file.name} could not be decoded as a texture.`, 'warning')
    } finally {
      input.disabled = false
    }
  }

  function fillSelection(cells: Vec3[]) {
    if (!cells.length) { showToast('Select voxels before painting.'); return }
    dismissGuide()
    void runStudioCommand({ type: 'edit.paint', cells }).then(outcome => {
      if (outcome && !outcome.changed) announce('Selection already uses the active color')
    })
  }

  function eraseSelection(cells: Vec3[]) {
    if (!cells.length) return
    dismissGuide()
    runStudioCommand({ type: 'edit.erase', cells })
  }

  function copySelection() {
    void runStudioCommand({ type: 'clipboard.copy' })
  }

  function cutSelection() {
    runStudioCommand({ type: 'clipboard.cut' })
  }

  function cancelPendingPaste() {
    runStudioCommand({ type: 'clipboard.paste.cancel' })
  }

  function pasteSelection() {
    closePanel()
    void runStudioCommand({ type: 'clipboard.paste.begin' }).then(outcome => {
      if (!outcome?.changed) return
      studio.dataset.tool = activeTool
      app.querySelector('#context-title')!.textContent = toolCopy[activeTool][0]
      closeToolPopups()
      renderer.focusViewport()
    })
  }

  function activateLayer(id: number) {
    runStudioCommand({ type: 'layer.activate', id })
  }

  renderer = new VoxelRenderer(options.viewportRoot ?? app.querySelector('#viewport')!, voxelDocument, settings, {
    onSelectionChange(next) {
      runStudioCommand({ type: 'selection.set', cells: next.cells, floating: next.floating }, 'renderer')
      if (next.count) dismissGuide()
    },
    onPaint: fillSelection,
    onErase: eraseSelection,
    onFillCommit(min, max, normal, shape) {
      dismissGuide()
      const axis = (['x', 'y', 'z'] as const).find(name => normal[name] !== 0) ?? 'y'
      void runStudioCommand({ type: 'edit.fill', min, max, shape, axis }, 'renderer').then(outcome => {
        if (outcome && !outcome.changed) announce('Volume made no changes')
      })
    },
    onPushPullCommit(cells, normal, distance, move, floating) {
      if (floating && move) {
        runStudioCommand({ type: 'clipboard.paste.place', offset: { x: normal.x * distance, y: normal.y * distance, z: normal.z * distance } }, 'renderer')
        return
      }
      runStudioCommand({ type: move ? 'edit.move' : 'edit.pushPull', cells, normal, distance }, 'renderer')
    },
    onPushPullPreview(cells, distance, move) {
      if (cells === undefined) { renderToolControls(); return }
      app.querySelector('#context-copy')!.textContent = pendingPaste
        ? `${formatNumber(cells)} pasted ${cells === 1 ? 'voxel' : 'voxels'} · ${distance ? `move ${Math.abs(distance)}` : 'drag to place'}`
        : distance
        ? `${move ? 'Move' : distance > 0 ? 'Pull' : 'Push'} ${Math.abs(distance)} · ${formatNumber(cells)} selected`
        : `${formatNumber(cells)} ${cells === 1 ? 'voxel' : 'voxels'} selected · drag to ${move ? 'move' : 'reshape'}`
    },
    onPick(color) {
      selectColor(color)
      setAuxiliary()
    },
    onLayerSelect: activateLayer,
    onViewStart() {
      rendererViewVersion++
    },
    onViewChange(view) {
      if (options.onViewChange?.(view)) return
      void dispatchApplicationCommand({ type: 'view.set', view }, 'renderer', undefined, rendererViewVersion).catch(commandFailed)
    },
    onHover(cell) {
      app.querySelector('#coordinate-status')!.textContent = cell ? `X ${cell.x}   Y ${cell.y}   Z ${cell.z}` : 'X --   Y --   Z --'
    },
    onMeshStats(pending, quads) {
      const status = app.querySelector('#mesh-status')!
      status.textContent = pending ? `Meshing ${pending}` : `${formatNumber(quads)} faces`
      if (quads > 2_000_000) showToast('This model has a high visible-face count. Camera movement may slow down.', 'warning')
    },
    onPathTracingStatus(status) {
      app.querySelector('#path-status')!.textContent = status
    },
    onFps(fps) {
      app.querySelector('#fps-status')!.textContent = fps === undefined ? '-- fps' : `${fps} fps`
    },
    onError(message) {
      showToast(message, 'warning')
    },
  })

  const modelLibrary = mountModelLibrary(app, {
    current: () => ({ name: voxelDocument.name, revision: studioController.revision, generation: libraryGeneration, changes: libraryChanges, library: libraryLink, hasTextureMaps: loadedPbrMaps.size > 0 }),
    snapshot: () => encodeProjectSnapshot(voxelDocument, settings),
    execute: (command, revision) => dispatchApplicationCommand(command, 'ui', revision),
    link(library) { libraryLink = library; queueSave(); updateSaveStatus() },
    notify: showToast,
  })

  async function activateSession(session: ModelSession) {
    if (disposed || disposal || activating) throw new StudioCommandError('invalid_state', 'Wait for the current editor operation to finish.')
    activating = true
    try {
      contextChanged()
      studioController = session.controller
      loadedPbrMaps = studioController.loadedPbrMaps
      if (session.maps) sessionMaps.set(studioController, session.maps)
      for (const command of session.maps?.values() ?? []) {
        const names = loadedPbrMaps.get(command.index) ?? new Map()
        names.set(command.map, command.name); loadedPbrMaps.set(command.index, names)
      }
      libraryLink = session.library
      libraryChanges = 0
      syncStudioState()
      renderer.setDocument(voxelDocument)
      renderer.setSettings(settings)
      renderer.setActive(true)
      renderer.setView(session.view)
      renderer.setActiveColor(activeColor)
      renderer.setTool(activeTool)
      renderer.setPaintMode(paintMode)
      renderer.setSculptMode(sculptMode)
      renderer.setSelectionMode(selectionMode)
      renderer.setFillShape(fillShape)
      renderer.setFillDepth(fillDepth)
      renderer.setAuxiliary(auxiliaryTool)
      renderer.applySelection(selection, false)
      renderer.setRenderMode(renderMode)
      for (const command of sessionMaps.get(studioController)?.values() ?? []) {
        await renderer.setPbrMap(command.index, command.map, new Blob([base64ToBytes(command.dataBase64)], { type: command.mime }))
      }
      studio.dataset.tool = activeTool
      studio.dataset.renderMode = String(renderMode)
      app.querySelectorAll<HTMLElement>('.tool-dock, .context-dock').forEach(element => { element.inert = renderMode })
      app.querySelector<HTMLButtonElement>('[data-action="render"]')!.setAttribute('aria-pressed', String(renderMode))
      closePanel(); closeToolPopups(); dismissGuide()
      renderPalette(); renderDocumentFacts(); renderSettings(); renderPaletteMaterial(); renderToolControls(); updateSaveStatus()
    } finally { activating = false }
  }

  function contextChanged() {
    editorGeneration++; libraryGeneration++; rendererViewVersion++; clearShortcutPrefix()
  }

  function setVisible(value: boolean) {
    visible = value
    studio.hidden = !value
    studio.inert = !value
    if (!value) { closeToolPopups(); closePanel(); clearShortcutPrefix(); modelLibrary.close() }
    app.querySelector<HTMLDetailsElement>('#project-menu')!.open = false
  }

  function openPanel(tab = 'model') {
    if (layerPanel.matches(':popover-open')) layerPanel.hidePopover()
    closeToolPopups()
    studio.dataset.panelOpen = 'true'
    stagePanel.dataset.open = 'true'
    stagePanel.setAttribute('aria-hidden', 'false')
    app.querySelector<HTMLButtonElement>('[data-action="panel"]')!.setAttribute('aria-expanded', 'true')
    app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)))
    app.querySelectorAll<HTMLElement>('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tab })
  }

  function closePanel() {
    delete studio.dataset.panelOpen
    delete stagePanel.dataset.open
    stagePanel.setAttribute('aria-hidden', 'true')
    app.querySelector<HTMLButtonElement>('[data-action="panel"]')!.setAttribute('aria-expanded', 'false')
  }

  function download(data: BlobPart, filename: string, type: string) {
    const url = URL.createObjectURL(new Blob([data], { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function filename(extension: string) {
    const safe = voxelDocument.name.trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || 'voxel-model'
    return `${safe}.${extension}`
  }

  function undo() {
    if (pendingPaste) { cancelPendingPaste(); return }
    runStudioCommand({ type: 'history.undo' })
  }

  function redo() {
    if (pendingPaste) { cancelPendingPaste(); return }
    runStudioCommand({ type: 'history.redo' })
  }

  function toggleRenderMode() {
    const next = !renderMode
    const button = app.querySelector<HTMLButtonElement>('[data-action="render"]')!
    const focusFromTool = toolPopups.some(popup => popup.contains(document.activeElement)) || Boolean((document.activeElement as HTMLElement | null)?.closest('.tool-dock'))
    if (next) { clearShortcutPrefix(); closeToolPopups(); if (focusFromTool) button.focus({ preventScroll: true }) }
    runStudioCommand({ type: 'renderMode.set', enabled: next })
    studio.dataset.renderMode = String(renderMode)
    app.querySelectorAll<HTMLElement>('.tool-dock, .context-dock').forEach(element => { element.inert = renderMode })
    button.setAttribute('aria-pressed', String(renderMode))
    if (renderMode && !matchMedia('(max-width: 840px)').matches) openPanel('render')
  }

  on(app, 'click', async event => {
    if (!visible || disposed || disposal) return
    const target = event.target as HTMLElement
    const clipboardButton = target.closest<HTMLButtonElement>('[data-clipboard-action]')
    if (clipboardButton) {
      const action = clipboardButton.dataset.clipboardAction
      if (action === 'cut') cutSelection()
      if (action === 'copy') copySelection()
      if (action === 'paste') pasteSelection()
      clipboardButton.closest<HTMLElement>('[popover]')?.hidePopover()
      return
    }
    const paletteFilterButton = target.closest<HTMLButtonElement>('[data-palette-filter]')
    if (paletteFilterButton) {
      const filter = paletteFilterButton.dataset.paletteFilter as PaletteFilter
      paletteFilter = paletteFilter === filter ? 'all' : filter
      renderPalette()
      return
    }
    const paletteViewButton = target.closest<HTMLButtonElement>('[data-palette-view]')
    if (paletteViewButton) {
      paletteView = paletteViewButton.dataset.paletteView as typeof paletteView
      writeLocalStorage('voxel-studio-palette-view', paletteView)
      renderPalette()
      return
    }
    const layerButton = target.closest<HTMLButtonElement>('[data-layer-action]')
    if (layerButton) {
      const action = layerButton.dataset.layerAction
      if (action === 'add') {
        runStudioCommand({ type: 'layer.create' })
        return
      }
      const id = Number(layerButton.closest<HTMLElement>('[data-layer-id]')?.dataset.layerId)
      const layer = voxelDocument.getLayer(id)
      if (!layer) return
      if (action === 'select') {
        activateLayer(id)
      }
      if (action === 'visibility') {
        runStudioCommand({ type: 'layer.visibility', id, visible: !layer.visible })
      }
      if (action === 'lock') {
        runStudioCommand({ type: 'layer.lock', id, locked: !layer.locked })
      }
      if (action === 'delete') {
        const count = voxelDocument.layerVoxelCount(id)
        if (count && !confirm(`Delete ${layer.name} and its ${formatNumber(count)} voxels?`)) return
        runStudioCommand({ type: 'layer.delete', id, allowNonEmpty: true })
      }
      return
    }
    const selectionButton = target.closest<HTMLButtonElement>('[data-selection-mode]')
    if (selectionButton) {
      if (activeTool !== 'select') setTool('select')
      runStudioCommand({ type: 'tool.selectionMode', mode: selectionButton.dataset.selectionMode as SelectionMode })
      selectionButton.closest<HTMLElement>('[popover]')?.hidePopover()
      announce(`${selectionLabels[selectionMode]} selection mode`)
      return
    }
    const paintButton = target.closest<HTMLButtonElement>('[data-paint-mode]')
    if (paintButton) {
      if (activeTool !== 'paint') setTool('paint')
      const mode = paintButton.dataset.paintMode as PaintMode
      setPaintMode(mode)
      paintButton.closest<HTMLElement>('[popover]')?.hidePopover()
      if (mode === 'fill' && event.detail === 0) requestAnimationFrame(() => fillOptions.querySelector<HTMLButtonElement>('button')?.focus())
      return
    }
    const sculptButton = target.closest<HTMLButtonElement>('[data-sculpt-mode]')
    if (sculptButton) {
      if (activeTool !== 'sculpt') setTool('sculpt')
      setSculptMode(sculptButton.dataset.sculptMode as SculptMode)
      sculptButton.closest<HTMLElement>('[popover]')?.hidePopover()
      return
    }
    const fillShapeButton = target.closest<HTMLButtonElement>('[data-fill-shape]')
    if (fillShapeButton) {
      setFillShape(fillShapeButton.dataset.fillShape as FillShape)
      return
    }
    const auxiliaryButton = target.closest<HTMLButtonElement>('[data-auxiliary]')
    if (auxiliaryButton) {
      if (activeTool !== 'paint') setTool('paint')
      setAuxiliary(auxiliaryButton.dataset.auxiliary as AuxiliaryTool)
      auxiliaryButton.closest<HTMLElement>('[popover]')?.hidePopover()
      return
    }
    const toolButton = target.closest<HTMLButtonElement>('button[data-tool]')
    if (toolButton) {
      setTool(toolButton.dataset.tool as Tool)
      return
    }
    const colorButton = target.closest<HTMLButtonElement>('[data-color]')
    if (colorButton) {
      if (colorButton.closest('#paint-tool-popup') && activeTool !== 'paint') setTool('paint')
      selectColor(Number(colorButton.dataset.color))
      return
    }
    const tabButton = target.closest<HTMLButtonElement>('[data-tab]')
    if (tabButton) { openPanel(tabButton.dataset.tab); return }
    const button = target.closest<HTMLButtonElement>('[data-action]')
    if (!button) return
    const action = button.dataset.action
    const external = options.menuActions?.find(item => item.action === action)
    if (external) {
      try { await external.run() } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) commandFailed(error) }
      return
    }
    if (action === 'save-model' || action === 'browse-models') {
      clearShortcutPrefix()
      closeToolPopups()
      modelLibrary.open(action === 'save-model')
    }
    if (action === 'undo') undo()
    if (action === 'redo') redo()
    if (action === 'frame') void dispatchApplicationCommand({ type: 'view.frame' }).catch(commandFailed)
    if (action === 'render') toggleRenderMode()
    if (action === 'panel') stagePanel.dataset.open ? closePanel() : openPanel('model')
    if (action === 'close-panel') closePanel()
    if (action === 'palette') {
      if (button.closest('#paint-tool-popup') && activeTool !== 'paint') setTool('paint')
      openPanel('palette')
    }
    if (action === 'dismiss-guide') { dismissGuide(); renderer.focusViewport() }
    if (action === 'clear-pbr') {
      void dispatchApplicationCommand({ type: 'material.map.clear', index: activeColor }).catch(commandFailed)
    }
    if (action === 'new') {
      if (voxelDocument.voxelCount && !confirm('Clear this model and start a new document? Your autosave will be replaced.')) return
      runStudioCommand({ type: 'document.new', dimensions: voxelDocument.dimensions })
      closePanel()
      showToast('New document ready.')
    }
    if (action === 'import') fileInput.click()
    if (action === 'export') {
      try {
        const response = await dispatchApplicationCommand({ type: 'io.vox.export' })
        const result = response.result as { dataBase64: string; filename: string; mime: string; warning: string }
        download(base64ToBytes(result.dataBase64), result.filename, result.mime)
        showToast(`VOX file exported. ${result.warning}`, 'warning')
      }
      catch { showToast('The VOX file could not be created.', 'warning') }
    }
    if (action === 'capture') {
      button.disabled = true
      try {
        const response = await dispatchApplicationCommand({ type: 'view.capture' })
        const result = response.result as { dataBase64: string; mime: string }
        download(base64ToBytes(result.dataBase64), filename('png'), result.mime)
        showToast('PNG captured.')
      }
      catch { showToast('The viewport could not be captured.', 'warning') }
      finally { button.disabled = false }
    }
    if (action === 'new-swatch') {
      runStudioCommand({ type: 'palette.duplicate' })
    }
    app.querySelector<HTMLDetailsElement>('#project-menu')!.open = false
  })

  projectName.value = voxelDocument.name
  on(projectName, 'input', () => {
    runStudioCommand({ type: 'document.rename', name: projectName.value })
  })

  on(fileInput, 'change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    const generation = editorGeneration, revision = studioController.revision
    if (voxelDocument.voxelCount && !confirm('Replace the current model with this VOX file?')) return
    try {
      const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
      if (generation !== editorGeneration) throw new Error('The editor changed while the VOX file was loading. Import it again in the intended model.')
      const response = await dispatchApplicationCommand({ type: 'io.vox.import', dataBase64, name: file.name, allowReplace: true }, 'ui', revision)
      const imported = response.result as { voxelCount: number; warning: string | null }
      closePanel()
      showToast(imported.warning ?? `Imported ${formatNumber(imported.voxelCount)} voxels.`, imported.warning ? 'warning' : 'normal')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'This VOX file could not be imported.', 'warning')
    }
  })

  on(resizeForm, 'submit', async event => {
    event.preventDefault()
    const data = new FormData(resizeForm)
    const dimensions: Dimensions = { x: Number(data.get('x')), y: Number(data.get('y')), z: Number(data.get('z')) }
    const anchor: ResizeAnchor = data.get('anchor') === 'origin' ? 'origin' : 'center'
    const command = { type: 'document.resize' as const, dimensions, anchor }
    try {
      await dispatchApplicationCommand(command)
    } catch (error) {
      if (!(error instanceof StudioCommandError) || error.code !== 'confirmation_required') { commandFailed(error); return }
      const cropped = Number(error.details?.cropped ?? 0)
      if (!confirm(`Resize and remove ${formatNumber(cropped)} voxels outside the new bounds?`)) return
      try { await dispatchApplicationCommand({ ...command, allowCrop: true }, 'ui', Number(error.details?.revision)) }
      catch (retryError) { commandFailed(retryError); return }
    }
    showToast(`Canvas resized to ${dimensions.x} × ${dimensions.y} × ${dimensions.z} from ${anchor}.`)
  })

  function updateActiveColor(value: string) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) { showToast('Enter a six-digit hex color such as #2F66DB.', 'warning'); renderPalette(); return }
    runStudioCommand({ type: 'palette.setColor', index: activeColor, color: Number.parseInt(value.slice(1), 16) })
  }

  on(app.querySelector<HTMLInputElement>('#color-input')!, 'change', event => updateActiveColor((event.target as HTMLInputElement).value))
  on(app.querySelector<HTMLInputElement>('#hex-input')!, 'change', event => updateActiveColor((event.target as HTMLInputElement).value))
  on(app.querySelector<HTMLInputElement>('#material-name')!, 'change', event => {
    const input = event.target as HTMLInputElement
    runStudioCommand({ type: 'material.update', index: activeColor, patch: { name: input.value } })
    renderPalette()
    renderPaletteMaterial()
  })

  on(layerList, 'change', event => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-layer-name]')
    if (!input) return
    const layer = voxelDocument.getLayer(Number(input.dataset.layerName))
    if (!layer) return
    runStudioCommand({ type: 'layer.rename', id: layer.id, name: input.value })
    const name = voxelDocument.getLayer(layer.id)!.name
    const row = input.closest<HTMLElement>('[data-layer-id]')!
    input.value = name
    input.setAttribute('aria-label', `Rename ${name}`)
    row.querySelector<HTMLButtonElement>('[data-layer-action="select"]')!.setAttribute('aria-label', `Make ${name} active`)
    row.querySelector<HTMLButtonElement>('[data-layer-action="visibility"]')!.setAttribute('aria-label', `${layer.visible ? 'Hide' : 'Show'} ${name}`)
    row.querySelector<HTMLButtonElement>('[data-layer-action="lock"]')!.setAttribute('aria-label', `${layer.locked ? 'Unlock' : 'Lock'} ${name}`)
    row.querySelector<HTMLButtonElement>('[data-layer-action="delete"]')!.setAttribute('aria-label', `Delete ${name}`)
    renderToolControls()
  })

  on(layerList, 'keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      const select = event.target.closest<HTMLElement>('[data-layer-id]')?.querySelector<HTMLButtonElement>('[data-layer-action="select"]')
      event.target.blur()
      select?.focus()
    }
  })

  on(app.querySelector<HTMLElement>('[data-panel="palette"]')!, 'input', event => {
    const target = event.target as HTMLInputElement | HTMLSelectElement
    if (target instanceof HTMLInputElement && target.dataset.pbrMap) { void loadPbrMap(target); return }
    if (target.id === 'roughness' || target.id === 'metalness' || target.id === 'emissiveIntensity' || target.id === 'opacity' || target.id === 'transmission' || target.id === 'ior') {
      const value = Number(target.value)
      runStudioCommand({ type: 'material.update', index: activeColor, patch: { [target.id]: value } })
      app.querySelector(`#${target.id}-output`)!.textContent = value.toFixed(2)
      renderMaterialPreview()
    }
  })

  on(app.querySelector<HTMLElement>('[data-panel="palette"]')!, 'change', event => {
    const target = event.target as HTMLInputElement
    if (target.matches('#roughness, #metalness, #emissiveIntensity, #opacity, #transmission, #ior')) renderPalette()
  })

  on(app.querySelector<HTMLElement>('[data-panel="render"]')!, 'input', event => {
    const target = event.target as HTMLInputElement | HTMLSelectElement
    const patch: Partial<ViewSettings> = {}
    if (target.id === 'projection') patch.projection = target.value as ViewSettings['projection']
    if (target.id === 'skybox') patch.skybox = target.value as ViewSettings['skybox']
    if (target.id === 'background') patch.background = target.value
    if (target.id === 'ambient') patch.ambient = Number(target.value)
    if (target.id === 'light') patch.light = Number(target.value)
    if (target.id === 'azimuth') patch.lightAzimuth = Number(target.value)
    if (target.id === 'ambient-occlusion') patch.ambientOcclusion = (target as HTMLInputElement).checked
    if (target.id === 'shadows') patch.shadows = (target as HTMLInputElement).checked
    if (target.id === 'grid') patch.grid = (target as HTMLInputElement).checked
    if (target.id === 'face-grid') patch.faceGrid = (target as HTMLInputElement).checked
    if (target.id === 'mesh-vertices') patch.meshVertices = (target as HTMLInputElement).checked
    if (target.id === 'mesh-triangles') patch.meshTriangles = (target as HTMLInputElement).checked
    if (target.id === 'path-tracing') patch.pathTracing = (target as HTMLInputElement).checked
    if (target.id === 'tilt-shift') patch.tiltShift = (target as HTMLInputElement).checked
    if (target.id === 'tiltShiftStrength' || target.id === 'tiltShiftFocus' || target.id === 'tiltShiftWidth') patch[target.id] = Number(target.value)
    runStudioCommand({ type: 'settings.update', patch })
  })

  on(app.querySelector<HTMLInputElement>('#fill-depth')!, 'input', event => {
    const input = event.target as HTMLInputElement
    if (!input.value) return
    runStudioCommand({ type: 'tool.fill', depth: Number(input.value) })
    if (Number(input.value) !== fillDepth) input.value = String(fillDepth)
  })

  on(app.querySelector<HTMLInputElement>('#fill-depth')!, 'change', event => {
    const input = event.target as HTMLInputElement
    input.value = String(fillDepth)
  })

  on(options.keyboardRoot ?? app, 'keydown', event => {
    if (!visible || disposed || disposal || options.busy?.() || event.defaultPrevented || (event.target as Element)?.closest('.voxel-assistant, dialog, [contenteditable]:not([contenteditable="false"])')) return
    const editingText = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement
    const key = event.key.toLowerCase()
    if (event.key === 'Escape' && toolPopups.some(popup => popup.matches(':popover-open'))) { clearShortcutPrefix(); return }
    if (event.key === 'Escape' && shortcutPrefix) {
      event.preventDefault()
      clearShortcutPrefix()
      return
    }
    if (event.key === 'Escape' && auxiliaryTool) {
      event.preventDefault()
      setAuxiliary()
      return
    }
    if (event.key === 'Escape' && pendingPaste) {
      event.preventDefault()
      cancelPendingPaste()
      announce('Paste canceled')
      return
    }
    if (event.key === 'Escape' && selection.count) {
      event.preventDefault()
      runStudioCommand({ type: 'selection.clear', focus: true })
      return
    }
    if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y') && !editingText) {
      event.preventDefault()
      clearShortcutPrefix()
      event.shiftKey || key === 'y' ? redo() : undo()
      return
    }
    if ((event.metaKey || event.ctrlKey) && ['x', 'c', 'v'].includes(key) && !editingText && !renderMode) {
      event.preventDefault()
      clearShortcutPrefix()
      if (key === 'x') cutSelection()
      if (key === 'c') copySelection()
      if (key === 'v') pasteSelection()
      return
    }
    if (editingText || event.metaKey || event.ctrlKey || event.altKey) { clearShortcutPrefix(); return }
    if (shortcutPrefix) {
      const prefix = shortcutPrefix
      clearShortcutPrefix()
      if (runShortcutChord(prefix, key)) {
        event.preventDefault()
        closeToolPopups()
        return
      }
    }
    const shortcuts: Record<string, Tool> = { q: 'select', w: 'paint', s: 'sculpt' }
    const tool = shortcuts[key]
    if (tool && !renderMode) {
      event.preventDefault()
      closeToolPopups()
      setTool(tool)
      armShortcut(key as 'q' | 'w' | 's')
      showToolPopup(tool)
      return
    }
    if (key === 'l' && !renderMode) {
      event.preventDefault()
      closeToolPopups()
      setTool('layer')
      showToolPopup('layer')
      return
    }
    if (key === 'f') { event.preventDefault(); void dispatchApplicationCommand({ type: 'view.frame' }).catch(commandFailed) }
    if (key === 'r') { event.preventDefault(); toggleRenderMode() }
    if (event.key === '?') { welcome.hidden = false }
  })

  renderer.setActiveColor(activeColor)
  renderer.setSelectionMode(selectionMode)
  renderer.setPaintMode(paintMode)
  renderer.setFillShape(fillShape)
  renderer.setFillDepth(fillDepth)
  renderPalette()
  renderDocumentFacts()
  renderSettings()
  renderPaletteMaterial()
  renderer.setTool(activeTool)
  renderToolControls()
  updateSaveStatus()
  renderer.focusViewport()
  if (storageError) showToast(storageError, 'warning')

  return {
    element: studio,
    menu: app.querySelector<HTMLElement>('#project-menu .menu-sheet')!,
    renderer,
    execute,
    dispatch: dispatchApplicationCommand,
    currentSession: (): ModelSession => ({ controller: studioController, library: libraryLink, view: renderer.getView(), maps: sessionMaps.get(studioController) }),
    activateSession,
    contextChanged,
    setVisible,
    updateSaveStatus,
    get saveState() { return saveState },
    get busy() { return activating || Boolean(disposal) },
    get revision() { return studioController.revision },
    dispose() {
      if (disposed) return Promise.resolve()
      if (disposal) return disposal
      if (activating) return Promise.reject(new StudioCommandError('invalid_state', 'Wait for the model session to finish opening before closing the editor.'))
      const viewportRoot = options.viewportRoot ?? app.querySelector<HTMLElement>('#viewport')!
      const inert = app.inert, viewportInert = viewportRoot.inert
      app.inert = viewportRoot.inert = true
      libraryGeneration++
      disposal = (async () => {
        try {
          // The application drains its external queue first; standalone mounts drain here.
          await localQueue.dispatch({ command: { type: 'save.flush' }, source: 'ui', editorGeneration })
          disposed = true; contextChanged(); lifetime.abort()
          clearTimeout(saveTimer); clearTimeout(toastTimer); clearTimeout(hoverPopupTimer); clearTimeout(shortcutTimer)
          modelLibrary.dispose(); renderer.dispose(); app.replaceChildren()
        } finally {
          if (!disposed) { app.inert = inert; viewportRoot.inert = viewportInert }
          disposal = undefined
        }
      })()
      return disposal
    },
  }
}

export type ModelEditor = Awaited<ReturnType<typeof mountModelEditor>>
