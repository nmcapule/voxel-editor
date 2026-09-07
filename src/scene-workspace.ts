import { VoxelDocument } from './editor'
import { decodeProjectSnapshot, type ProjectSnapshot } from './protocol'
import { SceneDocument, createScene } from './scene'
import { SceneRenderer } from './scene-renderer'
import { exportSceneFile } from './scene-library'
import { deactivateSceneRecovery, getSceneChunkCacheStats, loadSceneAsset, loadSceneRecovery, putSceneAsset, saveSceneDocumentRecovery } from './scene-storage'
import type { SceneAsset, SceneCommand, SceneManifest, SceneRecoveryContext } from './scene-types'
import { mountSceneUI, type SceneUI } from './scene-ui'
import type { CameraSnapshot, VoxelRenderer } from './renderer'
import { Studio, type StudioEffects } from './studio'
import type { LibraryLink } from './storage'

type ModelSession = { controller: Studio; library?: LibraryLink; view: CameraSnapshot }
interface WorkspaceHost {
  renderer: VoxelRenderer
  currentModel(): ModelSession
  activateModel(session: ModelSession, assetKey?: string): Promise<void>
  flushModel(): Promise<void>
  contextChanged(): void
  saveStateChanged(): void
  notify(message: string): void
}

/** The scene owns recovery while a child model is open. Only one hydrated child is retained. */
export class SceneWorkspace {
  private host: WorkspaceHost
  private scene: SceneDocument
  private library?: LibraryLink
  private sceneView?: CameraSnapshot
  private standalone?: ModelSession
  private editing?: { assetId: string; controller: Studio; changed: boolean; all: boolean; dirty: Set<number> }
  private child?: { assetId: string; session: ModelSession }
  private timer?: ReturnType<typeof setTimeout>
  private saving: Promise<void> = Promise.resolve()
  private saveCounter = 0
  private conflict = false
  private owned = false
  private sceneMode = false
  private working = false
  private returnBar = document.createElement('div')
  private originalChrome: HTMLElement[]
  private ui: SceneUI
  readonly renderer: SceneRenderer
  saveState: 'saved' | 'saving' | 'error' = 'saved'

  constructor(host: WorkspaceHost) {
    this.host = host
    this.scene = new SceneDocument(createScene(host.currentModel().controller.settings))
    this.originalChrome = [...document.querySelectorAll<HTMLElement>('.studio > .top-chrome, .studio > .welcome-panel, .studio > .scene-status, .studio > .context-dock, .studio > .tool-popup, .studio > .tool-dock, .studio > .layer-panel, .studio > .stage-panel')]
    this.returnBar.className = 'scene-return instrument'
    this.returnBar.hidden = true
    const done = document.createElement('button')
    done.type = 'button'; done.textContent = 'Done: Return to scene'; done.className = 'primary'
    done.addEventListener('click', () => { void this.returnToScene().catch(error => this.report(error)) })
    const context = document.createElement('span')
    context.id = 'scene-model-context'
    this.returnBar.append(done, context)
    document.querySelector('.studio')!.append(this.returnBar)
    this.renderer = new SceneRenderer(host.renderer, this.scene, {
      onSelect: ids => this.safeCommand({ type: 'selection.set', ids }),
      onPlace: (assetId, position) => this.safeCommand({ type: 'instance.place', assetId, position }),
      onTransform: transforms => this.safeCommand({ type: 'instances.transform', transforms }),
      onLayer: id => this.safeCommand({ type: 'layer.activate', id }),
      onStats: stats => this.ui?.setStats({ ...stats, residentBytes: stats.residentBytes + getSceneChunkCacheStats().bytes }),
      onError: message => host.notify(message),
    })
    this.ui = mountSceneUI({
      current: () => ({ scene: this.scene, library: this.library, hasTextureMaps: Boolean(this.child?.session.controller.loadedPbrMaps.size), renderMode: host.renderer.getSceneViewport().renderMode }),
      command: command => this.command(command),
      tool: tool => this.renderer.setTool(tool),
      transform: mode => this.renderer.setTransformMode(mode),
      snap: enabled => this.renderer.setSnap(enabled),
      place: id => this.renderer.setPlacementAsset(id),
      editModel: id => this.editModel(id),
      insertModel: (snapshot, source) => this.insertModel(snapshot, source),
      openScene: (snapshot, library) => this.open(snapshot, library),
      newScene: () => this.open(createScene(this.scene.data.settings)),
      leaveScene: () => this.leave(),
      frame: () => { this.renderer.frameSelection(); this.viewChanged() },
      renderMode: () => { host.renderer.setRenderMode(!host.renderer.getSceneViewport().renderMode); this.ui.render() },
      capture: exact => this.capture(exact),
      settings: patch => this.command({ type: 'scene.settings', patch }),
      notify: message => host.notify(message),
      librarySaved: library => { this.library = library; this.queueSave() },
    })
  }

  get active() { return this.sceneMode }
  get hasScene() { return this.owned }
  get busy() { return this.working }
  get revision() { return this.scene.data.revision }
  snapshot() { return this.scene.snapshot() }

  private report(error: unknown) { this.host.notify(error instanceof Error ? error.message : 'The scene operation failed. Your current work has been retained.') }
  private safeCommand(command: SceneCommand) {
    try { this.command(command) } catch (error) { this.renderer.refresh(); this.report(error) }
  }
  private command(command: SceneCommand) {
    if (this.working || !this.sceneMode) throw new Error('Wait for the current scene operation to finish.')
    const revision = this.scene.data.revision
    const change = this.scene.execute(command)
    if (!change.changed) return
    this.renderer.refresh(change)
    this.ui.render()
    if (this.scene.data.revision !== revision && this.library) this.library = { ...this.library, dirty: true }
    this.queueSave()
  }
  private setBusy(busy: boolean) {
    this.working = busy
    this.ui.setBusy(busy)
    this.returnBar.querySelector('button')!.disabled = busy
  }
  private showScene(visible: boolean) {
    this.sceneMode = visible
    const root = document.querySelector<HTMLElement>('.studio')!
    root.dataset.editor = visible ? 'scene' : this.editing ? 'asset' : 'model'
    for (const chrome of this.originalChrome) chrome.inert = visible
    for (const popup of this.originalChrome) if (popup.matches(':popover-open')) popup.hidePopover()
    const menu = document.querySelector<HTMLDetailsElement>('#project-menu')!
    menu.open = false
    this.returnBar.hidden = !this.editing || visible
    const sceneExport = document.querySelector<HTMLElement>('[data-action="export-owning-scene"]')
    if (sceneExport) sceneExport.hidden = !this.editing
    this.ui.setVisible(visible)
    this.host.contextChanged()
  }

  async start(includeModel = false) {
    if (this.working) return
    if (this.owned && this.editing) { await this.returnToScene(); return }
    if (!includeModel && this.standalone && !this.owned) {
      this.setBusy(true)
      try {
        await this.host.flushModel()
        this.standalone = this.host.currentModel()
        this.owned = true
        this.renderer.setActive(true); this.showScene(true); this.queueSave(); await this.flush()
      } finally { this.setBusy(false) }
      return
    }
    const current = this.host.currentModel()
    await this.open(createScene(current.controller.settings))
    if (includeModel) {
      this.setBusy(true)
      try {
        const asset = await putSceneAsset(current.controller.document, current.controller.settings, undefined, undefined, current.library)
        this.scene.execute({ type: 'asset.add', asset })
        this.scene.execute({ type: 'instance.place', assetId: asset.id, position: { x: 0, y: 0, z: 0 } })
        this.renderer.refresh(); this.renderer.frameSelection(); this.ui.render(); this.queueSave()
        await this.flush()
      } finally { this.setBusy(false) }
    }
  }

  async open(snapshot: SceneManifest, library?: LibraryLink, recovery?: SceneRecoveryContext) {
    if (this.working) throw new Error('Wait for the current scene operation to finish.')
    const next = new SceneDocument(recovery ? snapshot : { ...snapshot, id: crypto.randomUUID() })
    this.setBusy(true)
    try {
      if (this.owned) await this.flush()
      else { await this.host.flushModel(); this.standalone = this.host.currentModel() }
      this.renderer.setActive(false)
      this.scene = next; this.library = library; this.editing = undefined; this.child = undefined
      this.sceneView = recovery?.view; this.conflict = false; this.owned = true
      if (recovery?.selection) this.scene.execute({ type: 'selection.set', ids: recovery.selection })
      this.renderer.setDocument(next); this.renderer.setActive(true)
      if (this.sceneView) this.host.renderer.setView(this.sceneView)
      this.showScene(true); this.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
  }

  async restore() {
    const recovered = await loadSceneRecovery()
    if (!recovered) return
    await this.open(recovered.scene, recovered.context.library, recovered.context)
    if (recovered.context.editingAssetId) await this.editAsset(recovered.context.editingAssetId)
  }

  private async insertModel(snapshot: ProjectSnapshot, source?: { id: string; version: number }) {
    if (this.working) throw new Error('Wait for the current scene operation to finish.')
    const document = decodeProjectSnapshot(snapshot).document
    this.setBusy(true)
    let asset: SceneAsset
    try {
      asset = await putSceneAsset(document, snapshot.settings, undefined, undefined, source)
      this.scene.execute({ type: 'asset.add', asset })
      if (!document.voxelCount) this.scene.execute({ type: 'instance.place', assetId: asset.id, position: { x: 0, y: 0, z: 0 } })
      if (this.library) this.library = { ...this.library, dirty: true }
      this.renderer.refresh(); this.ui.render(); this.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
    if (!document.voxelCount) await this.editAsset(asset.id)
  }

  private async editModel(id: string) {
    const instance = this.scene.instances.get(id)
    const layer = instance && this.scene.data.layers.find(layer => layer.id === instance.layerId)
    if (!instance || !layer?.visible || layer.locked) throw new Error('Select an instance on a visible, unlocked layer before editing.')
    await this.editAsset(instance.assetId)
  }
  private async editAsset(assetId: string) {
    if (this.working) throw new Error('Wait for the current scene operation to finish.')
    const asset = this.scene.assets.get(assetId)
    if (!asset) throw new Error('The selected scene model no longer exists.')
    this.setBusy(true)
    try {
      await this.flush()
      const loaded = this.child?.assetId === assetId ? undefined : await loadSceneAsset(asset)
      const controller = loaded ? new Studio(loaded.document, loaded.settings) : this.child!.session.controller
      this.sceneView = this.host.renderer.getView()
      this.renderer.setActive(false)
      this.editing = { assetId, controller, changed: false, all: false, dirty: new Set() }
      this.showScene(false)
      const session = loaded ? { controller, view: this.host.renderer.getView() } : this.child!.session
      await this.host.activateModel(session, `${this.scene.data.id}:${assetId}`)
      if (loaded) this.host.renderer.frameModel()
      const count = this.scene.data.instances.filter(instance => instance.assetId === assetId).length
      this.returnBar.querySelector('span')!.textContent = `${this.scene.data.name} / ${asset.model.name} (${count} shared ${count === 1 ? 'instance' : 'instances'})`
      this.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
  }

  modelChanged(effects: StudioEffects = {}) {
    if (!this.editing) return
    this.editing.changed = true
    this.editing.all ||= Boolean(effects.documentReplaced)
    for (const id of effects.dirtyChunks ?? []) this.editing.dirty.add(id)
    if (this.library) this.library = { ...this.library, dirty: true }
    this.queueSave()
  }
  viewChanged() { if (this.sceneMode) this.queueSave() }
  private queueSave() {
    clearTimeout(this.timer)
    this.saveCounter++
    if (this.conflict) return
    this.saveState = 'saving'; this.ui.setSaveState('saving')
    this.host.saveStateChanged()
    this.timer = setTimeout(() => { void this.flush().catch(error => this.report(error)) }, 420)
  }

  async flush() {
    if (!this.owned) return
    clearTimeout(this.timer); this.timer = undefined
    if (this.conflict) throw new Error('Another tab changed this scene recovery. Export the scene to preserve this tab before reopening it.')
    const owner = this.scene
    const operation = this.saving.catch(() => {}).then(async () => {
      if (owner !== this.scene) return
      const counter = this.saveCounter
      await this.updateEditingAsset()
      await saveSceneDocumentRecovery(owner, { editingAssetId: this.editing?.assetId, selection: owner.selection, view: this.sceneMode ? this.host.renderer.getView() : this.sceneView, library: this.library })
      if (counter === this.saveCounter) { this.saveState = 'saved'; this.ui.setSaveState('saved'); this.host.saveStateChanged() }
    })
    this.saving = operation.catch(error => {
      this.saveState = 'error'
      this.conflict = (error as { code?: string }).code === 'storage_conflict'
      this.ui.setSaveState('error', error instanceof Error ? error.message : 'Local recovery failed. Export before leaving.')
      this.host.saveStateChanged()
      throw error
    })
    void this.saving.catch(() => {})
    await this.saving
  }

  private async updateEditingAsset() {
    const editing = this.editing
    if (!editing?.changed) return
    const dirty = editing.dirty, all = editing.all
    editing.changed = false; editing.all = false; editing.dirty = new Set()
    try {
      const asset = await putSceneAsset(editing.controller.document, editing.controller.settings, this.scene.assets.get(editing.assetId), all ? undefined : dirty)
      this.scene.execute({ type: 'asset.update', asset })
    } catch (error) {
      editing.changed = true; editing.all ||= all
      for (const id of dirty) editing.dirty.add(id)
      throw error
    }
  }

  /** Export remains available when another tab owns the recovery revision. */
  async exportScene() {
    if (!this.owned || this.working) return
    this.setBusy(true)
    try {
      await this.saving.catch(() => {})
      await this.updateEditingAsset()
      await exportSceneFile(this.scene.snapshot())
    } finally { this.setBusy(false) }
  }

  async returnToScene() {
    if (this.working || !this.editing) return
    this.setBusy(true)
    try {
      await this.host.flushModel()
      this.child = { assetId: this.editing.assetId, session: this.host.currentModel() }
      this.editing = undefined
      // Drop the child's render resources while retaining its bounded editing session.
      await this.host.activateModel({ controller: new Studio(new VoxelDocument(), this.scene.data.settings), view: this.host.renderer.getView() })
      this.renderer.refresh(); this.renderer.setActive(true)
      if (this.sceneView) this.host.renderer.setView(this.sceneView)
      this.showScene(true); this.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
  }

  private async leave() {
    if (this.working || !this.standalone) return
    this.setBusy(true)
    try {
      await this.flush()
      this.renderer.setActive(false)
      await deactivateSceneRecovery()
      this.owned = false; this.editing = undefined
      await this.host.activateModel(this.standalone)
      this.showScene(false)
    } finally { this.setBusy(false) }
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

  dispose() { clearTimeout(this.timer); this.renderer.dispose(); this.ui.dispose(); this.returnBar.remove() }
}
