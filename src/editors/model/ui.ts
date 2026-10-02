import { icon } from '../../shared/ui/icons'
import { escapeHtml } from '../../shared/ui/dom'
import { SKYBOX_PRESETS } from '../../shared/rendering/settings'

export const materialCube = `<svg class="material-cube" viewBox="0 0 64 64" aria-hidden="true"><path class="preview-top" d="m32 8 23 13-23 13L9 21 32 8Z"/><path class="preview-left" d="M9 21l23 13v26L9 47V21Z"/><path class="preview-right" d="m32 34 23-13v26L32 60V34Z"/></svg>`

export function modelMarkup(externalViewport: boolean, menuActions: { action: string; label: string; hidden?: boolean }[] = []) {
  const actions = [['attach', 'attach', 'Attach', 'T'], ['erase', 'erase', 'Erase', 'R'], ['paint', 'paint', 'Paint', 'G'], ['select', 'select', 'Select', 'N'], ['move', 'move', 'Move', '']] as const
  const actionButtons = actions
    .map(([value, glyph, label, key]) => `<button type="button" data-model-action="${value}" aria-pressed="false" title="${label}${key ? ` (${key})` : ' (Ctrl/Command-drag)'}">${icon(glyph)}<span>${label}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`).join('')
  const brushes = [['voxel', 'voxel', 'Voxel', 'V'], ['face', 'face', 'Face', 'F'], ['box', 'box', 'Box', 'B'], ['line', 'line', 'Line', 'L'], ['center', 'center', 'Center', 'C'], ['texture', 'pattern', 'Texture', ''], ['body', 'box', 'Body', ''], ['pattern', 'pattern', 'Pattern', 'P']] as const
  const brushButtons = brushes
    .map(([value, glyph, label, key]) => `<button type="button" data-brush="${value}" aria-pressed="false" title="${value === 'box' ? 'Box brush: drag between opposite 3D corners' : `${label} brush`}${key ? ` (${key})` : ''}" ${value === 'pattern' ? 'disabled' : ''}>${icon(glyph)}<span>${label}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`).join('')
  const mobileWheel = (kind: 'brush' | 'action', choices: readonly (typeof brushes[number] | typeof actions[number])[], selected: string) => {
    const [, glyph, label] = choices.find(([value]) => value === selected)!
    return `<div class="mobile-wheel-picker" data-mobile-wheel="${kind}">
      <button id="mobile-${kind}-trigger" class="mobile-wheel-trigger" type="button" aria-haspopup="listbox" aria-controls="mobile-${kind}-wheel" aria-expanded="false" aria-label="Choose ${kind}, ${label} selected" data-wheel-trigger><span id="mobile-${kind}-icon" class="mobile-wheel-icon">${icon(glyph)}</span><span class="sr-only"><strong id="mobile-${kind}-value">${label}</strong></span></button>
      <div class="mobile-wheel-panel instrument" data-wheel-panel hidden>
        <div id="mobile-${kind}-wheel" class="wheel-drum" role="listbox" tabindex="0" aria-orientation="horizontal" aria-label="${kind === 'brush' ? 'Brush' : 'Tool'} selection" aria-describedby="mobile-wheel-help">
          ${choices.map(([value, glyph, label]) => `<button id="mobile-${kind}-${value}" type="button" role="option" tabindex="-1" data-wheel-value="${value}" aria-label="${label}" aria-selected="${value === selected}">${icon(glyph)}<span class="option-tooltip" aria-hidden="true">${label}</span></button>`).join('')}
        </div>
      </div>
    </div>`
  }
  const operationButtons = (mobile = false) => `
    <button type="button" data-auxiliary="pick" aria-pressed="false" title="Eyedropper (Alt-click)">${icon('pick')}<span>${mobile ? 'Eyedropper' : 'Pick'}</span></button>
    <button ${mobile ? 'data-mobile-layer-trigger' : 'id="layer-tool-trigger"'} type="button" data-secondary-tool="layer" popovertarget="layer-panel" aria-pressed="false" title="Layers">${icon('layers')}<span>Layer</span></button>`
  const mirrorButtons = (['x', 'y', 'z'] as const).map((axis, index) => `<button type="button" class="axis-button" data-mirror="${axis}" aria-label="Mirror ${axis.toUpperCase()}" aria-pressed="false" title="Mirror ${axis.toUpperCase()} (${index + 1})">${axis.toUpperCase()}</button>`).join('')
  const wholeAxisButtons = (['x', 'y', 'z'] as const).map((axis, index) => `<button type="button" class="axis-button" data-whole-axis="${axis}" aria-label="Whole ${axis.toUpperCase()} axis" aria-pressed="false" title="Whole ${axis.toUpperCase()} axis (Ctrl/Command ${index + 1})">${axis.toUpperCase()}</button>`).join('')
  const clipboardButtons = (mobile = false) => `
    <button type="button" data-clipboard-action="cut" aria-label="Cut" title="Cut (Ctrl/Command X)">${icon('cut')}${mobile ? '<span>Cut</span>' : ''}</button>
    <button type="button" data-clipboard-action="copy" aria-label="Copy" title="Copy (Ctrl/Command C)">${icon('copy')}${mobile ? '<span>Copy</span>' : ''}</button>
    <button type="button" data-clipboard-action="paste" aria-label="Paste" title="Paste (Ctrl/Command V)">${icon('paste')}${mobile ? '<span>Paste</span>' : ''}</button>`
  const materialButton = (mobile = false) => `<button class="active-swatch deck-swatch" type="button" data-action="palette" aria-label="Open material picker">${materialCube}${mobile ? '<span>Palette</span>' : ''}</button>`

  return `

    <main class="model-editor" data-render-mode="false" data-tool="attach">
      ${externalViewport ? '' : '<div id="viewport" class="viewport"></div>'}

      <div class="top-chrome" role="toolbar" aria-label="Project controls">
        <div class="project-pill instrument">
          <details id="project-menu" class="project-menu">
            <summary aria-label="Open project menu" title="Project menu">${icon('menu')}</summary>
            <div class="menu-sheet">
              <div class="project-actions" role="menu" aria-label="Project">
              <strong>Project</strong>
              <button type="button" data-action="save-model" role="menuitem">Save model...</button>
              <button type="button" data-action="browse-models" role="menuitem">Browse models...</button>
              ${(menuActions ?? []).map(item => `<button type="button" data-action="${escapeHtml(item.action)}" role="menuitem" ${item.hidden ? 'hidden' : ''}>${escapeHtml(item.label)}</button>`).join('')}
              <button type="button" data-action="new" role="menuitem">New document</button>
              <button type="button" data-action="import" role="menuitem">Import VOX</button>
              <button type="button" data-action="export" role="menuitem">Export VOX</button>
              <button type="button" data-action="capture" role="menuitem">Capture PNG</button>
              </div>
            </div>
          </details>
          <label class="project-name"><span class="sr-only">Project name</span><input id="project-name" maxlength="60" value="Untitled"></label>
          <span id="save-status" class="save-status"><i></i><span>Saved locally</span></span>
        </div>

        <div class="top-actions instrument">
          <button type="button" data-action="undo" aria-label="Undo" title="Undo (Ctrl/Command Z)">${icon('undo')}</button>
          <button type="button" data-action="redo" aria-label="Redo" title="Redo (Ctrl/Command Shift Z)">${icon('redo')}</button>
          <button type="button" data-action="panel" aria-label="Open settings" aria-expanded="false" title="Settings">${icon('settings')}</button>
        </div>
      </div>

      <div class="view-control instrument" aria-label="Camera orientation">
        <div class="orientation-cube">
          <button type="button" data-view-face="top" aria-label="Top view" title="Top view">Y</button>
          <button type="button" data-view-face="right" aria-label="Right view" title="Right view">X</button>
          <button type="button" data-view-face="front" aria-label="Front view" title="Front view">Z</button>
        </div>
        <button type="button" class="view-trigger" popovertarget="view-panel" aria-label="View options">View ${icon('chevron')}</button>
      </div>
      <aside id="view-panel" class="view-panel instrument" popover aria-label="View options">
        <button type="button" data-action="frame" title="Frame model">${icon('frame')}Fit to scene</button>
        <div class="view-faces" role="group" aria-label="Camera views">${['front', 'back', 'left', 'right', 'top', 'bottom'].map(face => `<button type="button" data-view-face="${face}">${face[0].toUpperCase() + face.slice(1)}</button>`).join('')}</div>
        <label class="toggle-row"><span>Ground grid</span><input type="checkbox" data-view-setting="grid"></label>
        <label class="toggle-row"><span>Shadows</span><input type="checkbox" data-view-setting="shadows"></label>
        <label class="toggle-row"><span>Ambient occlusion</span><input type="checkbox" data-view-setting="ambientOcclusion"></label>
        <button type="button" data-action="render" aria-label="Toggle render mode" aria-pressed="false">${icon('camera')}Render mode</button>
        <button type="button" data-action="lighting">Lighting and camera settings ${icon('chevron')}</button>
      </aside>

      <section id="welcome" class="welcome-panel instrument" aria-labelledby="welcome-title" hidden>
        <button type="button" class="welcome-close" data-action="dismiss-guide" aria-label="Dismiss guide">${icon('close')}</button>
        <span class="welcome-cube" aria-hidden="true">${icon('logo')}</span>
        <h1 id="welcome-title">Action meets brush.</h1>
        <p>Choose what happens, then choose the shape. Attach with Box is ready.</p>
        <button type="button" class="primary" data-action="dismiss-guide">Start shaping</button>
      </section>

      <div class="scene-status instrument" role="group" aria-label="Model status" hidden>
        <span id="coordinate-status" aria-live="polite">X -- &nbsp; Y -- &nbsp; Z --</span>
        <span class="status-rule"></span>
        <span id="voxel-count">0 voxels</span>
        <span class="status-rule"></span>
        <span id="mesh-status">Ready</span>
        <span class="status-rule"></span>
        <span id="fps-status">-- fps</span>
      </div>

      <div id="context-dock" class="context-dock instrument" hidden>
        <div class="context-summary"><strong id="context-title">Attach · Box</strong><span id="context-copy">Drag between surface or guide-grid cells to span X, Y, and Z.</span></div>
      </div>

      <nav class="tool-dock mobile-tool-shelf instrument" aria-label="Current voxel tools">
        <div class="mobile-tool-summary" role="group" aria-label="Retained action and brush">
          ${mobileWheel('brush', brushes.slice(0, 5), 'box')}
          ${mobileWheel('action', actions.slice(0, 3), 'attach')}
          <div class="mobile-wheel-picker" data-mobile-wheel="material"><button class="active-swatch dock-material" type="button" data-action="palette" data-wheel-trigger aria-controls="material-picker" aria-haspopup="listbox" aria-expanded="false" aria-label="Open material picker">${materialCube}${icon('chevron')}</button></div>
        </div>
        <span id="mobile-wheel-help" class="sr-only">Tap to open, then tap an option. Or press, slide onto an option, and release to choose. Tap outside or press Escape to close. Arrow keys and Enter select.</span>
      </nav>
      <button class="all-tools-trigger instrument" type="button" popovertarget="all-tools-panel" aria-label="Open all tools">${icon('more')}<span id="mobile-operation-value" class="sr-only" hidden></span></button>

      <aside id="material-picker" class="material-picker instrument" hidden aria-label="Material picker">
        <div id="material-picker-grid" class="palette-grid" data-view="grid" role="listbox" tabindex="0" aria-label="Choose material" aria-describedby="mobile-wheel-help"></div>
        <button type="button" class="secondary full" data-action="edit-materials">Edit materials ${icon('chevron')}</button>
      </aside>

      <aside id="all-tools-panel" class="tool-popup all-tools-panel instrument" popover aria-labelledby="all-tools-title">
        <header>
          <div><strong id="all-tools-title">All tools</strong><span>Shape, select, and transform</span></div>
          <button type="button" popovertarget="all-tools-panel" popovertargetaction="hide" aria-label="Close all tools">${icon('close')}</button>
        </header>
        <div class="all-tools-body">
          <section class="all-tools-group" aria-labelledby="all-tools-action-title"><h2 id="all-tools-action-title">Action</h2><div class="all-tools-grid" role="group" aria-labelledby="all-tools-action-title">${actionButtons}</div></section>
          <section class="all-tools-group brush-tools-group" aria-labelledby="all-tools-brush-title"><h2 id="all-tools-brush-title">Brush</h2><div class="all-tools-grid" role="group" aria-labelledby="all-tools-brush-title">${brushButtons}</div></section>
          <section class="all-tools-group utility-tools-group" aria-labelledby="all-tools-utilities-title"><h2 id="all-tools-utilities-title">Utilities</h2><div class="all-tools-grid" role="group" aria-labelledby="all-tools-utilities-title">${operationButtons(true)}</div></section>
          <section class="all-tools-group axis-tools-group" aria-labelledby="all-tools-mirror-title"><h2 id="all-tools-mirror-title">Mirror axes</h2><div class="all-tools-grid" role="group" aria-labelledby="all-tools-mirror-title">${mirrorButtons}</div></section>
          <section class="all-tools-group axis-tools-group" aria-labelledby="all-tools-axis-title"><h2 id="all-tools-axis-title">Whole axes</h2><div class="all-tools-grid" role="group" aria-labelledby="all-tools-axis-title">${wholeAxisButtons}</div></section>
          <section class="all-tools-group clipboard-tools-group" aria-labelledby="all-tools-clipboard-title"><h2 id="all-tools-clipboard-title">Clipboard</h2><div class="all-tools-grid" role="group" aria-labelledby="all-tools-clipboard-title">${clipboardButtons(true)}</div></section>
          <section class="all-tools-group material-tools-group" aria-labelledby="all-tools-material-title"><h2 id="all-tools-material-title">Material</h2><div class="all-tools-grid" role="group" aria-labelledby="all-tools-material-title">${materialButton(true)}</div></section>
        </div>
      </aside>

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
          <div><strong id="settings-title">Settings</strong><span>Model, materials &amp; light</span></div>
          <button type="button" data-action="close-panel" aria-label="Close stage settings">${icon('close')}</button>
        </header>
        <nav class="panel-tabs" role="tablist" aria-label="Stage sections">
          <button id="model-tab" type="button" role="tab" data-tab="model" aria-selected="true">Model</button>
          <button id="palette-tab" type="button" role="tab" data-tab="palette" aria-selected="false">Palette</button>
          <button id="render-tab" type="button" role="tab" data-tab="render" aria-selected="false">Render</button>
        </nav>

        <section class="panel-section" role="tabpanel" aria-labelledby="model-tab" data-panel="model">
          <label class="toggle-row"><span>Show diagnostics</span><input id="diagnostics" type="checkbox"></label>
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
          <div class="palette-view-bar"><strong>Palette</strong><div role="group" aria-label="Palette view"><button type="button" data-palette-view="grid" aria-pressed="true">Grid</button><button type="button" data-palette-view="list" aria-pressed="false">List</button></div></div>
          <div class="palette-filter-bar" role="group" aria-label="Filter materials">
            <button type="button" data-palette-filter="opaque" aria-pressed="false">Opaque</button>
            <button type="button" data-palette-filter="transparent" aria-pressed="false">Transparent</button>
            <button type="button" data-palette-filter="metal" aria-pressed="false">Metal</button>
            <button type="button" data-palette-filter="emissive" aria-pressed="false">Emissive</button>
          </div>
          <div id="palette-grid" class="palette-grid" data-view="grid" role="group" aria-label="Document palette"></div>
          <details class="material-properties"><summary>Edit material properties</summary>
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
          </details>
        </section>

        <section class="panel-section" role="tabpanel" aria-labelledby="render-tab" data-panel="render" hidden>
          <div class="section-heading"><h2>Render</h2><span>Realtime / progressive</span></div>
          <label class="select-row"><span>Renderer</span><select id="preview-renderer" aria-describedby="preview-renderer-help"><option value="standard">Standard</option><option value="cube-sprites" disabled>Cube sprites</option></select></label>
          <p id="preview-renderer-help" class="panel-note" aria-live="polite" hidden></p>
          <label class="toggle-row"><span>PBR materials</span><input id="pbr-materials" type="checkbox" aria-describedby="pbr-materials-help"></label>
          <p id="pbr-materials-help" class="panel-note">Shared by Standard and Cube sprites for realtime rendering only. Off uses opaque palette colors without changing materials or maps. Progressive PBR is independent.</p>
          <label class="select-row"><span>Camera</span><select id="projection" aria-describedby="preview-renderer-help"><option value="orthographic">Orthographic</option><option value="perspective">Perspective</option></select></label>
          <label class="toggle-row"><span>Progressive PBR <output id="path-status" aria-live="polite">Ready</output></span><input id="path-tracing" type="checkbox" aria-label="Progressive PBR" aria-describedby="pbr-materials-help preview-renderer-help"></label>
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
          <label class="toggle-row"><span>Volumetric lighting</span><input id="volumetric-lighting" type="checkbox" aria-describedby="volumetric-lighting-help" aria-controls="fog-controls"></label>
          <p id="volumetric-lighting-help" class="panel-note">Adds sunbeams and haze to realtime and progressive rendering, with extra render cost. With Shadows off, haze remains.</p>
          <div id="fog-controls" hidden>
            <label class="range-row"><span>Density<output id="fogDensity-output" for="fogDensity">100%</output></span><input id="fogDensity" aria-label="Fog density" aria-describedby="fog-density-help" type="range" min="0" max="3" value="1" step="0.05"></label>
            <p id="fog-density-help" class="panel-note">Density is relative: 100% is the default.</p>
            <label class="range-row"><span>Spread<output id="fogSpread-output" for="fogSpread">25%</output></span><input id="fogSpread" aria-label="Fog spread" aria-describedby="fog-spread-help" type="range" min="0" max="1" value="0.25" step="0.05"></label>
            <p id="fog-spread-help" class="panel-note">Spread extends atmosphere beyond the model on each side, as a percentage of its longest axis.</p>
            <label class="color-row"><span>Fog color</span><input id="fog-color" type="color" value="#ffffff"></label>
          </div>
          <label class="toggle-row"><span>Editing grid</span><input id="grid" type="checkbox"></label>
          <label class="toggle-row"><span>Enclosing grid guides</span><input id="grid-walls" type="checkbox"></label>
          <label class="toggle-row"><span>Voxel face grid</span><input id="face-grid" type="checkbox"></label>
          <label class="toggle-row" title="Show the merged mesh's vertices in edit mode"><span>Mesh vertices</span><input id="mesh-vertices" type="checkbox"></label>
          <label class="toggle-row" title="Show the merged mesh's triangle edges in edit mode"><span>Mesh triangles</span><input id="mesh-triangles" type="checkbox"></label>
          <label class="toggle-row"><span>Performance monitor</span><input type="checkbox" data-performance-monitor aria-describedby="model-performance-help"></label>
          <p id="model-performance-help" class="panel-note">FPS, main-thread render time, and JS heap where available. Remembered in this browser; not included in PNG captures.</p>
          <label class="toggle-row"><span>Auto simplify rendering</span><input type="checkbox" data-auto-simplify-rendering aria-describedby="model-auto-simplify-help"></label>
          <p id="model-auto-simplify-help" class="panel-note">While moving the camera or editing, turns off realtime PBR, shadows, ambient occlusion, volumetric lighting, and miniature photography, and pauses progressive PBR. Glass becomes opaque. Restores your settings afterward; captures keep requested quality. Remembered in this browser.</p>
          <button type="button" class="primary full" data-action="capture">${icon('camera')} Capture PNG</button>
        </section>
      </aside>

      <input id="file-input" type="file" accept=".vox" hidden>
      <div id="toast" class="toast instrument" role="status" aria-live="polite" hidden></div>
      <div id="announcer" class="sr-only" aria-live="polite"></div>
    </main>
  `

}
