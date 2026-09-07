import { SceneDocument, createScene } from './document'
import { SceneRenderer } from './renderer'
import { exportSceneFile } from './library'
import { getSceneChunkCacheStats, putSceneAsset, saveSceneDocumentRecovery } from './storage'
import type { SceneAsset, SceneCommand, SceneManifest, SceneRecoveryContext } from './types'
import type { LibraryLink } from '../../shared/library/types'
import type { Viewport } from '../../shared/rendering/viewport'
import type { ViewSettings } from '../../shared/rendering/settings'
import { decodeProjectSnapshot, type ProjectSnapshot } from '../../shared/voxel/snapshot'
import { mountSceneUI, type SceneUI } from './ui'

export interface SceneEditorOptions {
  viewport: Viewport
  settings: ViewSettings
  keyboardRoot?: HTMLElement
  active?: boolean
  recoveryEnabled?: boolean
  editAsset?(assetId: string): Promise<void>
  openScene?(snapshot: SceneManifest, library?: LibraryLink): Promise<void>
  leaveScene?(): Promise<void>
  beforeSave?(): Promise<void>
  recoveryContext?(): Pick<SceneRecoveryContext, 'editingAssetId' | 'view'>
  hasTextureMaps?(): boolean
  saveStateChanged?(): void
  notify(message: string): void
}

/** Scene commands, rendering and recovery; model editing is an optional host callback. */
export class SceneEditor {
  private scene: SceneDocument
  private library?: LibraryLink
  private timer?: ReturnType<typeof setTimeout>
  private saving: Promise<void> = Promise.resolve()
  private saveCounter = 0
  private conflict = false
  private disposed = false
  private disposal?: Promise<void>
  private ui: SceneUI
  private working = false
  private sceneMode = false
  private options: SceneEditorOptions
  recoveryEnabled: boolean
  readonly renderer: SceneRenderer
  saveState: 'saved' | 'saving' | 'error' = 'saved'

  constructor(root: HTMLElement, options: SceneEditorOptions) {
    this.options = options
    root.classList.add('editor-surface', 'editor-mount')
    this.scene = new SceneDocument(createScene(options.settings))
    this.recoveryEnabled = options.recoveryEnabled ?? true
    this.renderer = new SceneRenderer(options.viewport, this.scene, {
      onSelect: ids => this.safeCommand({ type: 'selection.set', ids }),
      onPlace: (assetId, position) => this.safeCommand({ type: 'instance.place', assetId, position }),
      onTransform: transforms => this.safeCommand({ type: 'instances.transform', transforms }),
      onLayer: id => this.safeCommand({ type: 'layer.activate', id }),
      onStats: stats => this.ui?.setStats({ ...stats, residentBytes: stats.residentBytes + getSceneChunkCacheStats().bytes }),
      onError: message => options.notify(message),
    })
    this.ui = mountSceneUI(root, {
      current: () => ({ scene: this.scene, library: this.library, hasTextureMaps: options.hasTextureMaps?.(), renderMode: options.viewport.renderMode }),
      command: command => this.command(command),
      tool: tool => this.renderer.setTool(tool),
      transform: mode => this.renderer.setTransformMode(mode),
      snap: enabled => this.renderer.setSnap(enabled),
      place: id => this.renderer.setPlacementAsset(id),
      editModel: id => this.editModel(id),
      insertModel: (snapshot, source) => this.insertModel(snapshot, source),
      openScene: (snapshot, library) => options.openScene ? options.openScene(snapshot, library) : this.open(snapshot, library),
      newScene: () => options.openScene ? options.openScene(createScene(this.scene.data.settings)) : this.open(createScene(this.scene.data.settings)),
      leaveScene: () => options.leaveScene?.(),
      frame: () => { this.renderer.frameSelection(); this.viewChanged() },
      renderMode: () => { options.viewport.setRenderMode(!options.viewport.renderMode); this.ui.render() },
      capture: exact => this.capture(exact),
      settings: patch => this.command({ type: 'scene.settings', patch }),
      notify: message => options.notify(message),
      librarySaved: library => { this.library = library; this.queueSave() },
    }, options.keyboardRoot)
    this.setActive(options.active ?? true)
  }

  get document() { return this.scene }
  get active() { return this.sceneMode }
  get busy() { return this.working }
  get revision() { return this.scene.data.revision }
  snapshot() { return this.scene.snapshot() }

  private report(error: unknown) {
    if (!this.disposed) this.options.notify(error instanceof Error ? error.message : 'The scene operation failed. Your current work has been retained.')
  }

  private safeCommand(command: SceneCommand) {
    try { this.command(command) } catch (error) { this.renderer.refresh(); this.report(error) }
  }

  command(command: SceneCommand) {
    if (this.disposed || this.working || !this.sceneMode) throw new Error('Wait for the current scene operation to finish.')
    const revision = this.scene.data.revision
    const change = this.scene.execute(command)
    if (!change.changed) return
    this.renderer.refresh(change)
    this.ui.render()
    if (this.scene.data.revision !== revision) this.markLibraryDirty()
    this.queueSave()
  }

  markLibraryDirty() { if (this.library) this.library = { ...this.library, dirty: true } }
  updateAsset(asset: SceneAsset) { this.scene.execute({ type: 'asset.update', asset }) }
  refresh() { this.renderer.refresh(); this.ui.render() }
  setBusy(busy: boolean) { this.working = busy; this.ui.setBusy(busy) }
  setActive(active: boolean) {
    this.sceneMode = active
    this.renderer.setActive(active)
    this.ui.setVisible(active)
  }

  replace(next: SceneDocument, library?: LibraryLink, recovery?: SceneRecoveryContext) {
    this.renderer.setActive(false)
    this.scene = next; this.library = library; this.conflict = false
    if (recovery?.selection) this.scene.execute({ type: 'selection.set', ids: recovery.selection })
    this.renderer.setDocument(next)
  }

  async open(snapshot: SceneManifest, library?: LibraryLink) {
    if (this.working || this.disposed) throw new Error('Wait for the current scene operation to finish.')
    const next = new SceneDocument({ ...snapshot, id: crypto.randomUUID() })
    this.setBusy(true)
    try {
      await this.flush()
      this.replace(next, library)
      this.setActive(true); this.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
  }

  async insertModel(snapshot: ProjectSnapshot, source?: { id: string; version: number }) {
    if (this.working || this.disposed) throw new Error('Wait for the current scene operation to finish.')
    const document = decodeProjectSnapshot(snapshot).document
    this.setBusy(true)
    let asset: SceneAsset
    try {
      asset = await putSceneAsset(document, snapshot.settings, undefined, undefined, source)
      this.scene.execute({ type: 'asset.add', asset })
      if (!document.voxelCount) this.scene.execute({ type: 'instance.place', assetId: asset.id, position: { x: 0, y: 0, z: 0 } })
      this.markLibraryDirty()
      this.refresh(); this.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
    if (!document.voxelCount) await this.options.editAsset?.(asset.id)
  }

  private async editModel(id: string) {
    const instance = this.scene.instances.get(id)
    const layer = instance && this.scene.data.layers.find(layer => layer.id === instance.layerId)
    if (!instance || !layer?.visible || layer.locked) throw new Error('Select an instance on a visible, unlocked layer before editing.')
    if (!this.options.editAsset) throw new Error('Model editing is not available in this scene editor.')
    await this.options.editAsset(instance.assetId)
  }

  viewChanged() { if (this.sceneMode) this.queueSave() }
  queueSave() {
    if (this.disposed || !this.recoveryEnabled) return
    clearTimeout(this.timer)
    this.saveCounter++
    if (this.conflict) return
    this.saveState = 'saving'; this.ui.setSaveState('saving')
    this.options.saveStateChanged?.()
    this.timer = setTimeout(() => { void this.flush().catch(error => this.report(error)) }, 420)
  }

  async flush() {
    if (!this.recoveryEnabled || this.disposed) return
    clearTimeout(this.timer); this.timer = undefined
    if (this.conflict) throw new Error('Another tab changed this scene recovery. Export the scene to preserve this tab before reopening it.')
    const owner = this.scene
    const operation = this.saving.catch(() => {}).then(async () => {
      if (owner !== this.scene || this.disposed) return
      const counter = this.saveCounter
      await this.options.beforeSave?.()
      await saveSceneDocumentRecovery(owner, { view: this.options.viewport.getView(), ...this.options.recoveryContext?.(), selection: owner.selection, library: this.library })
      if (!this.disposed && counter === this.saveCounter) { this.saveState = 'saved'; this.ui.setSaveState('saved'); this.options.saveStateChanged?.() }
    })
    this.saving = operation.catch(error => {
      if (!this.disposed) {
        this.saveState = 'error'
        this.conflict = (error as { code?: string }).code === 'storage_conflict'
        this.ui.setSaveState('error', error instanceof Error ? error.message : 'Local recovery failed. Export before leaving.')
        this.options.saveStateChanged?.()
      }
      throw error
    })
    void this.saving.catch(() => {})
    await this.saving
  }

  /** Export remains available when another tab owns the recovery revision. */
  async exportScene() {
    if (this.disposed || this.disposal) throw new Error('Wait for the current scene operation to finish.')
    await this.saving.catch(() => {})
    await this.options.beforeSave?.()
    await exportSceneFile(this.scene.snapshot())
  }

  private async capture(exact = false) {
    if (this.working) throw new Error('Wait for the current scene operation to finish.')
    this.setBusy(true)
    try {
      const { blob } = await this.renderer.capture(exact)
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = `${this.scene.data.name.replace(/[^a-z0-9_-]+/gi, '-') || 'scene'}.png`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } finally { this.setBusy(false) }
  }

  dispose() {
    if (this.disposed) return Promise.resolve()
    if (this.disposal) return this.disposal
    if (this.working) return Promise.reject(new Error('Wait for the current scene operation to finish before closing the editor.'))
    const canvas = this.options.viewport.getSceneViewport().canvas
    const inert = this.ui.element.inert, canvasInert = canvas.inert
    this.ui.element.inert = canvas.inert = true
    this.setBusy(true)
    this.disposal = (async () => {
      try {
        do { await this.flush() } while (this.recoveryEnabled && this.saveState === 'saving')
        this.disposed = true; clearTimeout(this.timer); this.renderer.dispose(); this.ui.dispose()
      } finally {
        canvas.inert = canvasInert
        if (!this.disposed) { this.ui.element.inert = inert; this.setBusy(false) }
        this.disposal = undefined
      }
    })()
    return this.disposal
  }
}
