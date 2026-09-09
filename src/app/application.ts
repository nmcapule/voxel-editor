import './style.css'
import { mountModelEditor, type CommandSource, type ModelCommandEvent, type ModelDispatch, type ModelResult } from '../editors/model/editor'
import { connectIntegrations } from './integrations'
import { SerialCommandQueue, type RemoteCommand } from '../editors/model/protocol'
import { StudioCommandError } from '../shared/errors'
import type { ModelPreviewPlugin } from '../shared/rendering/contracts'
import { mountPerformanceMonitor } from './performance-monitor'
import { mountRenderingPreferences } from './rendering-preferences'

export async function mountApplication(root: HTMLElement) {
  root.innerHTML = `<div class="studio editor-surface" data-editor="model"><div class="viewport"></div><div class="model-root"></div><div class="toast instrument" role="status" aria-live="polite" hidden></div></div>`
  const shell = root.querySelector<HTMLElement>('.studio')!
  const modelRoot = shell.querySelector<HTMLElement>('.model-root')!
  const toast = shell.querySelector<HTMLElement>('.toast')!
  const lifetime = new AbortController()
  const listeners = new Set<(event: ModelCommandEvent & { sequence: number }) => void>()
  let sequence = 0
  let editorGeneration = 0
  let disposed = false
  let disposal: Promise<void> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let workspace: import('../../plugins/scene/client').ScenePlugin | undefined
  let opening: Promise<NonNullable<typeof workspace>> | undefined

  function notify(message: string, tone: 'normal' | 'warning' = 'normal') {
    if (disposed) return
    clearTimeout(toastTimer)
    toast.textContent = message; toast.dataset.tone = tone; toast.hidden = false
    toastTimer = setTimeout(() => { toast.hidden = true }, 4200)
  }

  type QueuedCommand = { command: RemoteCommand; source: CommandSource; ifRevision?: number; viewVersion?: number; editorGeneration: number }
  const queue = new SerialCommandQueue<QueuedCommand, ModelResult>(async ({ command, source, ifRevision, viewVersion, editorGeneration: generation }) => {
    if (disposed || generation !== editorGeneration) throw new StudioCommandError('revision_conflict', 'The active editor changed before this command ran. Retry in the current editor.')
    return (workspace ?? model).execute(command, source, ifRevision, viewVersion)
  })
  const dispatch: ModelDispatch = (command, source = 'ui', ifRevision, viewVersion, signal) => {
    if (disposed || disposal || (opening || workspace?.busy) && command.type !== 'save.flush') return Promise.reject(new StudioCommandError('invalid_state', 'Wait for the current editor operation to finish.'))
    return queue.dispatch({ command, source, ifRevision, viewVersion, editorGeneration }, signal)
  }
  let previewPlugin: ModelPreviewPlugin | undefined
  let previewPluginNotice = ''
  try {
    // This optional file glob keeps builds valid even when the plugin directory is removed.
    const modules = import.meta.glob<{ default: ModelPreviewPlugin }>('../../plugins/cube-sprites/index.ts')
    previewPlugin = (await modules['../../plugins/cube-sprites/index.ts']?.())?.default
    if (!previewPlugin) previewPluginNotice = 'Cube sprites is not installed. Using Standard rendering.'
  } catch {
    previewPluginNotice = 'Cube sprites could not be loaded. Using Standard rendering.'
  }
  const model = await mountModelEditor(modelRoot, {
    viewportRoot: shell.querySelector<HTMLElement>('.viewport')!,
    keyboardRoot: shell,
    previewPlugin,
    dispatch,
    notify,
    onCommand(event) { const emitted = { ...event, sequence: ++sequence }; for (const listener of listeners) listener(emitted) },
    onViewChange: () => workspace?.onViewChange() ?? false,
    onSave: effects => workspace?.onSave(effects) ?? false,
    flushOwner: () => workspace?.flushOwner(),
    ownerSaveStatus: () => workspace?.ownerSaveStatus(),
    busy: () => Boolean(opening || workspace?.busy),
  })
  if (previewPluginNotice) notify(previewPluginNotice, 'warning')
  const plugins = document.createElement('details')
  plugins.className = 'plugins-menu'
  plugins.innerHTML = '<summary>Plugins</summary><div class="plugin-actions" role="menu" aria-label="Plugins"><button type="button" data-plugin="scene" role="menuitem">Scene editor</button></div>'
  model.menu.append(plugins)
  const openPlugin = plugins.querySelector<HTMLButtonElement>('[data-plugin="scene"]')!

  function openScenePlugin() {
    if (disposed || disposal) return Promise.reject(new StudioCommandError('invalid_state', 'The editor is closing or has been disposed.'))
    if (opening) return opening
    if (model.busy || workspace?.busy) return Promise.reject(new StudioCommandError('invalid_state', 'Wait for the current editor operation to finish.'))
    openPlugin.disabled = true
    openPlugin.textContent = 'Opening scene editor...'
    opening = (async () => {
      if (!workspace) {
        const { ScenePlugin } = await import('../../plugins/scene/client').catch(() => {
          // Browsers cache failed module loads until the page is reloaded.
          throw new Error('Check your connection, save or export your model, then reload to retry. Scene recovery has not been changed.')
        })
        workspace = new ScenePlugin({
          model, root: shell,
          notify: message => notify(message, 'warning'),
          contextChanged() { editorGeneration++; model.contextChanged() },
        })
      }
      await workspace.activate()
      plugins.open = false
      return workspace
    })().finally(() => {
      opening = undefined
      openPlugin.disabled = false
      openPlugin.textContent = 'Scene editor'
    })
    return opening
  }
  openPlugin.addEventListener('click', () => {
    void openScenePlugin().catch(error => notify(`Scene editor could not be opened. ${error instanceof Error ? error.message : 'Try again.'}`, 'warning'))
  }, { signal: lifetime.signal })
  const disposePerformanceMonitor = mountPerformanceMonitor(shell, model.renderer.viewport)
  const disposeRenderingPreferences = mountRenderingPreferences(shell, model.renderer.viewport)
  const disconnect = connectIntegrations({
    root: shell, menu: plugins.querySelector<HTMLElement>('.plugin-actions')!, dispatch,
    revision: () => (workspace ?? model).revision,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    notify,
  })
  window.addEventListener('beforeunload', event => {
    if (model.saveState === 'saving' || workspace?.hasUnsavedChanges) event.preventDefault()
  }, { signal: lifetime.signal })
  return {
    model,
    openScenePlugin,
    dispatch,
    dispose() {
      if (disposed) return Promise.resolve()
      if (disposal) return disposal
      if (opening || workspace?.busy || model.busy) return Promise.reject(new StudioCommandError('invalid_state', 'Wait for the current editor operation to finish before closing the editor.'))
      const inert = shell.inert
      shell.inert = true
      model.contextChanged()
      workspace?.setBusy(true)
      disposal = (async () => {
        try {
          // Bypass dispatch's input lock, but keep the flush behind accepted commands.
          await queue.dispatch({ command: { type: 'save.flush' }, source: 'ui', editorGeneration })
          workspace?.setBusy(false)
          await workspace?.dispose()
          await model.dispose()
          disposed = true; editorGeneration++; lifetime.abort(); clearTimeout(toastTimer)
          disposePerformanceMonitor(); disposeRenderingPreferences(); disconnect(); listeners.clear(); root.replaceChildren()
        } catch (error) {
          notify(`Could not close the editor. ${error instanceof Error ? error.message : 'Save your work and retry.'}`, 'warning')
          throw error
        } finally {
          if (!disposed) { workspace?.setBusy(false); shell.inert = inert }
          disposal = undefined
        }
      })()
      return disposal
    },
  }
}
