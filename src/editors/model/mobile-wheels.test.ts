import { expect, test } from 'bun:test'
import { bindMobileWheels } from './mobile-wheels'

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height })

class Element extends EventTarget {
  dataset: Record<string, string> = {}
  style = { left: '', transform: '', opacity: '', setProperty(name: string, value: string) { Reflect.set(this, name, value) } }
  attributes = new Map<string, string>()
  children = new Map<string, Element[]>()
  captures = new Set<number>()
  hidden = false
  disabled = false
  visible = true
  scrolled = false
  id = ''
  rect = rect(0, 0, 0, 0)
  ownerDocument!: Element
  documentElement = { clientWidth: 320 }
  defaultView = new EventTarget()
  activeElement?: Element
  getBoundingClientRect() { return this.rect }
  checkVisibility() { return this.visible && !this.hidden }
  scrollIntoView() { this.scrolled = true }
  querySelectorAll(selector: string): Element[] { return this.children.get(selector) ?? [] }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] }
  contains(node: Element): boolean { return this === node || [...this.children.values()].flat().some(child => child.contains(node)) }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  removeAttribute(name: string) { this.attributes.delete(name) }
  setPointerCapture(id: number) { this.captures.add(id) }
  hasPointerCapture(id: number) { return this.captures.has(id) }
  releasePointerCapture(id: number) { this.captures.delete(id) }
  focus() { this.ownerDocument.activeElement = this }
}

function fixture(material = false) {
  const document = new Element(), root = new Element(), controller = new AbortController()
  root.ownerDocument = document
  const kinds: ('brush' | 'action' | 'material')[] = material ? ['brush', 'action', 'material'] : ['brush', 'action']
  const wheels = kinds.map(kind => {
    const picker = new Element(), trigger = new Element(), panel = new Element(), drum = new Element()
    const values = kind === 'material' ? Array.from({ length: 10 }, (_, i) => String(i)) : kind === 'brush' ? ['voxel', 'face', 'box', 'line', 'center'] : ['attach', 'erase', 'paint']
    const options = values.map((value, index) => {
      const option = new Element()
      option.id = `${kind}-${value}`; option.dataset.wheelValue = value
      option.rect = rect(10 + index * 54, 300, 48, 48)
      option.setAttribute('aria-selected', String(value === (kind === 'brush' ? 'box' : 'attach')))
      return option
    })
    picker.rect = rect(kind === 'brush' ? 10 : 260, 400, 50, 50)
    trigger.rect = picker.rect
    panel.rect = rect(0, 290, values.length * 54, 68)
    picker.dataset.mobileWheel = kind; panel.hidden = true
    for (const element of [picker, trigger, panel, drum, ...options]) element.ownerDocument = document
    picker.children.set('[data-wheel-trigger]', [trigger]); picker.children.set('[data-wheel-panel]', [panel])
    picker.children.set('[role="listbox"]', [drum]); picker.children.set('[data-wheel-value]', options)
    drum.children.set('options', options)
    if (kind === 'material') {
      picker.children.delete('[data-wheel-panel]'); picker.children.delete('[role="listbox"]'); picker.children.delete('[data-wheel-value]')
      root.children.set('#material-picker', [panel])
      panel.children.set('#material-picker-grid', [drum]); panel.children.set('[data-wheel-value]', options)
      drum.rect = rect(10, 240, 270, 108)
      panel.rect = rect(0, 230, 294, 158)
      options.forEach((option, i) => { option.rect = rect(10 + i % 5 * 54, 240 + Math.floor(i / 5) * 54, 48, 48) })
      options[2]!.setAttribute('aria-selected', 'true')
    }
    return { picker, trigger, panel, drum, options, kind }
  })
  root.children.set('[data-mobile-wheel]', wheels.map(wheel => wheel.picker))
  let enabled = true, opens = 0
  const commits: string[][] = []
  const close = bindMobileWheels(root as unknown as HTMLElement, controller.signal, () => enabled, () => { opens++ }, (kind, value) => {
    commits.push([kind, value])
    for (const option of wheels.find(wheel => wheel.kind === kind)!.options) option.setAttribute('aria-selected', String(option.dataset.wheelValue === value))
  })
  const emit = (type: string, target: Element, values = {}) => {
    const event = new Event(type, { cancelable: true })
    let stopped = false
    event.stopImmediatePropagation = () => { stopped = true; Event.prototype.stopImmediatePropagation.call(event) }
    Object.assign(event, { pointerId: 1, pointerType: type.startsWith('pointer') ? 'touch' : '', button: 0, isPrimary: true, clientX: 30, clientY: 420, detail: type === 'click' ? 0 : 1, touches: [], ...values })
    Object.defineProperty(event, 'target', { value: target })
    document.dispatchEvent(event)
    return { prevented: event.defaultPrevented, stopped }
  }
  return { document, root, wheels, controller, commits, close, emit, opens: () => opens, disable: () => { enabled = false }, [Symbol.dispose]() { controller.abort() } }
}

const consumed = { prevented: true, stopped: true }
const point = (option: Element) => ({ clientX: option.rect.left + 24, clientY: option.rect.top + 24 })
function cleaned(wheel: ReturnType<typeof fixture>['wheels'][number]) {
  expect(wheel.panel.hidden).toBe(true)
  expect(wheel.trigger.getAttribute('aria-expanded')).toBe('false')
  expect(wheel.drum.getAttribute('aria-activedescendant')).toBeNull()
  expect(wheel.options.every(option => option.dataset.inspected === undefined)).toBe(true)
  expect(wheel.picker.captures.size).toBe(0)
}

test('tap keeps each popup open, option tap selects, and a second trigger tap dismisses', () => {
  for (const pointerType of ['touch', 'pen', 'mouse']) {
    using f = fixture(true)
    for (const wheel of f.wheels) {
      const tap = (target: Element) => {
        f.emit('pointerdown', target, { pointerType, ...point(target) })
        f.emit('pointerup', wheel.picker, { pointerType, ...point(target) })
        f.emit('click', target, { pointerType, detail: 1 })
      }
      tap(wheel.trigger)
      expect(wheel.panel.hidden).toBe(false)
      expect(wheel.picker.captures.size).toBe(0)
      tap(wheel.options[1]!)
      expect(f.commits.at(-1)).toEqual([wheel.kind, wheel.options[1]!.dataset.wheelValue!])
      cleaned(wheel)
      tap(wheel.trigger)
      tap(wheel.trigger)
      cleaned(wheel)
    }
    expect(f.commits).toHaveLength(3)
  }
})

test('mouse, pen and touch open immediately, inspect horizontally, and commit the release rect', () => {
  using f = fixture(true)
  for (const wheel of f.wheels) for (const pointerType of ['mouse', 'pen', 'touch']) {
    expect(f.emit('pointerdown', wheel.trigger, { pointerType })).toEqual(consumed)
    expect(wheel.panel.hidden).toBe(false)
    expect(wheel.trigger.getAttribute('aria-expanded')).toBe('true')
    expect(wheel.picker.hasPointerCapture(1)).toBe(true)
    expect(wheel.drum.getAttribute('aria-activedescendant')).toBeNull()
    const selected = wheel.options.map(option => option.getAttribute('aria-selected'))
    const before = f.commits.length
    expect(f.emit('pointermove', wheel.picker, { pointerType, ...point(wheel.options[1]!) })).toEqual(consumed)
    expect(wheel.options[1]!.dataset.inspected).toBe('true')
    expect(wheel.drum.getAttribute('aria-activedescendant')).toBe(wheel.options[1]!.id)
    expect(wheel.options.map(option => option.getAttribute('aria-selected'))).toEqual(selected)
    expect(f.commits).toHaveLength(before)
    // Capture retargets to the picker; geometry, not event.target or previous hover, wins.
    expect(f.emit('pointerup', wheel.picker, { pointerType, ...point(wheel.options.at(-1)!) })).toEqual(consumed)
    expect(f.commits.at(-1)).toEqual([wheel.kind, wheel.options.at(-1)!.dataset.wheelValue!])
    expect(f.commits).toHaveLength(before + 1)
    cleaned(wheel)
    for (const click of [{ detail: 1 }, { detail: 0, pointerType }, { detail: 0, sourceCapabilities: { firesTouchEvents: true } }]) {
      expect(f.emit('click', wheel.trigger, click)).toEqual(consumed)
      expect(wheel.panel.hidden).toBe(true)
    }
    expect(wheel.options.every(option => option.style.transform === '' && option.style.opacity === '')).toBe(true)
  }
  expect(f.opens()).toBe(9)
})

test('outside, gaps, disabled and zero-area rects cancel rather than choosing the last inspected option', () => {
  for (const outside of [{ clientX: 0, clientY: 324 }, { clientX: 59, clientY: 324 }, { clientX: 30, clientY: 299 }, { clientX: 30, clientY: 348 }, { clientX: 30, clientY: 420 }, { clientX: 999, clientY: 324 }, 'disabled', 'empty']) {
    using f = fixture()
    const wheel = f.wheels[0]!
    f.emit('pointerdown', wheel.trigger)
    f.emit('pointermove', wheel.picker, point(wheel.options[2]!))
    if (outside === 'disabled') wheel.options[0]!.disabled = true
    if (outside === 'empty') wheel.options[0]!.rect = rect(30, 324, 0, 0)
    const position = typeof outside === 'string' ? { clientX: 30, clientY: 324 } : outside
    f.emit('pointermove', wheel.picker, position)
    expect(wheel.drum.getAttribute('aria-activedescendant')).toBeNull()
    f.emit('pointerup', wheel.options[2]!, position)
    expect(f.commits).toHaveLength(0)
    cleaned(wheel)
  }
})

test('AT clicks focus the listbox; arrows, Home, End, Enter and Escape preserve selection semantics', () => {
  using f = fixture()
  const brush = f.wheels[0]!, action = f.wheels[1]!
  expect(f.emit('click', brush.trigger)).toEqual(consumed)
  expect(f.document.activeElement).toBe(brush.drum)
  expect(brush.drum.getAttribute('aria-activedescendant')).toBe('brush-box')
  brush.options[1]!.disabled = true
  for (const [key, value] of [['ArrowLeft', 'voxel'], ['ArrowUp', 'voxel'], ['ArrowRight', 'box'], ['ArrowDown', 'line'], ['End', 'center'], ['ArrowRight', 'center'], ['Home', 'voxel']]) {
    expect(f.emit('keydown', brush.drum, { key })).toEqual(consumed)
    expect(brush.drum.getAttribute('aria-activedescendant')).toBe(`brush-${value}`)
  }
  f.emit('keydown', brush.drum, { key: 'Enter' })
  expect(f.commits).toEqual([['brush', 'voxel']])
  expect(f.document.activeElement).toBe(brush.trigger)
  cleaned(brush)
  f.emit('click', brush.trigger)
  f.emit('keydown', brush.drum, { key: 'End' })
  f.emit('click', action.trigger)
  cleaned(brush)
  f.emit('keydown', action.drum, { key: 'ArrowDown' })
  expect(f.emit('keydown', action.drum, { key: 'Escape' })).toEqual(consumed)
  cleaned(action)
  expect(f.document.activeElement).toBe(action.trigger)
  expect(f.commits).toHaveLength(1)
  f.emit('click', action.trigger)
  f.emit('click', action.options[2]!)
  expect(f.commits.at(-1)).toEqual(['action', 'paint'])
  f.emit('click', action.trigger)
  expect(action.drum.getAttribute('aria-activedescendant')).toBe('action-paint')
  expect(f.emit('keydown', action.drum, { key: 'Tab' }).prevented).toBe(false)
  cleaned(action)
})

test('hover and direct option presses use fresh rects after keyboard opening', () => {
  using f = fixture()
  const wheel = f.wheels[0]!
  for (const option of wheel.options) option.setAttribute('aria-selected', 'false')
  f.emit('click', wheel.trigger)
  expect(wheel.drum.getAttribute('aria-activedescendant')).toBe('brush-voxel')
  wheel.options[4]!.rect = rect(220, 200, 70, 60)
  f.emit('pointermove', wheel.options[0]!, point(wheel.options[4]!))
  expect(wheel.drum.getAttribute('aria-activedescendant')).toBe('brush-center')
  f.emit('pointerdown', wheel.options[4]!, point(wheel.options[4]!))
  f.emit('pointerup', wheel.picker, point(wheel.options[4]!))
  expect(f.commits).toEqual([['brush', 'center']])
})

test('secondary pointers and native touch/mouse events cannot leak into canvas navigation', () => {
  using f = fixture()
  const wheel = f.wheels[0]!
  f.emit('pointerdown', wheel.trigger)
  expect(f.emit('touchstart', wheel.trigger, { touches: [{}] })).toEqual(consumed)
  expect(f.emit('pointerdown', f.root, { pointerId: 2, isPrimary: false })).toEqual(consumed)
  for (const type of ['touchstart', 'touchmove', 'mousedown', 'mouseup', 'contextmenu']) {
    expect(f.emit(type, f.root, { touches: [{}, {}] })).toEqual(consumed)
  }
  for (const type of ['pointermove', 'pointercancel', 'lostpointercapture']) f.emit(type, f.root, { pointerId: 3, isPrimary: false })
  expect(wheel.panel.hidden).toBe(false)
  expect(wheel.picker.hasPointerCapture(1)).toBe(true)
  f.emit('pointerup', wheel.picker, point(wheel.options[1]!))
  cleaned(wheel)
  expect(f.emit('pointermove', f.root, { pointerId: 2 })).toEqual(consumed)
  expect(f.emit('pointerup', f.root, { pointerId: 2 })).toEqual(consumed)
  expect(f.emit('touchend', f.root)).toEqual(consumed)
  expect(f.emit('click', f.root, { detail: 1 })).toEqual(consumed)
  expect(f.commits).toEqual([['brush', 'face']])
  expect(f.emit('pointerdown', f.root).prevented).toBe(false)
  expect(f.emit('pointermove', f.root).prevented).toBe(false)
})

test('cancellation and lifecycle changes clean previews; stale release never commits or reopens', () => {
  for (const cancel of ['pointercancel', 'capture', 'blur', 'resize', 'hidden', 'close', 'disabled-move', 'disabled-up', 'abort', 'focus']) {
    using f = fixture()
    const wheel = f.wheels[0]!
    f.emit('pointerdown', wheel.trigger)
    f.emit('pointermove', wheel.picker, point(wheel.options[1]!))
    if (cancel === 'pointercancel') expect(f.emit('pointercancel', wheel.picker)).toEqual(consumed)
    if (cancel === 'capture') { wheel.picker.captures.clear(); f.emit('lostpointercapture', wheel.picker) }
    if (cancel === 'blur' || cancel === 'resize') f.document.defaultView.dispatchEvent(new Event(cancel))
    if (cancel === 'hidden') { f.document.hidden = true; f.emit('visibilitychange', f.document) }
    if (cancel === 'close') f.close()
    if (cancel.startsWith('disabled')) { f.disable(); if (cancel === 'disabled-move') f.emit('pointermove', wheel.picker) }
    if (cancel === 'abort') f.controller.abort()
    if (cancel === 'focus') f.emit('focusin', f.root)
    f.emit('pointerup', wheel.picker, point(wheel.options[1]!))
    f.emit('click', wheel.trigger, { detail: 1 })
    expect(f.commits).toHaveLength(0)
    cleaned(wheel)
    if (cancel === 'abort') {
      expect(f.emit('pointerdown', wheel.trigger).prevented).toBe(false)
      f.emit('click', wheel.trigger)
      expect(wheel.panel.hidden).toBe(true)
    }
  }
})

test('outside keyboard dismissal consumes the full gesture; invalid starts do not open', () => {
  using f = fixture()
  const wheel = f.wheels[0]!
  for (const values of [{ button: 2 }, { isPrimary: false }]) {
    f.emit('pointerdown', wheel.trigger, values)
    expect(wheel.panel.hidden).toBe(true)
  }
  f.emit('click', wheel.trigger)
  expect(f.emit('pointerdown', f.root)).toEqual(consumed)
  cleaned(wheel)
  expect(f.emit('pointermove', f.root)).toEqual(consumed)
  expect(f.emit('pointerup', f.root)).toEqual(consumed)
  expect(f.emit('mouseup', f.root)).toEqual(consumed)
  expect(f.emit('click', f.root, { detail: 1 })).toEqual(consumed)
  f.disable()
  f.emit('pointerdown', wheel.trigger)
  f.emit('click', wheel.trigger)
  expect(wheel.panel.hidden).toBe(true)
  expect(f.commits).toHaveLength(0)
})

test('a fresh primary press recovers after a missing release; stale capture events cannot close it', () => {
  using f = fixture()
  const wheel = f.wheels[0]!
  f.emit('pointerdown', wheel.trigger)
  f.document.defaultView.dispatchEvent(new Event('blur'))
  cleaned(wheel)
  f.emit('pointerdown', wheel.trigger)
  expect(wheel.panel.hidden).toBe(false)
  f.emit('lostpointercapture', wheel.picker)
  expect(wheel.panel.hidden).toBe(false)
  expect(f.emit('pointerup', f.root, { pointerId: 2, isPrimary: false })).toEqual(consumed)
  expect(wheel.picker.hasPointerCapture(1)).toBe(true)
  f.emit('pointerup', wheel.picker, point(wheel.options[0]!))
  expect(f.commits).toEqual([['brush', 'voxel']])
  cleaned(wheel)
  f.emit('click', wheel.trigger)
  expect(f.document.activeElement).toBe(wheel.drum)
})

test('opening centers on the picker and clamps left to the viewport without transforms', () => {
  using f = fixture()
  const brush = f.wheels[0]!, action = f.wheels[1]!
  f.emit('click', brush.trigger)
  expect(brush.panel.style.left).toBe('12px')
  expect(Reflect.get(brush.panel.style, '--callout-x')).toBe('23px')
  f.emit('click', action.trigger)
  expect(action.panel.style.left).toBe('146px')
  expect(Reflect.get(action.panel.style, '--callout-x')).toBe('139px')
  f.close()
  action.picker.rect = rect(140, 400, 50, 50)
  f.emit('click', action.trigger)
  expect(action.panel.style.left).toBe('84px')
  expect(Reflect.get(action.panel.style, '--callout-x')).toBe('81px')
  expect(action.panel.style.transform).toBe('')
})

test('other UI controls dismiss keyboard strips without swallowing their activation', () => {
  using f = fixture()
  const other = new Element()
  Object.assign(other, { closest: () => other })
  f.emit('click', f.wheels[0]!.trigger)
  expect(f.emit('pointerdown', other).prevented).toBe(false)
  expect(f.wheels[0]!.panel.hidden).toBe(true)
  f.emit('click', f.wheels[0]!.trigger)
  expect(f.emit('click', other).prevented).toBe(false)
  expect(f.wheels[0]!.panel.hidden).toBe(true)
  expect(f.commits).toHaveLength(0)
})

test('material options are live after opening and palette rebuilds, with five-column keyboard navigation', () => {
  using f = fixture(true)
  const wheel = f.wheels[2]!
  const replace = () => {
    const options = wheel.options.map(old => {
      const option = new Element()
      option.ownerDocument = f.document
      option.rect = old.rect; option.dataset.wheelValue = old.dataset.wheelValue!
      option.setAttribute('aria-selected', String(option.dataset.wheelValue === '2'))
      return option
    })
    wheel.options = options
    wheel.panel.children.set('[data-wheel-value]', options)
    wheel.drum.children.set('options', options)
  }
  replace()
  f.emit('click', wheel.trigger)
  expect(wheel.options[2]!.dataset.inspected).toBe('true')
  expect(wheel.options[2]!.scrolled).toBe(true)
  expect(f.emit('focusin', wheel.drum).prevented).toBe(false)
  expect(wheel.panel.hidden).toBe(false)
  for (const [key, index] of [['ArrowDown', 7], ['ArrowLeft', 6], ['ArrowUp', 1], ['ArrowRight', 2]] as const) {
    f.emit('keydown', wheel.drum, { key })
    expect(wheel.options[index]!.dataset.inspected).toBe('true')
    expect(wheel.options[index]!.scrolled).toBe(true)
  }
  f.emit('keydown', wheel.drum, { key: 'Enter' })
  expect(f.commits).toEqual([['material', '2']])
  f.emit('pointerdown', wheel.trigger, point(wheel.trigger))
  replace()
  f.emit('pointermove', wheel.picker, point(wheel.options[5]!))
  expect(wheel.options[5]!.dataset.inspected).toBe('true')
  f.emit('pointerup', wheel.picker, point(wheel.options[6]!))
  expect(f.commits.at(-1)).toEqual(['material', '6'])
  cleaned(wheel)
  f.emit('click', wheel.trigger)
  f.emit('keydown', wheel.drum, { key: 'Escape' })
  cleaned(wheel)
})

test('material drag hit testing clips fresh visible enabled cells to the grid viewport', () => {
  for (const invalid of ['above', 'below', 'left', 'right', 'disabled', 'hidden', 'invisible', 'empty']) {
    using f = fixture(true)
    const wheel = f.wheels[2]!, option = wheel.options[0]!
    f.emit('pointerdown', wheel.trigger, point(wheel.trigger))
    f.emit('pointermove', wheel.picker, point(wheel.options[1]!))
    if (invalid === 'above') option.rect = rect(10, 200, 48, 48)
    if (invalid === 'below') option.rect = rect(10, 330, 48, 48)
    if (invalid === 'left') option.rect = rect(-30, 240, 48, 48)
    if (invalid === 'right') option.rect = rect(260, 240, 48, 48)
    if (invalid === 'disabled') option.disabled = true
    if (invalid === 'hidden') option.hidden = true
    if (invalid === 'invisible') option.visible = false
    if (invalid === 'empty') option.rect = rect(10, 240, 0, 0)
    f.emit('pointermove', wheel.picker, point(option))
    expect(wheel.drum.getAttribute('aria-activedescendant')).toBeNull()
    f.emit('pointerup', wheel.picker, point(option))
    expect(f.commits).toHaveLength(0)
    cleaned(wheel)
  }
  using f = fixture(true)
  const wheel = f.wheels[2]!
  wheel.options[0]!.rect = rect(10, 220, 48, 48)
  f.emit('pointerdown', wheel.trigger, point(wheel.trigger))
  f.emit('pointerup', wheel.picker, { clientX: 30, clientY: 245 })
  expect(f.commits).toEqual([['material', '0']])
})

test('tap-open material panel passes native scroll gestures and edit activation but owns option clicks', () => {
  using f = fixture(true)
  const wheel = f.wheels[2]!, edit = new Element()
  Object.assign(edit, { closest: () => edit })
  wheel.panel.children.set('edit', [edit])
  f.emit('pointerdown', wheel.trigger, point(wheel.trigger))
  f.emit('touchstart', wheel.trigger, { touches: [{}] })
  f.emit('pointerup', wheel.picker, point(wheel.trigger))
  f.emit('touchend', wheel.trigger)
  expect(f.emit('click', wheel.trigger, { detail: 1 })).toEqual(consumed)
  for (const type of ['pointerdown', 'touchstart', 'pointermove', 'touchmove', 'pointerup', 'touchend', 'pointercancel', 'mousedown', 'mouseup', 'contextmenu']) {
    expect(f.emit(type, wheel.options[1]!, { touches: type === 'touchend' ? [] : [{}] })).toEqual({ prevented: false, stopped: false })
    expect(wheel.panel.hidden).toBe(false)
    expect(wheel.picker.captures.size).toBe(0)
    expect(f.commits).toHaveLength(0)
  }
  expect(f.emit('click', wheel.options[1]!, { detail: 1 })).toEqual(consumed)
  expect(f.commits).toEqual([['material', '1']])
  cleaned(wheel)
  for (const detail of [0, 1]) {
    f.emit('click', wheel.trigger)
    expect(f.emit('keydown', wheel.drum, { key: 'Tab' }).prevented).toBe(false)
    f.emit('focusin', edit)
    expect(wheel.panel.hidden).toBe(false)
    expect(f.emit('keydown', edit, { key: 'Enter' }).prevented).toBe(false)
    expect(f.emit('pointerdown', edit).prevented).toBe(false)
    expect(f.emit('pointerup', edit).prevented).toBe(false)
    expect(f.emit('click', edit, { detail })).toEqual({ prevented: false, stopped: false })
    cleaned(wheel)
  }
})

test('material trigger drags consume panel touch events and retain cancellation safety', () => {
  for (const cancel of ['pointercancel', 'capture', 'blur', 'resize', 'close', 'abort', 'outside']) {
    using f = fixture(true)
    const wheel = f.wheels[2]!
    f.emit('pointerdown', wheel.trigger, point(wheel.trigger))
    for (const type of ['touchstart', 'touchmove', 'mousedown', 'mouseup']) expect(f.emit(type, wheel.drum, { touches: [{}] })).toEqual(consumed)
    f.emit('pointermove', wheel.picker, point(wheel.options[1]!))
    if (cancel === 'pointercancel') f.emit('pointercancel', wheel.picker)
    if (cancel === 'capture') { wheel.picker.captures.clear(); f.emit('lostpointercapture', wheel.picker) }
    if (cancel === 'blur' || cancel === 'resize') f.document.defaultView.dispatchEvent(new Event(cancel))
    if (cancel === 'close') f.close()
    if (cancel === 'abort') f.controller.abort()
    if (cancel === 'outside') f.emit('pointerup', f.root, { clientX: 0, clientY: 0 })
    f.emit('pointerup', wheel.picker, point(wheel.options[1]!))
    f.emit('click', wheel.trigger, { detail: 1 })
    expect(f.commits).toHaveLength(0)
    cleaned(wheel)
  }
})

test('detached material panel tail aligns to the trigger rather than its wrapper', () => {
  using f = fixture(true)
  const wheel = f.wheels[2]!
  wheel.picker.rect = rect(100, 400, 150, 50)
  wheel.trigger.rect = rect(120, 400, 50, 50)
  f.emit('click', wheel.trigger)
  expect(wheel.panel.style.left).toBe('12px')
  expect(Reflect.get(wheel.panel.style, '--callout-x')).toBe('133px')
})
