import type { ViewSettings } from '../../shared/rendering/settings'
import './style.css'
import { icon } from '../../shared/ui/icons'
import { escapeHtml as escape } from '../../shared/ui/dom'
import { modelRequest } from '../../shared/library/models'
import { Euler, Quaternion } from 'three'
import type { ModelSummary } from '../../shared/library/types'
import { VoxelDocument } from '../../shared/voxel/document'
import { encodeProjectSnapshot, parseProjectSnapshot, type ProjectSnapshot } from '../../shared/voxel/snapshot'
import type { SceneDocument } from './document'
import { exportSceneFile, importSceneFile, listSceneLibrary, openLibraryScene, saveLibraryScene } from './library'
import { MAX_SCENE_INSTANCES, SCENE_EXTENT, type SceneAsset, type SceneCommand, type SceneInstance, type SceneManifest, type SceneStats, type SceneTool, type TransformMode } from './types'
import type { LibraryLink } from '../../shared/library/types'
import { importVox } from '../../shared/voxel/vox'

export interface SceneUIHost {
  current(): { scene: SceneDocument; library?: LibraryLink; hasTextureMaps?: boolean; renderMode?: boolean }
  command(command: SceneCommand): void | Promise<void>
  tool(tool: SceneTool): void
  transform(mode: TransformMode): void
  snap(enabled: boolean): void
  place(assetId?: string): void
  editModel(instanceId: string): void | Promise<void>
  insertModel(snapshot: ProjectSnapshot, source?: { id: string; version: number }): Promise<void>
  openScene(snapshot: SceneManifest, library?: LibraryLink): Promise<void>
  newScene(): void | Promise<void>
  leaveScene(): void | Promise<void>
  frame(): void
  renderMode(): void
  capture(exact?: boolean): void | Promise<void>
  settings(patch: Partial<ViewSettings>): void
  notify(message: string): void
  librarySaved(library: LibraryLink): void
}

export interface SceneUI {
  element: HTMLElement
  setVisible(visible: boolean): void
  render(): void
  setStats(stats: SceneStats): void
  setSaveState(state: 'saved' | 'saving' | 'error', message?: string): void
  setBusy(busy: boolean): void
  dispose(): void
}

const number = new Intl.NumberFormat()
const axes = ['x', 'y', 'z'] as const
const modes = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' } as const
const button = (action: string, label: string, glyph?: string, attributes = '') => `<button type="button" data-scene-action="${action}" ${attributes}>${glyph ? icon(glyph) : ''}${label}</button>`
const iconButton = (action: string, label: string, glyph: string, attributes = '') => button(action, '', glyph, `class="scene-icon-button" aria-label="${label}" title="${label}" ${attributes}`)

// Scene chrome owns no renderer or document mutations. All edits pass through the host.
export function mountSceneUI(root: HTMLElement, host: SceneUIHost, keyboardRoot: HTMLElement = root): SceneUI {
  const element = document.createElement('div')
  element.className = 'scene-ui'
  element.hidden = true
  element.inert = true
  element.innerHTML = `
    <div class="top-chrome scene-top" role="toolbar" aria-label="Scene controls">
      <div class="project-pill instrument">
        ${iconButton('menu', 'Scene menu', 'menu', 'popovertarget="scene-project-menu"')}
        <span class="brand-mark">${icon('logo')}</span>
        <label class="project-name"><span class="sr-only">Scene name</span><input id="scene-name" maxlength="60" required autocomplete="off"></label>
      </div>
      <div class="top-actions instrument">
        ${iconButton('undo', 'Undo (Ctrl/Command Z)', 'undo')}${iconButton('redo', 'Redo (Ctrl/Command Shift Z)', 'redo')}
        <span class="instrument-rule"></span>
        ${iconButton('frame', 'Frame scene or selection (F)', 'frame')}
        ${iconButton('render', 'Toggle render mode (R)', 'render', 'aria-pressed="false"')}
        ${iconButton('inspector', 'Open scene stage settings', 'sliders', 'aria-controls="scene-inspector" aria-expanded="false"')}
      </div>
    </div>
    <aside id="scene-project-menu" class="scene-popover scene-menu instrument" popover aria-label="Scene menu">
      <strong>Scene</strong>
      ${button('save', 'Save scene...')}${button('browse-scenes', 'Browse scenes...')}${button('browse-models', 'Insert a model...')}
      ${button('import-scene', 'Import scene (.vscene)')}${button('export-scene', 'Export scene (.vscene)')}
      ${button('new-scene', 'New scene')}${button('capture', 'Capture PNG')}${button('leave', 'Return to model editor')}
    </aside>
    <div class="scene-status instrument scene-metrics" role="group" aria-label="Scene status">
      <div class="scene-persistence-status"><span id="scene-local-save-status" role="status">Local recovery not confirmed</span><span id="scene-save-state">Not saved to server</span></div>
      <div class="scene-render-status"><span id="scene-selection-status">No selection</span><span id="scene-voxel-status">Represented voxels not measured</span>
      <span id="scene-resident-status">Resident memory not measured</span><span id="scene-lod-status">Waiting for renderer</span></div>
      <span id="scene-wait-status" role="status" hidden></span>
    </div>
    <nav class="tool-dock instrument scene-dock" aria-label="Scene tools">
      ${(['select', 'place', 'transform', 'layer'] as const).map((tool, index) => `<button type="button" data-scene-tool="${tool}" aria-pressed="${tool === 'select'}" popovertarget="scene-${tool}-popup" aria-keyshortcuts="${['Q', 'W', 'S', 'L'][index]}">${icon(['select', 'fill', 'move', 'layers'][index])}<span class="tool-label"><strong>${['Select', 'Place', 'Transform', 'Layer'][index]}</strong><small id="scene-${tool}-summary">${['Instances', 'Choose model', 'Move', 'Layer 1'][index]}</small></span><kbd>${['Q', 'W', 'S', 'L'][index]}</kbd></button>`).join('')}
    </nav>
    <aside id="scene-select-popup" class="scene-popover scene-tool-popup instrument" popover aria-labelledby="scene-select-title">
      <header><strong id="scene-select-title">Selection</strong><span id="scene-select-count">Select an instance in the scene or list.</span></header>
      <div class="scene-action-list">
        ${button('edit-model', '<span><strong>Edit model</strong><small>Updates all copies of this scene asset</small></span>', 'box')}
        ${button('make-unique', '<span><strong>Make unique</strong><small>Detach this copy before editing</small></span>', 'copy')}
      </div>
      <div class="scene-action-list scene-divider">
        ${button('copy', '<span>Copy</span><kbd>Ctrl/Command C</kbd>', 'copy')}${button('cut', '<span>Cut</span><kbd>Ctrl/Command X</kbd>', 'cut')}
        ${button('paste', '<span>Paste</span><kbd>Ctrl/Command V</kbd>', 'paste')}${button('delete', '<span>Delete selection</span><kbd>Delete</kbd>', 'trash')}
      </div>
      ${button('instance-list', 'Find instances in Scene', 'select', 'class="secondary full"')}
    </aside>
    <aside id="scene-place-popup" class="scene-popover scene-tool-popup instrument" popover aria-labelledby="scene-place-title">
      <header><strong id="scene-place-title">Place a model</strong><span>Scene assets are shared by their copies.</span></header>
      <div class="scene-action-list">
        ${button('browse-models', 'Browse model library...', 'box')}${button('import-vox', 'Import VOX...', 'plus')}${button('blank-model', 'New blank model...', 'plus')}
      </div>
      <label class="scene-field scene-divider">Scene assets<input id="scene-asset-search" type="search" placeholder="Find a scene asset" maxlength="120" autocomplete="off"></label>
      <ul id="scene-assets" class="scene-list" aria-label="Scene assets"></ul>
      <div id="scene-asset-pages" class="scene-pages">${button('asset-prev', 'Previous')}<span></span>${button('asset-next', 'Next')}</div>
      <p class="scene-note">Choose an asset, then click the viewport or use Place at origin. Escape cancels.</p>
      <div class="scene-button-row">${button('place-origin', 'Place at origin', undefined, 'class="primary"')}${button('cancel-place', 'Cancel placement', undefined, 'class="secondary"')}</div>
    </aside>
    <aside id="scene-transform-popup" class="scene-popover scene-tool-popup instrument" popover aria-labelledby="scene-transform-title">
      <header><strong id="scene-transform-title">Transform</strong><span>Use the gizmo for one or more instances.</span></header>
      <div class="scene-action-list" role="group" aria-label="Transform mode">
        ${(Object.entries(modes) as [TransformMode, string][]).map(([mode, label], index) => `<button type="button" data-scene-transform="${mode}" aria-pressed="${index === 0}"><span>${label}</span><kbd>S ${index + 1}</kbd></button>`).join('')}
      </div>
      <label class="toggle-row"><span>Snap transforms</span><input id="scene-snap" type="checkbox" checked></label>
      <p class="scene-note">Snapping uses the viewport's position, rotation, and scale increments.</p>
      ${button('instance-panel', 'Enter exact values', undefined, 'class="secondary full"')}
    </aside>
    <aside id="scene-layer-popup" class="scene-popover scene-tool-popup instrument" popover aria-labelledby="scene-layer-title">
      <header class="scene-heading"><div><strong id="scene-layer-title">Layers</strong><span>Visibility, locking, and placement</span></div>${iconButton('add-layer', 'Add scene layer', 'plus')}</header>
      <ul id="scene-layers" class="scene-list" aria-label="Scene layers"></ul>
      ${button('assign-layer', 'Move selection to active layer', undefined, 'class="secondary full"')}
      <p class="scene-note">New copies use the active layer. Hidden or locked layers cannot be edited.</p>
    </aside>
    <aside id="scene-inspector" class="stage-panel instrument scene-inspector" aria-label="Scene stage settings" hidden>
      <header><div><strong>Stage</strong><span>Scene, instance &amp; light</span></div>${iconButton('close-inspector', 'Close scene stage settings', 'close')}</header>
      <nav class="panel-tabs" role="tablist" aria-label="Scene stage sections">
        ${['Scene', 'Instance', 'Render'].map((label, index) => `<button id="scene-tab-${label.toLowerCase()}" type="button" role="tab" data-scene-tab="${label.toLowerCase()}" aria-controls="scene-panel-${label.toLowerCase()}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('')}
      </nav>
      <section id="scene-panel-scene" class="panel-section" role="tabpanel" aria-labelledby="scene-tab-scene" tabindex="0">
        <div class="section-heading"><h2>Scene</h2><span id="scene-extent"></span></div>
        <p class="scene-note">Up to ${number.format(MAX_SCENE_INSTANCES)} instances in a ${number.format(SCENE_EXTENT)}-voxel extent. Models stream on demand with adaptive level of detail.</p>
        <p id="scene-offline-help" class="scene-note" hidden>Assets may still stream from the server. Local recovery does not guarantee that every asset is available offline. Export a .vscene file while connected to keep a self-contained copy.</p>
        <div class="scene-button-row">${button('browse-models', 'Insert model', 'plus', 'class="primary"')}${button('save', 'Save scene', undefined, 'class="secondary"')}</div>
        <h3>Instances <span id="scene-instance-count"></span></h3>
        <label class="scene-field">Find an instance<input id="scene-instance-search" type="search" maxlength="120" placeholder="Search instance or model names" autocomplete="off"></label>
        <p class="scene-note">Select by name below. Check multiple instances to transform a group.</p>
        <ul id="scene-instances" class="scene-list" aria-label="Scene instances"></ul>
        <div id="scene-instance-pages" class="scene-pages">${button('instance-prev', 'Previous')}<span></span>${button('instance-next', 'Next')}</div>
        ${button('clear-selection', 'Clear selection', undefined, 'class="secondary full"')}
      </section>
      <section id="scene-panel-instance" class="panel-section" role="tabpanel" aria-labelledby="scene-tab-instance" tabindex="0" hidden>
        <div class="section-heading"><h2 id="scene-instance-title">No instance selected</h2></div>
        <p id="scene-instance-help" class="scene-note">Select an instance in the viewport or the Scene list.</p>
        <form id="scene-transform-form"><fieldset>
          ${(['position', 'rotation', 'scale'] as const).map(group => `<fieldset class="scene-vector"><legend>${group === 'rotation' ? 'Rotation (degrees, XYZ)' : group === 'position' ? 'Position (voxels)' : 'Scale'}</legend>${axes.map(axis => `<label>${axis.toUpperCase()}<input name="${group}-${axis}" type="number" inputmode="decimal" step="any" ${group === 'scale' ? 'min="0.01" max="256"' : ''} required aria-label="${group} ${axis.toUpperCase()}"></label>`).join('')}</fieldset>`).join('')}
          <button type="submit" class="primary full">Apply transform</button>
        </fieldset></form>
        <p id="scene-shared-help" class="scene-note"></p>
        <div class="scene-button-row">${button('edit-model', 'Edit model', undefined, 'class="secondary"')}${button('make-unique', 'Make unique', undefined, 'class="secondary"')}</div>
      </section>
      <section id="scene-panel-render" class="panel-section" role="tabpanel" aria-labelledby="scene-tab-render" tabindex="0" hidden>
        <div class="section-heading"><h2>Render</h2><span>Realtime / progressive</span></div>
        <label class="select-row"><span>Camera</span><select data-scene-setting="projection"><option value="orthographic">Orthographic</option><option value="perspective">Perspective</option></select></label>
        <label class="toggle-row"><span>Progressive PBR</span><input type="checkbox" data-scene-setting="pathTracing" aria-describedby="scene-pbr-help"></label>
        <p id="scene-pbr-help" class="scene-note">Progressive PBR uses full-scene detail in Render mode. Over-budget scenes fall back to adaptive raster.</p>
        <label class="toggle-row"><span>Miniature photography</span><input type="checkbox" data-scene-setting="tiltShift" aria-describedby="scene-tilt-shift-help" aria-controls="scene-tilt-shift-controls"></label>
        <p id="scene-tilt-shift-help" class="scene-note">A tilt-shift effect visible only in Render mode and included in PNG captures from Render mode.</p>
        <div id="scene-tilt-shift-controls" hidden>
          ${([['tiltShiftStrength', 'Blur strength'], ['tiltShiftFocus', 'Focus position'], ['tiltShiftWidth', 'Sharp band width']] as const).map(([key, label]) => `<label class="range-row"><span>${label}<output id="scene-output-${key}" for="scene-${key}"></output></span><input id="scene-${key}" type="range" data-scene-setting="${key}" aria-label="${label}" aria-describedby="scene-tilt-shift-band-help" min="0" max="1" step="0.01"></label>`).join('')}
          <p id="scene-tilt-shift-band-help" class="scene-note">Focus runs from 0% at the top to 100% at the bottom. Sharp band width is a percentage of image height.</p>
        </div>
        <label class="color-row"><span>Backdrop</span><input type="color" data-scene-setting="background"></label>
        ${([['ambient', 'Ambient light', 0, 3, 0.1], ['light', 'Key light', 0, 5, 0.1], ['lightAzimuth', 'Light angle', -180, 180, 1]] as const).map(([key, label, min, max, step]) => `<label class="range-row"><span>${label}<output id="scene-output-${key}"></output></span><input type="range" data-scene-setting="${key}" aria-label="${label}" min="${min}" max="${max}" step="${step}"></label>`).join('')}
        ${([['ambientOcclusion', 'Ambient occlusion'], ['shadows', 'Ground shadows'], ['grid', 'Editing grid']] as const).map(([key, label]) => `<label class="toggle-row"><span>${label}</span><input type="checkbox" data-scene-setting="${key}"></label>`).join('')}
        <label class="scene-field scene-capture-quality">Capture quality<select id="scene-capture-quality" aria-describedby="scene-capture-help"><option value="viewport">Viewport detail</option><option value="full">Full-scene detail</option></select></label>
        <p id="scene-capture-help" class="scene-note">Viewport detail uses the current rendered detail. Full-scene detail prepares every visible scene layer at full voxel detail. Preflight may reject it above 1,000,000 triangles or a 96 MiB estimated peak budget. If rejected, choose Viewport detail or reduce the scene.</p>
        ${button('capture', 'Capture PNG', 'camera', 'id="scene-capture" class="primary full"')}
      </section>
    </aside>
    <dialog id="scene-browser" class="model-library model-browser instrument scene-dialog" aria-labelledby="scene-browser-title">
      <header class="library-header"><div><h2 id="scene-browser-title">Library</h2><p>Insert a model or open a saved scene</p></div>${iconButton('close-browser', 'Close library', 'close')}</header>
      <nav class="panel-tabs scene-library-tabs" role="tablist" aria-label="Library type">${['Models', 'Scenes'].map((label, index) => `<button type="button" id="scene-library-tab-${label.toLowerCase()}" role="tab" data-scene-library-tab="${label.toLowerCase()}" aria-selected="${index === 0}" aria-controls="scene-library-results-panel" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('')}</nav>
      <div class="library-toolbar">
        <form id="scene-library-search" class="library-filters"><label>Search library<input name="q" type="search" maxlength="120" placeholder="Search names or tags" autocomplete="off"></label><label>Filter by tag<select name="tag"><option value="">All tags</option></select></label><button type="submit" class="sr-only">Search</button></form>
        <div class="library-count-row"><p id="scene-library-count" class="library-count" role="status"></p>${button('refresh-library', 'Refresh', undefined, 'class="library-refresh"')}</div>
        <p id="scene-library-message" class="library-message" role="status" hidden></p>
      </div>
      <section id="scene-library-results-panel" class="library-body" role="tabpanel" aria-labelledby="scene-library-tab-models" tabindex="0">
        <ul id="scene-library-results" class="library-results" aria-label="Saved models"></ul>
        <div id="scene-library-pages" class="scene-pages" hidden>${button('library-prev', 'Previous', undefined, 'class="secondary"')}<span></span>${button('library-next', 'Next', undefined, 'class="secondary"')}</div>
      </section>
    </dialog>
    <dialog id="scene-save-dialog" class="model-library model-save-dialog instrument scene-dialog" aria-labelledby="scene-save-title">
      <header class="library-header"><div><h2 id="scene-save-title">Save scene</h2><p id="scene-save-description"></p></div>${iconButton('close-save', 'Close save scene', 'close')}</header>
      <div class="library-body"><form id="scene-save-form"><fieldset>
        <label>Scene name<input name="name" maxlength="60" required autocomplete="off"></label>
        <label>Tags<input name="tags" maxlength="838" placeholder="e.g. landscape, architecture" aria-describedby="scene-tags-help" autocomplete="off"></label>
        <p id="scene-tags-help" class="panel-note">Separate tags with commas. Up to 20 tags, 40 characters each.</p>
        <div class="library-save-actions"><button type="submit" class="primary" id="scene-save-submit">Save to server</button><button type="submit" name="copy" class="secondary" id="scene-save-copy">Save a copy</button></div>
        <p class="panel-note">Saves this scene and its shared model assets. Texture image files and undo history are not included.</p>
        <p id="scene-texture-warning" class="panel-note" hidden>Texture images are loaded in this session. They will not be included in the saved scene or .vscene export; keep the original image files separately.</p>
      </fieldset></form><p id="scene-save-message" class="library-message" role="status" hidden></p></div>
    </dialog>
    <input id="scene-vox-file" type="file" accept=".vox" hidden>
    <input id="scene-file" type="file" accept=".vscene" hidden>`
  root.append(element)
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => element.querySelector<T>(selector)!
  const abort = new AbortController()
  const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Document | Window, type: K, listener: (event: HTMLElementEventMap[K]) => void) => target.addEventListener(type, listener as EventListener, { signal: abort.signal })
  const inspector = $('#scene-inspector')
  const browser = $<HTMLDialogElement>('#scene-browser')
  const saveDialog = $<HTMLDialogElement>('#scene-save-dialog')
  const saveForm = $<HTMLFormElement>('#scene-save-form')
  const transformForm = $<HTMLFormElement>('#scene-transform-form')
  const searchForm = $<HTMLFormElement>('#scene-library-search')
  const librarySearch = searchForm.elements.namedItem('q') as HTMLInputElement
  const libraryTag = searchForm.elements.namedItem('tag') as HTMLSelectElement
  const popovers = [...element.querySelectorAll<HTMLElement>('[popover]')]
  let visible = false
  let disposed = false
  let externalBusy = false
  let localBusy = false
  let waiting = ''
  let activeTool: SceneTool = 'select'
  let transformMode: TransformMode = 'translate'
  let placing: string | undefined
  let rendering = false
  let documentIdentity: SceneDocument | undefined
  let recovery: { scene: SceneDocument; state: 'saved' | 'saving' | 'error'; message?: string } | undefined
  let clipboard: { sceneId: string; instances: SceneInstance[] } | undefined
  let pasteCount = 0
  let assetOffset = 0
  let instanceOffset = 0
  let libraryOffset = 0
  let libraryTotal = 0
  let libraryKind: 'models' | 'scenes' = 'models'
  let browseGeneration = 0
  let browsing: AbortController | undefined
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  let shortcutUntil = 0
  let saveIdentity: SceneDocument | undefined
  let transformIdentity = ''
  let countedScene: SceneManifest | undefined
  let totalSceneVoxels = 0
  let returnFocus: HTMLElement | null = null
  const markup = new WeakMap<HTMLElement, string>()
  const blocked = () => disposed || !visible || externalBusy || localBusy
  const selection = () => {
    const { scene } = host.current()
    const ids = new Set(scene.selection)
    return scene.data.instances.filter(instance => ids.has(instance.id))
  }
  const editable = (instance: SceneInstance) => host.current().scene.data.layers.some(layer => layer.id === instance.layerId && layer.visible && !layer.locked)

  function message(target: HTMLElement, text: string, error = false) {
    target.textContent = text
    target.hidden = !text
    target.dataset.error = String(error)
  }

  function report(error: unknown, target?: HTMLElement) {
    if (disposed) return
    const text = error instanceof Error ? error.message : 'This action could not be completed. Please retry.'
    if (target && !disposed) message(target, text, true)
    host.notify(text)
  }

  async function run(action: () => void | Promise<void>, label = 'Working...', target?: HTMLElement) {
    if (blocked()) return
    try {
      const pending = action()
      if (pending) {
        localBusy = true
        waiting = label
        render()
        await pending
      }
    }
    catch (error) { report(error, target) }
    finally { localBusy = false; waiting = ''; if (!disposed) render() }
  }

  function replaceList(target: HTMLElement, html: string) {
    if (markup.get(target) === html) return
    const focused = target.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.sceneFocus : undefined
    const scroll = target.scrollTop
    target.innerHTML = html
    markup.set(target, html)
    target.scrollTop = scroll
    if (focused) target.querySelector<HTMLElement>(`[data-scene-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
  }

  function closePopovers() {
    clearTimeout(hoverTimer)
    for (const popup of popovers) if (popup.matches(':popover-open')) popup.hidePopover()
  }

  function showInspector(tab: 'scene' | 'instance' | 'render' = 'scene', focus = true) {
    closePopovers()
    inspector.hidden = false
    inspector.inert = false
    inspector.dataset.open = 'true'
    element.dataset.inspector = 'true'
    $('[data-scene-action="inspector"]').setAttribute('aria-expanded', 'true')
    for (const item of element.querySelectorAll<HTMLButtonElement>('[data-scene-tab]')) {
      const selected = item.dataset.sceneTab === tab
      item.setAttribute('aria-selected', String(selected))
      item.tabIndex = selected ? 0 : -1
      $(`#scene-panel-${item.dataset.sceneTab}`).hidden = !selected
    }
    if (focus) $(`#scene-tab-${tab}`).focus()
  }

  function closeInspector(focus = true) {
    inspector.hidden = true
    inspector.inert = true
    delete inspector.dataset.open
    delete element.dataset.inspector
    $('[data-scene-action="inspector"]').setAttribute('aria-expanded', 'false')
    if (focus) $('[data-scene-action="inspector"]').focus()
  }

  function chooseTool(tool: SceneTool, open = false) {
    if (blocked() || rendering) return
    if (tool !== 'place' && placing) { host.place(); placing = undefined }
    host.tool(tool)
    activeTool = tool
    if (tool === 'transform') host.transform(transformMode)
    closeInspector(false)
    if (open) { closePopovers(); $(`#scene-${tool}-popup`).showPopover() }
    render()
    if (open) $(`#scene-${tool}-popup`).querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true })
  }

  function chooseTransform(mode: TransformMode) {
    chooseTool('transform')
    host.transform(mode)
    transformMode = mode
    closePopovers()
    render()
  }

  function syncSaveForm() {
    const { scene, library, hasTextureMaps } = host.current()
    saveIdentity = scene
    ;(saveForm.elements.namedItem('name') as HTMLInputElement).value = scene.data.name
    ;(saveForm.elements.namedItem('tags') as HTMLInputElement).value = library?.tags.join(', ') ?? ''
    $('#scene-save-submit').textContent = library ? 'Save changes' : 'Save to server'
    $('#scene-save-copy').hidden = !library
    $('#scene-save-description').textContent = !library ? 'Not saved to server' : library.dirty ? 'Unsaved server changes' : 'Saved to server'
    $('#scene-texture-warning').hidden = !hasTextureMaps
  }

  function confirmTextureOmission() {
    return !host.current().hasTextureMaps || confirm('Texture image files are not included in saved scenes or .vscene exports. Keep the originals separately. Continue without these images?')
  }

  async function insertModel(snapshot: ProjectSnapshot, source?: { id: string; version: number }) {
    const { scene } = host.current()
    const assetIds = new Set(scene.data.assets.map(asset => asset.id))
    await host.insertModel(snapshot, source)
    // Blank insertion owns placement and editor entry in the host; do not re-enter or change tools on return.
    if (disposed || !visible || host.current().scene !== scene || !snapshot.chunks.length) return
    const asset = scene.data.assets.find(asset => !assetIds.has(asset.id))
    if (asset && !scene.data.instances.some(instance => instance.assetId === asset.id)) {
      activeTool = 'place'
      placing = asset.id
      host.tool('place')
      host.place(asset.id)
      closePopovers()
      closeInspector(false)
    }
  }

  function openDialog(panel: HTMLDialogElement) {
    closePopovers()
    returnFocus = $('[data-scene-action="menu"]')
    for (const other of [browser, saveDialog]) if (other !== panel && other.open) other.close()
    if (!panel.open) panel.showModal()
  }

  function setLibraryKind(kind: 'models' | 'scenes') {
    libraryKind = kind
    libraryOffset = 0
    libraryTag.replaceChildren(new Option('All tags', ''))
    for (const tab of element.querySelectorAll<HTMLButtonElement>('[data-scene-library-tab]')) {
      const selected = tab.dataset.sceneLibraryTab === kind
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    $('#scene-library-results-panel').setAttribute('aria-labelledby', `scene-library-tab-${kind}`)
    $('#scene-library-results').setAttribute('aria-label', `Saved ${kind}`)
    void browse()
  }

  async function browse() {
    clearTimeout(searchTimer)
    browsing?.abort()
    const controller = browsing = new AbortController()
    const generation = ++browseGeneration
    const kind = libraryKind
    const results = $('#scene-library-results')
    message($('#scene-library-message'), '')
    $('#scene-library-count').textContent = `Loading ${kind}...`
    results.setAttribute('aria-busy', 'true')
    results.replaceChildren()
    $('#scene-library-pages').hidden = true
    try {
      const data = kind === 'models'
        ? await modelRequest<{ models: ModelSummary[]; tags: string[]; total: number }>(`?${new URLSearchParams({ q: librarySearch.value.trim(), tag: libraryTag.value, offset: String(libraryOffset) })}`, { signal: controller.signal })
        : await listSceneLibrary(librarySearch.value.trim(), libraryTag.value, libraryOffset)
      if (generation !== browseGeneration || disposed || !browser.open) return
      libraryTotal = data.total
      if (libraryOffset && libraryOffset >= libraryTotal) { libraryOffset = 0; void browse(); return }
      const tag = libraryTag.value
      libraryTag.replaceChildren(new Option('All tags', ''), ...data.tags.map(value => new Option(value, value)))
      if (tag && !data.tags.includes(tag)) libraryTag.add(new Option(tag, tag))
      libraryTag.value = tag
      $('#scene-library-count').textContent = libraryTotal ? `${number.format(libraryTotal)} ${libraryTotal === 1 ? kind.slice(0, -1) : kind}`
        : librarySearch.value || tag ? 'No matches. Try another search or choose All tags.' : `No saved ${kind} yet.`
      const entries = 'models' in data ? data.models : data.scenes
      for (const entry of entries.slice(0, 50)) {
        const row = document.createElement('li')
        row.className = 'library-model'
        const open = document.createElement('button')
        open.type = 'button'
        open.dataset.sceneOpen = entry.id
        open.dataset.sceneOpenKind = kind
        open.disabled = blocked()
        open.className = kind === 'models' ? 'library-preview' : 'scene-library-open'
        open.setAttribute('aria-label', `${kind === 'models' ? 'Insert' : 'Open'} ${entry.name || 'Untitled'}`)
        if (kind === 'models') {
          const state = document.createElement('span')
          state.className = 'library-preview-state'
          state.textContent = 'Loading preview...'
          const image = document.createElement('img')
          image.alt = ''
          image.width = image.height = 256
          image.loading = 'lazy'
          image.decoding = 'async'
          image.addEventListener('load', () => { state.hidden = true }, { once: true })
          image.addEventListener('error', () => { image.hidden = true; state.textContent = 'Preview unavailable' }, { once: true })
          image.src = `/api/models/${encodeURIComponent(entry.id)}/thumbnail.png?v=${entry.version}`
          open.append(state, image)
          const label = document.createElement('span')
          label.className = 'library-open-label'
          label.textContent = 'Insert'
          open.append(label)
        } else {
          open.innerHTML = `${icon('layers')}<span></span>${icon('chevron')}`
          open.querySelector('span')!.textContent = entry.name || 'Untitled scene'
        }
        const info = document.createElement('div')
        const title = document.createElement('strong')
        title.textContent = entry.name || 'Untitled'
        const facts = document.createElement('p')
        facts.className = 'library-model-facts'
        facts.textContent = 'dimensions' in entry ? `${entry.dimensions.x} x ${entry.dimensions.y} x ${entry.dimensions.z} / ${number.format(entry.voxelCount)} voxels` : `${number.format(entry.instanceCount)} instances / ${number.format(entry.assetCount)} shared assets`
        info.append(title, facts)
        const tags = document.createElement('div')
        tags.className = 'library-model-tags'
        for (const value of entry.tags) {
          const filter = document.createElement('button')
          filter.type = 'button'
          filter.dataset.sceneTag = value
          filter.textContent = value
          filter.setAttribute('aria-label', `Filter by tag ${value}`)
          tags.append(filter)
        }
        info.append(tags)
        row.append(open, info)
        results.append(row)
      }
      results.dataset.kind = kind
      $('#scene-library-results-panel').scrollTop = 0
      updatePages('library', libraryOffset, libraryTotal)
    } catch (error) {
      if (generation === browseGeneration && !controller.signal.aborted && !disposed) {
        $('#scene-library-count').textContent = 'Library unavailable. Use Refresh to retry.'
        report(error, $('#scene-library-message'))
      }
    } finally {
      if (generation === browseGeneration) results.removeAttribute('aria-busy')
    }
  }

  function updatePages(kind: 'asset' | 'instance' | 'library', offset: number, total: number) {
    const pages = $(`#scene-${kind}-pages`)
    pages.hidden = total <= 50
    pages.querySelector('span')!.textContent = `${offset + 1}-${Math.min(offset + 50, total)} of ${number.format(total)}`
    pages.querySelector<HTMLButtonElement>('button:first-child')!.disabled = blocked() || offset === 0
    pages.querySelector<HTMLButtonElement>('button:last-child')!.disabled = blocked() || offset + 50 >= total
  }

  function render() {
    if (disposed || !visible) return
    const { scene, library, hasTextureMaps, renderMode } = host.current()
    const data = scene.data
    if (documentIdentity !== scene) {
      documentIdentity = scene
      assetOffset = instanceOffset = 0
      transformIdentity = ''
      placing = undefined
      rendering = false
      $('#scene-voxel-status').textContent = 'Represented voxels not measured'
      $('#scene-resident-status').textContent = 'Resident memory not measured'
      $('#scene-resident-status').removeAttribute('title')
      $('#scene-lod-status').textContent = 'Waiting for renderer'
      $('#scene-lod-status').removeAttribute('title')
      if (clipboard?.sceneId !== data.id) clipboard = undefined
    }
    if (renderMode !== undefined) rendering = renderMode
    const selected = selection()
    const single = selected.length === 1 ? selected[0] : undefined
    const canEdit = selected.length > 0 && selected.every(editable)
    const activeLayer = data.layers.find(layer => layer.id === data.activeLayerId)
    const activeEditable = Boolean(activeLayer?.visible && !activeLayer.locked)
    const canPlace = activeEditable && data.instances.length < MAX_SCENE_INSTANCES
    const busy = blocked()
    const name = $<HTMLInputElement>('#scene-name')
    if (document.activeElement !== name) name.value = data.name
    name.disabled = busy
    $('#scene-save-state').textContent = library ? library.dirty ? 'Unsaved server changes' : 'Saved to server' : 'Not saved to server'
    const local = recovery?.scene === scene ? recovery : undefined
    const localText = local ? `${({ saved: 'Local recovery saved', saving: 'Saving local recovery...', error: 'Local save failed' })[local.state]}${local.message ? `: ${local.message}` : local.state === 'error' ? '. Save to the server or export a .vscene file to keep your changes.' : ''}` : 'Local recovery not confirmed'
    if ($('#scene-local-save-status').textContent !== localText) $('#scene-local-save-status').textContent = localText
    $('#scene-local-save-status').dataset.state = local?.state ?? 'unknown'
    $('#scene-offline-help').hidden = !library
    $('#scene-texture-warning').hidden = !hasTextureMaps
    $('#scene-select-summary').textContent = selected.length ? `${number.format(selected.length)} selected` : 'Instances'
    $('#scene-place-summary').textContent = data.assets.find(asset => asset.id === placing)?.model.name ?? 'Choose model'
    $('#scene-transform-summary').textContent = modes[transformMode]
    $('#scene-layer-summary').textContent = activeLayer?.name ?? 'No layer'
    $('#scene-selection-status').textContent = `${number.format(selected.length)} selected / ${number.format(data.instances.length)} instances`
    $('#scene-select-count').textContent = selected.length ? `${number.format(selected.length)} ${selected.length === 1 ? 'instance' : 'instances'} selected` : 'Select an instance in the scene or list.'
    $('#scene-extent').textContent = `${number.format(data.extent.x)} x ${number.format(data.extent.y)} x ${number.format(data.extent.z)}`
    $('#scene-instance-count').textContent = number.format(data.instances.length)
    message($('#scene-wait-status'), busy ? waiting || 'Please wait for the current operation...' : '')
    element.setAttribute('aria-busy', String(busy))
    element.dataset.rendering = String(rendering)
    $('.scene-dock').inert = rendering || busy
    for (const tool of element.querySelectorAll<HTMLButtonElement>('[data-scene-tool]')) {
      tool.setAttribute('aria-pressed', String(tool.dataset.sceneTool === activeTool))
      tool.disabled = busy || rendering
    }
    for (const mode of element.querySelectorAll<HTMLButtonElement>('[data-scene-transform]')) {
      mode.setAttribute('aria-pressed', String(mode.dataset.sceneTransform === transformMode))
      mode.disabled = busy || rendering
    }
    $('[data-scene-action="render"]').setAttribute('aria-pressed', String(rendering))
    const usage = new Map<string, number>()
    const layerCounts = new Map<number, number>()
    for (const instance of data.instances) {
      usage.set(instance.assetId, (usage.get(instance.assetId) ?? 0) + 1)
      layerCounts.set(instance.layerId, (layerCounts.get(instance.layerId) ?? 0) + 1)
    }
    const assetById = new Map(data.assets.map(asset => [asset.id, asset]))
    const layerById = new Map(data.layers.map(layer => [layer.id, layer]))
    const instanceById = new Map(data.instances.map(instance => [instance.id, instance]))
    const assetQuery = $<HTMLInputElement>('#scene-asset-search').value.trim().toLowerCase()
    const assets = data.assets.filter(asset => asset.model.name.toLowerCase().includes(assetQuery))
    if (assetOffset >= assets.length) assetOffset = 0
    replaceList($('#scene-assets'), assets.slice(assetOffset, assetOffset + 50).map(asset => `<li><button type="button" class="scene-asset" data-scene-asset="${escape(asset.id)}" data-scene-focus="asset-${escape(asset.id)}" aria-pressed="${placing === asset.id}">${assetPalette(asset)}<span><strong>${escape(asset.model.name)}</strong><small>${number.format(usage.get(asset.id) ?? 0)} copies / ${number.format(asset.voxelCount)} voxels</small></span></button></li>`).join('') || `<li class="scene-empty">${assetQuery ? 'No matching scene assets.' : 'No assets yet. Browse models, import VOX, or create a blank model.'}</li>`)
    for (const item of element.querySelectorAll<HTMLButtonElement>('[data-scene-asset]')) item.disabled = busy || !canPlace
    updatePages('asset', assetOffset, assets.length)
    const instanceQuery = $<HTMLInputElement>('#scene-instance-search').value.trim().toLowerCase()
    const instances = data.instances.filter(instance => `${instance.name} ${assetById.get(instance.assetId)?.model.name ?? ''}`.toLowerCase().includes(instanceQuery))
    if (instanceOffset >= instances.length) instanceOffset = 0
    const selectedIds = new Set(scene.selection)
    replaceList($('#scene-instances'), instances.slice(instanceOffset, instanceOffset + 50).map(instance => {
      const layer = layerById.get(instance.layerId)!
      return `<li class="scene-instance-row"><label><input type="checkbox" data-scene-select="${escape(instance.id)}" data-scene-focus="select-${escape(instance.id)}" ${selectedIds.has(instance.id) ? 'checked' : ''} aria-label="Select ${escape(instance.name)}"><span><strong>${escape(instance.name)}</strong><small>${escape(layer.name)}${layer.visible ? '' : ' / Hidden'}${layer.locked ? ' / Locked' : ''}</small></span></label>${iconButton('inspect-instance', `Inspect ${escape(instance.name)}`, 'chevron', `data-scene-id="${escape(instance.id)}" data-scene-focus="inspect-${escape(instance.id)}"`)}</li>`
    }).join('') || `<li class="scene-empty">${instanceQuery ? 'No matching instances.' : 'Your scene is empty. Insert a model to begin.'}</li>`)
    for (const item of element.querySelectorAll<HTMLInputElement>('[data-scene-select]')) {
      const instance = instanceById.get(item.dataset.sceneSelect!)!
      item.disabled = busy || !layerById.get(instance.layerId)!.visible
      item.checked = selectedIds.has(instance.id)
    }
    updatePages('instance', instanceOffset, instances.length)
    replaceList($('#scene-layers'), [...data.layers].reverse().map(layer => `<li class="scene-layer-row" data-active="${layer.id === data.activeLayerId}">
      <div class="scene-layer-name">${button('activate-layer', layer.id === data.activeLayerId ? 'Active' : 'Use', undefined, `data-scene-layer="${layer.id}" data-scene-focus="active-${layer.id}" aria-pressed="${layer.id === data.activeLayerId}" aria-label="Activate ${escape(layer.name)}"`)}<label><span class="sr-only">Layer name</span><input data-scene-layer-name="${layer.id}" data-scene-focus="name-${layer.id}" value="${escape(layer.name)}" maxlength="40" required aria-label="Rename ${escape(layer.name)}"></label></div>
      <div class="scene-layer-controls"><small>${number.format(layerCounts.get(layer.id) ?? 0)} instances</small>${iconButton('visibility-layer', `${layer.visible ? 'Hide' : 'Show'} ${escape(layer.name)}`, layer.visible ? 'eye' : 'eye-off', `data-scene-layer="${layer.id}" data-scene-focus="visibility-${layer.id}" aria-pressed="${layer.visible}"`)}${iconButton('lock-layer', `${layer.locked ? 'Unlock' : 'Lock'} ${escape(layer.name)}`, layer.locked ? 'lock' : 'unlock', `data-scene-layer="${layer.id}" data-scene-focus="lock-${layer.id}" aria-pressed="${layer.locked}"`)}${iconButton('delete-layer', `Delete ${escape(layer.name)}`, 'trash', `data-scene-layer="${layer.id}" data-scene-focus="delete-${layer.id}"`)}</div>
    </li>`).join(''))
    for (const input of element.querySelectorAll<HTMLInputElement>('[data-scene-layer-name]')) {
      const layer = data.layers.find(layer => layer.id === Number(input.dataset.sceneLayerName))!
      input.disabled = busy || !layer.visible || layer.locked
      if (document.activeElement !== input) input.value = layer.name
    }
    $('#scene-instance-title').textContent = single?.name ?? (selected.length ? `${number.format(selected.length)} instances selected` : 'No instance selected')
    $('#scene-instance-help').textContent = single ? editable(single) ? 'Apply all nine values as one undoable transform.' : 'This instance is on a hidden or locked layer. Show and unlock its layer to edit.' : selected.length ? 'Use the viewport gizmo to transform this group. Exact fields are available for a single instance.' : 'Select an instance in the viewport or the Scene list.'
    const asset = single && assetById.get(single.assetId)
    $('#scene-shared-help').textContent = asset ? `"${asset.model.name}" is shared by ${number.format(usage.get(asset.id) ?? 0)} copies in this scene. Edit model changes every copy, including hidden or locked copies; layer locks protect instances, not shared model content. Make unique detaches only this instance. The source library model is not changed.` : ''
    const nextIdentity = single ? JSON.stringify([data.id, single]) : ''
    if (nextIdentity !== transformIdentity) {
      transformIdentity = nextIdentity
      const rotation = single && new Euler().setFromQuaternion(new Quaternion(single.rotation.x, single.rotation.y, single.rotation.z, single.rotation.w), 'XYZ')
      for (const group of ['position', 'rotation', 'scale'] as const) for (const axis of axes) {
        const value = !single ? '' : group === 'rotation' ? rotation![axis] * 180 / Math.PI : single[group][axis]
        ;(transformForm.elements.namedItem(`${group}-${axis}`) as HTMLInputElement).value = typeof value === 'number' ? String(Number(value.toFixed(6))) : value
      }
    }
    transformForm.querySelector('fieldset')!.disabled = busy || !single || !canEdit
    for (const axis of axes) {
      const input = transformForm.elements.namedItem(`position-${axis}`) as HTMLInputElement
      input.min = String(axis === 'y' ? 0 : -data.extent[axis] / 2)
      input.max = String(axis === 'y' ? data.extent[axis] : data.extent[axis] / 2)
    }
    for (const input of element.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-scene-setting]')) {
      const key = input.dataset.sceneSetting as keyof ViewSettings
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(data.settings[key])
      else if (document.activeElement !== input) input.value = String(data.settings[key])
      input.disabled = busy
      updateSettingOutput(input)
    }
    $('#scene-tilt-shift-controls').hidden = !data.settings.tiltShift
    $<HTMLInputElement>('#scene-snap').disabled = busy
    $<HTMLSelectElement>('#scene-capture-quality').disabled = busy
    saveForm.querySelector('fieldset')!.disabled = busy
    for (const item of element.querySelectorAll<HTMLButtonElement>('[data-scene-open]')) item.disabled = busy
    for (const item of element.querySelectorAll<HTMLButtonElement>('[data-scene-action]')) {
      const action = item.dataset.sceneAction!
      if (/^(asset|instance|library)-(prev|next)$/.test(action)) continue
      const unavailable = action === 'undo' ? !scene.canUndo : action === 'redo' ? !scene.canRedo
        : ['edit-model', 'make-unique'].includes(action) ? !single || !canEdit
        : ['cut', 'delete'].includes(action) ? !canEdit
        : ['copy', 'clear-selection'].includes(action) ? !selected.length
        : action === 'paste' ? !clipboard?.instances.length || !canPlace || data.instances.length + clipboard.instances.length > MAX_SCENE_INSTANCES
        : action === 'assign-layer' ? !canEdit || !activeEditable
        : action === 'delete-layer' ? data.layers.length < 2 || !data.layers.some(layer => layer.id === Number(item.dataset.sceneLayer) && layer.visible && !layer.locked)
        : action === 'inspect-instance' ? !layerById.get(instanceById.get(item.dataset.sceneId!)!.layerId)!.visible
        : ['browse-models', 'import-vox', 'blank-model'].includes(action) ? !canPlace
        : action === 'place-origin' ? !placing || !assetById.has(placing) || !canPlace
        : action === 'cancel-place' ? !placing : false
      item.disabled = (busy && !['close-browser', 'close-save', 'close-inspector', 'menu'].includes(action)) || unavailable
    }
  }

  function assetPalette(asset: SceneAsset) {
    const used = new Set<number>()
    for (const chunk of asset.chunks) {
      for (const color of chunk.colors) { used.add(color); if (used.size === 4) break }
      if (used.size === 4) break
    }
    const colors = [...used].filter(index => index > 0).slice(0, 4).map(index => `#${(asset.model.palette[index] ?? 0).toString(16).padStart(6, '0')}`)
    if (!colors.length) return icon('box')
    return `<svg class="scene-asset-palette" viewBox="0 0 32 32" aria-hidden="true">${colors.map((color, index) => `<rect x="${index % 2 * 16 + 1}" y="${Math.floor(index / 2) * 16 + 1}" width="14" height="14" rx="2" fill="${color}"/>`).join('')}</svg>`
  }

  async function clipboardAction(action: 'copy' | 'cut' | 'paste') {
    const { scene } = host.current()
    if (action !== 'paste') {
      const selected = selection()
      if (!selected.length) return
      if (action === 'cut' && !selected.every(editable)) throw new Error('Show and unlock the selected layers before cutting.')
      clipboard = { sceneId: scene.data.id, instances: structuredClone(selected) }
      pasteCount = 0
      if (action === 'cut') await host.command({ type: 'instances.delete', ids: selected.map(instance => instance.id) })
      host.notify(`${number.format(selected.length)} ${selected.length === 1 ? 'instance' : 'instances'} ${action === 'copy' ? 'copied' : 'cut'}. Copies share the scene asset.`)
    } else {
      if (!clipboard?.instances.length || clipboard.sceneId !== scene.data.id) throw new Error('Copy instances from this scene before pasting.')
      if (clipboard.instances.some(instance => !scene.data.assets.some(asset => asset.id === instance.assetId))) throw new Error('A copied asset is no longer in this scene. Copy the instances again.')
      const offset = 8 * (pasteCount + 1)
      const shift = (axis: 'x' | 'z') => {
        const positions = clipboard!.instances.map(instance => instance.position[axis])
        const forward = Math.min(offset, scene.data.extent[axis] / 2 - Math.max(...positions))
        return forward > 0 ? forward : Math.max(-offset, -scene.data.extent[axis] / 2 - Math.min(...positions))
      }
      const x = shift('x'), z = shift('z')
      if (!x && !z) throw new Error('There is no room to offset these copies. Move the selection away from the scene boundary, then copy again.')
      const instances = clipboard.instances.map(instance => ({ ...structuredClone(instance), id: crypto.randomUUID(), layerId: scene.data.activeLayerId, position: { x: instance.position.x + x, y: instance.position.y, z: instance.position.z + z } }))
      await host.command({ type: 'instances.insert', instances })
      pasteCount++
      if (host.current().scene !== scene) return
      host.tool('transform')
      host.transform('translate')
      activeTool = 'transform'
      transformMode = 'translate'
      host.notify(`Pasted ${number.format(instances.length)} ${instances.length === 1 ? 'instance' : 'instances'}, offset X ${x}, Z ${z} voxels. Use Move to adjust.`)
    }
  }

  function replacementAllowed() {
    const { scene, library } = host.current()
    return !scene.data.instances.length && !scene.data.assets.length && !scene.canUndo && !library?.dirty || confirm('Replace this scene and its undo history? Save or export any scene changes you want to keep first.')
  }

  async function handleAction(action: string, source?: HTMLButtonElement) {
    if (['menu', 'close-browser', 'close-save', 'close-inspector'].includes(action)) {
      if (action === 'close-browser') browser.close()
      if (action === 'close-save') saveDialog.close()
      if (action === 'close-inspector') closeInspector()
      return
    }
    if (blocked()) return
    if (rendering && ['copy', 'cut', 'paste', 'delete'].includes(action)) return
    if (source?.closest('#scene-project-menu')) closePopovers()
    switch (action) {
      case 'undo': case 'redo': return run(async () => { host.place(); placing = undefined; await host.command({ type: action === 'undo' ? 'history.undo' : 'history.redo' }) })
      case 'frame': host.frame(); return
      case 'render': {
        const next = !rendering
        host.renderMode(); rendering = host.current().renderMode ?? next; closePopovers()
        if (rendering && !matchMedia('(max-width: 840px)').matches) showInspector('render', false)
        render(); return
      }
      case 'inspector': inspector.hidden ? showInspector() : closeInspector(); return
      case 'instance-list': showInspector('scene'); $('#scene-instance-search').focus(); return
      case 'instance-panel': showInspector('instance'); return
      case 'save': syncSaveForm(); message($('#scene-save-message'), ''); openDialog(saveDialog); return
      case 'browse-models': case 'browse-scenes': openDialog(browser); setLibraryKind(action === 'browse-models' ? 'models' : 'scenes'); librarySearch.focus(); return
      case 'refresh-library': await browse(); return
      case 'library-prev': case 'library-next': libraryOffset = Math.max(0, libraryOffset + (action === 'library-next' ? 50 : -50)); await browse(); return
      case 'asset-prev': case 'asset-next': assetOffset = Math.max(0, assetOffset + (action === 'asset-next' ? 50 : -50)); render(); return
      case 'instance-prev': case 'instance-next': instanceOffset = Math.max(0, instanceOffset + (action === 'instance-next' ? 50 : -50)); render(); return
      case 'import-vox': $('#scene-vox-file').click(); closePopovers(); return
      case 'import-scene': $('#scene-file').click(); closePopovers(); return
      case 'export-scene':
        if (!confirmTextureOmission()) return
        return run(async () => {
          const snapshot = structuredClone(host.current().scene.data)
          await exportSceneFile(snapshot)
          host.notify('Scene file exported, including its shared model assets but not texture image files.')
        }, 'Exporting scene...')
      case 'new-scene': if (replacementAllowed()) return run(() => host.newScene(), 'Creating scene...'); return
      case 'leave': return run(() => host.leaveScene(), 'Returning to model editor...')
      case 'capture': {
        const exact = $<HTMLSelectElement>('#scene-capture-quality').value === 'full'
        return run(() => host.capture(exact), exact ? 'Preparing full-scene PNG...' : 'Capturing viewport detail PNG...')
      }
      case 'blank-model':
        closePopovers()
        return run(() => insertModel(encodeProjectSnapshot(new VoxelDocument({ x: 32, y: 32, z: 32 }, 'Untitled model'), host.current().scene.data.settings)), 'Creating blank model...')
      case 'edit-model': {
        const selected = selection()
        if (selected.length === 1 && editable(selected[0])) { closePopovers(); return run(() => host.editModel(selected[0].id), 'Opening model editor...') }
        return
      }
      case 'make-unique': {
        const selected = selection()
        if (selected.length === 1 && editable(selected[0])) return run(() => host.command({ type: 'instance.unique', id: selected[0].id }), 'Making a unique asset...')
        return
      }
      case 'copy': case 'cut': case 'paste': closePopovers(); return run(() => clipboardAction(action))
      case 'delete': return run(() => host.command({ type: 'instances.delete', ids: selection().map(instance => instance.id) }))
      case 'clear-selection': return run(() => host.command({ type: 'selection.set', ids: [] }))
      case 'cancel-place': host.place(); placing = undefined; render(); return
      case 'place-origin': {
        const assetId = placing, scene = host.current().scene
        if (!assetId) return
        return run(async () => {
          await host.command({ type: 'instance.place', assetId, position: { x: 0, y: 0, z: 0 } })
          if (disposed || !visible || host.current().scene !== scene) return
          host.place(); placing = undefined
          showInspector('instance')
        })
      }
      case 'add-layer': return run(() => host.command({ type: 'layer.create' }))
      case 'assign-layer': return run(() => host.command({ type: 'instances.layer', ids: [...host.current().scene.selection], layerId: host.current().scene.data.activeLayerId }))
      case 'inspect-instance': {
        const id = source?.dataset.sceneId
        if (id) await run(async () => { await host.command({ type: 'selection.set', ids: [id] }); showInspector('instance') })
        return
      }
      case 'activate-layer': case 'visibility-layer': case 'lock-layer': case 'delete-layer': {
        const { scene } = host.current()
        const layer = scene.data.layers.find(item => item.id === Number(source?.dataset.sceneLayer))
        if (!layer) return
        if (action === 'delete-layer') {
          const count = scene.data.instances.filter(instance => instance.layerId === layer.id).length
          if (!confirm(`Delete "${layer.name}"${count ? ` and its ${number.format(count)} instances` : ''}? This can be undone.`)) return
        }
        return run(() => host.command(action === 'activate-layer' ? { type: 'layer.activate', id: layer.id }
          : action === 'visibility-layer' ? { type: 'layer.visibility', id: layer.id, visible: !layer.visible }
          : action === 'lock-layer' ? { type: 'layer.lock', id: layer.id, locked: !layer.locked }
          : { type: 'layer.delete', id: layer.id, allowNonEmpty: true }))
      }
    }
  }

  on(element, 'click', event => {
    const target = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!target || target.disabled) return
    const action = target.dataset.sceneAction
    if (action) { void handleAction(action, target).catch(error => report(error)); return }
    if (blocked()) return
    try {
      if (target.dataset.sceneTool) chooseTool(target.dataset.sceneTool as SceneTool)
      if (target.dataset.sceneTransform) chooseTransform(target.dataset.sceneTransform as TransformMode)
      if (target.dataset.sceneTab) showInspector(target.dataset.sceneTab as 'scene' | 'instance' | 'render')
      if (target.dataset.sceneLibraryTab) setLibraryKind(target.dataset.sceneLibraryTab as 'models' | 'scenes')
      if (target.dataset.sceneAsset) {
        host.tool('place'); host.place(target.dataset.sceneAsset)
        activeTool = 'place'; placing = target.dataset.sceneAsset; closePopovers(); render()
      }
      if (target.dataset.sceneTag !== undefined) { libraryTag.value = target.dataset.sceneTag; libraryOffset = 0; void browse() }
      if (target.dataset.sceneOpen) {
        const id = target.dataset.sceneOpen
        const kind = target.dataset.sceneOpenKind
        if (kind === 'scenes' && !replacementAllowed()) return
        void run(async () => {
          const captured = host.current().scene
          const revision = captured.data.revision
          if (kind === 'models') {
            const model = await modelRequest<ModelSummary & { snapshot: unknown }>(`/${encodeURIComponent(id)}`)
            let snapshot: ProjectSnapshot
            try {
              snapshot = parseProjectSnapshot(model.snapshot)
              if (model.id !== id || !Number.isSafeInteger(model.version) || model.version < 1) throw new Error('Invalid model source reference.')
            } catch { throw new Error('This saved model is invalid. Choose another model, or open and re-save its source in the model editor.') }
            if (disposed || !visible || host.current().scene !== captured) throw new Error('The scene changed while loading. Reopen the library to insert this model.')
            await insertModel(snapshot, { id: model.id, version: model.version })
          } else {
            const opened = await openLibraryScene(id)
            if (disposed || !visible || host.current().scene !== captured || captured.data.revision !== revision) throw new Error('The scene changed while loading. Nothing was replaced. Save your changes, then retry.')
            await host.openScene(opened.snapshot, opened.library)
          }
          browser.close()
        }, kind === 'models' ? 'Inserting model...' : 'Opening scene...', $('#scene-library-message'))
      }
    } catch (error) { report(error) }
  })

  function updateSettingOutput(input: HTMLInputElement | HTMLSelectElement) {
    const key = input.dataset.sceneSetting!
    const output = element.querySelector(`#scene-output-${key}`)
    if (!output) return
    const text = key.startsWith('tiltShift') ? `${Math.round(Number(input.value) * 100)}%` : `${input.value}${key === 'lightAzimuth' ? ' deg' : ''}`
    output.textContent = text
    input.setAttribute('aria-valuetext', text)
  }

  on($('#scene-panel-render'), 'input', event => {
    const input = event.target as HTMLInputElement
    // Keep one undo entry per slider change; dragging only previews its numeric value.
    if (!blocked() && input.type === 'range' && input.dataset.sceneSetting) updateSettingOutput(input)
  })

  on(element, 'change', event => {
    const target = event.target as HTMLInputElement | HTMLSelectElement
    if (blocked()) return
    try {
      if (target.id === 'scene-name') {
        if (!target.value.trim()) { report(new Error('Enter a scene name.')); target.value = host.current().scene.data.name; return }
        void run(() => host.command({ type: 'scene.rename', name: target.value.trim() }))
      }
      if (target.dataset.sceneSelect) {
        const ids = new Set(host.current().scene.selection)
        if ((target as HTMLInputElement).checked) ids.add(target.dataset.sceneSelect)
        else ids.delete(target.dataset.sceneSelect)
        void run(() => host.command({ type: 'selection.set', ids: [...ids] }))
      }
      if (target.dataset.sceneLayerName) void run(() => host.command({ type: 'layer.rename', id: Number(target.dataset.sceneLayerName), name: target.value.trim() }))
      if (target.id === 'scene-snap') host.snap((target as HTMLInputElement).checked)
      if (target.dataset.sceneSetting) {
        const key = target.dataset.sceneSetting as keyof ViewSettings
        const value = target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.type === 'range' ? Number(target.value) : target.value
        host.settings({ [key]: value }); render()
      }
    } catch (error) { report(error) }
  })

  on(transformForm, 'submit', event => {
    event.preventDefault()
    if (blocked()) return
    const selected = selection()
    if (selected.length !== 1 || !editable(selected[0]) || !transformForm.reportValidity()) return
    const values = (group: string) => {
      const value = (axis: string) => (transformForm.elements.namedItem(`${group}-${axis}`) as HTMLInputElement).valueAsNumber
      return { x: value('x'), y: value('y'), z: value('z') }
    }
    const position = values('position'), rotation = values('rotation'), scale = values('scale')
    if (![...Object.values(position), ...Object.values(rotation), ...Object.values(scale)].every(Number.isFinite)) { report(new Error('Enter finite numbers in all transform fields.')); return }
    const quaternion = new Quaternion().setFromEuler(new Euler(rotation.x * Math.PI / 180, rotation.y * Math.PI / 180, rotation.z * Math.PI / 180, 'XYZ'))
    void run(() => host.command({ type: 'instances.transform', transforms: [{ id: selected[0].id, position, rotation: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }, scale }] }))
  })

  on(saveForm, 'submit', event => {
    event.preventDefault()
    if (blocked()) return
    const name = (saveForm.elements.namedItem('name') as HTMLInputElement).value.trim()
    const tags = [...new Set((saveForm.elements.namedItem('tags') as HTMLInputElement).value.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean))]
    if (!name || tags.length > 20 || tags.some(tag => tag.length > 40 || /\p{Cc}/u.test(tag))) { message($('#scene-save-message'), 'Enter a name and up to 20 tags, each at most 40 characters without control characters.', true); return }
    if (host.current().scene !== saveIdentity) { syncSaveForm(); message($('#scene-save-message'), 'The scene was replaced. Review its name and tags before saving.', true); return }
    if (!confirmTextureOmission()) return
    const copy = (event as SubmitEvent).submitter?.getAttribute('name') === 'copy'
    void run(async () => {
      const scene = host.current().scene
      await host.command({ type: 'scene.rename', name })
      if (host.current().scene !== scene) throw new Error('The scene was replaced before saving. Reopen Save scene.')
      const snapshot = structuredClone(scene.data)
      const library = copy ? undefined : host.current().library
      message($('#scene-save-message'), 'Saving scene and model assets to the server...')
      const saved = await saveLibraryScene(snapshot, tags, library)
      const current = host.current().scene
      // A late save may advance the same scene's CAS link, but must not clean newer edits or link a replacement.
      if (!disposed && current === scene && current.data.id === snapshot.id) {
        host.librarySaved({ ...saved, dirty: current.data.revision !== snapshot.revision })
        if (saveIdentity === scene) syncSaveForm()
        message($('#scene-save-message'), `Saved "${snapshot.name}".${current.data.revision !== snapshot.revision ? ' Newer scene changes still need saving.' : ''}`)
      } else if (!disposed) host.notify(`Saved "${snapshot.name}". The current scene was not changed.`)
    }, 'Saving scene...', $('#scene-save-message'))
  })

  for (const [id, vox] of [['scene-vox-file', true], ['scene-file', false]] as const) on($(`#${id}`), 'change', event => {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || blocked() || !vox && !replacementAllowed()) return
    void run(async () => {
      const scene = host.current().scene
      const revision = scene.data.revision
      if (vox) {
        if (file.size > 100 * 1024 * 1024) throw new Error('This VOX file exceeds 100 MiB. Import a smaller model.')
        const imported = importVox(await file.arrayBuffer(), file.name)
        if (disposed || !visible || host.current().scene !== scene) throw new Error('The scene changed before import completed. Please import again.')
        await insertModel(encodeProjectSnapshot(imported.document, scene.data.settings))
        if (imported.warning) host.notify(imported.warning)
      } else {
        const snapshot = await importSceneFile(file)
        if (disposed || !visible || host.current().scene !== scene || scene.data.revision !== revision) throw new Error('The scene changed during import. Nothing was replaced. Save your changes and retry.')
        await host.openScene(snapshot)
      }
    }, vox ? 'Importing model...' : 'Importing scene...')
  })

  for (const id of ['scene-asset-search', 'scene-instance-search']) on($(`#${id}`), 'input', () => { if (id === 'scene-asset-search') assetOffset = 0; else instanceOffset = 0; render() })
  on(librarySearch, 'input', () => {
    libraryOffset = 0
    browsing?.abort()
    browseGeneration++
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { void browse() }, 200)
  })
  on(libraryTag, 'change', () => { libraryOffset = 0; void browse() })
  on(searchForm, 'submit', event => { event.preventDefault(); libraryOffset = 0; void browse() })
  for (const panel of [browser, saveDialog]) {
    on(panel, 'close', () => {
      if (panel === browser) { browsing?.abort(); browseGeneration++; clearTimeout(searchTimer) }
      if (visible && !disposed && !browser.open && !saveDialog.open) returnFocus?.focus({ preventScroll: true })
    })
  }
  on(element, 'keydown', event => {
    const target = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]')
    if (!target || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = [...target.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(target) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    event.preventDefault()
    tabs[index].click()
    tabs[index].focus()
  })
  on(keyboardRoot, 'keydown', event => {
    const target = event.target instanceof Element ? event.target : document.activeElement
    if (!visible || disposed || event.defaultPrevented || event.repeat || target?.closest('.voxel-assistant, input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog') || browser.open || saveDialog.open) return
    const key = event.key.toLowerCase()
    if (event.altKey) return
    let action: string | undefined
    if (event.ctrlKey || event.metaKey) {
      action = key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' ? 'redo' : key === 'c' ? 'copy' : key === 'x' ? 'cut' : key === 'v' ? 'paste' : undefined
    } else if (key === 'escape') {
      closePopovers(); closeInspector(false); shortcutUntil = 0
      if (!blocked()) {
        try { host.place(); placing = undefined } catch (error) { report(error) }
        void run(() => host.command({ type: 'selection.set', ids: [] }))
      }
      return
    } else if (!blocked() && !rendering) {
      const tool = ({ q: 'select', w: 'place', s: 'transform', l: 'layer' } as Record<string, SceneTool>)[key]
      if (tool) {
        event.preventDefault()
        shortcutUntil = key === 's' ? performance.now() + 1600 : 0
        try { chooseTool(tool, true) } catch (error) { report(error) }
        return
      }
      if (shortcutUntil > performance.now() && ['1', '2', '3'].includes(key)) {
        event.preventDefault(); shortcutUntil = 0
        try { chooseTransform((['translate', 'rotate', 'scale'] as const)[Number(key) - 1]) } catch (error) { report(error) }
        return
      }
      action = key === 'delete' || key === 'backspace' ? 'delete' : key === 'f' ? 'frame' : key === 'r' ? 'render' : undefined
    } else if (key === 'r' && rendering) action = 'render'
    if (action) { event.preventDefault(); void handleAction(action).catch(error => report(error)) }
  })
  for (const trigger of element.querySelectorAll<HTMLButtonElement>('[data-scene-tool]')) {
    const popup = $(`#${trigger.getAttribute('popovertarget')}`)
    const leave = () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { if (popup.matches(':popover-open') && !popup.contains(document.activeElement)) popup.hidePopover() }, 180) }
    on(trigger, 'pointerenter', event => {
      if (event.pointerType !== 'mouse' || !matchMedia('(hover: hover) and (pointer: fine)').matches || blocked() || rendering || browser.open || saveDialog.open) return
      closePopovers(); popup.showPopover()
    })
    on(trigger, 'pointerleave', leave)
    on(popup, 'pointerenter', () => clearTimeout(hoverTimer))
    on(popup, 'pointerleave', leave)
  }
  on(window, 'resize', () => {
    for (const popup of popovers) if (popup.matches(':popover-open')) positionPopover(popup)
  })
  function positionPopover(popup: HTMLElement) {
    const trigger = element.querySelector<HTMLButtonElement>(`[popovertarget="${popup.id}"]`)!
    const box = trigger.getBoundingClientRect()
    const width = popup.getBoundingClientRect().width
    popup.style.left = `${Math.max(10, Math.min(innerWidth - width - 10, popup.id === 'scene-project-menu' ? box.left : box.left + box.width / 2 - width / 2))}px`
  }
  for (const popup of popovers) on(popup, 'toggle', () => { if (popup.matches(':popover-open')) positionPopover(popup) })

  return {
    element,
    setVisible(value) {
      if (disposed) return
      visible = value
      if (!value) {
        closePopovers(); closeInspector(false)
        for (const panel of [browser, saveDialog]) if (panel.open) panel.close()
        browsing?.abort(); browseGeneration++; clearTimeout(searchTimer); shortcutUntil = 0
      }
      element.hidden = !value
      element.inert = !value
      render()
    },
    render,
    setStats(stats) {
      if (disposed) return
      const data = host.current().scene.data
      if (countedScene !== data) {
        const counts = new Map(data.assets.map(asset => [asset.id, asset.voxelCount]))
        totalSceneVoxels = data.instances.reduce((total, instance) => total + (counts.get(instance.assetId) ?? 0), 0)
        countedScene = data
      }
      $('#scene-voxel-status').textContent = `${number.format(totalSceneVoxels)} scene voxels / ${number.format(stats.activeInstances)} active instances`
      $('#scene-voxel-status').title = `Authored voxel count across all instances, including hidden and overlapping layers. Active geometry represents ${number.format(stats.representedVoxels)} source voxels.`
      $('#scene-resident-status').textContent = `CPU ${(stats.residentBytes / 1048576).toFixed(1)} MiB est. / GPU geometry ${(stats.geometryBytes / 2 / 1048576).toFixed(1)} MiB est.`
      $('#scene-resident-status').title = 'CPU uses host-reported resident buffers and cache. Geometry counts retained CPU and GPU copies, so the GPU geometry estimate is half that value. These are not total browser or GPU memory usage.'
      const detail = stats.detail.includes('incomplete') ? stats.detail : `${stats.detail.split(';')[0]}${stats.detail.includes('reduced detail') ? ' / memory-limited' : ''}`
      $('#scene-lod-status').textContent = `${detail}${stats.pending ? ` / ${number.format(stats.pending)} loading` : ''}`
      $('#scene-lod-status').title = `${number.format(stats.triangles)} triangles. ${stats.detail}`
    },
    setSaveState(state, message) { if (!disposed) { recovery = { scene: host.current().scene, state, message }; render() } },
    setBusy(value) { externalBusy = value; render() },
    dispose() {
      if (disposed) return
      visible = false; disposed = true
      abort.abort(); browsing?.abort(); browseGeneration++
      clearTimeout(searchTimer); clearTimeout(hoverTimer)
      closePopovers()
      for (const panel of [browser, saveDialog]) if (panel.open) panel.close()
      element.remove()
    },
  }
}
