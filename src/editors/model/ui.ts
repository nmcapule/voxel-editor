import { icon } from '../../shared/ui/icons'
import { escapeHtml } from '../../shared/ui/dom'
import { SKYBOX_PRESETS } from '../../shared/rendering/settings'

export const materialCube = `<svg class="material-cube" viewBox="0 0 64 64" aria-hidden="true"><path class="preview-top" d="m32 8 23 13-23 13L9 21 32 8Z"/><path class="preview-left" d="M9 21l23 13v26L9 47V21Z"/><path class="preview-right" d="m32 34 23-13v26L32 60V34Z"/></svg>`

export function modelMarkup(externalViewport: boolean, menuActions: { action: string; label: string; hidden?: boolean }[] = []) {
  return `

    <main class="model-editor" data-render-mode="false" data-tool="select">
      ${externalViewport ? '' : '<div id="viewport" class="viewport"></div>'}

      <div class="top-chrome" role="toolbar" aria-label="Project controls">
        <div class="project-pill instrument">
          <details id="project-menu" class="project-menu">
            <summary aria-label="Open project menu" title="Project menu">${icon('menu')}</summary>
            <div class="menu-sheet" role="menu">
              <strong>Project</strong>
              <button type="button" data-action="save-model" role="menuitem">Save model...</button>
              <button type="button" data-action="browse-models" role="menuitem">Browse models...</button>
              ${(menuActions ?? []).map(item => `<button type="button" data-action="${escapeHtml(item.action)}" role="menuitem" ${item.hidden ? 'hidden' : ''}>${escapeHtml(item.label)}</button>`).join('')}
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
        <div class="tool-slot">
          <button type="button" class="tool-expand" data-tool-popup="select" popovertarget="select-tool-popup" aria-label="Expand Select options" title="Select options">${icon('chevron')}</button>
          <button type="button" data-tool="select" aria-pressed="false">${icon('select')}<span class="tool-label"><strong>Select</strong><small id="select-tool-mode">Point</small></span><kbd>Q</kbd></button>
        </div>
        <div class="tool-slot">
          <button type="button" class="tool-expand" data-tool-popup="paint" popovertarget="paint-tool-popup" aria-label="Expand Place options" title="Place options">${icon('chevron')}</button>
          <button type="button" data-tool="paint" aria-pressed="false">${icon('paint')}<span class="tool-label"><strong>Place</strong><small><i id="paint-tool-swatch"></i><span id="paint-tool-mode">Paint</span></small></span><kbd>W</kbd></button>
        </div>
        <div class="tool-slot">
          <button type="button" class="tool-expand" data-tool-popup="sculpt" popovertarget="sculpt-tool-popup" aria-label="Expand Sculpt options" title="Sculpt options">${icon('chevron')}</button>
          <button type="button" data-tool="sculpt" aria-pressed="false">${icon('push')}<span class="tool-label"><strong>Sculpt</strong><small id="sculpt-tool-mode">Push/Pull</small></span><kbd>S</kbd></button>
        </div>
        <div class="tool-slot">
          <button type="button" class="tool-expand" data-tool-popup="layer" popovertarget="layer-panel" aria-label="Expand Layer options" title="Layer options">${icon('chevron')}</button>
          <button type="button" data-tool="layer" aria-pressed="false">${icon('layers')}<span class="tool-label"><strong>Layer</strong><small id="layer-tool-mode">Layer 1</small></span><kbd>L</kbd></button>
        </div>
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
          <label class="select-row"><span>Renderer</span><select id="preview-renderer" aria-describedby="preview-renderer-help"><option value="standard">Standard</option><option value="cube-sprites" disabled>Cube sprites</option></select></label>
          <label id="cube-sprites-pbr-row" class="toggle-row" hidden><span>PBR materials</span><input id="cube-sprites-pbr" type="checkbox" aria-describedby="preview-renderer-help" disabled></label>
          <p id="preview-renderer-help" class="panel-note" aria-live="polite" hidden></p>
          <label class="select-row"><span>Camera</span><select id="projection" aria-describedby="preview-renderer-help"><option value="orthographic">Orthographic</option><option value="perspective">Perspective</option></select></label>
          <label class="toggle-row"><span>Progressive PBR <output id="path-status" aria-live="polite">Ready</output></span><input id="path-tracing" type="checkbox" aria-label="Progressive PBR" aria-describedby="preview-renderer-help"></label>
          <label class="toggle-row"><span>Miniature photography</span><input id="tilt-shift" type="checkbox" aria-describedby="tilt-shift-help" aria-controls="tilt-shift-controls"></label>
          <p id="tilt-shift-help" class="panel-note">A tilt-shift effect visible only in Render mode and included in PNG captures from Render mode.</p>
          <div id="tilt-shift-controls" hidden>
            ${([['tiltShiftStrength', 'Blur strength', 0.5], ['tiltShiftFocus', 'Focus position', 0.5], ['tiltShiftWidth', 'Sharp band width', 0.3]] as const).map(([key, label, value]) => `<label class="range-row"><span>${label}<output id="${key}-output" for="${key}">${Math.round(value * 100)}%</output></span><input id="${key}" aria-label="${label}" aria-describedby="tilt-shift-band-help" type="range" min="0" max="1" value="${value}" step="0.01"></label>`).join('')}
            <p id="tilt-shift-band-help" class="panel-note">Focus runs from 0% at the top to 100% at the bottom. Sharp band width is a percentage of image height.</p>
          </div>
          <label class="select-row"><span>Skybox</span><select id="skybox">${Object.entries(SKYBOX_PRESETS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
          <label id="background-label" class="color-row"><span>Backdrop</span><input id="background" type="color"></label>
          <label class="range-row"><span>Ambient <output id="ambient-output">1.2</output></span><input id="ambient" aria-label="Ambient light" type="range" min="0" max="3" value="1.2" step="0.1"></label>
          <label class="range-row"><span>Key light <output id="light-output">2.4</output></span><input id="light" aria-label="Key light" type="range" min="0" max="5" value="2.4" step="0.1"></label>
          <label class="range-row"><span>Light angle <output id="azimuth-output">42°</output></span><input id="azimuth" aria-label="Light angle" type="range" min="-180" max="180" value="42" step="1"></label>
          <p id="skybox-help" class="panel-note" hidden>Ambient scales sky lighting and reflections. Key light controls the sun or moon. Light angle rotates the sky and light.</p>
          <label class="toggle-row"><span>Ambient occlusion</span><input id="ambient-occlusion" type="checkbox"></label>
          <label class="toggle-row"><span>Shadows</span><input id="shadows" type="checkbox"></label>
          <label class="toggle-row"><span>Editing grid</span><input id="grid" type="checkbox"></label>
          <label class="toggle-row"><span>Voxel face grid</span><input id="face-grid" type="checkbox"></label>
          <label class="toggle-row" title="Show the merged mesh's vertices in edit mode"><span>Mesh vertices</span><input id="mesh-vertices" type="checkbox"></label>
          <label class="toggle-row" title="Show the merged mesh's triangle edges in edit mode"><span>Mesh triangles</span><input id="mesh-triangles" type="checkbox"></label>
          <button type="button" class="primary full" data-action="capture">${icon('camera')} Capture PNG</button>
        </section>
      </aside>

      <input id="file-input" type="file" accept=".vox" hidden>
      <div id="toast" class="toast instrument" role="status" aria-live="polite" hidden></div>
      <div id="announcer" class="sr-only" aria-live="polite"></div>
    </main>
  `

}
