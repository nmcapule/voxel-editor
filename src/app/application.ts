import './style.css'
import { mountModelEditor, type CommandSource, type ModelCommandEvent, type ModelDispatch, type ModelResult } from '../editors/model/editor'
import { SceneModelBridge } from './scene-model-bridge'
import { connectIntegrations } from './integrations'
import { SerialCommandQueue, type RemoteCommand } from '../editors/model/protocol'
import { StudioCommandError } from '../shared/errors'
import { bytesToBase64 } from '../shared/voxel/snapshot'

export async function mountApplication(root: HTMLElement) {
  root.innerHTML = `<div class="studio editor-surface" data-editor="model"><div class="viewport"></div><div class="model-root"></div><div class="scene-root"></div><div class="scene-return instrument" hidden><button type="button" class="primary">Done: Return to scene</button><span></span></div><div class="toast instrument" role="status" aria-live="polite" hidden></div></div>`
  const shell = root.querySelector<HTMLElement>('.studio')!
  const modelRoot = shell.querySelector<HTMLElement>('.model-root')!
  const sceneRoot = shell.querySelector<HTMLElement>('.scene-root')!
  const returnBar = shell.querySelector<HTMLElement>('.scene-return')!
  const done = returnBar.querySelector<HTMLButtonElement>('button')!
  const toast = shell.querySelector<HTMLElement>('.toast')!
  const lifetime = new AbortController()
  const listeners = new Set<(event: ModelCommandEvent & { sequence: number }) => void>()
  let sequence = 0
  let editorGeneration = 0
  let activeEditor: 'model' | 'scene' = 'model'
  let disposed = false
  let disposal: Promise<void> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let bridge: SceneModelBridge | undefined

  function notify(message: string, tone: 'normal' | 'warning' = 'normal') {
    if (disposed) return
    clearTimeout(toastTimer)
    toast.textContent = message; toast.dataset.tone = tone; toast.hidden = false
    toastTimer = setTimeout(() => { toast.hidden = true }, 4200)
  }

  type QueuedCommand = { command: RemoteCommand; source: CommandSource; ifRevision?: number; viewVersion?: number; editorGeneration: number }
  const queue = new SerialCommandQueue<QueuedCommand, ModelResult>(async ({ command, source, ifRevision, viewVersion, editorGeneration: generation }) => {
    if (disposed || generation !== editorGeneration) throw new StudioCommandError('revision_conflict', 'The active editor changed before this command ran. Retry in the current editor.')
    if (activeEditor === 'model') return model.execute(command, source, ifRevision, viewVersion)
    const scene = bridge!.scene, revision = scene.revision, viewport = model.renderer.viewport
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
  })
  const dispatch: ModelDispatch = (command, source = 'ui', ifRevision, viewVersion, signal) => {
    if (disposed || disposal || bridge?.busy && command.type !== 'save.flush') return Promise.reject(new StudioCommandError('invalid_state', 'Wait for the current scene operation to finish.'))
    return queue.dispatch({ command, source, ifRevision, viewVersion, editorGeneration }, signal)
  }
  const model = await mountModelEditor(modelRoot, {
    viewportRoot: shell.querySelector<HTMLElement>('.viewport')!,
    keyboardRoot: shell,
    dispatch,
    notify,
    onCommand(event) { const emitted = { ...event, sequence: ++sequence }; for (const listener of listeners) listener(emitted) },
    onViewChange() { if (activeEditor !== 'scene') return false; bridge?.viewChanged(); return true },
    onSave(effects) { if (!bridge?.hasScene) return false; bridge.modelChanged(effects); return true },
    flushOwner: () => bridge?.hasScene ? bridge.flush() : undefined,
    ownerSaveStatus: () => bridge?.hasScene ? {
      state: bridge.saveState,
      text: bridge.saveState === 'saving' ? 'Saving scene...' : bridge.saveState === 'error' ? 'Scene save failed' : 'Scene recovery saved',
      title: 'Model edits are saved inside the owning scene. Texture images are session-only.',
    } : undefined,
    busy: () => bridge?.busy ?? false,
    menuActions: [
      { action: 'scene-editor', label: 'Scene editor', run: async () => { await bridge!.start() } },
      { action: 'scene-from-model', label: 'Create scene from this model', run: async () => { await bridge!.start(true) } },
      { action: 'export-owning-scene', label: 'Export owning scene...', hidden: true, run: async () => { await bridge!.exportScene() } },
    ],
  })
  bridge = new SceneModelBridge({
    model, sceneRoot, keyboardRoot: shell,
    notify: message => notify(message, 'warning'),
    busyChanged: busy => { done.disabled = busy },
    contextChanged(context, label) {
      editorGeneration++
      activeEditor = context === 'scene' ? 'scene' : 'model'
      shell.dataset.editor = context
      model.contextChanged()
      model.element.dataset.saveOwner = context === 'asset' ? 'scene' : 'model'
      model.menu.querySelector<HTMLElement>('[data-action="export-owning-scene"]')!.hidden = context !== 'asset'
      returnBar.hidden = context !== 'asset'
      returnBar.querySelector('span')!.textContent = label ?? ''
      model.updateSaveStatus()
      model.renderer.viewport.focusViewport()
    },
  })
  done.addEventListener('click', () => { void bridge!.returnToScene().catch(error => notify(error instanceof Error ? error.message : 'Could not return to the scene.', 'warning')) }, { signal: lifetime.signal })
  const disconnect = connectIntegrations({
    root: shell, menu: model.menu, dispatch,
    revision: () => activeEditor === 'scene' ? bridge!.revision : model.revision,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    notify,
  })
  window.addEventListener('beforeunload', event => {
    if (model.saveState === 'saving' || bridge?.hasScene && bridge.saveState !== 'saved') event.preventDefault()
  }, { signal: lifetime.signal })
  try { await bridge.restore() }
  catch (error) { notify(`Scene recovery could not be opened. ${error instanceof Error ? error.message : 'Retry after checking storage.'}`, 'warning') }
  return {
    model,
    bridge,
    dispatch,
    dispose() {
      if (disposed) return Promise.resolve()
      if (disposal) return disposal
      if (bridge!.busy || model.busy) return Promise.reject(new StudioCommandError('invalid_state', 'Wait for the current editor operation to finish before closing the editor.'))
      const inert = shell.inert
      shell.inert = true
      model.contextChanged()
      bridge!.scene.setBusy(true)
      disposal = (async () => {
        try {
          // Bypass dispatch's input lock, but keep the flush behind accepted commands.
          await queue.dispatch({ command: { type: 'save.flush' }, source: 'ui', editorGeneration })
          bridge!.scene.setBusy(false)
          await bridge!.dispose()
          await model.dispose()
          disposed = true; editorGeneration++; lifetime.abort(); clearTimeout(toastTimer)
          disconnect(); listeners.clear(); root.replaceChildren()
        } catch (error) {
          notify(`Could not close the editor. ${error instanceof Error ? error.message : 'Save your work and retry.'}`, 'warning')
          throw error
        } finally {
          if (!disposed) { bridge!.scene.setBusy(false); shell.inert = inert }
          disposal = undefined
        }
      })()
      return disposal
    },
  }
}
