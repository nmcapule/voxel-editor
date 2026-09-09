import './style.css'
import { VoxelDocument } from '../../src/shared/voxel/document'
import { Studio, type StudioEffects } from '../../src/editors/model/studio'
import { SceneDocument, createScene } from '../../src/editors/scene/document'
import { loadSceneAsset, loadSceneRecovery, putSceneAsset } from '../../src/editors/scene/storage'
import type { SceneManifest, SceneRecoveryContext } from '../../src/editors/scene/types'
import type { LibraryLink } from '../../src/shared/library/types'
import type { CameraSnapshot } from '../../src/shared/rendering/contracts'
import { SceneEditor } from '../../src/editors/scene/editor'
import type { CommandSource, ModelEditor, ModelResult, ModelSession } from '../../src/editors/model/editor'
import type { RemoteCommand } from '../../src/editors/model/protocol'
import { StudioCommandError } from '../../src/shared/errors'
import { bytesToBase64 } from '../../src/shared/voxel/snapshot'

interface ScenePluginOptions {
  model: ModelEditor
  root: HTMLElement
  contextChanged(): void
  notify(message: string): void
}

/** The optional plugin owns scene transitions and save ownership, not model history. */
export class ScenePlugin {
  readonly scene: SceneEditor
  private sceneRoot: HTMLElement
  private returnBar: HTMLElement
  private lifetime = new AbortController()
  private standalone?: ModelSession
  private child?: { assetId: string; session: ModelSession }
  private editing?: { assetId: string; controller: Studio; changed: boolean; all: boolean; dirty: Set<number> }
  private sceneView?: CameraSnapshot
  private recoveryAssetId?: string
  private sceneVisible = false
  private assetMaps = new Map<string, NonNullable<ModelSession['maps']>>()
  private owned = false
  private disposed = false
  private options: ScenePluginOptions

  constructor(options: ScenePluginOptions) {
    this.options = options
    const { model } = options
    this.sceneRoot = document.createElement('div')
    this.sceneRoot.className = 'scene-root'
    this.returnBar = document.createElement('div')
    this.returnBar.className = 'scene-return instrument'
    this.returnBar.hidden = true
    this.returnBar.innerHTML = '<div class="scene-return-actions"><button type="button" class="primary">Done: Return to scene</button><button type="button" class="secondary">Export owning scene...</button></div><span></span>'
    this.scene = new SceneEditor(this.sceneRoot, {
      viewport: model.renderer.viewport,
      settings: model.currentSession().controller.settings,
      keyboardRoot: options.root,
      active: false,
      recoveryEnabled: false,
      editAsset: id => this.editAsset(id),
      openScene: (snapshot, library) => this.open(snapshot, library),
      createFromModel: () => this.start(true),
      leaveScene: () => this.leave(),
      beforeSave: () => this.updateEditingAsset(),
      recoveryContext: () => ({ editingAssetId: this.editing?.assetId ?? this.recoveryAssetId, view: this.active ? model.renderer.getView() : this.sceneView }),
      hasTextureMaps: () => [...this.assetMaps.values()].some(maps => maps.size > 0),
      saveStateChanged: () => model.updateSaveStatus(),
      notify: options.notify,
    })
    options.root.append(this.sceneRoot, this.returnBar)
    this.returnBar.querySelector('button.primary')!.addEventListener('click', () => {
      void this.returnToScene().catch(error => options.notify(error instanceof Error ? error.message : 'Could not return to the scene.'))
    }, { signal: this.lifetime.signal })
    this.returnBar.querySelector('button.secondary')!.addEventListener('click', () => {
      void this.exportScene().catch(error => options.notify(error instanceof Error ? error.message : 'Could not export the scene.'))
    }, { signal: this.lifetime.signal })
  }

  // Renderer activation can change before an async session handoff finishes.
  get active() { return this.sceneVisible }
  get hasScene() { return this.owned }
  get busy() { return this.disposed || this.scene.busy }
  get saveState() { return this.scene.saveState }
  get revision() { return this.active ? this.scene.revision : this.options.model.revision }
  get hasUnsavedChanges() { return this.owned && this.saveState !== 'saved' }
  snapshot() { return this.scene.snapshot() }
  flush() { return this.scene.flush() }
  onViewChange() { if (!this.active) return false; this.scene.viewChanged(); return true }
  onSave(effects?: StudioEffects) { if (!this.owned) return false; this.modelChanged(effects); return true }
  flushOwner() { return this.owned ? this.flush() : undefined }
  ownerSaveStatus() {
    if (!this.owned) return
    return {
      state: this.saveState,
      text: this.saveState === 'saving' ? 'Saving scene...' : this.saveState === 'error' ? 'Scene save failed' : 'Scene recovery saved',
      title: 'Model edits are saved inside the owning scene. Texture images are session-only.',
    }
  }

  async execute(command: RemoteCommand, source: CommandSource, ifRevision?: number, viewVersion?: number): Promise<ModelResult> {
    if (!this.active) return this.options.model.execute(command, source, ifRevision, viewVersion)
    const scene = this.scene, revision = scene.revision, viewport = this.options.model.renderer.viewport
    if (ifRevision !== undefined && ifRevision !== revision) throw new StudioCommandError('revision_conflict', 'The scene changed before this command ran.')
    switch (command.type) {
      case 'state.get': return { changed: false, revision, result: { editor: 'scene', name: scene.snapshot().name, instanceCount: scene.snapshot().instances.length, view: viewport.getView(), streaming: scene.renderer.stats, saveState: scene.saveState } }
      case 'project.snapshot.get': return { changed: false, revision, result: scene.snapshot() }
      case 'view.get': return { changed: false, revision, result: viewport.getView() }
      case 'view.set': viewport.setView(command.view); scene.viewChanged(); return { changed: true, revision, result: viewport.getView() }
      case 'view.frame': scene.renderer.frameSelection(); scene.viewChanged(); return { changed: true, revision, result: viewport.getView() }
      case 'save.flush': await scene.flush(); return { changed: false, revision, result: { saveState: scene.saveState } }
      case 'view.capture': {
        const { blob, view } = await viewport.capture()
        return { changed: false, revision, result: { mime: 'image/png', dataBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), view, revision } }
      }
      default: throw new StudioCommandError('invalid_state', 'This command edits voxels. Select an instance and choose Edit model first.')
    }
  }

  async activate() {
    const restoring = !this.standalone
    if (restoring) await this.restore()
    if (this.hasUnsavedChanges) await this.flush()
    if (this.recoveryAssetId) {
      if (this.editing?.assetId !== this.recoveryAssetId) await this.editAsset(this.recoveryAssetId)
      this.recoveryAssetId = undefined
      return
    }
    if (restoring && this.owned) return
    await this.start()
  }

  private assertAlive() { if (this.disposed) throw new Error('The workspace has been disposed.') }
  setBusy(busy: boolean) {
    if (this.disposed) return
    this.scene.setBusy(busy)
    for (const button of this.returnBar.querySelectorAll('button')) button.disabled = busy
  }
  private showScene(visible: boolean, label?: string) {
    this.assertAlive()
    const context = visible ? 'scene' : this.editing ? 'asset' : 'model'
    const { model, root } = this.options
    model.setVisible(!visible)
    this.sceneVisible = visible
    root.dataset.editor = context
    model.element.dataset.saveOwner = context === 'asset' ? 'scene' : 'model'
    this.returnBar.hidden = context !== 'asset'
    this.returnBar.querySelector('span')!.textContent = label ?? ''
    this.options.contextChanged()
    model.updateSaveStatus()
    model.renderer.viewport.focusViewport()
  }

  async start(includeModel = false) {
    if (this.busy) return
    if (this.owned && this.editing) { await this.returnToScene(); return }
    if (this.active && !includeModel) return
    if (!includeModel && this.standalone && !this.owned) {
      this.setBusy(true)
      try {
        await this.options.model.dispatch({ type: 'save.flush' })
        this.assertAlive()
        this.standalone = this.options.model.currentSession()
        this.owned = this.scene.recoveryEnabled = true
        this.options.model.renderer.setActive(false)
        this.scene.setActive(true); this.showScene(true); this.scene.queueSave(); await this.flush()
      } finally { this.setBusy(false) }
      return
    }
    const current = this.owned ? this.standalone! : this.options.model.currentSession()
    await this.open(createScene(current.controller.settings))
    if (includeModel) {
      this.setBusy(true)
      try {
        const asset = await putSceneAsset(current.controller.document, current.controller.settings, undefined, undefined, current.library)
        this.assertAlive()
        this.scene.document.execute({ type: 'asset.add', asset })
        this.scene.document.execute({ type: 'instance.place', assetId: asset.id, position: { x: 0, y: 0, z: 0 } })
        this.scene.refresh(); this.scene.renderer.frameSelection(); this.scene.queueSave()
        await this.flush()
      } finally { this.setBusy(false) }
    }
  }

  async open(snapshot: SceneManifest, library?: LibraryLink, recovery?: SceneRecoveryContext) {
    if (this.busy) throw new Error('Wait for the current scene operation to finish.')
    const next = new SceneDocument(recovery ? snapshot : { ...snapshot, id: crypto.randomUUID() })
    this.setBusy(true)
    try {
      if (this.owned) await this.flush()
      else { await this.options.model.dispatch({ type: 'save.flush' }); this.standalone = this.options.model.currentSession() }
      this.assertAlive()
      this.options.model.renderer.setActive(false)
      this.scene.replace(next, library, recovery)
      this.editing = undefined; this.child = undefined; this.assetMaps.clear()
      this.recoveryAssetId = recovery?.editingAssetId
      this.sceneView = recovery?.view; this.owned = this.scene.recoveryEnabled = true
      this.scene.setActive(true)
      if (this.sceneView) this.options.model.renderer.viewport.setView(this.sceneView)
      this.showScene(true); this.scene.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
  }

  private async restore() {
    const recovered = await loadSceneRecovery()
    if (!recovered || this.disposed) return
    await this.open(recovered.scene, recovered.context.library, recovered.context)
  }

  private async editAsset(assetId: string) {
    if (this.busy) throw new Error('Wait for the current scene operation to finish.')
    const asset = this.scene.document.assets.get(assetId)
    if (!asset) throw new Error('The selected scene model no longer exists.')
    this.setBusy(true)
    try {
      await this.flush()
      const loaded = this.child?.assetId === assetId ? undefined : await loadSceneAsset(asset)
      this.assertAlive()
      const controller = loaded ? new Studio(loaded.document, loaded.settings) : this.child!.session.controller
      const viewport = this.options.model.renderer.viewport
      this.sceneView = viewport.getView()
      this.scene.setActive(false)
      this.editing = { assetId, controller, changed: false, all: false, dirty: new Set() }
      const session = loaded ? { controller, view: viewport.getView() } : this.child!.session
      const maps = this.assetMaps.get(assetId) ?? session.maps ?? new Map()
      this.assetMaps.set(assetId, maps)
      const count = this.scene.document.data.instances.filter(instance => instance.assetId === assetId).length
      this.showScene(false, `${this.scene.document.data.name} / ${asset.model.name} (${count} shared ${count === 1 ? 'instance' : 'instances'})`)
      await this.options.model.activateSession({ ...session, maps })
      if (loaded) this.options.model.renderer.frameModel()
      this.scene.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
  }

  modelChanged(effects: StudioEffects = {}) {
    if (!this.editing) return
    this.editing.changed = true
    this.editing.all ||= Boolean(effects.documentReplaced)
    for (const id of effects.rawDirtyChunks ?? effects.dirtyChunks ?? []) this.editing.dirty.add(id)
    this.scene.markLibraryDirty()
    this.scene.queueSave()
  }

  private async updateEditingAsset() {
    const editing = this.editing
    if (!editing?.changed) return
    const dirty = editing.dirty, all = editing.all
    editing.changed = false; editing.all = false; editing.dirty = new Set()
    try {
      const asset = await putSceneAsset(editing.controller.document, editing.controller.settings, this.scene.document.assets.get(editing.assetId), all ? undefined : dirty)
      this.scene.updateAsset(asset)
    } catch (error) {
      editing.changed = true; editing.all ||= all
      for (const id of dirty) editing.dirty.add(id)
      throw error
    }
  }

  async exportScene() {
    if (!this.owned || this.busy) return
    this.setBusy(true)
    try { await this.scene.exportScene() } finally { this.setBusy(false) }
  }

  async returnToScene() {
    if (this.busy || !this.editing) return
    this.setBusy(true)
    try {
      await this.options.model.dispatch({ type: 'save.flush' })
      this.assertAlive()
      this.child = { assetId: this.editing.assetId, session: this.options.model.currentSession() }
      this.editing = undefined
      this.options.model.renderer.setActive(false)
      // Release the child's render resources, retaining only its bounded editing session.
      this.options.model.renderer.setDocument(new VoxelDocument())
      this.scene.refresh(); this.scene.setActive(true)
      if (this.sceneView) this.options.model.renderer.viewport.setView(this.sceneView)
      this.showScene(true); this.scene.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
  }

  async leave() {
    if (this.busy || !this.standalone) return
    this.setBusy(true)
    try {
      await this.flush()
      this.assertAlive()
      this.scene.setActive(false)
      this.owned = this.scene.recoveryEnabled = false; this.editing = undefined
      this.recoveryAssetId = undefined
      await this.options.model.activateSession(this.standalone)
      this.showScene(false)
    } finally { this.setBusy(false) }
  }

  async dispose() {
    if (this.disposed) return
    await this.scene.dispose()
    this.disposed = true; this.assetMaps.clear()
    this.lifetime.abort(); this.sceneRoot.remove(); this.returnBar.remove()
  }
}
