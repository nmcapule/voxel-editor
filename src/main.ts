import './style.css'
import { EditSession, History, VoxelDocument, dirtyChunks, moveVoxels, pushPull, resizeVoxelDocument, type Dimensions, type FillShape, type ResizeAnchor, type Vec3 } from './editor'
import { VoxelRenderer, type AuxiliaryTool, type PaintMode, type PbrMap, type SculptMode, type SelectionMode, type SelectionState, type Tool } from './renderer'
import { loadProject, saveProject, type ViewSettings } from './storage'
import { exportVox, importVox } from './vox'

const DEFAULT_SETTINGS: ViewSettings = {
  background: '#dfe7ec',
  ambient: 1.2,
  light: 2.4,
  lightAzimuth: 42,
  ambientOcclusion: true,
  shadows: true,
  grid: true,
  faceGrid: false,
  projection: 'orthographic',
  pathTracing: true,
}

const icon = (name: string) => `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`
const materialCube = `<svg class="material-cube" viewBox="0 0 64 64" aria-hidden="true"><path class="preview-top" d="m32 8 23 13-23 13L9 21 32 8Z"/><path class="preview-left" d="M9 21l23 13v26L9 47V21Z"/><path class="preview-right" d="m32 34 23-13v26L32 60V34Z"/></svg>`
const app = document.querySelector<HTMLDivElement>('#app')!
type PaletteFilter = 'all' | 'opaque' | 'transparent' | 'metal' | 'emissive'
type StoredToolState = { selectionMode?: unknown; activeColor?: unknown; recentColors?: unknown }

function readLocalStorage(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}

function writeLocalStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* Preferences remain usable for this session. */ }
}

let restored: Awaited<ReturnType<typeof loadProject>>
let storageError = ''
try {
  restored = await loadProject()
} catch {
  storageError = 'Local autosave is unavailable. Export a VOX file before leaving.'
}

let voxelDocument = restored?.document ?? new VoxelDocument()
let settings: ViewSettings = { ...DEFAULT_SETTINGS, ...restored?.settings }
const storedToolState: StoredToolState = (() => {
  try {
    const parsed: unknown = JSON.parse(readLocalStorage('voxel-studio-tool-state') ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed as StoredToolState : {}
  } catch { return {} }
})()
const isSelectionMode = (value: unknown): value is SelectionMode => typeof value === 'string' && ['point', 'surface', 'texture', 'body'].includes(value)
const isPaletteColor = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) < 256 && Boolean(voxelDocument.palette[Number(value)])
const defaultActiveColor = voxelDocument.palette[5] ? 5 : Math.max(1, voxelDocument.palette.findIndex((color, index) => index > 0 && Boolean(color)))
let history = new History()
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
const storedRecentColors = Array.isArray(storedToolState.recentColors) ? storedToolState.recentColors : [5, 6, 12, 14, 3, 2]
let recentColors = [...new Set([activeColor, ...storedRecentColors.filter(isPaletteColor)])].slice(0, 6)
let selection: SelectionState = { cells: [], count: 0 }
type ClipboardVoxel = Vec3 & { color: number }
let clipboard: ClipboardVoxel[] = []
let pendingPaste: { voxels: ClipboardVoxel[]; selectionBefore: Vec3[]; layerId: number } | undefined
const loadedPbrMaps = new Map<number, Map<PbrMap, string>>()

app.innerHTML = `
  <svg class="icon-sprite" aria-hidden="true">
    <symbol id="icon-logo" viewBox="0 0 32 32"><path d="m16 3 11 6.4v13.2L16 29 5 22.6V9.4L16 3Z"/><path d="m16 16 11-6.6M16 16 5 9.4M16 16v13"/></symbol>
    <symbol id="icon-menu" viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14"/></symbol>
    <symbol id="icon-undo" viewBox="0 0 24 24"><path d="m9 8-4 4 4 4M6 12h7a5 5 0 0 1 5 5"/></symbol>
    <symbol id="icon-redo" viewBox="0 0 24 24"><path d="m15 8 4 4-4 4M18 12h-7a5 5 0 0 0-5 5"/></symbol>
    <symbol id="icon-frame" viewBox="0 0 24 24"><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="m12 8 4 2.3v4.6L12 17l-4-2.1v-4.6L12 8Z"/></symbol>
    <symbol id="icon-sliders" viewBox="0 0 24 24"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="18" r="2"/></symbol>
    <symbol id="icon-render" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></symbol>
    <symbol id="icon-select" viewBox="0 0 24 24"><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="m12 8 4 2.3v4.6L12 17l-4-2.1v-4.6L12 8Z"/></symbol>
    <symbol id="icon-paint" viewBox="0 0 24 24"><path d="M5 4h12v6H5zM8 10v4h6v6H8v-6M17 6h2v9"/></symbol>
    <symbol id="icon-pick" viewBox="0 0 24 24"><path d="m14 4 6 6-3 3-1.5-1.5L9 18H5v-4l6.5-6.5L10 6l4-2Z"/><path d="m7 16 1 1"/></symbol>
    <symbol id="icon-push" viewBox="0 0 24 24"><path d="m9 5 7 4v8l-7 4-7-4V9l7-4Z"/><path d="m9 13 7-4M9 13 2 9M9 13v8M19 5v14M16 8l3-3 3 3M16 16l3 3 3-3"/></symbol>
    <symbol id="icon-move" viewBox="0 0 24 24"><path d="m9 5 7 4v7l-7 4-7-4V9l7-4Z"/><path d="m9 13 7-4M9 13 2 9M9 13v7M13 20h8M18 17l3 3-3 3"/></symbol>
    <symbol id="icon-erase" viewBox="0 0 24 24"><path d="m8 5 7 4v8l-7 4-5-3V9l5-4Z"/><path d="m8 13 7-4M8 13 3 9M8 13v8M16 5l5 5M21 5l-5 5"/></symbol>
    <symbol id="icon-fill" viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m12 12 8-4.5M12 12 4 7.5M12 12v9M7 10l5-3 5 3"/></symbol>
    <symbol id="icon-layers" viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></symbol>
    <symbol id="icon-box" viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m12 12 8-4.5M12 12 4 7.5M12 12v9"/></symbol>
    <symbol id="icon-sphere" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 2.5 4.5 5.5 4.5 9S15 18.5 12 21M12 3c-3 2.5-4.5 5.5-4.5 9S9 18.5 12 21"/></symbol>
    <symbol id="icon-cylinder" viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 18c0-1.7 3.6-3 8-3s8 1.3 8 3"/></symbol>
    <symbol id="icon-close" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></symbol>
    <symbol id="icon-chevron" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></symbol>
    <symbol id="icon-camera" viewBox="0 0 24 24"><path d="M4 8h4l2-3h4l2 3h4v11H4V8Z"/><circle cx="12" cy="13" r="3.5"/></symbol>
    <symbol id="icon-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="icon-eye" viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/></symbol>
    <symbol id="icon-eye-off" viewBox="0 0 24 24"><path d="M4 4l16 16M10.6 6.2A8.9 8.9 0 0 1 12 6c5.5 0 9 6 9 6a15 15 0 0 1-2.2 2.8M6.1 7.1A15.4 15.4 0 0 0 3 12s3.5 6 9 6c1 0 1.9-.2 2.7-.5"/></symbol>
    <symbol id="icon-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></symbol>
    <symbol id="icon-unlock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M9 10V7a4 4 0 0 1 7-2.6"/></symbol>
    <symbol id="icon-trash" viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></symbol>
    <symbol id="icon-cut" viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.5 7.5 11 8.5M8.5 16.5l11-8.5"/></symbol>
    <symbol id="icon-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></symbol>
    <symbol id="icon-paste" viewBox="0 0 24 24"><path d="M9 5h6M9 3h6v4H9z"/><path d="M8 5H5v16h14V5h-3M8 12h8M8 16h5"/></symbol>
  </svg>

  <main class="studio" data-render-mode="false" data-tool="select">
    <div id="viewport" class="viewport"></div>

    <div class="top-chrome" role="toolbar" aria-label="Project controls">
      <div class="project-pill instrument">
        <details id="project-menu" class="project-menu">
          <summary aria-label="Open project menu" title="Project menu">${icon('menu')}</summary>
          <div class="menu-sheet" role="menu">
            <strong>Project</strong>
            <button type="button" data-action="new" role="menuitem">New document</button>
            <button type="button" data-action="import" role="menuitem">Import VOX</button>
            <button type="button" data-action="export" role="menuitem">Export VOX</button>
            <button type="button" data-action="capture" role="menuitem">Capture PNG</button>
          </div>
        </details>
        <span class="brand-mark">${icon('logo')}</span>
        <label class="project-name"><span class="sr-only">Project name</span><input id="project-name" maxlength="60" value="Untitled"></label>
        <span id="save-status" class="save-status"><i></i><span>Saved locally</span></span>
      </div>

      <div class="top-actions instrument">
        <button type="button" data-action="undo" aria-label="Undo" title="Undo (Ctrl/Command Z)">${icon('undo')}</button>
        <button type="button" data-action="redo" aria-label="Redo" title="Redo (Ctrl/Command Shift Z)">${icon('redo')}</button>
        <span class="instrument-rule"></span>
        <button type="button" data-action="frame" aria-label="Frame model" title="Frame model (F)">${icon('frame')}</button>
        <button type="button" data-action="render" aria-label="Toggle render mode" aria-pressed="false" title="Render mode (R)">${icon('render')}</button>
        <button type="button" data-action="panel" aria-label="Open stage settings" aria-expanded="false" title="Stage settings">${icon('sliders')}</button>
      </div>
    </div>

    <section id="welcome" class="welcome-panel instrument" aria-labelledby="welcome-title">
      <button type="button" class="welcome-close" data-action="dismiss-guide" aria-label="Dismiss guide">${icon('close')}</button>
      <span class="welcome-cube" aria-hidden="true">${icon('logo')}</span>
      <h1 id="welcome-title">Choose how you shape.</h1>
      <p>Select, place, sculpt, or switch layers with one focused tool at a time.</p>
      <button type="button" class="primary" data-action="dismiss-guide">Start shaping</button>
    </section>

    <div class="scene-status instrument" role="group" aria-label="Model status">
      <span id="coordinate-status" aria-live="polite">X -- &nbsp; Y -- &nbsp; Z --</span>
      <span class="status-rule"></span>
      <span id="voxel-count">0 voxels</span>
      <span class="status-rule"></span>
      <span id="mesh-status">Ready</span>
      <span class="status-rule"></span>
      <span id="fps-status">-- fps</span>
    </div>

    <div id="context-dock" class="context-dock instrument">
      <div class="context-summary"><strong id="context-title">Select</strong><span id="context-copy">Click a connected surface.</span></div>
      <div id="fill-options" class="tool-options fill-options" role="group" aria-label="Volume shape" hidden>
        <button type="button" data-fill-shape="box" aria-label="Box volume" aria-pressed="true">${icon('box')}<span>Box</span></button>
        <button type="button" data-fill-shape="sphere" aria-label="Sphere volume" aria-pressed="false">${icon('sphere')}<span>Sphere</span></button>
        <button type="button" data-fill-shape="cylinder" aria-label="Cylinder volume" aria-pressed="false">${icon('cylinder')}<span>Cylinder</span></button>
        <label class="fill-depth"><span>Depth</span><input id="fill-depth" type="number" min="1" max="256" value="1" inputmode="numeric"></label>
      </div>
    </div>

    <aside id="select-tool-popup" class="tool-popup instrument" popover aria-labelledby="select-popup-title">
      <header><strong id="select-popup-title">Select mode</strong><span>Choose what a gesture resolves</span></header>
      <div class="tool-mode-list" role="group" aria-label="Select mode">
        <button type="button" data-selection-mode="point" aria-pressed="true"><span><strong>Point</strong><small>One voxel or a box drag</small></span><kbd>Q 1</kbd></button>
        <button type="button" data-selection-mode="surface" aria-pressed="false"><span><strong>Surface</strong><small>Connected exposed faces</small></span><kbd>Q 2</kbd></button>
        <button type="button" data-selection-mode="texture" aria-pressed="false"><span><strong>Texture</strong><small>Contiguous voxels with one texture</small></span><kbd>Q 3</kbd></button>
        <button type="button" data-selection-mode="body" aria-pressed="false"><span><strong>Body</strong><small>One contiguous voxel body</small></span><kbd>Q 4</kbd></button>
      </div>
      <div class="popup-actions">
        <span class="popup-section-label">Clipboard</span>
        <div class="tool-mode-list" role="group" aria-label="Clipboard actions">
          <button type="button" data-clipboard-action="cut" aria-keyshortcuts="Control+X Meta+X">${icon('cut')}<span><strong>Cut</strong><small>Remove and hold selection</small></span><kbd>⌘/Ctrl X</kbd></button>
          <button type="button" data-clipboard-action="copy" aria-keyshortcuts="Control+C Meta+C">${icon('copy')}<span><strong>Copy</strong><small>Hold a duplicate of selection</small></span><kbd>⌘/Ctrl C</kbd></button>
          <button type="button" data-clipboard-action="paste" aria-keyshortcuts="Control+V Meta+V">${icon('paste')}<span><strong>Paste</strong><small>Place with the Move tool</small></span><kbd>⌘/Ctrl V</kbd></button>
        </div>
      </div>
    </aside>

    <aside id="paint-tool-popup" class="tool-popup instrument" popover aria-labelledby="paint-popup-title">
      <header><strong id="paint-popup-title">Place operation</strong><span>Uses the Select scope and active material</span></header>
      <div class="tool-mode-list" role="group" aria-label="Place operation">
        <button type="button" data-paint-mode="paint" aria-pressed="true">${icon('paint')}<span><strong>Paint</strong><small>Use the current Select scope</small></span><kbd>W 1</kbd></button>
        <button type="button" data-paint-mode="fill" aria-pressed="false">${icon('fill')}<span><strong>Volume</strong><small>Create a solid voxel volume</small></span><kbd>W 2</kbd></button>
        <button type="button" data-auxiliary="pick" aria-pressed="false">${icon('pick')}<span><strong>Eyedropper</strong><small>Pick material from a voxel</small></span><kbd>W 3</kbd></button>
      </div>
      <div class="popup-materials">
        <span class="popup-section-label">Material</span>
        <button class="active-swatch popup-active-material" type="button" data-action="palette" aria-label="Open palette">${materialCube}<span><strong id="paint-material-name">Gold</strong><small id="paint-material-value">#F2C14E</small></span>${icon('chevron')}</button>
        <div id="paint-quick-palette" class="quick-palette popup-material-grid" role="group" aria-label="Recent materials"></div>
      </div>
    </aside>

    <aside id="sculpt-tool-popup" class="tool-popup instrument" popover aria-labelledby="sculpt-popup-title">
      <header><strong id="sculpt-popup-title">Sculpt mode</strong><span>Choose how the model changes</span></header>
      <div class="tool-mode-list" role="group" aria-label="Sculpt mode">
        <button type="button" data-sculpt-mode="push" aria-pressed="true">${icon('push')}<span><strong>Push/Pull</strong><small>Add or remove complete layers</small></span><kbd>S 1</kbd></button>
        <button type="button" data-sculpt-mode="move" aria-pressed="false">${icon('move')}<span><strong>Move</strong><small>Translate the current selection</small></span><kbd>S 2</kbd></button>
        <button type="button" data-sculpt-mode="erase" aria-pressed="false">${icon('erase')}<span><strong>Erase</strong><small>Remove the resolved selection</small></span><kbd>S 3</kbd></button>
      </div>
    </aside>

    <nav class="tool-dock instrument" aria-label="Voxel tools">
      <button type="button" data-tool="select" aria-pressed="false" popovertarget="select-tool-popup">${icon('select')}<span class="tool-label"><strong>Select</strong><small id="select-tool-mode">Point</small></span><kbd>Q</kbd></button>
      <button type="button" data-tool="paint" aria-pressed="false" popovertarget="paint-tool-popup">${icon('paint')}<span class="tool-label"><strong>Place</strong><small><i id="paint-tool-swatch"></i><span id="paint-tool-mode">Paint</span></small></span><kbd>W</kbd></button>
      <button type="button" data-tool="sculpt" aria-pressed="false" popovertarget="sculpt-tool-popup">${icon('push')}<span class="tool-label"><strong>Sculpt</strong><small id="sculpt-tool-mode">Push/Pull</small></span><kbd>S</kbd></button>
      <button type="button" data-tool="layer" aria-pressed="false" popovertarget="layer-panel">${icon('layers')}<span class="tool-label"><strong>Layer</strong><small id="layer-tool-mode">Layer 1</small></span><kbd>L</kbd></button>
    </nav>

    <aside id="layer-panel" class="layer-panel instrument" popover aria-labelledby="layer-panel-title">
      <header>
        <div><strong id="layer-panel-title">Layers</strong><span>Pick a voxel or manage layers</span></div>
        <div class="layer-panel-actions">
          <button type="button" data-layer-action="add" aria-label="Add layer" title="Add layer">${icon('plus')}</button>
          <button type="button" popovertarget="layer-panel" popovertargetaction="hide" aria-label="Close layers">${icon('close')}</button>
        </div>
      </header>
      <div id="layer-list" class="layer-list" role="list" aria-label="Voxel layers"></div>
      <p class="panel-note layer-note">VOX export flattens visible layers into one model.</p>
    </aside>

    <aside id="stage-panel" class="stage-panel instrument" aria-label="Stage settings" aria-hidden="true">
      <header>
        <div><strong>Stage</strong><span>Model, materials &amp; light</span></div>
        <button type="button" data-action="close-panel" aria-label="Close stage settings">${icon('close')}</button>
      </header>
      <nav class="panel-tabs" role="tablist" aria-label="Stage sections">
        <button id="model-tab" type="button" role="tab" data-tab="model" aria-selected="true">Model</button>
        <button id="palette-tab" type="button" role="tab" data-tab="palette" aria-selected="false">Palette</button>
        <button id="render-tab" type="button" role="tab" data-tab="render" aria-selected="false">Render</button>
      </nav>

      <section class="panel-section" role="tabpanel" aria-labelledby="model-tab" data-panel="model">
        <div class="section-heading"><h2>Canvas size</h2><span id="dimension-readout">32 × 32 × 32</span></div>
        <form id="resize-form" class="dimension-form">
          <label>X<input name="x" type="number" min="16" max="256" required></label>
          <label>Y<input name="y" type="number" min="16" max="256" required></label>
          <label>Z<input name="z" type="number" min="16" max="256" required></label>
          <label class="resize-anchor">Anchor<select name="anchor"><option value="center" selected>Center</option><option value="origin">Origin</option></select></label>
          <button type="submit">Resize</button>
        </form>
        <div class="model-facts">
          <div><span>Occupied</span><strong id="panel-voxel-count">0</strong></div>
          <div><span>Chunks</span><strong id="chunk-count">0</strong></div>
        </div>
        <p class="panel-note">Origin keeps voxel coordinates. Center balances the size change around the model. Shrinking removes anything outside the new bounds.</p>
        <button type="button" class="secondary full" data-action="new">Clear and start new</button>
      </section>

      <section class="panel-section" role="tabpanel" aria-labelledby="palette-tab" data-panel="palette" hidden>
        <div class="section-heading"><h2>Active swatch</h2><span id="active-index">Color 5</span></div>
        <div class="color-editor">
          <label id="material-preview" class="material-preview" title="Change swatch color">
            ${materialCube}
            <input id="color-input" type="color" aria-label="Active swatch color">
          </label>
          <div class="swatch-fields">
            <label>Name<input id="material-name" type="text" maxlength="40" spellcheck="false"></label>
            <label>Hex<input id="hex-input" type="text" maxlength="7" spellcheck="false"></label>
          </div>
          <button type="button" data-action="new-swatch" aria-label="Duplicate as a new swatch">${icon('plus')}</button>
        </div>
        <p class="panel-note swatch-note">Click the cube to change color. Duplicate a swatch before making a variant.</p>
        <div class="palette-view-bar"><strong>Palette</strong><div role="group" aria-label="Palette view"><button type="button" data-palette-view="grid" aria-pressed="true">Grid</button><button type="button" data-palette-view="list" aria-pressed="false">List</button></div></div>
        <div class="palette-filter-bar" role="group" aria-label="Filter materials">
          <button type="button" data-palette-filter="opaque" aria-pressed="false">Opaque</button>
          <button type="button" data-palette-filter="transparent" aria-pressed="false">Transparent</button>
          <button type="button" data-palette-filter="metal" aria-pressed="false">Metal</button>
          <button type="button" data-palette-filter="emissive" aria-pressed="false">Emissive</button>
        </div>
        <div id="palette-grid" class="palette-grid" data-view="grid" role="group" aria-label="Document palette"></div>
        <div class="section-heading pbr-heading"><h2>Material</h2><span id="material-color">Color 5</span></div>
        <label class="range-row"><span>Roughness <output id="roughness-output">0.24</output></span><input id="roughness" aria-label="Color 5 material roughness" type="range" min="0" max="1" value="0.24" step="0.01"></label>
        <label class="range-row"><span>Metalness <output id="metalness-output">0.88</output></span><input id="metalness" aria-label="Color 5 material metalness" type="range" min="0" max="1" value="0.88" step="0.01"></label>
        <label class="range-row"><span>Emission <output id="emissiveIntensity-output">0.00</output></span><input id="emissiveIntensity" aria-label="Color 5 material emission" type="range" min="0" max="5" value="0" step="0.1"></label>
        <label class="range-row"><span>Opacity <output id="opacity-output">1.00</output></span><input id="opacity" aria-label="Color 5 material opacity" type="range" min="0" max="1" value="1" step="0.01"></label>
        <label class="range-row"><span>Transmission <output id="transmission-output">0.00</output></span><input id="transmission" aria-label="Color 5 material transmission" type="range" min="0" max="1" value="0" step="0.01"></label>
        <label class="range-row"><span>Refraction (IOR) <output id="ior-output">1.50</output></span><input id="ior" aria-label="Color 5 material index of refraction" type="range" min="1" max="2.5" value="1.5" step="0.01"></label>
        <p class="panel-note material-note">Emission makes the swatch self-lit; transmission creates glass and water.</p>
        <div class="section-heading pbr-heading"><h2>Texture maps</h2><span id="pbr-map-count">No maps</span></div>
        <label class="texture-row"><span>Albedo <small data-pbr-name="map">No file</small></span><input type="file" data-pbr-map="map" accept="image/*"></label>
        <label class="texture-row"><span>Normal <small data-pbr-name="normalMap">No file</small></span><input type="file" data-pbr-map="normalMap" accept="image/*"></label>
        <label class="texture-row"><span>Roughness <small data-pbr-name="roughnessMap">No file</small></span><input type="file" data-pbr-map="roughnessMap" accept="image/*"></label>
        <label class="texture-row"><span>Metalness <small data-pbr-name="metalnessMap">No file</small></span><input type="file" data-pbr-map="metalnessMap" accept="image/*"></label>
        <button type="button" class="secondary full" data-action="clear-pbr">Clear texture maps</button>
      </section>

      <section class="panel-section" role="tabpanel" aria-labelledby="render-tab" data-panel="render" hidden>
        <div class="section-heading"><h2>Render</h2><span>Realtime / progressive</span></div>
        <label class="select-row"><span>Camera</span><select id="projection"><option value="orthographic">Orthographic</option><option value="perspective">Perspective</option></select></label>
        <label class="toggle-row"><span>Progressive PBR <output id="path-status" aria-live="polite">Ready</output></span><input id="path-tracing" type="checkbox" aria-label="Progressive PBR"></label>
        <label class="color-row"><span>Backdrop</span><input id="background" type="color"></label>
        <label class="range-row"><span>Ambient <output id="ambient-output">1.2</output></span><input id="ambient" aria-label="Ambient light" type="range" min="0" max="3" value="1.2" step="0.1"></label>
        <label class="range-row"><span>Key light <output id="light-output">2.4</output></span><input id="light" aria-label="Key light" type="range" min="0" max="5" value="2.4" step="0.1"></label>
        <label class="range-row"><span>Light angle <output id="azimuth-output">42°</output></span><input id="azimuth" aria-label="Light angle" type="range" min="-180" max="180" value="42" step="1"></label>
        <label class="toggle-row"><span>Ambient occlusion</span><input id="ambient-occlusion" type="checkbox"></label>
        <label class="toggle-row"><span>Ground shadows</span><input id="shadows" type="checkbox"></label>
        <label class="toggle-row"><span>Editing grid</span><input id="grid" type="checkbox"></label>
        <label class="toggle-row"><span>Voxel face grid</span><input id="face-grid" type="checkbox"></label>
        <button type="button" class="primary full" data-action="capture">${icon('camera')} Capture PNG</button>
      </section>
    </aside>

    <input id="file-input" type="file" accept=".vox" hidden>
    <div id="toast" class="toast instrument" role="status" aria-live="polite" hidden></div>
    <div id="announcer" class="sr-only" aria-live="polite"></div>
  </main>
`

const studio = document.querySelector<HTMLElement>('.studio')!
const projectName = document.querySelector<HTMLInputElement>('#project-name')!
const stagePanel = document.querySelector<HTMLElement>('#stage-panel')!
const layerPanel = document.querySelector<HTMLElement>('#layer-panel')!
const toast = document.querySelector<HTMLElement>('#toast')!
const announcer = document.querySelector<HTMLElement>('#announcer')!
const welcome = document.querySelector<HTMLElement>('#welcome')!
const saveStatus = document.querySelector<HTMLElement>('#save-status')!
const resizeForm = document.querySelector<HTMLFormElement>('#resize-form')!
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const fillOptions = document.querySelector<HTMLElement>('#fill-options')!
const layerList = document.querySelector<HTMLElement>('#layer-list')!
const toolPopups = [...document.querySelectorAll<HTMLElement>('.tool-popup, .layer-panel')]
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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function showToast(message: string, tone: 'normal' | 'warning' = 'normal') {
  if (toastTimer) clearTimeout(toastTimer)
  toast.textContent = message
  toast.dataset.tone = tone
  toast.hidden = false
  toastTimer = setTimeout(() => { toast.hidden = true }, 4200)
}

function announce(message: string) {
  announcer.textContent = ''
  requestAnimationFrame(() => { announcer.textContent = message })
}

function dismissGuide() {
  welcome.hidden = true
  writeLocalStorage('voxel-studio-guide', 'seen')
}

function updateSaveStatus() {
  saveStatus.dataset.state = saveState
  saveStatus.querySelector('span')!.textContent = saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Export to keep changes' : 'Saved locally'
}

function queueSave() {
  if (storageError) return
  if (saveTimer) clearTimeout(saveTimer)
  saveState = 'saving'
  updateSaveStatus()
  const revision = ++saveRevision
  saveTimer = setTimeout(async () => {
    try {
      await saveProject(voxelDocument, settings)
      if (revision === saveRevision) { saveState = 'saved'; updateSaveStatus() }
    } catch {
      storageError = 'Autosave failed.'
      saveState = 'error'
      updateSaveStatus()
      showToast('Autosave failed. Export a VOX file to keep this model.', 'warning')
    }
  }, 420)
}

function persistToolState() {
  writeLocalStorage('voxel-studio-tool-state', JSON.stringify({ selectionMode, activeColor, recentColors }))
}

function paletteIndices(filter: PaletteFilter = paletteFilter) {
  const used = new Set<number>()
  voxelDocument.forEachVoxel((_x, _y, _z, color) => used.add(color))
  const indices: number[] = []
  for (let index = 1; index < 256; index++) {
    if (!voxelDocument.palette[index] && !used.has(index)) continue
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
  if (!voxelDocument.palette[index]) return
  activeColor = index
  recentColors = [index, ...recentColors.filter(color => color !== index)].slice(0, 6)
  persistToolState()
  renderer.setActiveColor(index)
  renderPalette()
  renderPaletteMaterial()
  announce(`Color ${index}, ${colorHex(index)}`)
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
  const preview = document.querySelector<HTMLElement>('#material-preview')!
  preview.style.cssText = materialPreviewStyle(activeColor)
  preview.dataset.transparent = String(material.opacity < 1 || material.transmission > 0)
  preview.title = `${material.name}: change swatch color`
}

function renderPalette() {
  const focusedPalette = document.activeElement instanceof HTMLButtonElement ? document.activeElement.closest<HTMLElement>('.quick-palette') : null
  const focusedColor = (document.activeElement as HTMLElement | null)?.dataset.color
  const activeMaterial = voxelDocument.materials[activeColor]
  for (const activeSwatch of document.querySelectorAll<HTMLButtonElement>('.active-swatch')) {
    activeSwatch.style.cssText = materialPreviewStyle(activeColor)
    activeSwatch.dataset.transparent = String(activeMaterial.opacity < 1 || activeMaterial.transmission > 0)
    activeSwatch.setAttribute('aria-label', `Open ${activeMaterial.name} in palette`)
    activeSwatch.title = `${activeMaterial.name}, ${colorHex(activeColor)}: open full palette`
  }
  const recentMaterials = recentColors.filter(index => index !== activeColor && voxelDocument.palette[index]).map(index =>
    `<button type="button" data-color="${index}" data-transparent="${voxelDocument.materials[index].opacity < 1 || voxelDocument.materials[index].transmission > 0}" aria-label="Use ${escapeHtml(voxelDocument.materials[index].name)}, ${colorHex(index)}" aria-pressed="${index === activeColor}" style="${materialPreviewStyle(index)}">${materialCube}</button>`,
  ).join('')
  for (const quickPalette of document.querySelectorAll<HTMLElement>('.quick-palette')) quickPalette.innerHTML = recentMaterials
  if (focusedColor) (focusedPalette?.querySelector<HTMLButtonElement>(`[data-color="${focusedColor}"]`)
    ?? focusedPalette?.parentElement?.querySelector<HTMLButtonElement>('.active-swatch'))?.focus({ preventScroll: true })
  const palette = document.querySelector<HTMLElement>('#palette-grid')!
  palette.dataset.view = paletteView
  const filteredMaterials = paletteIndices()
  palette.innerHTML = filteredMaterials.length ? filteredMaterials.map(index => {
    const material = voxelDocument.materials[index]
    return `<button type="button" data-color="${index}" data-transparent="${material.opacity < 1 || material.transmission > 0}" aria-label="Use ${escapeHtml(material.name)}, color ${index}, ${colorHex(index)}" aria-pressed="${index === activeColor}" style="${materialPreviewStyle(index)}">
      ${materialCube}<span class="swatch-copy"><strong>${escapeHtml(material.name)}</strong><small>${materialSummary(index)}</small></span><span class="swatch-index">${index}</span>
    </button>`
  }).join('') : '<p class="palette-empty">No materials match this filter.</p>'
  if (focusedColor && !focusedPalette) palette.querySelector<HTMLButtonElement>(`[data-color="${focusedColor}"]`)?.focus({ preventScroll: true })
  document.querySelectorAll<HTMLButtonElement>('[data-palette-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paletteView === paletteView)))
  document.querySelectorAll<HTMLButtonElement>('[data-palette-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paletteFilter === paletteFilter)))
  document.querySelector('#active-index')!.textContent = `Color ${activeColor}`
  const value = colorHex(activeColor)
  document.querySelector<HTMLInputElement>('#color-input')!.value = value
  document.querySelector<HTMLInputElement>('#hex-input')!.value = value.toUpperCase()
  document.querySelector<HTMLInputElement>('#material-name')!.value = activeMaterial.name
  document.querySelector('#paint-material-name')!.textContent = activeMaterial.name
  document.querySelector('#paint-material-value')!.textContent = value.toUpperCase()
  document.querySelector<HTMLElement>('#paint-tool-swatch')!.style.background = value
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
  document.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === activeTool)))
  document.querySelectorAll<HTMLButtonElement>('[data-selection-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.selectionMode === selectionMode)))
  document.querySelectorAll<HTMLButtonElement>('[data-paint-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paintMode === paintMode)))
  document.querySelectorAll<HTMLButtonElement>('[data-sculpt-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sculptMode === sculptMode)))
  document.querySelectorAll<HTMLButtonElement>('[data-fill-shape]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fillShape === fillShape)))
  document.querySelectorAll<HTMLButtonElement>('[data-auxiliary]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.auxiliary === auxiliaryTool)))
  const editable = voxelDocument.activeLayer.visible && !voxelDocument.activeLayer.locked
  document.querySelectorAll<HTMLButtonElement>('[data-clipboard-action]').forEach(button => {
    const action = button.dataset.clipboardAction
    button.disabled = action === 'paste' ? selection.floating === true || !clipboard.length || !editable
      : selection.floating === true || !selection.count || action === 'cut' && !editable
  })
  fillOptions.hidden = activeTool !== 'paint' || paintMode !== 'fill'
  document.querySelector('#select-tool-mode')!.textContent = selectionLabels[selectionMode]
  document.querySelector('#paint-tool-mode')!.textContent = auxiliaryTool ? 'Eyedropper' : paintMode === 'paint' ? voxelDocument.materials[activeColor].name : paintLabels[paintMode]
  document.querySelector('#sculpt-tool-mode')!.textContent = sculptCopy[sculptMode][0]
  document.querySelector('#layer-tool-mode')!.textContent = voxelDocument.activeLayer.name
  document.querySelector('button[data-tool="paint"] use')!.setAttribute('href', `#icon-${auxiliaryTool ? 'pick' : paintMode}`)
  document.querySelector('button[data-tool="sculpt"] use')!.setAttribute('href', `#icon-${sculptMode === 'push' ? 'push' : sculptMode}`)
  const count = formatNumber(selection.count)
  const copy = selection.floating ? `${count} pasted ${selection.count === 1 ? 'voxel' : 'voxels'} · drag to place or press Escape to cancel`
    : auxiliaryTool === 'pick' ? 'Choose a color directly from the model.'
    : activeTool === 'select' ? selection.count ? `${count} selected` : selectionCopy[selectionMode]
    : activeTool === 'paint' && paintMode === 'fill' ? `${fillShape} · ${fillDepth} ${fillDepth === 1 ? 'voxel' : 'voxels'} deep · drag on the model or guide grid`
    : activeTool === 'paint' ? selection.count ? `${count} selected · click to paint` : `${selectionLabels[selectionMode]} scope · release to select and paint`
    : activeTool === 'layer' ? 'Click a voxel to make its layer active.'
    : selection.count ? `${count} selected · ${sculptCopy[sculptMode][0]}` : `${selectionMode} · select before ${sculptCopy[sculptMode][0]}`
  document.querySelector('#context-copy')!.textContent = copy
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
  return id ? document.getElementById(id) : null
}

function showToolPopup(tool: Tool) {
  clearHoverPopupTimer()
  const trigger = document.querySelector<HTMLButtonElement>(`.tool-dock button[data-tool="${tool}"]`)
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

for (const trigger of document.querySelectorAll<HTMLButtonElement>('.tool-dock button[data-tool][popovertarget]')) {
  const popup = popupForTrigger(trigger)
  if (!popup) continue
  trigger.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse') return
    clearHoverPopupTimer()
    if (!popup.matches(':popover-open')) popup.showPopover()
  })
  trigger.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') scheduleHoverPopupClose(trigger, popup) })
  popup.addEventListener('pointerenter', clearHoverPopupTimer)
  popup.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') scheduleHoverPopupClose(trigger, popup) })
}

function setTool(tool: Tool) {
  if (pendingPaste && tool !== 'sculpt') cancelPendingPaste()
  closePanel()
  activeTool = tool
  auxiliaryTool = undefined
  studio.dataset.tool = tool
  renderer.setAuxiliary()
  renderer.setTool(tool)
  renderer.setPaintMode(paintMode)
  renderer.setSculptMode(sculptMode)
  document.querySelector('#context-title')!.textContent = toolCopy[tool][0]
  renderToolControls()
  announce(`${toolCopy[tool][0]} tool selected`)
}

function setPaintMode(mode: PaintMode) {
  paintMode = mode
  auxiliaryTool = undefined
  renderer.setAuxiliary()
  renderer.setPaintMode(mode)
  document.querySelector('#context-title')!.textContent = toolCopy[activeTool][0]
  renderToolControls()
  announce(`${paintLabels[mode]} operation selected`)
}

function setSculptMode(mode: SculptMode) {
  if (pendingPaste && mode !== 'move') cancelPendingPaste()
  sculptMode = mode
  renderer.setSculptMode(mode)
  renderToolControls()
  announce(`${sculptCopy[mode][0]} operation selected`)
}

function setFillShape(shape: FillShape) {
  fillShape = shape
  renderer.setFillShape(shape)
  renderToolControls()
  announce(`${shape} volume shape selected`)
}

function setAuxiliary(tool?: AuxiliaryTool) {
  auxiliaryTool = auxiliaryTool === tool ? undefined : tool
  renderer.setAuxiliary(auxiliaryTool)
  document.querySelector('#context-title')!.textContent = auxiliaryTool ? 'Eyedropper' : toolCopy[activeTool][0]
  renderToolControls()
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
    selectionMode = mode
    renderer.setSelectionMode(mode)
    persistToolState()
    renderToolControls()
    announce(`${selectionLabels[mode]} selection mode`)
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
  document.querySelector('#dimension-readout')!.textContent = `${dimensions.x} × ${dimensions.y} × ${dimensions.z}`
  for (const axis of ['x', 'y', 'z'] as const) (resizeForm.elements.namedItem(axis) as HTMLInputElement).value = String(dimensions[axis])
  document.querySelector('#voxel-count')!.textContent = `${formatNumber(voxelDocument.voxelCount)} ${voxelDocument.voxelCount === 1 ? 'voxel' : 'voxels'}`
  document.querySelector('#panel-voxel-count')!.textContent = formatNumber(voxelDocument.voxelCount)
  document.querySelector('#chunk-count')!.textContent = formatNumber(voxelDocument.chunks.size)
  document.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled = !history.canUndo
  document.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled = !history.canRedo
  renderLayers()
}

function renderSettings() {
  document.querySelector<HTMLSelectElement>('#projection')!.value = settings.projection
  document.querySelector<HTMLInputElement>('#background')!.value = settings.background
  document.querySelector<HTMLInputElement>('#ambient')!.value = String(settings.ambient)
  document.querySelector<HTMLInputElement>('#light')!.value = String(settings.light)
  document.querySelector<HTMLInputElement>('#azimuth')!.value = String(settings.lightAzimuth)
  document.querySelector<HTMLInputElement>('#ambient-occlusion')!.checked = settings.ambientOcclusion
  document.querySelector<HTMLInputElement>('#shadows')!.checked = settings.shadows
  document.querySelector<HTMLInputElement>('#grid')!.checked = settings.grid
  document.querySelector<HTMLInputElement>('#face-grid')!.checked = settings.faceGrid
  document.querySelector<HTMLInputElement>('#path-tracing')!.checked = settings.pathTracing
  document.querySelector('#ambient-output')!.textContent = settings.ambient.toFixed(1)
  document.querySelector('#light-output')!.textContent = settings.light.toFixed(1)
  document.querySelector('#azimuth-output')!.textContent = `${settings.lightAzimuth}°`
}

function renderPbrMapCount() {
  const count = loadedPbrMaps.get(activeColor)?.size ?? 0
  document.querySelector('#pbr-map-count')!.textContent = count ? `${count} of 4 loaded` : 'No maps'
}

function renderPaletteMaterial() {
  const material = voxelDocument.materials[activeColor]
  for (const property of ['roughness', 'metalness', 'emissiveIntensity', 'opacity', 'transmission', 'ior'] as const) {
    const value = material[property]
    const label = property === 'ior' ? 'index of refraction' : property === 'emissiveIntensity' ? 'emission' : property
    const input = document.querySelector<HTMLInputElement>(`#${property}`)!
    input.value = String(value)
    input.setAttribute('aria-label', `${material.name} ${label}`)
    document.querySelector(`#${property}-output`)!.textContent = value.toFixed(2)
  }
  document.querySelector<HTMLInputElement>('#material-name')!.value = material.name
  document.querySelector('#material-color')!.textContent = material.name
  renderMaterialPreview()
  const maps = loadedPbrMaps.get(activeColor)
  document.querySelectorAll<HTMLInputElement>('[data-pbr-map]').forEach(input => {
    input.value = ''
    document.querySelector<HTMLElement>(`[data-pbr-name="${input.dataset.pbrMap}"]`)!.textContent = maps?.get(input.dataset.pbrMap as PbrMap) ?? 'No file'
  })
  renderPbrMapCount()
}

function canEditActiveLayer() {
  const layer = voxelDocument.activeLayer
  if (layer.visible && !layer.locked) return true
  showToast(`${layer.name} is ${layer.locked ? 'locked' : 'hidden'}.`, 'warning')
  return false
}

async function loadPbrMap(input: HTMLInputElement) {
  const file = input.files?.[0]
  const map = input.dataset.pbrMap as PbrMap
  if (!file) return
  const color = activeColor
  const label = document.querySelector<HTMLElement>(`[data-pbr-name="${map}"]`)!
  input.disabled = true
  label.textContent = 'Loading...'
  try {
    await renderer.setPbrMap(color, map, file)
    const maps = loadedPbrMaps.get(color) ?? new Map<PbrMap, string>()
    maps.set(map, file.name)
    loadedPbrMaps.set(color, maps)
    if (activeColor === color) renderPaletteMaterial()
    announce(`${file.name} loaded for color ${color}`)
  } catch {
    if (activeColor === color) renderPaletteMaterial()
    showToast(`${file.name} could not be decoded as a texture.`, 'warning')
  } finally {
    input.disabled = false
  }
}

function fillSelection() {
  if (!selection.count) { showToast('Select voxels before painting.'); return }
  if (!canEditActiveLayer()) return
  dismissGuide()
  const session = new EditSession(voxelDocument)
  for (const cell of selection.cells) session.set(cell.x, cell.y, cell.z, activeColor)
  const command = session.commit()
  history.push(command, selection.cells, selection.cells, voxelDocument.activeLayerId)
  if (!command) { announce('Selection already uses the active color'); return }
  renderer.markDirty(dirtyChunks(voxelDocument, command.changes.map(change => change.id)))
  renderDocumentFacts()
  queueSave()
  announce(`Painted ${formatNumber(selection.count)} ${selection.count === 1 ? 'voxel' : 'voxels'}`)
}

function eraseSelection() {
  if (!selection.count) return
  if (!canEditActiveLayer()) return
  dismissGuide()
  const count = selection.count
  const session = new EditSession(voxelDocument)
  for (const cell of selection.cells) session.set(cell.x, cell.y, cell.z, 0)
  const command = session.commit()
  history.push(command, selection.cells, [], voxelDocument.activeLayerId)
  if (!command) return
  renderer.markDirty(dirtyChunks(voxelDocument, command.changes.map(change => change.id)))
  renderer.clearSelection()
  renderDocumentFacts()
  queueSave()
  announce(`Erased ${formatNumber(count)} ${count === 1 ? 'voxel' : 'voxels'}`)
}

function copySelection(report = true) {
  if (!selection.count || selection.floating) { showToast('Select placed voxels before copying.'); return false }
  const copied: ClipboardVoxel[] = []
  for (const cell of selection.cells) {
    const color = voxelDocument.getLayerVoxel(cell.x, cell.y, cell.z)
    if (color) copied.push({ ...cell, color })
  }
  if (!copied.length) return false
  clipboard = copied
  renderToolControls()
  if (report) announce(`Copied ${formatNumber(copied.length)} ${copied.length === 1 ? 'voxel' : 'voxels'}`)
  return true
}

function cutSelection() {
  const count = selection.count
  if (!canEditActiveLayer() || !copySelection(false)) return
  eraseSelection()
  announce(`Cut ${formatNumber(count)} ${count === 1 ? 'voxel' : 'voxels'}`)
}

function cancelPendingPaste() {
  if (!pendingPaste) return
  pendingPaste = undefined
  renderer.clearSelection()
}

function pasteSelection() {
  if (pendingPaste) { showToast('Place or cancel the current paste first.'); return }
  if (!clipboard.length) { showToast('Copy or cut voxels before pasting.'); return }
  if (!canEditActiveLayer()) return
  const voxels = clipboard.filter(cell => voxelDocument.contains(cell.x, cell.y, cell.z)).map(cell => ({ ...cell }))
  if (!voxels.length) { showToast('The copied voxels are outside this canvas.', 'warning'); return }
  pendingPaste = { voxels, selectionBefore: selection.cells.map(cell => ({ ...cell })), layerId: voxelDocument.activeLayerId }
  setTool('sculpt')
  setSculptMode('move')
  renderer.setFloatingSelection(voxels)
  closeToolPopups()
  renderer.focusViewport()
  announce(`Pasted ${formatNumber(voxels.length)} ${voxels.length === 1 ? 'voxel' : 'voxels'}; drag to place`)
}

let renderer!: VoxelRenderer

function activateLayer(id: number) {
  const layer = voxelDocument.getLayer(id)
  if (!layer) return
  cancelPendingPaste()
  voxelDocument.setActiveLayer(id)
  renderer.clearSelection()
  renderDocumentFacts()
  renderToolControls()
  queueSave()
  announce(`${layer.name} active`)
}

renderer = new VoxelRenderer(document.querySelector('#viewport')!, voxelDocument, settings, {
  onSelectionChange(next) {
    if (pendingPaste && !next.floating) pendingPaste = undefined
    selection = next
    if (next.count) dismissGuide()
    renderToolControls()
    announce(next.count ? `${formatNumber(next.count)} ${next.count === 1 ? 'voxel' : 'voxels'} selected` : 'Selection cleared')
  },
  onPaint: fillSelection,
  onErase: eraseSelection,
  onFillCommit(min, max, normal, shape) {
    if (!canEditActiveLayer()) return
    dismissGuide()
    const axis = (['x', 'y', 'z'] as const).find(name => normal[name] !== 0) ?? 'y'
    const session = new EditSession(voxelDocument)
    session.fillShape(min, max, activeColor, shape, axis)
    const command = session.commit()
    history.push(command, selection.cells, selection.cells, voxelDocument.activeLayerId)
    if (!command) { announce('Volume made no changes'); return }
    renderer.markDirty(dirtyChunks(voxelDocument, command.changes.map(change => change.id)))
    renderDocumentFacts()
    queueSave()
    announce(`${shape} volume filled`)
  },
  onPushPullCommit(cells, normal, distance, move) {
    if (!canEditActiveLayer()) return
    if (pendingPaste && move) {
      const paste = pendingPaste
      pendingPaste = undefined
      const session = new EditSession(voxelDocument)
      const nextSelection = paste.voxels.map(voxel => ({
        x: voxel.x + normal.x * distance,
        y: voxel.y + normal.y * distance,
        z: voxel.z + normal.z * distance,
      }))
      paste.voxels.forEach((voxel, index) => session.set(nextSelection[index].x, nextSelection[index].y, nextSelection[index].z, voxel.color))
      const command = session.commit()
      history.push(command, paste.selectionBefore, nextSelection, paste.layerId)
      if (command) {
        renderer.markDirty(dirtyChunks(voxelDocument, command.changes.map(change => change.id)))
        renderDocumentFacts()
        queueSave()
      }
      announce(`Placed ${formatNumber(nextSelection.length)} ${nextSelection.length === 1 ? 'voxel' : 'voxels'}`)
      return
    }
    const session = new EditSession(voxelDocument)
    const amount = move ? moveVoxels(voxelDocument, session, cells, normal, distance) : pushPull(voxelDocument, session, cells, normal, distance)
    const command = session.commit()
    const nextSelection = cells.map(cell => ({ x: cell.x + normal.x * amount, y: cell.y + normal.y * amount, z: cell.z + normal.z * amount }))
      .filter(cell => voxelDocument.getVisibleVoxelLayer(cell.x, cell.y, cell.z) === voxelDocument.activeLayerId)
    history.push(command, selection.cells, nextSelection, voxelDocument.activeLayerId)
    if (!command) return
    renderer.markDirty(dirtyChunks(voxelDocument, command.changes.map(change => change.id)))
    renderDocumentFacts()
    queueSave()
    announce(`${move ? 'Moved' : amount > 0 ? 'Pulled' : 'Pushed'} ${Math.abs(amount)} ${Math.abs(amount) === 1 ? 'voxel' : 'voxels'}`)
  },
  onPushPullPreview(cells, distance, move) {
    if (cells === undefined) { renderToolControls(); return }
    document.querySelector('#context-copy')!.textContent = pendingPaste
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
  onHover(cell) {
    document.querySelector('#coordinate-status')!.textContent = cell ? `X ${cell.x}   Y ${cell.y}   Z ${cell.z}` : 'X --   Y --   Z --'
  },
  onMeshStats(pending, quads) {
    const status = document.querySelector('#mesh-status')!
    status.textContent = pending ? `Meshing ${pending}` : `${formatNumber(quads)} faces`
    if (quads > 2_000_000) showToast('This model has a high visible-face count. Camera movement may slow down.', 'warning')
  },
  onPathTracingStatus(status) {
    document.querySelector('#path-status')!.textContent = status
  },
  onFps(fps) {
    document.querySelector('#fps-status')!.textContent = fps === undefined ? '-- fps' : `${fps} fps`
  },
  onError(message) {
    showToast(message, 'warning')
  },
})

function replaceDocument(next: VoxelDocument, preserveMaterials = false) {
  pendingPaste = undefined
  clipboard = []
  voxelDocument = next
  history = new History()
  if (!preserveMaterials) {
    activeColor = paletteIndices('all')[0] ?? 1
    recentColors = [activeColor]
    loadedPbrMaps.clear()
  }
  persistToolState()
  renderer.setDocument(voxelDocument, preserveMaterials)
  renderer.setActiveColor(activeColor)
  renderPalette()
  renderPaletteMaterial()
  renderDocumentFacts()
  queueSave()
}

function openPanel(tab = 'model') {
  if (layerPanel.matches(':popover-open')) layerPanel.hidePopover()
  closeToolPopups()
  studio.dataset.panelOpen = 'true'
  stagePanel.dataset.open = 'true'
  stagePanel.setAttribute('aria-hidden', 'false')
  document.querySelector<HTMLButtonElement>('[data-action="panel"]')!.setAttribute('aria-expanded', 'true')
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)))
  document.querySelectorAll<HTMLElement>('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tab })
}

function closePanel() {
  delete studio.dataset.panelOpen
  delete stagePanel.dataset.open
  stagePanel.setAttribute('aria-hidden', 'true')
  document.querySelector<HTMLButtonElement>('[data-action="panel"]')!.setAttribute('aria-expanded', 'false')
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
  if (pendingPaste) { cancelPendingPaste(); announce('Paste canceled'); return }
  const result = history.undo(voxelDocument)
  if (!result) return
  if (result.layerId !== undefined) voxelDocument.setActiveLayer(result.layerId)
  renderer.markDirty(dirtyChunks(voxelDocument, result.ids))
  renderer.setSelection(result.selection)
  renderDocumentFacts()
  queueSave()
  announce('Undo')
}

function redo() {
  if (pendingPaste) { cancelPendingPaste(); announce('Paste canceled'); return }
  const result = history.redo(voxelDocument)
  if (!result) return
  if (result.layerId !== undefined) voxelDocument.setActiveLayer(result.layerId)
  renderer.markDirty(dirtyChunks(voxelDocument, result.ids))
  renderer.setSelection(result.selection)
  renderDocumentFacts()
  queueSave()
  announce('Redo')
}

function toggleRenderMode() {
  if (!renderMode) cancelPendingPaste()
  renderMode = !renderMode
  const button = document.querySelector<HTMLButtonElement>('[data-action="render"]')!
  const focusFromTool = toolPopups.some(popup => popup.contains(document.activeElement)) || Boolean((document.activeElement as HTMLElement | null)?.closest('.tool-dock'))
  if (renderMode) { clearShortcutPrefix(); closeToolPopups(); if (focusFromTool) button.focus({ preventScroll: true }) }
  studio.dataset.renderMode = String(renderMode)
  document.querySelectorAll<HTMLElement>('.tool-dock, .context-dock').forEach(element => { element.inert = renderMode })
  renderer.setRenderMode(renderMode)
  button.setAttribute('aria-pressed', String(renderMode))
  if (renderMode && !matchMedia('(max-width: 840px)').matches) openPanel('render')
  announce(renderMode ? 'Render mode on' : 'Render mode off')
}

document.addEventListener('click', async event => {
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
      const layer = voxelDocument.createLayer()
      renderer.clearSelection()
      renderDocumentFacts()
      renderToolControls()
      queueSave()
      announce(`${layer.name} created`)
      return
    }
    const id = Number(layerButton.closest<HTMLElement>('[data-layer-id]')?.dataset.layerId)
    const layer = voxelDocument.getLayer(id)
    if (!layer) return
    if (action === 'select') {
      activateLayer(id)
    }
    if (action === 'visibility') {
      layer.visible = !layer.visible
      renderer.setSelection(selection.cells)
      renderer.markDirty(dirtyChunks(voxelDocument, voxelDocument.chunks.keys()))
      renderDocumentFacts()
      queueSave()
      announce(`${layer.name} ${layer.visible ? 'shown' : 'hidden'}`)
    }
    if (action === 'lock') {
      layer.locked = !layer.locked
      renderDocumentFacts()
      queueSave()
      announce(`${layer.name} ${layer.locked ? 'locked' : 'unlocked'}`)
    }
    if (action === 'delete') {
      const count = voxelDocument.layerVoxelCount(id)
      if (count && !confirm(`Delete ${layer.name} and its ${formatNumber(count)} voxels?`)) return
      const ids = [...voxelDocument.chunks.keys()]
      voxelDocument.deleteLayer(id)
      history.clear()
      renderer.clearSelection()
      renderer.markDirty(dirtyChunks(voxelDocument, ids))
      renderDocumentFacts()
      renderToolControls()
      queueSave()
      announce(`${layer.name} deleted`)
    }
    return
  }
  const selectionButton = target.closest<HTMLButtonElement>('[data-selection-mode]')
  if (selectionButton) {
    if (activeTool !== 'select') setTool('select')
    selectionMode = selectionButton.dataset.selectionMode as SelectionMode
    renderer.setSelectionMode(selectionMode)
    persistToolState()
    renderToolControls()
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
  if (action === 'undo') undo()
  if (action === 'redo') redo()
  if (action === 'frame') renderer.frameModel()
  if (action === 'render') toggleRenderMode()
  if (action === 'panel') stagePanel.dataset.open ? closePanel() : openPanel('model')
  if (action === 'close-panel') closePanel()
  if (action === 'palette') {
    if (button.closest('#paint-tool-popup') && activeTool !== 'paint') setTool('paint')
    openPanel('palette')
  }
  if (action === 'dismiss-guide') dismissGuide()
  if (action === 'clear-pbr') {
    renderer.clearPbrMaps(activeColor)
    loadedPbrMaps.delete(activeColor)
    renderPaletteMaterial()
    announce(`PBR texture maps cleared for color ${activeColor}`)
  }
  if (action === 'new') {
    if (voxelDocument.voxelCount && !confirm('Clear this model and start a new document? Your autosave will be replaced.')) return
    replaceDocument(new VoxelDocument(voxelDocument.dimensions))
    closePanel()
    showToast('New document ready.')
  }
  if (action === 'import') fileInput.click()
  if (action === 'export') {
    try { download(exportVox(voxelDocument), filename('vox'), 'application/octet-stream'); showToast('VOX file exported.') }
    catch { showToast('The VOX file could not be created.', 'warning') }
  }
  if (action === 'capture') {
    button.disabled = true
    try { download(await renderer.capture(), filename('png'), 'image/png'); showToast('PNG captured.') }
    catch { showToast('The viewport could not be captured.', 'warning') }
    finally { button.disabled = false }
  }
  if (action === 'new-swatch') {
    const free = Array.from({ length: 255 }, (_, index) => index + 1).find(index => !voxelDocument.palette[index])
    if (!free) { showToast('The 255-color palette is full.', 'warning'); return }
    voxelDocument.palette[free] = voxelDocument.palette[activeColor]
    voxelDocument.materials[free] = { ...voxelDocument.materials[activeColor], name: `${voxelDocument.materials[activeColor].name} copy`.slice(0, 40) }
    activeColor = free
    recentColors = [free, ...recentColors].slice(0, 6)
    persistToolState()
    renderer.updatePalette()
    renderer.updatePaletteMaterial(free)
    renderPalette()
    renderPaletteMaterial()
    queueSave()
  }
  document.querySelector<HTMLDetailsElement>('#project-menu')!.open = false
})

projectName.value = voxelDocument.name
projectName.addEventListener('input', () => {
  voxelDocument.name = projectName.value.trim() || 'Untitled'
  queueSave()
})

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  fileInput.value = ''
  if (!file) return
  if (voxelDocument.voxelCount && !confirm('Replace the current model with this VOX file?')) return
  try {
    const imported = importVox(await file.arrayBuffer(), file.name)
    replaceDocument(imported.document)
    closePanel()
    showToast(imported.warning ?? `Imported ${formatNumber(imported.document.voxelCount)} voxels.`, imported.warning ? 'warning' : 'normal')
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'This VOX file could not be imported.', 'warning')
  }
})

resizeForm.addEventListener('submit', event => {
  event.preventDefault()
  const data = new FormData(resizeForm)
  const dimensions: Dimensions = { x: Number(data.get('x')), y: Number(data.get('y')), z: Number(data.get('z')) }
  const anchor: ResizeAnchor = data.get('anchor') === 'origin' ? 'origin' : 'center'
  const { document: resized, cropped } = resizeVoxelDocument(voxelDocument, dimensions, anchor)
  if (cropped && !confirm(`Resize and remove ${formatNumber(cropped)} voxels outside the new bounds?`)) return
  replaceDocument(resized, true)
  showToast(`Canvas resized to ${resized.dimensions.x} × ${resized.dimensions.y} × ${resized.dimensions.z} from ${anchor}.`)
})

function updateActiveColor(value: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) { showToast('Enter a six-digit hex color such as #2F66DB.', 'warning'); renderPalette(); return }
  voxelDocument.palette[activeColor] = Number.parseInt(value.slice(1), 16)
  renderer.updatePalette()
  renderPalette()
  queueSave()
}

document.querySelector<HTMLInputElement>('#color-input')!.addEventListener('change', event => updateActiveColor((event.target as HTMLInputElement).value))
document.querySelector<HTMLInputElement>('#hex-input')!.addEventListener('change', event => updateActiveColor((event.target as HTMLInputElement).value))
document.querySelector<HTMLInputElement>('#material-name')!.addEventListener('change', event => {
  const input = event.target as HTMLInputElement
  const material = voxelDocument.materials[activeColor]
  material.name = input.value.trim().slice(0, 40) || `Color ${activeColor}`
  renderer.updatePaletteMaterial(activeColor)
  renderPalette()
  renderPaletteMaterial()
  queueSave()
})

layerList.addEventListener('change', event => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-layer-name]')
  if (!input) return
  const layer = voxelDocument.getLayer(Number(input.dataset.layerName))
  if (!layer) return
  if (voxelDocument.renameLayer(layer.id, input.value)) {
    queueSave()
    announce(`Layer renamed to ${voxelDocument.getLayer(layer.id)!.name}`)
  }
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

layerList.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement) {
    event.preventDefault()
    const select = event.target.closest<HTMLElement>('[data-layer-id]')?.querySelector<HTMLButtonElement>('[data-layer-action="select"]')
    event.target.blur()
    select?.focus()
  }
})

document.querySelector<HTMLElement>('[data-panel="palette"]')!.addEventListener('input', event => {
  const target = event.target as HTMLInputElement | HTMLSelectElement
  if (target instanceof HTMLInputElement && target.dataset.pbrMap) { void loadPbrMap(target); return }
  if (target.id === 'roughness' || target.id === 'metalness' || target.id === 'emissiveIntensity' || target.id === 'opacity' || target.id === 'transmission' || target.id === 'ior') {
    const value = Number(target.value)
    voxelDocument.materials[activeColor][target.id as 'roughness' | 'metalness' | 'emissiveIntensity' | 'opacity' | 'transmission' | 'ior'] = value
    document.querySelector(`#${target.id}-output`)!.textContent = value.toFixed(2)
    renderer.updatePaletteMaterial(activeColor)
    renderMaterialPreview()
    queueSave()
  }
})

document.querySelector<HTMLElement>('[data-panel="palette"]')!.addEventListener('change', event => {
  const target = event.target as HTMLInputElement
  if (target.matches('#roughness, #metalness, #emissiveIntensity, #opacity, #transmission, #ior')) renderPalette()
})

document.querySelector<HTMLElement>('[data-panel="render"]')!.addEventListener('input', event => {
  const target = event.target as HTMLInputElement | HTMLSelectElement
  if (target.id === 'projection') settings.projection = target.value as ViewSettings['projection']
  if (target.id === 'background') settings.background = target.value
  if (target.id === 'ambient') settings.ambient = Number(target.value)
  if (target.id === 'light') settings.light = Number(target.value)
  if (target.id === 'azimuth') settings.lightAzimuth = Number(target.value)
  if (target.id === 'ambient-occlusion') settings.ambientOcclusion = (target as HTMLInputElement).checked
  if (target.id === 'shadows') settings.shadows = (target as HTMLInputElement).checked
  if (target.id === 'grid') settings.grid = (target as HTMLInputElement).checked
  if (target.id === 'face-grid') settings.faceGrid = (target as HTMLInputElement).checked
  if (target.id === 'path-tracing') settings.pathTracing = (target as HTMLInputElement).checked
  renderer.setSettings(settings)
  renderSettings()
  queueSave()
})

document.querySelector<HTMLInputElement>('#fill-depth')!.addEventListener('input', event => {
  const input = event.target as HTMLInputElement
  if (!input.value) return
  fillDepth = Math.max(1, Math.min(256, Math.round(Number(input.value))))
  if (Number(input.value) !== fillDepth) input.value = String(fillDepth)
  renderer.setFillDepth(fillDepth)
  renderToolControls()
})

document.querySelector<HTMLInputElement>('#fill-depth')!.addEventListener('change', event => {
  const input = event.target as HTMLInputElement
  input.value = String(fillDepth)
})

document.addEventListener('keydown', event => {
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
    renderer.clearSelection()
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
  if (key === 'f') { event.preventDefault(); renderer.frameModel() }
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
setTool(activeTool)
updateSaveStatus()
if (storageError) showToast(storageError, 'warning')

window.addEventListener('beforeunload', event => {
  if (saveState === 'saving') event.preventDefault()
})
