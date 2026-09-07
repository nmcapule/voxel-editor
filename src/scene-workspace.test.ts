import { expect, mock, test } from 'bun:test'
import type { AssistantHost } from '../plugins/assistant/shared'
import type { VoxelDocument } from './editor'
import type { RemoteCommand } from './protocol'
import type { CameraSnapshot } from './renderer'
import type { SceneRecoveryContext, SceneManifest } from './scene-types'
import type { SceneUIHost } from './scene-ui'
import type { StoredProject, ViewSettings } from './storage'
import type { PbrMap } from './studio'

const cases = [
  'shared model edits return to every instance without changing the standalone session',
  'latest autosave survives an in-flight save and restores child and scene context',
  'resume and return reject late commands and queued commands cannot cross editors',
  'PBR maps survive another asset hydration and cleared maps stay cleared',
  'delayed VOX and texture reads cannot change a different editor',
  'failed child recovery is visible and retry retains the edited voxels',
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
  const { VoxelDocument } = await import('./editor')
  const { encodeProjectSnapshot, PROTOCOL } = await import('./protocol')
  const storage = { ...await import('./storage') }
  const sceneStorage = { ...await import('./scene-storage') }
  const settings: ViewSettings = { background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42, ambientOcclusion: true, shadows: true, grid: true, faceGrid: false, meshVertices: false, projection: 'orthographic', pathTracing: false }
  const original = new VoxelDocument(undefined, 'Standalone')
  original.setVoxel(1, 1, 1, 5)
  let standalone = storage.snapshotProject(original, settings, { id: 'source', version: 1, tags: ['test'], dirty: false })
  let recovery: { scene: SceneManifest; context: SceneRecoveryContext } | undefined
  const recoveryPauses: ReturnType<typeof gate>[] = []
  let modelPause: ReturnType<typeof gate> | undefined
  let capturePause: ReturnType<typeof gate> | undefined
  let storageFailure = false
  let standaloneWrites = 0

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
  mock.module('./storage', () => ({
    ...storage,
    loadProject: async () => storage.restoreProjectSnapshot(structuredClone(standalone)),
    saveProjectSnapshot: async (snapshot: StoredProject) => {
      const captured = structuredClone(snapshot), pause = modelPause
      modelPause = undefined
      if (pause) { pause.entered.resolve(); await pause.release.promise }
      standalone = captured; standaloneWrites++
    },
  }))
  mock.module('./scene-storage', () => ({
    ...sceneStorage,
    loadSceneRecovery: async () => structuredClone(recovery),
    deactivateSceneRecovery: async () => { recovery = undefined },
    saveSceneDocumentRecovery: async (scene: import('./scene').SceneDocument, context: SceneRecoveryContext) => {
      const captured = structuredClone({ scene: scene.snapshot(), context }), pause = recoveryPauses.shift()
      if (pause) { pause.entered.resolve(); await pause.release.promise }
      if (storageFailure) throw new Error('Recovery quota exceeded')
      recovery = captured
    },
  }))

  // This is a control/event surface, not a layout engine. main.ts still runs all its real handlers.
  class ElementStub {
    dataset: Record<string, string> = {}
    style = {}
    value = ''
    textContent = ''
    hidden = false
    disabled = false
    files: Pick<File, 'name' | 'type' | 'arrayBuffer'>[] = []
    children: ElementStub[] = []
    nodes = new Map<string, ElementStub>()
    listeners = new Map<string, ((event: unknown) => unknown)[]>()
    elements = { namedItem: (name: string) => this.querySelector(name) }
    readonly tag: string
    constructor(tag = '') { this.tag = tag }
    querySelector(selector: string): ElementStub {
      const child = this.children.find(child => child.tag === selector)
      if (child) return child
      if (!this.nodes.has(selector)) this.nodes.set(selector, new ElementStub(selector))
      return this.nodes.get(selector)!
    }
    querySelectorAll() { return [] }
    addEventListener(type: string, listener: (event: unknown) => unknown) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]) }
    async emit(type: string, event: unknown = { target: this }) { await Promise.all(this.listeners.get(type)?.map(listener => listener(event)) ?? []) }
    append(...children: ElementStub[]) { this.children.push(...children) }
    matches() { return false }
    contains() { return false }
    setAttribute() {}
    remove() {}
    hidePopover() {}
  }
  const dom = Object.assign(new ElementStub(), { activeElement: null, createElement: (tag: string) => new ElementStub(tag) })
  Object.assign(globalThis, {
    document: dom, window: new ElementStub(),
    HTMLElement: ElementStub, HTMLButtonElement: ElementStub, HTMLInputElement: ElementStub, HTMLSelectElement: ElementStub, HTMLTextAreaElement: ElementStub,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, confirm: () => true,
    localStorage: { getItem: () => null, setItem() {} },
  })
  class RendererStub {
    document = original
    view: CameraSnapshot = { projection: 'orthographic', position: { x: 50, y: 40, z: 50 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, orthographicSpan: 64, viewport: { width: 800, height: 600 } }
    maps = new Map<string, Blob>()
    renderMode = false
    getView() { return structuredClone(this.view) }
    setView(view: CameraSnapshot) { this.view = structuredClone(view) }
    getSceneViewport() { return { renderMode: this.renderMode } }
    setDocument(document: VoxelDocument) { this.document = document; this.maps.clear() }
    setRenderMode(enabled: boolean) { this.renderMode = enabled }
    async setPbrMap(index: number, map: PbrMap, blob: Blob) { this.maps.set(`${index}:${map}`, blob) }
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
    setTool() {}
    setPaintMode() {}
    setSculptMode() {}
    setSelectionMode() {}
    setFillShape() {}
    setFillDepth() {}
    setAuxiliary() {}
    applySelection() {}
    markDirty() {}
    updatePalette() {}
    updatePaletteMaterial() {}
  }
  let renderer!: RendererStub
  mock.module('./renderer', () => ({ VoxelRenderer: class extends RendererStub { constructor(_host: unknown, document: VoxelDocument) { super(); this.document = document; renderer = this } } }))
  mock.module('./scene-renderer', () => ({ SceneRenderer: class {
    stats = {}
    setActive() {}
    setDocument() {}
    refresh() {}
    frameSelection() { renderer.frameModel() }
    dispose() {}
  } }))
  let ui!: SceneUIHost
  mock.module('./scene-ui', () => ({ mountSceneUI: (host: SceneUIHost) => {
    ui = host
    return { setVisible() {}, setBusy() {}, render() {}, setSaveState() {}, dispose() {} }
  } }))
  mock.module('./model-library', () => ({ mountModelLibrary: () => ({ dispose() {} }) }))
  let remote!: Parameters<typeof import('./remote').connectRemote>[0]
  mock.module('./remote', () => ({ connectRemote: (host: typeof remote) => { remote = host } }))
  const assistantReady = Promise.withResolvers<AssistantHost>()
  mock.module('../plugins/assistant/client', () => ({ mountAssistant: (host: AssistantHost) => { assistantReady.resolve(host); return () => {} } }))
  const { SceneWorkspace } = await import('./scene-workspace')
  let workspace!: InstanceType<typeof SceneWorkspace>
  let workspaceHost!: ConstructorParameters<typeof SceneWorkspace>[0]
  mock.module('./scene-workspace', () => ({ SceneWorkspace: class extends SceneWorkspace {
    constructor(host: typeof workspaceHost) { super(host); workspace = this; workspaceHost = host }
  } }))
  await import('./main')
  const assistant = await assistantReady.promise
  const dispatch = (command: RemoteCommand) => remote.dispatch({ protocol: PROTOCOL, id: crypto.randomUUID(), command })
  const state = async () => (await dispatch({ type: 'state.get' })).result as ReturnType<import('./studio').Studio['stateSnapshot']> & { saveState: string }
  const edit = (x: number, color = 6) => dispatch({ type: 'edit.setVoxels', voxels: [{ x, y: 1, z: 1, color }] })
  const enter = () => ui.editModel(workspace.snapshot().instances[0].id)
  const savedModel = async () => (await sceneStorage.loadSceneAsset(recovery!.scene.assets[0])).document

  try {
    if (name === cases[0]) {
      await edit(2)
      await dispatch({ type: 'selection.set', cells: [{ x: 2, y: 1, z: 1 }] })
      await dispatch({ type: 'tool.set', tool: 'sculpt' })
      await dispatch({ type: 'tool.sculptMode', mode: 'move' })
      const before = workspaceHost.currentModel(), standaloneSnapshot = encodeProjectSnapshot(before.controller.document, before.controller.settings)
      const beforeState = before.controller.stateSnapshot()
      await workspace.start(true)
      const assetId = workspace.snapshot().assets[0].id
      await ui.command({ type: 'instance.place', assetId, position: { x: 100, y: 0, z: 0 } })
      await enter(); await edit(17)
      const child = workspaceHost.currentModel().controller
      await workspace.returnToScene()
      expect(workspace.snapshot().instances.map(instance => instance.assetId)).toEqual([assetId, assetId])
      expect((await savedModel()).getVoxel(17, 1, 1)).toBe(6)
      await enter()
      expect(workspaceHost.currentModel().controller).toBe(child)
      await dispatch({ type: 'history.undo' }); await workspace.returnToScene()
      expect((await savedModel()).getVoxel(17, 1, 1)).toBe(0)
      await ui.leaveScene()
      expect(workspaceHost.currentModel().controller).toBe(before.controller)
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
      expect(dom.querySelector('#save-status').dataset.state).toBe('saving')
      second.release.resolve(); await latest
      expect((await savedModel()).getVoxel(2, 1, 1)).toBe(6)
      expect((await savedModel()).getVoxel(17, 1, 1)).toBe(12)
      expect(recovery!.context).toMatchObject({ editingAssetId: workspace.snapshot().assets[0].id, selection, view: sceneView })
      expect((await state()).saveState).toBe('saved')
      const previousWorkspace = workspace
      workspace.dispose()
      const reload = './main.ts?workspace-reload'
      await import(reload)
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
      const refused = edit(3).then(() => undefined, error => error)
      pause.release.resolve(); await resuming
      expect(await refused).toMatchObject({ code: 'invalid_state' })
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
      const late = assistant.execute({ type: 'document.rename', name: 'Late edit' }, { signal: new AbortController().signal, ifRevision: workspaceHost.currentModel().controller.revision }).then(() => undefined, error => error)
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
      await workspace.returnToScene(); await enter()
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
      const { exportVox } = await import('./vox')
      const replacement = new VoxelDocument(undefined, 'Wrong model')
      replacement.setVoxel(9, 9, 9, 12)
      const file = dom.querySelector('#file-input')
      file.files = [{ name: 'wrong.vox', type: '', arrayBuffer: () => voxRead.promise }]
      const importing = file.emit('change')
      const texture = new ElementStub('input')
      texture.dataset.pbrMap = 'map'
      texture.files = [{ name: 'wrong.png', type: 'image/png', arrayBuffer: () => textureRead.promise }]
      await dom.querySelector('[data-panel="palette"]').emit('input', { target: texture })
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
      await dom.querySelector('[data-panel="palette"]').emit('input', { target: texture })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(renderer.maps.size).toBe(1)
    } else {
      await workspace.start(true); await enter()
      const saved = structuredClone(recovery)
      storageFailure = true
      await edit(17)
      await expect(dispatch({ type: 'save.flush' })).rejects.toThrow('Recovery quota exceeded')
      expect(workspace.saveState).toBe('error')
      expect(dom.querySelector('#save-status').dataset.state).toBe('error')
      expect((await state()).saveState).toBe('error')
      expect(recovery).toEqual(saved)
      await expect(workspace.returnToScene()).rejects.toThrow('Recovery quota exceeded')
      expect(workspace.active).toBe(false)
      expect(renderer.document.getVoxel(17, 1, 1)).toBe(6)
      storageFailure = false
      await workspace.flush()
      expect(dom.querySelector('#save-status').dataset.state).toBe('saved')
      expect((await savedModel()).getVoxel(17, 1, 1)).toBe(6)
      await workspace.returnToScene()
      expect(workspace.active).toBe(true)
    }
  } finally {
    workspace.dispose()
  }
}
