import { expect, test } from 'bun:test'
import { bindMobileWheels } from './mobile-wheels'

class Element extends EventTarget {
  dataset: Record<string, string> = {}
  style = { transform: '', opacity: '' }
  attributes = new Map<string, string>()
  children = new Map<string, Element[]>()
  captures = new Set<number>()
  hidden = false
  disabled = false
  id = ''
  ownerDocument!: Element
  defaultView = new EventTarget()
  activeElement?: Element
  querySelectorAll(selector: string): Element[] { return this.children.get(selector) ?? [] }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] }
  contains(node: Element): boolean { return this === node || [...this.children.values()].flat().some(child => child.contains(node)) }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  setPointerCapture(id: number) { this.captures.add(id) }
  hasPointerCapture(id: number) { return this.captures.has(id) }
  releasePointerCapture(id: number) { this.captures.delete(id) }
  focus() { this.ownerDocument.activeElement = this }
}

function fixture() {
  const document = new Element(), root = new Element(), controller = new AbortController()
  root.ownerDocument = document
  const wheels = (['brush', 'action'] as const).map(kind => {
    const picker = new Element(), trigger = new Element(), panel = new Element(), drum = new Element()
    const values = kind === 'brush' ? ['voxel', 'face', 'box', 'line', 'center', 'texture', 'body', 'pattern'] : ['attach', 'erase', 'paint', 'select', 'move']
    const options = values.map(value => {
      const option = new Element()
      option.id = `${kind}-${value}`; option.dataset.wheelValue = value; option.disabled = value === 'pattern'
      option.setAttribute('aria-selected', String(value === (kind === 'brush' ? 'box' : 'attach')))
      return option
    })
    picker.dataset.mobileWheel = kind; panel.hidden = true
    for (const element of [picker, trigger, panel, drum, ...options]) element.ownerDocument = document
    picker.children.set('[data-wheel-trigger]', [trigger]); picker.children.set('[data-wheel-panel]', [panel])
    picker.children.set('[role="listbox"]', [drum]); picker.children.set('[data-wheel-value]', options)
    drum.children.set('options', options)
    return { picker, trigger, panel, drum, options, kind }
  })
  root.children.set('[data-mobile-wheel]', wheels.map(wheel => wheel.picker))
  let enabled = true
  const commits: string[][] = []
  const close = bindMobileWheels(root as unknown as HTMLElement, controller.signal, () => enabled, () => {}, (kind, value) => {
    commits.push([kind, value])
    for (const option of wheels.find(wheel => wheel.kind === kind)!.options) option.setAttribute('aria-selected', String(option.dataset.wheelValue === value))
  })
  const emit = (type: string, target: Element, values = {}) => {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, { pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true, clientY: 400, detail: 1, ...values })
    Object.defineProperty(event, 'target', { value: target })
    document.dispatchEvent(event)
    return event
  }
  return { document, root, wheels, controller, commits, close, emit, disable: () => { enabled = false }, [Symbol.dispose]() { controller.abort() } }
}

test('both wheels preview without committing, sample release, and suppress the generated click', () => {
  using f = fixture()
  for (const [index, wheel] of f.wheels.entries()) {
    for (const pointerType of ['touch', 'pen', 'mouse']) {
      f.emit('pointerdown', wheel.trigger, { pointerType })
      expect(wheel.panel.hidden).toBe(false)
      expect(wheel.trigger.getAttribute('aria-expanded')).toBe('true')
      expect(wheel.picker.hasPointerCapture(1)).toBe(true)
      const before = f.commits.length
      f.emit('pointermove', wheel.picker, { pointerType, clientY: 356 })
      expect(f.commits).toHaveLength(before)
      f.emit('pointerup', wheel.picker, { pointerType, clientY: 312 })
      expect(f.commits).toHaveLength(before + 1)
      expect(f.commits.at(-1)).toEqual([wheel.kind, index === 0 ? 'center' : 'paint'])
      expect(wheel.panel.hidden).toBe(true)
      expect(wheel.picker.captures.size).toBe(0)
      expect(f.emit('click', wheel.trigger).defaultPrevented).toBe(true)
      expect(wheel.panel.hidden).toBe(true)
      for (const option of wheel.options) option.setAttribute('aria-selected', String(option.dataset.wheelValue === (index === 0 ? 'box' : 'attach')))
    }
  }
})

test('tap, keyboard, disabled bounds, and switching wheels preserve the committed state', () => {
  using f = fixture()
  const [brush, action] = f.wheels
  f.emit('pointerdown', brush!.trigger); f.emit('pointerup', brush!.picker)
  expect(brush!.panel.hidden).toBe(false)
  expect(f.commits).toHaveLength(0)
  f.emit('keydown', brush!.drum, { key: 'End' })
  expect(brush!.drum.getAttribute('aria-activedescendant')).toBe('brush-body')
  f.emit('keydown', brush!.drum, { key: 'Enter' })
  expect(f.commits).toEqual([['brush', 'body']])
  f.emit('click', brush!.trigger, { detail: 0 })
  expect(brush!.drum.getAttribute('aria-activedescendant')).toBe('brush-body')
  f.emit('pointerdown', brush!.options[7]!); f.emit('pointerup', brush!.picker)
  expect(f.commits).toHaveLength(1)
  f.emit('pointerdown', brush!.options[1]!); f.emit('pointerup', brush!.picker)
  expect(f.commits.at(-1)).toEqual(['brush', 'face'])
  f.emit('click', brush!.trigger, { detail: 0 })
  f.emit('keydown', brush!.drum, { key: 'ArrowDown' })
  f.emit('click', action!.trigger, { detail: 0 })
  expect(brush!.panel.hidden).toBe(true)
  expect(action!.panel.hidden).toBe(false)
  f.emit('keydown', action!.drum, { key: 'ArrowDown' })
  f.emit('keydown', action!.drum, { key: 'Escape' })
  expect(f.commits).toHaveLength(2)
  expect(f.document.activeElement).toBe(action!.trigger)
  f.emit('click', action!.trigger, { detail: 0 })
  f.emit('keydown', action!.drum, { key: 'End' })
  f.emit('keydown', action!.drum, { key: 'Home' })
  f.emit('keydown', action!.drum, { key: 'ArrowUp' })
  expect(action!.drum.getAttribute('aria-activedescendant')).toBe('action-attach')
  f.emit('pointerdown', action!.drum)
  f.emit('pointerup', action!.picker, { clientY: -1000 })
  expect(f.commits.at(-1)).toEqual(['action', 'move'])
  brush!.options[7]!.disabled = false
  f.emit('click', brush!.trigger, { detail: 0 })
  f.emit('keydown', brush!.drum, { key: 'End' })
  f.emit('keydown', brush!.drum, { key: 'Enter' })
  expect(f.commits.at(-1)).toEqual(['brush', 'pattern'])
})

test('cancellation, outside dismissal, lifecycle changes, and disabled editing never commit a wheel preview', () => {
  for (const cancel of ['pointercancel', 'capture', 'outside', 'multitouch', 'blur', 'resize', 'hidden', 'close', 'disabled', 'abort']) {
    using f = fixture()
    const wheel = f.wheels[0]!
    f.emit('pointerdown', wheel.trigger)
    f.emit('pointermove', wheel.picker, { clientY: 312 })
    f.emit('pointerup', wheel.picker, { pointerId: 2 })
    expect(f.commits).toHaveLength(0)
    if (cancel === 'pointercancel') f.emit('pointercancel', wheel.picker)
    if (cancel === 'capture') { wheel.picker.captures.clear(); f.emit('lostpointercapture', wheel.picker) }
    if (cancel === 'outside') { f.emit('pointercancel', wheel.picker); f.emit('click', wheel.trigger, { detail: 0 }); f.emit('pointerdown', f.root) }
    if (cancel === 'multitouch') f.emit('pointerdown', wheel.picker, { pointerId: 2, isPrimary: false })
    if (cancel === 'blur' || cancel === 'resize') f.document.defaultView.dispatchEvent(new Event(cancel))
    if (cancel === 'hidden') { f.document.hidden = true; f.emit('visibilitychange', f.document) }
    if (cancel === 'close') f.close()
    if (cancel === 'disabled') { f.disable(); f.emit('pointermove', wheel.picker, { clientY: 300 }) }
    if (cancel === 'abort') f.controller.abort()
    f.emit('pointerup', wheel.picker, { clientY: 300 })
    expect(f.commits).toHaveLength(0)
    expect(wheel.panel.hidden).toBe(true)
    expect(wheel.picker.captures.size).toBe(0)
  }
})
