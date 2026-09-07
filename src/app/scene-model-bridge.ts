import { VoxelDocument } from '../shared/voxel/document'
import { Studio, type StudioEffects } from '../editors/model/studio'
import { SceneDocument, createScene } from '../editors/scene/document'
import { deactivateSceneRecovery, loadSceneAsset, loadSceneRecovery, putSceneAsset } from '../editors/scene/storage'
import type { SceneManifest, SceneRecoveryContext } from '../editors/scene/types'
import type { LibraryLink } from '../shared/library/types'
import type { CameraSnapshot } from '../shared/rendering/contracts'
import { SceneEditor } from '../editors/scene/editor'
import type { ModelEditor, ModelSession } from '../editors/model/editor'

interface BridgeOptions {
  model: ModelEditor
  sceneRoot: HTMLElement
  keyboardRoot: HTMLElement
  contextChanged(context: 'model' | 'scene' | 'asset', label?: string): void
  busyChanged(busy: boolean): void
  notify(message: string): void
}

/** App composition owns transitions and save ownership, not either editor's history. */
export class SceneModelBridge {
  readonly scene: SceneEditor
  private standalone?: ModelSession
  private child?: { assetId: string; session: ModelSession }
  private editing?: { assetId: string; controller: Studio; changed: boolean; all: boolean; dirty: Set<number> }
  private sceneView?: CameraSnapshot
  private assetMaps = new Map<string, NonNullable<ModelSession['maps']>>()
  private owned = false
  private disposed = false
  private options: BridgeOptions

  constructor(options: BridgeOptions) {
    this.options = options
    const { model } = options
    this.scene = new SceneEditor(options.sceneRoot, {
      viewport: model.renderer.viewport,
      settings: model.currentSession().controller.settings,
      keyboardRoot: options.keyboardRoot,
      active: false,
      recoveryEnabled: false,
      editAsset: id => this.editAsset(id),
      openScene: (snapshot, library) => this.open(snapshot, library),
      leaveScene: () => this.leave(),
      beforeSave: () => this.updateEditingAsset(),
      recoveryContext: () => ({ editingAssetId: this.editing?.assetId, view: this.active ? model.renderer.getView() : this.sceneView }),
      hasTextureMaps: () => [...this.assetMaps.values()].some(maps => maps.size > 0),
      saveStateChanged: () => model.updateSaveStatus(),
      notify: options.notify,
    })
  }

  get active() { return this.scene.active }
  get hasScene() { return this.owned }
  get busy() { return this.disposed || this.scene.busy }
  get saveState() { return this.scene.saveState }
  get revision() { return this.scene.revision }
  snapshot() { return this.scene.snapshot() }
  flush() { return this.scene.flush() }
  viewChanged() { this.scene.viewChanged() }

  private assertAlive() { if (this.disposed) throw new Error('The workspace has been disposed.') }
  private setBusy(busy: boolean) { if (!this.disposed) { this.scene.setBusy(busy); this.options.busyChanged(busy) } }
  private showScene(visible: boolean, label?: string) {
    this.assertAlive()
    this.options.model.setVisible(!visible)
    this.options.contextChanged(visible ? 'scene' : this.editing ? 'asset' : 'model', label)
  }

  async start(includeModel = false) {
    if (this.busy) return
    if (this.owned && this.editing) { await this.returnToScene(); return }
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
    const current = this.options.model.currentSession()
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
      this.sceneView = recovery?.view; this.owned = this.scene.recoveryEnabled = true
      this.scene.setActive(true)
      if (this.sceneView) this.options.model.renderer.viewport.setView(this.sceneView)
      this.showScene(true); this.scene.queueSave(); await this.flush()
    } finally { this.setBusy(false) }
  }

  async restore() {
    const recovered = await loadSceneRecovery()
    if (!recovered || this.disposed) return
    await this.open(recovered.scene, recovered.context.library, recovered.context)
    if (recovered.context.editingAssetId) await this.editAsset(recovered.context.editingAssetId)
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
    for (const id of effects.dirtyChunks ?? []) this.editing.dirty.add(id)
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
      await deactivateSceneRecovery()
      this.assertAlive()
      this.owned = this.scene.recoveryEnabled = false; this.editing = undefined
      await this.options.model.activateSession(this.standalone)
      this.showScene(false)
    } finally { this.setBusy(false) }
  }

  async dispose() {
    if (this.disposed) return
    await this.scene.dispose()
    this.disposed = true; this.assetMaps.clear()
  }
}
