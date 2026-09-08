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
