import { expect, mock, spyOn, test } from 'bun:test'
import type { AssistantHost } from '../../plugins/assistant/shared'
import type { VoxelDocument } from '../shared/voxel/document'
import type { RemoteCommand } from '../editors/model/protocol'
import type { CameraSnapshot } from '../shared/rendering/contracts'
import type { SceneRecoveryContext, SceneManifest } from '../editors/scene/types'
import type { SceneUIHost } from '../editors/scene/ui'
import type { StoredProject } from '../editors/model/storage'
import { DEFAULT_SETTINGS } from '../shared/rendering/settings'
import type { AuxiliaryTool, PaintMode, PbrMap, SelectionState, Tool } from '../editors/model/studio'

const cases = [
  'shared model edits return to every instance without changing the standalone session',
  'latest autosave survives an in-flight save and restores child and scene context',
  'resume and return reject late commands and queued commands cannot cross editors',
  'PBR maps survive another asset hydration and cleared maps stay cleared',
  'delayed VOX and texture reads cannot change a different editor',
  'failed child recovery is visible and retry retains the edited voxels',
  'each editor mounts without the other editor and disposal removes its listeners',
  'autosave timers respect changed persistence owners and handle rejected saves',
  'application teardown drains accepted commands and failed saves retain an editable UI',
  'model effects synchronize tools once and reuse layer counts for metadata only',
  'visibility saves reuse raw chunks without losing pending voxel edits',
  'model palette retains regrouped operations and Select clicks clear selection',
] as const

for (const name of cases) {
  if (process.env.SCENE_WORKSPACE_CASE && process.env.SCENE_WORKSPACE_CASE !== name) continue
  test(name, async () => {
    if (process.env.SCENE_WORKSPACE_CASE) return integration(name)
    // Bun module mocks are process-global. Never install these doubles in the shared test runner.
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, SCENE_WORKSPACE_CASE: name, VITE_CANVAS_ASSISTANT: 'true' },
      stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(12_000),
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stdout + stderr).toBe(0)
  }, 15_000)
}

function gate() {
  return { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
}

async function integration(name: typeof cases[number]) {
  const { VoxelDocument } = await import('../shared/voxel/document')
  const { encodeProjectSnapshot } = await import('../shared/voxel/snapshot')
  const { PROTOCOL } = await import('../editors/model/protocol')
  const storage = { ...await import('../editors/model/storage') }
  const sceneStorage = { ...await import('../editors/scene/storage') }
  const settings = { ...DEFAULT_SETTINGS, pathTracing: false }
  const original = new VoxelDocument(undefined, 'Standalone')
  original.setVoxel(1, 1, 1, 5)
  let standalone = storage.snapshotProject(original, settings, { id: 'source', version: 1, tags: ['test'], dirty: false })
  let recovery: { scene: SceneManifest; context: SceneRecoveryContext } | undefined
  const recoveryPauses: ReturnType<typeof gate>[] = []
  let modelPause: ReturnType<typeof gate> | undefined
  let capturePause: ReturnType<typeof gate> | undefined
  let texturePause: ReturnType<typeof gate> | undefined
  let storageFailure = false
  let modelFailure = false
  let standaloneWrites = 0
  const disposedAdapters: string[] = []

  // Only the browser storage boundary is fake: asset hashing, dirty-chunk reuse and hydration are real.
  const blobs = new Map<unknown, unknown>()
  const request = (value: unknown) => {
    const result = { result: structuredClone(value), onsuccess: undefined as (() => void) | undefined }
    queueMicrotask(() => result.onsuccess?.())
    return result
  }
  const db = {
    transaction() {
      const tx = {
        oncomplete: undefined as (() => void) | undefined,
        objectStore: () => ({ get: (key: unknown) => request(blobs.get(key)), put: (value: unknown, key: unknown) => blobs.set(key, structuredClone(value)) }),
      }
      setTimeout(() => tx.oncomplete?.(), 0)
      return tx
    },
  }
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => {
    const result = { result: db, onsuccess: undefined as (() => void) | undefined }
    queueMicrotask(() => result.onsuccess?.())
    return result
  } } })
  mock.module('../editors/model/storage', () => ({
    ...storage,
    loadProject: async () => storage.restoreProjectSnapshot(structuredClone(standalone)),
    saveProjectSnapshot: async (snapshot: StoredProject) => {
      const captured = structuredClone(snapshot), pause = modelPause
      modelPause = undefined
      if (pause) { pause.entered.resolve(); await pause.release.promise }
      if (modelFailure) throw new Error('Model quota exceeded')
      standalone = captured; standaloneWrites++
    },
  }))
  mock.module('../editors/scene/storage', () => ({
    ...sceneStorage,
    loadSceneRecovery: async () => structuredClone(recovery),
    deactivateSceneRecovery: async () => { recovery = undefined },
    saveSceneDocumentRecovery: async (scene: import('../editors/scene/document').SceneDocument, context: SceneRecoveryContext) => {
      const captured = structuredClone({ scene: scene.snapshot(), context }), pause = recoveryPauses.shift()
      if (pause) { pause.entered.resolve(); await pause.release.promise }
      if (storageFailure) throw new Error('Recovery quota exceeded')
      recovery = captured
    },
  }))

  // This is a control/event surface, not a layout engine. The mounted app runs its real handlers.
  class ElementStub {
    dataset: Record<string, string> = {}
    style = {}
    classList = { add() {} }
    value = ''
    textContent = ''
    innerHTML = ''
    hidden = false
    inert = false
    disabled = false
    files: Pick<File, 'name' | 'type' | 'arrayBuffer'>[] = []
    children: ElementStub[] = []
    nodes = new Map<string, ElementStub>()
    listeners = new Map<string, ((event: unknown) => unknown)[]>()
    elements = { namedItem: (name: string) => this.querySelector(name) }
    readonly tag: string
    get ownerDocument(): ElementStub { return dom }
    constructor(tag = '') { this.tag = tag }
    querySelector(selector: string): ElementStub {
      const child = this.children.find(child => child.tag === selector)
      if (child) return child
      if (!this.nodes.has(selector)) this.nodes.set(selector, new ElementStub(selector))
      return this.nodes.get(selector)!
    }
    querySelectorAll(selector: string) {
      return selector === '.tool-dock, .context-dock' ? [this.querySelector('.tool-dock'), this.querySelector('.context-dock')] : []
    }
    addEventListener(type: string, listener: (event: unknown) => unknown, options?: { signal?: AbortSignal }) {
      this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
      options?.signal?.addEventListener('abort', () => { this.listeners.set(type, this.listeners.get(type)?.filter(item => item !== listener) ?? []) }, { once: true })
    }
    async emit(type: string, event: unknown = { target: this }) { await Promise.all(this.listeners.get(type)?.map(listener => listener(event)) ?? []) }
    append(...children: ElementStub[]) { this.children.push(...children) }
    matches() { return false }
    contains() { return false }
    setAttribute() {}
    remove() {}
    replaceChildren(...children: ElementStub[]) { this.nodes.clear(); this.children = children }
    hidePopover() {}
  }
  const dom = Object.assign(new ElementStub(), { activeElement: null, defaultView: new ElementStub(), createElement: (tag: string) => new ElementStub(tag) })
  Object.assign(globalThis, {
    document: dom, window: new ElementStub(),
    HTMLElement: ElementStub, HTMLButtonElement: ElementStub, HTMLInputElement: ElementStub, HTMLSelectElement: ElementStub, HTMLTextAreaElement: ElementStub,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, confirm: () => true,
    localStorage: { getItem: () => null, setItem() {} },
  })
  class RendererStub {
    viewport = this
    document = original
    view: CameraSnapshot = { projection: 'orthographic', position: { x: 50, y: 40, z: 50 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, orthographicSpan: 64, viewport: { width: 800, height: 600 } }
    maps = new Map<string, Blob>()
    renderMode = false
    canvas = new ElementStub('canvas')
    getView() { return structuredClone(this.view) }
    setView(view: CameraSnapshot) { this.view = structuredClone(view) }
    getSceneViewport() { return { renderMode: this.renderMode, canvas: this.canvas } }
    setDocument(document: VoxelDocument) { this.document = document; this.maps.clear() }
    setRenderMode(enabled: boolean) { this.renderMode = enabled }
    setActive() {}
    focusViewport() {}
    dispose() { disposedAdapters.push('model') }
    async setPbrMap(index: number, map: PbrMap, blob: Blob) {
      const pause = texturePause
      texturePause = undefined
      if (pause) { pause.entered.resolve(); await pause.release.promise }
      this.maps.set(`${index}:${map}`, blob)
    }
    clearPbrMaps(index: number, map?: PbrMap) { for (const key of this.maps.keys()) if (map ? key === `${index}:${map}` : key.startsWith(`${index}:`)) this.maps.delete(key) }
    async capture() {
      const pause = capturePause
      capturePause = undefined
      if (pause) { pause.entered.resolve(); await pause.release.promise }
      return { blob: new Blob(['png']), view: this.getView() }
    }
    frameModel() { this.view.position.x += 10 }
    meshState() { return { pending: 0 } }
    setSettings() {}
    setActiveColor() {}
    setToolState = mock((_tool: Tool, _paintMode: PaintMode, _auxiliary?: AuxiliaryTool) => {})
    refreshLayerScope = mock(() => {})
    setSculptMode() {}
    setSelectionMode() {}
    setFillShape() {}
    setFillDepth() {}
    applySelection = mock((_selection: SelectionState, _focus?: boolean) => {})
    markDirty() {}
    updatePalette() {}
    updatePaletteMaterial() {}
  }
  let renderer!: RendererStub
  mock.module('../editors/model/renderer', () => ({ VoxelRenderer: class extends RendererStub { constructor(_host: unknown, document: VoxelDocument) { super(); this.document = document; renderer = this } } }))
  mock.module('../editors/scene/renderer', () => ({ SceneRenderer: class {
    stats = {}
    setActive() {}
    setDocument() {}
    refresh() {}
    frameSelection() { renderer.frameModel() }
    dispose() { disposedAdapters.push('scene') }
  } }))
  let ui!: SceneUIHost
  mock.module('../editors/scene/ui', () => ({ mountSceneUI: (_root: HTMLElement, host: SceneUIHost) => {
    ui = host
    return { element: new ElementStub(), setVisible() {}, setBusy() {}, render() {}, setSaveState() {}, dispose() {} }
  } }))
  let library!: Parameters<typeof import('../editors/model/library').mountModelLibrary>[1]
  mock.module('../editors/model/library', () => ({ mountModelLibrary: (_root: HTMLElement, host: typeof library) => { library = host; return { close() {}, dispose() {} } } }))
  let remote!: Parameters<typeof import('./remote').connectRemote>[0]
  let remoteDisconnected = false
  mock.module('./remote', () => ({ connectRemote: (host: typeof remote) => { remote = host; return () => { remoteDisconnected = true } } }))
  const assistantReady = Promise.withResolvers<AssistantHost>()
  mock.module('../../plugins/assistant/client', () => ({ mountAssistant: (host: AssistantHost) => { assistantReady.resolve(host); return () => {} } }))
  const { mountApplication } = await import('./application')
  let application = await mountApplication(dom as unknown as HTMLElement)
  let workspace = application.bridge
  const currentModel = () => application.model.currentSession()
  const modelNode = (selector: string) => dom.querySelector('.studio').querySelector('.model-root').querySelector(selector)
  const assistant = await assistantReady.promise
  const dispatch = (command: RemoteCommand) => remote.dispatch({ protocol: PROTOCOL, id: crypto.randomUUID(), command })
  const state = async () => (await dispatch({ type: 'state.get' })).result as ReturnType<import('../editors/model/studio').Studio['stateSnapshot']> & { saveState: string }
  const edit = (x: number, color = 6) => dispatch({ type: 'edit.setVoxels', voxels: [{ x, y: 1, z: 1, color }] })
  const enter = () => ui.editModel(workspace.snapshot().instances[0].id)
  const savedModel = async () => (await sceneStorage.loadSceneAsset(recovery!.scene.assets[0])).document

  try {
    if (name === cases[0]) {
      await edit(2)
      await dispatch({ type: 'selection.set', cells: [{ x: 2, y: 1, z: 1 }] })
      await dispatch({ type: 'tool.set', tool: 'sculpt' })
      await dispatch({ type: 'tool.sculptMode', mode: 'move' })
      await dispatch({ type: 'renderMode.set', enabled: true })
      expect(modelNode('.tool-dock').inert).toBe(true)
      const before = currentModel(), standaloneSnapshot = encodeProjectSnapshot(before.controller.document, before.controller.settings)
      const beforeState = before.controller.stateSnapshot()
      await workspace.start(true)
      const assetId = workspace.snapshot().assets[0].id
      await ui.command({ type: 'instance.place', assetId, position: { x: 100, y: 0, z: 0 } })
      await enter(); await edit(17)
      expect(modelNode('.tool-dock').inert).toBe(false)
      expect(modelNode('.context-dock').inert).toBe(false)
      const child = currentModel().controller
      await workspace.returnToScene()
      expect(workspace.snapshot().instances.map(instance => instance.assetId)).toEqual([assetId, assetId])
      expect((await savedModel()).getVoxel(17, 1, 1)).toBe(6)
      await enter()
      expect(currentModel().controller).toBe(child)
      await dispatch({ type: 'history.undo' }); await workspace.returnToScene()
      expect((await savedModel()).getVoxel(17, 1, 1)).toBe(0)
      await ui.leaveScene()
      expect(currentModel().controller).toBe(before.controller)
      expect(modelNode('.tool-dock').inert).toBe(true)
      expect(modelNode('.context-dock').inert).toBe(true)
      expect((await state()).editor).toEqual(beforeState.editor)
      expect(renderer.getView()).toEqual(before.view)
      expect(encodeProjectSnapshot(renderer.document, before.controller.settings)).toEqual(standaloneSnapshot)
      expect(storage.restoreProjectSnapshot(standalone)!.document.getVoxel(17, 1, 1)).toBe(0)
      expect(standalone.library).toEqual({ id: 'source', version: 1, tags: ['test'], dirty: true })
    } else if (name === cases[1]) {
      await workspace.start(true)
      ui.frame()
      const sceneView = renderer.getView(), selection = [...ui.current().scene.selection]
      expect(workspace.saveState).toBe('saving')
      await enter()
      const first = gate(), second = gate()
      recoveryPauses.push(first, second)
      await edit(2)
      await first.entered.promise // Exercise the real 420 ms autosave, not just explicit flush.
      await edit(17, 12)
      const latest = workspace.flush()
      first.release.resolve(); await second.entered.promise
      expect(workspace.saveState).toBe('saving')
      expect(modelNode('#save-status').dataset.state).toBe('saving')
      second.release.resolve(); await latest
      expect((await savedModel()).getVoxel(2, 1, 1)).toBe(6)
      expect((await savedModel()).getVoxel(17, 1, 1)).toBe(12)
      expect(recovery!.context).toMatchObject({ editingAssetId: workspace.snapshot().assets[0].id, selection, view: sceneView })
      expect((await state()).saveState).toBe('saved')
      const previousWorkspace = workspace
      await application.dispose()
      application = await mountApplication(dom as unknown as HTMLElement)
      workspace = application.bridge
      expect(workspace).not.toBe(previousWorkspace)
      expect(workspace.active).toBe(false)
      expect(renderer.document.getVoxel(17, 1, 1)).toBe(12)
      await workspace.returnToScene()
      expect(ui.current().scene.selection).toEqual(selection)
      expect(renderer.getView()).toEqual(sceneView)
      await dispatch({ type: 'view.frame' })
      expect(workspace.saveState).toBe('saving')
      await workspace.flush()
      expect(recovery!.context.view).toEqual(renderer.getView())
    } else if (name === cases[2]) {
      await workspace.start(true); await ui.leaveScene(); await edit(2)
      const pause = modelPause = gate(), resuming = workspace.start()
      await pause.entered.promise
      expect(workspace.busy).toBe(true)
      await expect(application.dispose()).rejects.toMatchObject({ code: 'invalid_state' })
      expect(disposedAdapters).toEqual([])
      // A completed server save can update its link while the standalone flush is awaiting storage.
      library.link({ id: 'source', version: 2, tags: ['late-save'], dirty: false })
      const refused = edit(3).then(() => undefined, error => error)
      pause.release.resolve(); await resuming
      expect(await refused).toMatchObject({ code: 'invalid_state' })
      expect(standalone.library).toEqual({ id: 'source', version: 2, tags: ['late-save'], dirty: false })
      const savedStandalone = structuredClone(standalone), writes = standaloneWrites
      const capturing = capturePause = gate()
      const capture = dispatch({ type: 'view.capture' })
      await capturing.entered.promise
      const stale = edit(4).then(() => undefined, error => error)
      await enter()
      capturing.release.resolve(); await capture
      expect(await stale).toMatchObject({ code: 'revision_conflict' })
      expect(renderer.document.getVoxel(4, 1, 1)).toBe(0)
      const saving = gate()
      recoveryPauses.push(saving)
      const returning = workspace.returnToScene()
      await saving.entered.promise
      const late = assistant.execute({ type: 'document.rename', name: 'Late edit' }, { signal: new AbortController().signal, ifRevision: currentModel().controller.revision }).then(() => undefined, error => error)
      saving.release.resolve(); await returning
      expect(await late).toMatchObject({ code: 'invalid_state' })
      await new Promise(resolve => setTimeout(resolve, 450))
      expect(standaloneWrites).toBe(writes)
      expect(standalone).toEqual(savedStandalone)
      expect(recovery!.scene.assets[0].model.name).toBe('Standalone')
    } else if (name === cases[3]) {
      await workspace.start(true); await enter()
      const map: Extract<RemoteCommand, { type: 'material.map.set' }> = { type: 'material.map.set', index: 5, map: 'map', name: 'albedo.png', mime: 'image/png', dataBase64: btoa('image bytes') }
      await dispatch(map); await workspace.returnToScene()
      await ui.insertModel(encodeProjectSnapshot(new VoxelDocument(undefined, 'B'), settings))
      await workspace.returnToScene()
      const hydration = texturePause = gate(), entering = enter()
      await hydration.entered.promise
      await expect(application.dispose()).rejects.toMatchObject({ code: 'invalid_state' })
      await expect(application.model.dispose()).rejects.toMatchObject({ code: 'invalid_state' })
      hydration.release.resolve(); await entering
      expect(await renderer.maps.get('5:map')!.text()).toBe('image bytes')
      expect((await state()).palette.find(color => color.index === 5)!.maps).toEqual({ map: 'albedo.png' })
      await dispatch({ type: 'material.map.clear', index: 5 })
      await workspace.returnToScene()
      const b = workspace.snapshot().instances.find(instance => instance.assetId !== workspace.snapshot().assets[0].id)!
      await ui.editModel(b.id); await workspace.returnToScene(); await enter()
      expect(renderer.maps.size).toBe(0)
      expect((await state()).palette.find(color => color.index === 5)!.maps).toEqual({})
    } else if (name === cases[4]) {
      await workspace.start(true); await enter()
      const voxRead = Promise.withResolvers<ArrayBuffer>(), textureRead = Promise.withResolvers<ArrayBuffer>()
      const { exportVox } = await import('../shared/voxel/vox')
      const replacement = new VoxelDocument(undefined, 'Wrong model')
      replacement.setVoxel(9, 9, 9, 12)
      const file = modelNode('#file-input')
      file.files = [{ name: 'wrong.vox', type: '', arrayBuffer: () => voxRead.promise }]
      const importing = file.emit('change')
      const texture = new ElementStub('input')
      texture.dataset.pbrMap = 'map'
      texture.files = [{ name: 'wrong.png', type: 'image/png', arrayBuffer: () => textureRead.promise }]
      await modelNode('[data-panel="palette"]').emit('input', { target: texture })
      expect(texture.disabled).toBe(true)
      await workspace.returnToScene()
      await ui.insertModel(encodeProjectSnapshot(new VoxelDocument(undefined, 'Different editor'), settings))
      const before = encodeProjectSnapshot(renderer.document, settings)
      voxRead.resolve(exportVox(replacement)); textureRead.resolve(new ArrayBuffer(1))
      await importing
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(encodeProjectSnapshot(renderer.document, settings)).toEqual(before)
      expect(renderer.maps.size).toBe(0)
      expect(texture.disabled).toBe(false)
      // The same file handlers still work when their captured editor stays current.
      await file.emit('change')
      expect(renderer.document.getVoxel(9, 9, 9)).toBe(12)
      await modelNode('[data-panel="palette"]').emit('input', { target: texture })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(renderer.maps.size).toBe(1)
    } else if (name === cases[5]) {
      await workspace.start(true); await enter()
      const saved = structuredClone(recovery)
      storageFailure = true
      await edit(17)
      await expect(dispatch({ type: 'save.flush' })).rejects.toThrow('Recovery quota exceeded')
      expect(workspace.saveState).toBe('error')
      expect(modelNode('#save-status').dataset.state).toBe('error')
      expect((await state()).saveState).toBe('error')
      expect(recovery).toEqual(saved)
      await expect(workspace.returnToScene()).rejects.toThrow('Recovery quota exceeded')
      await expect(application.dispose()).rejects.toThrow('Recovery quota exceeded')
      expect(dom.querySelector('.studio').inert).toBe(false)
      expect(workspace.busy).toBe(false)
      expect(disposedAdapters).toEqual([])
      expect(workspace.active).toBe(false)
      expect(renderer.document.getVoxel(17, 1, 1)).toBe(6)
      storageFailure = false
      await edit(3)
      await workspace.flush()
      expect(modelNode('#save-status').dataset.state).toBe('saved')
      expect((await savedModel()).getVoxel(17, 1, 1)).toBe(6)
      await workspace.returnToScene()
      expect(workspace.active).toBe(true)
      ui.command({ type: 'scene.rename', name: 'Saved on scene teardown' })
      await application.dispose()
      expect(recovery!.scene.name).toBe('Saved on scene teardown')
      expect(disposedAdapters).toEqual(['scene', 'model'])
    } else if (name === cases[6]) {
      await application.dispose()
      const { mountModelEditor } = await import('../editors/model/editor')
      const root = new ElementStub()
      const model = await mountModelEditor(root as unknown as HTMLElement)
      await model.dispatch({ type: 'document.rename', name: 'Independent model' })
      expect(model.currentSession().controller.document.name).toBe('Independent model')
      const nameInput = root.querySelector('#project-name')
      await model.dispose()
      expect(standalone.name).toBe('Independent model')
      expect(nameInput.listeners.get('input')).toEqual([])
      expect(root.listeners.get('keydown')).toEqual([])
      await expect(model.dispatch({ type: 'state.get' })).rejects.toMatchObject({ code: 'invalid_state' })

      const { SceneEditor } = await import('../editors/scene/editor')
      const modelBeforeSceneMount = renderer
      const viewport = new RendererStub()
      const scene = new SceneEditor(new ElementStub() as unknown as HTMLElement, {
        viewport: viewport as unknown as import('../shared/rendering/viewport').Viewport,
        settings, notify() {},
      })
      scene.command({ type: 'scene.rename', name: 'Independent scene' })
      const saving = gate()
      recoveryPauses.push(saving)
      const closing = scene.dispose()
      expect(scene.dispose()).toBe(closing)
      await saving.entered.promise
      expect(viewport.canvas.inert).toBe(true)
      expect(() => scene.command({ type: 'scene.rename', name: 'Late edit' })).toThrow()
      storageFailure = true
      saving.release.resolve()
      await expect(closing).rejects.toThrow('Recovery quota exceeded')
      expect(scene.active).toBe(true)
      expect(scene.busy).toBe(false)
      expect(viewport.canvas.inert).toBe(false)
      storageFailure = false
      scene.command({ type: 'scene.rename', name: 'Independent scene retry' })
      await scene.dispose()
      expect(recovery!.scene.name).toBe('Independent scene retry')
      await scene.dispose()
      expect(renderer).toBe(modelBeforeSceneMount)
      expect(() => scene.command({ type: 'scene.rename', name: 'Disposed scene' })).toThrow()
    } else if (name === cases[7]) {
      await application.dispose()
      const { mountModelEditor } = await import('../editors/model/editor')
      const { Studio } = await import('../editors/model/studio')
      let owned = false, ownerFailure = false, ownerFlushes = 0
      const notices: string[] = []
      const root = new ElementStub()
      const model = await mountModelEditor(root as unknown as HTMLElement, {
        onSave: () => owned,
        flushOwner() {
          if (!owned) return
          ownerFlushes++
          return ownerFailure ? Promise.reject(new Error('Owner quota exceeded')) : Promise.resolve()
        },
        notify: message => notices.push(message),
      })
      const saved = structuredClone(standalone), writes = standaloneWrites
      await model.dispatch({ type: 'document.rename', name: 'Pending standalone timer' })
      owned = true
      await model.activateSession({ controller: new Studio(new VoxelDocument(undefined, 'Scene child'), settings), view: renderer.getView() })
      await new Promise(resolve => setTimeout(resolve, 450))
      expect(ownerFlushes).toBe(1)
      expect(standaloneWrites).toBe(writes)
      expect(standalone).toEqual(saved)

      owned = false
      await model.dispatch({ type: 'document.rename', name: 'Another pending timer' })
      owned = ownerFailure = true
      await new Promise(resolve => setTimeout(resolve, 450))
      expect(notices).toContain('Owner quota exceeded')
      expect(standalone).toEqual(saved)

      owned = ownerFailure = false
      modelFailure = true
      await model.dispatch({ type: 'document.rename', name: 'Retry standalone autosave' })
      await new Promise(resolve => setTimeout(resolve, 450))
      expect(model.saveState).toBe('error')
      expect(notices).toContain('Model quota exceeded')
      const saving = modelPause = gate(), closing = model.dispose()
      expect(model.dispose()).toBe(closing)
      await saving.entered.promise
      expect(root.inert).toBe(true)
      await expect(model.dispatch({ type: 'document.rename', name: 'Late model edit' })).rejects.toMatchObject({ code: 'invalid_state' })
      saving.release.resolve()
      await expect(closing).rejects.toThrow('Model quota exceeded')
      expect(root.inert).toBe(false)
      await model.dispatch({ type: 'document.rename', name: 'Retry standalone autosave' })
      modelFailure = false
      await model.dispose()
      expect(standalone.name).toBe('Retry standalone autosave')
    } else if (name === cases[9]) {
      const counts = () => [...modelNode('#layer-list').innerHTML.matchAll(/<small>(\d+) voxels?<\/small>/g)].map(match => Number(match[1]))
      expect(counts()).toEqual([1])
      expect(renderer.setToolState.mock.calls).toEqual([['select', 'paint', undefined]])
      const scans = spyOn(VoxelDocument.prototype, 'forEachVoxel')
      try {
        for (const command of [
          { type: 'document.rename', name: 'Metadata only' },
          { type: 'layer.create' },
          { type: 'layer.rename', id: 2, name: 'Upper' },
          { type: 'layer.activate', id: 1 },
          { type: 'layer.visibility', id: 2, visible: false },
          { type: 'layer.visibility', id: 2, visible: true },
          { type: 'layer.lock', id: 2, locked: true },
          { type: 'layer.lock', id: 2, locked: false },
        ] satisfies RemoteCommand[]) await dispatch(command)
        expect(renderer.refreshLayerScope).toHaveBeenCalledTimes(7)
        expect(renderer.applySelection).toHaveBeenLastCalledWith({ cells: [], count: 0 }, false)
        expect(counts()).toEqual([0, 1])

        for (const command of [
          { type: 'tool.set', tool: 'paint' },
          { type: 'tool.auxiliary', tool: 'pick' },
          { type: 'tool.paintMode', mode: 'fill' },
          { type: 'tool.auxiliary', tool: 'pick' },
          { type: 'tool.set', tool: 'select' },
          { type: 'tool.set', tool: 'select' },
          { type: 'selection.set', cells: [{ x: 1, y: 1, z: 1 }] },
          { type: 'clipboard.copy' },
          { type: 'tool.auxiliary', tool: 'pick' },
          { type: 'clipboard.paste.begin' },
          { type: 'clipboard.paste.cancel' },
        ] satisfies RemoteCommand[]) await dispatch(command)
        expect(renderer.setToolState.mock.calls.slice(1)).toEqual([
          ['paint', 'paint', undefined], ['paint', 'paint', 'pick'], ['paint', 'fill', undefined], ['paint', 'fill', 'pick'],
          ['select', 'fill', undefined], ['select', 'fill', undefined], ['select', 'fill', 'pick'], ['sculpt', 'fill', 'pick'],
        ])
        expect(renderer.refreshLayerScope).toHaveBeenCalledTimes(7)
        expect(scans).not.toHaveBeenCalled()

        await edit(2)
        expect(counts()).toEqual([0, 2])
        await dispatch({ type: 'history.undo' })
        expect(counts()).toEqual([0, 1])
        await dispatch({ type: 'history.redo' })
        expect(counts()).toEqual([0, 2])
        expect(renderer.refreshLayerScope).toHaveBeenCalledTimes(9)
        expect(scans).toHaveBeenCalledTimes(3)

        const { Studio } = await import('../editors/model/studio')
        const replacement = new VoxelDocument()
        replacement.createLayer()
        replacement.setVoxel(1, 1, 1, 5); replacement.setVoxel(2, 1, 1, 6)
        const controller = new Studio(replacement, settings)
        controller.execute({ type: 'tool.set', tool: 'paint' })
        controller.execute({ type: 'tool.paintMode', mode: 'fill' })
        controller.execute({ type: 'tool.auxiliary', tool: 'pick' })
        const toolCalls = renderer.setToolState.mock.calls.length
        await application.model.activateSession({ controller, view: renderer.getView() })
        expect(renderer.setToolState.mock.calls.slice(toolCalls)).toEqual([['paint', 'fill', 'pick']])
        expect(counts()).toEqual([2, 0])
        expect(scans).toHaveBeenCalledTimes(4)
        await dispatch({ type: 'layer.delete', id: 2, allowNonEmpty: true })
        await dispatch({ type: 'layer.create' })
        expect(counts()).toEqual([0, 0])
        expect(scans).toHaveBeenCalledTimes(5)
        await dispatch({ type: 'document.new' })
        expect(counts()).toEqual([0])
        expect(scans).toHaveBeenCalledTimes(6)
      } finally { scans.mockRestore() }
    } else if (name === cases[10]) {
      await workspace.start(true); await enter()
      const before = recovery!.scene.assets[0]
      const hashes = spyOn(crypto.subtle, 'digest')
      try {
        await dispatch({ type: 'layer.visibility', id: 1, visible: false })
        await workspace.flush()
        expect(hashes).not.toHaveBeenCalled()
        expect(recovery!.scene.assets[0].chunks).toEqual(before.chunks)
        expect(recovery!.scene.assets[0].model.layers[0].visible).toBe(false)

        await dispatch({ type: 'layer.visibility', id: 1, visible: true })
        await edit(2)
        await dispatch({ type: 'layer.visibility', id: 1, visible: false })
        await workspace.flush()
        expect(hashes).toHaveBeenCalledTimes(2) // Asset hash plus the blob store's integrity check.
        const saved = await savedModel()
        expect(saved.getLayerVoxel(2, 1, 1)).toBe(6)
        expect(saved.activeLayer.visible).toBe(false)
      } finally { hashes.mockRestore() }
    } else if (name === cases[11]) {
      const root = dom.querySelector('.studio').querySelector('.model-root')
      const click = async (selector: string, dataset: Record<string, string>) => {
        const target = Object.assign(new ElementStub(), { dataset, closest: (query: string): ElementStub | null => query === selector ? target : null })
        await root.emit('click', { target, detail: 1 })
        await state() // Drain the real command queue before checking the control state.
      }
      const choose = (tool: Tool) => click('button[data-tool]', { tool })
      const mode = (sculptMode: string) => click('[data-sculpt-mode]', { sculptMode })
      const controller = currentModel().controller
      const cells = [{ x: 1, y: 1, z: 1 }]
      await dispatch({ type: 'selection.set', cells })
      await mode('move')
      await mode('erase')
      expect(controller.activeTool).toBe('sculpt')
      expect(controller.sculptMode).toBe('erase')
      expect(modelNode('#context-title').textContent).toBe('Volume')
      expect(modelNode('#paint-tool-mode').textContent).toBe('Erase')
      expect(modelNode('#sculpt-tool-mode').textContent).toBe('Move')
      await choose('sculpt')
      expect(controller.sculptMode).toBe('move')
      await choose('paint')
      expect(controller.sculptMode).toBe('erase')
      expect(controller.selection.count).toBe(1)
      await click('[data-selection-mode]', { selectionMode: 'body' })
      expect(controller.selection.count).toBe(1)
      await choose('select')
      expect(controller.selection.count).toBe(0)
      expect(controller.selectionMode).toBe('body')
      expect(controller.activeTool).toBe('select')
      await choose('paint')
      expect(controller.sculptMode).toBe('erase')
      await click('[data-auxiliary]', { auxiliary: 'pick' })
      expect(controller.auxiliaryTool).toBe('pick')
      expect(modelNode('#paint-tool-mode').textContent).toBe('Eyedropper')
      await dispatch({ type: 'tool.auxiliary' })
      expect(modelNode('#paint-tool-mode').textContent).toBe('Erase')
      await click('[data-paint-mode]', { paintMode: 'fill' })
      expect(controller.activeTool).toBe('paint')
      expect(controller.paintMode).toBe('fill')
      expect(modelNode('#paint-tool-mode').textContent).toBe('Fill')
      expect(modelNode('#fill-options').hidden).toBe(false)
      await choose('sculpt')
      await choose('paint')
      expect(controller.activeTool).toBe('paint')
      expect(controller.paintMode).toBe('fill')
      const session = currentModel()
      await workspace.start(true); await enter()
      await mode('push')
      await workspace.returnToScene(); await ui.leaveScene()
      expect(currentModel().controller).toBe(session.controller)
      await choose('sculpt')
      expect(controller.sculptMode).toBe('move')
      await dispatch({ type: 'selection.set', cells })
      await dispatch({ type: 'clipboard.copy' })
      await dispatch({ type: 'clipboard.paste.begin' })
      expect(controller.selection.floating).toBe(true)
      await choose('select')
      expect(controller.selection.count).toBe(0)
      expect(controller.pendingPaste).toBeUndefined()
      expect(controller.document.voxelCount).toBe(1)
      await dispatch({ type: 'tool.paintMode', mode: 'paint' })
      expect(modelNode('#paint-tool-mode').textContent).toBe(controller.document.materials[controller.activeColor].name)
      await dispatch({ type: 'tool.sculptMode', mode: 'erase' })
      expect(modelNode('#paint-tool-mode').textContent).toBe('Erase')
      await dispatch({ type: 'tool.paintMode', mode: 'paint' })
      expect(modelNode('#paint-tool-mode').textContent).toBe(controller.document.materials[controller.activeColor].name)
      await dispatch({ type: 'tool.sculptMode', mode: 'erase' })
      expect(modelNode('#paint-tool-mode').textContent).toBe('Erase')
      await dispatch({ type: 'tool.paintMode', mode: 'fill' })
      expect(modelNode('#paint-tool-mode').textContent).toBe('Fill')
      await choose('paint')
      expect(controller.activeTool).toBe('paint')
      expect(controller.paintMode).toBe('fill')
    } else {
      const shell = dom.querySelector('.studio'), nameInput = modelNode('#project-name')
      const captureGate = capturePause = gate()
      const capturing = dispatch({ type: 'view.capture' })
      await captureGate.entered.promise
      const accepted = edit(2)
      const saveGate = modelPause = gate()
      const closing = application.dispose()
      expect(application.dispose()).toBe(closing)
      expect(shell.inert).toBe(true)
      await expect(edit(4)).rejects.toMatchObject({ code: 'invalid_state' })
      await expect(workspace.open(workspace.snapshot())).rejects.toThrow('Wait for the current scene operation')
      captureGate.release.resolve(); await capturing; await accepted
      await saveGate.entered.promise
      expect(disposedAdapters).toEqual([])
      expect(remoteDisconnected).toBe(false)
      expect(nameInput.listeners.get('input')!.length).toBe(1)
      modelFailure = true
      saveGate.release.resolve()
      await expect(closing).rejects.toThrow('Model quota exceeded')
      expect(shell.inert).toBe(false)
      expect(workspace.busy).toBe(false)
      expect(disposedAdapters).toEqual([])
      nameInput.value = 'Retained and editable'
      await nameInput.emit('input')
      await edit(3)
      modelFailure = false
      await application.dispose()
      expect(standalone.name).toBe('Retained and editable')
      const saved = storage.restoreProjectSnapshot(standalone)!.document
      expect(saved.getVoxel(2, 1, 1)).toBe(6)
      expect(saved.getVoxel(3, 1, 1)).toBe(6)
      expect(saved.getVoxel(4, 1, 1)).toBe(0)
      expect(disposedAdapters).toEqual(['scene', 'model'])
      expect(nameInput.listeners.get('input')).toEqual([])
      expect(dom.nodes.size).toBe(0)
    }
  } finally {
    await application.dispose()
    expect(remoteDisconnected).toBe(true)
    await expect(application.dispatch({ type: 'state.get' })).rejects.toMatchObject({ code: 'invalid_state' })
  }
}
