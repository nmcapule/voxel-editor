import { expect, test } from 'bun:test'
import { modelMarkup } from './ui'

test('model editor exposes the MagicaVoxel action and brush matrix', () => {
  const actions: string[] = [], brushes: string[] = []
  const markup = modelMarkup(false)
  new HTMLRewriter()
    .on('#all-tools-panel [data-model-action]', { element(button) {
      actions.push(button.getAttribute('data-model-action')!)
      expect(button.getAttribute('aria-pressed')).toBe('false')
    } })
    .on('#all-tools-panel [data-brush]', { element(button) {
      brushes.push(button.getAttribute('data-brush')!)
      expect(button.getAttribute('aria-pressed')).toBe('false')
      if (button.getAttribute('data-brush') === 'pattern') expect(button.hasAttribute('disabled')).toBe(true)
    } })
    .transform(markup)

  expect(actions).toEqual(['attach', 'erase', 'paint', 'select', 'move'])
  expect(brushes).toEqual(['voxel', 'face', 'box', 'line', 'center', 'texture', 'body', 'pattern'])
  expect(markup).toContain('<kbd>T</kbd>')
  expect(markup).toContain('<kbd>F</kbd>')
  expect(markup).toContain('Box brush: drag between opposite 3D corners (B)')
  expect(markup).toContain('Drag between surface or guide-grid cells to span X, Y, and Z.')
  expect(markup).not.toContain('<kbd>Q</kbd>')
  expect(markup).not.toContain('<kbd>W</kbd>')
  expect(markup).not.toContain('<kbd>S</kbd>')
})

test('keeps only utilities beside the action and brush matrix', () => {
  const secondary: string[] = [], mirrors: string[] = [], axes: string[] = []
  const markup = modelMarkup(false)
  new HTMLRewriter()
    .on('#all-tools-panel [data-secondary-tool]', { element(button) { secondary.push(button.getAttribute('data-secondary-tool')!) } })
    .on('#all-tools-panel [data-mirror]', { element(button) { mirrors.push(button.getAttribute('data-mirror')!) } })
    .on('#all-tools-panel [data-whole-axis]', { element(button) { axes.push(button.getAttribute('data-whole-axis')!) } })
    .transform(markup)

  expect(secondary).toEqual(['layer'])
  expect(mirrors).toEqual(['x', 'y', 'z'])
  expect(axes).toEqual(['x', 'y', 'z'])
  expect(markup).toContain('data-auxiliary="pick"')
  expect(markup).not.toContain('data-secondary-tool="push"')
  expect(markup).not.toContain('data-secondary-tool="fill"')
  expect(markup).not.toContain('id="fill-options"')
  expect(markup).toContain('data-clipboard-action="paste"')
  expect(markup).toContain('popovertarget="layer-panel"')
  expect(markup).toContain('title="Frame model"')
})

test('exposes the full matrix in all tools and horizontal quick choices in the dock', () => {
  const actions: string[] = [], brushes: string[] = [], wheelBrushes: string[] = [], wheelActions: string[] = [], secondary: string[] = [], mirrors: string[] = [], axes: string[] = [], clipboard: string[] = []
  const markup = modelMarkup(false)
  let panelLabel = ''
  let panelIsPopover = false
  let triggerTarget = ''
  let closeAction = ''
  new HTMLRewriter()
    .on('.all-tools-trigger', { element(button) { triggerTarget = button.getAttribute('popovertarget') ?? '' } })
    .on('#all-tools-panel', { element(panel) { panelLabel = panel.getAttribute('aria-labelledby') ?? ''; panelIsPopover = panel.hasAttribute('popover') } })
    .on('#all-tools-panel [popovertargetaction="hide"]', { element(button) { closeAction = button.getAttribute('popovertarget') ?? '' } })
    .on('#all-tools-panel [data-model-action]', { element(button) { actions.push(button.getAttribute('data-model-action')!) } })
    .on('#all-tools-panel [data-brush]', { element(button) { brushes.push(button.getAttribute('data-brush')!) } })
    .on('#mobile-brush-wheel [data-wheel-value]', { element(button) { wheelBrushes.push(button.getAttribute('data-wheel-value')!) } })
    .on('#mobile-action-wheel [data-wheel-value]', { element(button) { wheelActions.push(button.getAttribute('data-wheel-value')!) } })
    .on('.wheel-drum', { element(wheel) { expect(wheel.getAttribute('role')).toBe('listbox'); expect(wheel.getAttribute('tabindex')).toBe('0'); expect(wheel.getAttribute('aria-orientation')).toBe('horizontal') } })
    .on('[data-wheel-trigger]', { element(button) { expect(button.getAttribute('aria-haspopup')).toBe('listbox'); expect(button.getAttribute('aria-expanded')).toBe('false') } })
    .on('#all-tools-panel [data-secondary-tool]', { element(button) { secondary.push(button.getAttribute('data-secondary-tool')!) } })
    .on('#all-tools-panel [data-mirror]', { element(button) { mirrors.push(button.getAttribute('data-mirror')!) } })
    .on('#all-tools-panel [data-whole-axis]', { element(button) { axes.push(button.getAttribute('data-whole-axis')!) } })
    .on('#all-tools-panel [data-clipboard-action]', { element(button) { clipboard.push(button.getAttribute('data-clipboard-action')!) } })
    .transform(markup)

  expect(triggerTarget).toBe('all-tools-panel')
  expect(panelLabel).toBe('all-tools-title')
  expect(panelIsPopover).toBe(true)
  expect(closeAction).toBe('all-tools-panel')
  expect(actions).toEqual(['attach', 'erase', 'paint', 'select', 'move'])
  expect(brushes).toEqual(['voxel', 'face', 'box', 'line', 'center', 'texture', 'body', 'pattern'])
  expect(wheelBrushes).toEqual(['voxel', 'face', 'box', 'line', 'center'])
  expect(wheelActions).toEqual(['attach', 'erase', 'paint'])
  expect(secondary).toEqual(['layer'])
  expect(mirrors).toEqual(['x', 'y', 'z'])
  expect(axes).toEqual(['x', 'y', 'z'])
  expect(clipboard).toEqual(['cut', 'copy', 'paste'])
  expect(markup).toContain('<strong id="mobile-action-value">Attach</strong>')
  expect(markup).toContain('id="mobile-brush-trigger"')
  expect(markup).toContain('id="mobile-action-trigger"')
  expect(markup).toContain('<strong id="mobile-brush-value">Box</strong>')
  expect(markup).toContain('data-mobile-layer-trigger')
  expect(markup).toContain('data-auxiliary="pick"')
  expect(markup).toContain('class="active-swatch deck-swatch"')
  expect(markup.match(/data-mobile-layer-trigger/g)).toHaveLength(1)
})

test('closed dock has exactly three triggers, excluding nested hidden options', () => {
  const triggers: string[] = []
  let buttons = 0, hiddenButtons = 0, panels = 0, allToolsTriggers = 0
  new HTMLRewriter()
    .on('.tool-dock button', { element() { buttons++ } })
    .on('.tool-dock [hidden] button', { element() { hiddenButtons++ } })
    .on('.tool-dock [data-wheel-panel]', { element(panel) { panels++; expect(panel.hasAttribute('hidden')).toBe(true) } })
    .on('.tool-dock [data-wheel-trigger], .tool-dock .dock-material', { element(button) {
      triggers.push(button.getAttribute('id') ?? button.getAttribute('data-action')!)
      expect(button.hasAttribute('hidden')).toBe(false)
    } })
    .on('.tool-dock .all-tools-trigger', { element() { allToolsTriggers++ } })
    .transform(modelMarkup(false))

  expect(triggers).toEqual(['mobile-brush-trigger', 'mobile-action-trigger', 'palette'])
  expect(panels).toBe(2)
  expect(hiddenButtons).toBe(8)
  expect(buttons - hiddenButtons).toBe(3)
  expect(allToolsTriggers).toBe(0)
})

test('material selection has a headerless gesture popup, separate from settings', () => {
  let target = '', hidden = false, nestedInSettings = false, grid = false, header = false
  new HTMLRewriter()
    .on('.dock-material', { element(button) { target = button.getAttribute('aria-controls')!; expect(button.hasAttribute('data-wheel-trigger')).toBe(true) } })
    .on('#material-picker', { element(panel) { hidden = panel.hasAttribute('hidden') } })
    .on('#material-picker header, #material-picker [popovertargetaction="hide"]', { element() { header = true } })
    .on('#stage-panel #material-picker', { element() { nestedInSettings = true } })
    .on('#material-picker #material-picker-grid', { element(element) { grid = true; expect(element.getAttribute('role')).toBe('listbox') } })
    .transform(modelMarkup(false))
  expect(target).toBe('material-picker')
  expect(hidden && grid).toBe(true)
  expect(header).toBe(false)
  expect(nestedInSettings).toBe(false)
})

test('top bar orders menu, project name, save status, undo, redo, and settings without view actions', () => {
  const controls: string[] = [], actions: string[] = []
  new HTMLRewriter()
    .on('.top-chrome #project-menu, .top-chrome #project-name, .top-chrome #save-status, .top-actions button', { element(control) {
      controls.push(control.getAttribute('id') ?? control.getAttribute('data-action')!)
    } })
    .on('.top-chrome [data-action]', { element(button) { actions.push(button.getAttribute('data-action')!) } })
    .transform(modelMarkup(false))

  expect(controls).toEqual(['project-menu', 'project-name', 'save-status', 'undo', 'redo', 'panel'])
  expect(actions).not.toContain('frame')
  expect(actions).not.toContain('render')
})

test('preserves view controls and opt-in diagnostics', () => {
  const orientation: string[] = [], views: string[] = [], settings: string[] = [], actions: string[] = [], diagnostics: string[] = []
  let viewTrigger = '', viewPanel = false, statusHidden = false, diagnosticsToggle = false
  new HTMLRewriter()
    .on('.view-control [data-view-face]', { element(button) { orientation.push(button.getAttribute('data-view-face')!) } })
    .on('.view-control [popovertarget]', { element(button) { viewTrigger = button.getAttribute('popovertarget')! } })
    .on('#view-panel', { element(panel) { viewPanel = panel.hasAttribute('popover') } })
    .on('#view-panel [data-view-face]', { element(button) { views.push(button.getAttribute('data-view-face')!) } })
    .on('#view-panel [data-view-setting]', { element(input) { settings.push(input.getAttribute('data-view-setting')!); expect(input.getAttribute('type')).toBe('checkbox') } })
    .on('#view-panel [data-action]', { element(button) { actions.push(button.getAttribute('data-action')!) } })
    .on('#diagnostics', { element(input) { diagnosticsToggle = input.getAttribute('type') === 'checkbox'; expect(input.hasAttribute('checked')).toBe(false) } })
    .on('.scene-status', { element(status) { statusHidden = status.hasAttribute('hidden') } })
    .on('.scene-status [id]', { element(status) { diagnostics.push(status.getAttribute('id')!) } })
    .transform(modelMarkup(false))

  expect(orientation).toEqual(['top', 'right', 'front'])
  expect(viewTrigger).toBe('view-panel')
  expect(viewPanel).toBe(true)
  expect(views).toEqual(['front', 'back', 'left', 'right', 'top', 'bottom'])
  expect(settings).toEqual(['grid', 'shadows', 'ambientOcclusion'])
  expect(actions).toEqual(['frame', 'render', 'lighting'])
  expect(diagnosticsToggle).toBe(true)
  expect(statusHidden).toBe(true)
  expect(diagnostics).toEqual(['coordinate-status', 'voxel-count', 'mesh-status', 'fps-status'])
})

test('preserves layer, palette, material, render, and project features', () => {
  const features: string[] = [], menuActions: string[] = []
  new HTMLRewriter()
    .on('#layer-list, #resize-form, #palette-grid, #color-input, #roughness, #metalness, #opacity, #transmission, #ior, #preview-renderer, #pbr-materials, #projection, #path-tracing, #tilt-shift, #skybox, #volumetric-lighting, [data-performance-monitor], [data-auto-simplify-rendering], #file-input', { element(control) {
      features.push(control.getAttribute('id') ?? (control.hasAttribute('data-performance-monitor') ? 'performance-monitor' : 'auto-simplify-rendering'))
    } })
    .on('#project-menu [data-action]', { element(button) { menuActions.push(button.getAttribute('data-action')!) } })
    .transform(modelMarkup(false, [{ action: 'extra-feature', label: 'Extra feature' }]))

  expect(features).toEqual(['layer-list', 'resize-form', 'palette-grid', 'color-input', 'roughness', 'metalness', 'opacity', 'transmission', 'ior', 'preview-renderer', 'pbr-materials', 'projection', 'path-tracing', 'tilt-shift', 'skybox', 'volumetric-lighting', 'performance-monitor', 'auto-simplify-rendering', 'file-input'])
  expect(menuActions).toEqual(['save-model', 'browse-models', 'extra-feature', 'new', 'import', 'export', 'capture'])
})
