import { expect, test } from 'bun:test'
import { modelMarkup } from './ui'

test('model editor exposes the MagicaVoxel action and brush matrix', () => {
  const actions: string[] = [], brushes: string[] = []
  const markup = modelMarkup(false)
  new HTMLRewriter()
    .on('.tool-dock [data-model-action]', { element(button) {
      actions.push(button.getAttribute('data-model-action')!)
      expect(button.getAttribute('aria-pressed')).toBe('false')
    } })
    .on('.tool-dock [data-brush]', { element(button) {
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
    .on('.tool-dock [data-secondary-tool]', { element(button) { secondary.push(button.getAttribute('data-secondary-tool')!) } })
    .on('.tool-dock [data-mirror]', { element(button) { mirrors.push(button.getAttribute('data-mirror')!) } })
    .on('.tool-dock [data-whole-axis]', { element(button) { axes.push(button.getAttribute('data-whole-axis')!) } })
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

test('exposes every editor capability in a labeled mobile tool sheet', () => {
  const actions: string[] = [], brushes: string[] = [], wheelBrushes: string[] = [], wheelActions: string[] = [], secondary: string[] = [], mirrors: string[] = [], axes: string[] = [], clipboard: string[] = []
  const markup = modelMarkup(false)
  let panelLabel = ''
  let panelIsPopover = false
  let triggerTarget = ''
  let closeAction = ''
  new HTMLRewriter()
    .on('.mobile-tool-shelf .all-tools-trigger', { element(button) { triggerTarget = button.getAttribute('popovertarget') ?? '' } })
    .on('#all-tools-panel', { element(panel) { panelLabel = panel.getAttribute('aria-labelledby') ?? ''; panelIsPopover = panel.hasAttribute('popover') } })
    .on('#all-tools-panel [popovertargetaction="hide"]', { element(button) { closeAction = button.getAttribute('popovertarget') ?? '' } })
    .on('#all-tools-panel [data-model-action]', { element(button) { actions.push(button.getAttribute('data-model-action')!) } })
    .on('#all-tools-panel [data-brush]', { element(button) { brushes.push(button.getAttribute('data-brush')!) } })
    .on('#mobile-brush-wheel [data-wheel-value]', { element(button) { wheelBrushes.push(button.getAttribute('data-wheel-value')!) } })
    .on('#mobile-action-wheel [data-wheel-value]', { element(button) { wheelActions.push(button.getAttribute('data-wheel-value')!) } })
    .on('.wheel-drum', { element(wheel) { expect(wheel.getAttribute('role')).toBe('listbox'); expect(wheel.getAttribute('tabindex')).toBe('0') } })
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
  expect(wheelBrushes).toEqual(brushes)
  expect(wheelActions).toEqual(actions)
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
  expect(markup.match(/id="layer-tool-trigger"/g)).toHaveLength(1)
})
