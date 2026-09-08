import { expect, test } from 'bun:test'
import { modelMarkup } from './ui'

test('Model tools activate separately from their accessible popup controls', () => {
  const tools: string[] = [], popups: string[] = []
  const targets = { select: 'select-tool-popup', paint: 'paint-tool-popup', sculpt: 'sculpt-tool-popup', layer: 'layer-panel' }
  const markup = modelMarkup(false)
  new HTMLRewriter()
    .on('.tool-dock .tool-slot > button[data-tool]', { element(button) {
      tools.push(button.getAttribute('data-tool')!)
      expect(button.getAttribute('popovertarget')).toBeNull()
      expect(button.getAttribute('aria-pressed')).toBe('false')
    } })
    .on('.tool-dock .tool-slot > button.tool-expand', { element(button) {
      const tool = button.getAttribute('data-tool-popup') as keyof typeof targets
      popups.push(tool)
      expect(button.getAttribute('data-tool')).toBeNull()
      expect(button.getAttribute('aria-pressed')).toBeNull()
      expect(button.getAttribute('type')).toBe('button')
      expect(button.getAttribute('aria-label')).toMatch(/^Expand .+ options$/)
      expect(button.getAttribute('popovertarget')).toBe(targets[tool])
      expect(markup).toContain(`id="${targets[tool]}"`)
    } })
    .transform(markup)
  expect(tools).toEqual(Object.keys(targets))
  expect(popups).toEqual(tools)
})

test('Volume groups Paint, Fill, Eyedropper and Erase; Sculpt retains only Push/Pull and Move', () => {
  const volume: string[] = [], sculpt: string[] = [], labels: string[] = []
  const markup = modelMarkup(false)
  const operation = (button: { getAttribute(name: string): string | null }) => button.getAttribute('data-paint-mode') ?? button.getAttribute('data-sculpt-mode') ?? button.getAttribute('data-auxiliary')!
  new HTMLRewriter()
    .on('#paint-tool-popup .tool-mode-list > button', { element(button) { volume.push(operation(button)) } })
    .on('#sculpt-tool-popup .tool-mode-list > button', { element(button) { sculpt.push(operation(button)) } })
    .on('.tool-dock .tool-label > strong', { text(text) { if (text.text) labels.push(text.text) } })
    .transform(markup)
  expect(volume).toEqual(['paint', 'fill', 'pick', 'erase'])
  expect(sculpt).toEqual(['push', 'move'])
  expect(labels).toEqual(['Select', 'Volume', 'Sculpt', 'Layer'])
  expect(markup).toContain('<strong>Fill</strong>')
  expect(markup).toContain('<kbd>W 4</kbd>')
  expect(markup).not.toContain('<kbd>S 3</kbd>')
  expect(markup).toContain('aria-label="Expand Volume options"')
})
