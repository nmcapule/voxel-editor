import { expect, test } from 'bun:test'
import { bindToolPopups } from './tool-popups'

// Only event routing is stubbed here; the browser fixture checks native scrolling/popovers.
class ElementStub extends EventTarget {
  children: ElementStub[] = []
  parent?: ElementStub
  popoverTargetElement?: ElementStub
  scrollTop = 0
  hovered = false
  opened = false
  captures = new Set<number>()
  ownerDocument!: ElementStub
  activeElement: ElementStub | null = null
  defaultView = new EventTarget()
  hidden = false
  readonly selector: string
  constructor(selector: string) { super(); this.selector = selector }
  append(selector: string) {
    const element = new ElementStub(selector)
    element.parent = this
    element.ownerDocument = this.ownerDocument
    this.children.push(element)
    return element
  }
  contains(target: ElementStub | null): boolean { return target === this || this.children.some(child => child.contains(target)) }
  matches(selector: string): boolean {
    return selector === ':hover' ? this.hovered : selector === ':popover-open' ? this.opened : selector.split(', ').includes(this.selector)
  }
  querySelectorAll(selector: string): ElementStub[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] }
  getBoundingClientRect() { return { left: 0, top: 100, right: 100, bottom: 200 } }
  hasPointerCapture(id: number) { return this.captures.has(id) }
  setPointerCapture(id: number) { this.captures.add(id) }
  releasePointerCapture(id: number) { this.captures.delete(id) }
  showPopover() { this.opened = true }
  hidePopover() { emit(this, 'beforetoggle', { newState: 'closed' }); this.opened = false }
}

function emit(receiver: EventTarget, type: string, values: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true })
  for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value })
  receiver.dispatchEvent(event)
  return event
}

function fixture() {
  const globals = ['HTMLElement', 'Node'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  Object.assign(globalThis, { HTMLElement: ElementStub, Node: ElementStub })
  const document = new ElementStub('document')
  document.ownerDocument = document
  const root = document.append('root')
  const pairs = ['.tool-popup', '.layer-panel'].map(selector => {
    const slot = root.append('.tool-slot'), expand = slot.append('[data-tool-popup]'), button = slot.append('button')
    const popup = root.append(selector), list = popup.append('.layer-list'), action = list.append('button')
    expand.popoverTargetElement = popup
    return { slot, expand, button, popup, list, action }
  })
  const controller = new AbortController()
  let enabled = true
  const reset = bindToolPopups(root as unknown as HTMLElement, controller.signal, () => enabled)
  const pointer = (type: string, target: ElementStub, x = 50, y = 150, values: Record<string, unknown> = {}) =>
    emit(document, type, { target, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true, ...values })
  const touch = (type: string, target: ElementStub, y: number, count = 1) => {
    const touches = Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: 50, clientY: y }))
    return emit(document, type, { target, touches: type === 'touchend' ? [] : touches, changedTouches: touches })
  }
  return { root, document, pairs, reset, controller, pointer, touch, disable: () => { enabled = false },
    [Symbol.dispose]() {
      controller.abort()
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('slot swipes open/close on release without activation; capture starts only after claiming', async () => {
  using f = fixture()
  let actions = 0
  f.document.addEventListener('click', () => actions++)
  for (const { slot, expand, button, popup } of f.pairs) for (const start of [slot, expand, button]) {
    f.pointer('pointerdown', start)
    expect(f.root.captures.size).toBe(0)
    f.pointer('pointermove', start, 50, 125)
    expect(popup.opened).toBe(false)
    expect(f.root.hasPointerCapture(1)).toBe(true)
    f.pointer('pointerup', f.root, 50, 125)
    await Bun.sleep(1)
    expect(popup.opened).toBe(true)
    expect(f.root.captures.size).toBe(0)
    expect(emit(f.document, 'click', { target: expand, detail: 1 }).defaultPrevented).toBe(true)
    f.pointer('pointerdown', button)
    f.pointer('pointermove', button, 50, 180)
    f.pointer('pointerup', f.root, 50, 180)
    expect(popup.opened).toBe(false)
    emit(f.document, 'click', { target: button, detail: 1 })
  }
  expect(actions).toBe(0)
  expect(f.document.activeElement).toBeNull()
  expect(emit(f.document, 'click', { detail: 0 }).defaultPrevented).toBe(false)
  f.pointer('pointerdown', f.pairs[0]!.button)
  f.pointer('pointerup', f.pairs[0]!.button)
  expect(emit(f.document, 'click', { detail: 1 }).defaultPrevented).toBe(false)
  expect(actions).toBe(2)
})

test('touch downward pulls are reserved before threshold, anywhere in a top-scrolled popup', () => {
  using f = fixture()
  for (const { popup, list, action } of f.pairs) for (const target of [popup, list, action]) {
    popup.showPopover()
    f.pointer('pointerdown', target, 50, 100, { pointerType: 'touch' })
    f.touch('touchstart', target, 100)
    expect(f.touch('touchmove', target, 104).defaultPrevented).toBe(true)
    expect(f.root.captures.size).toBe(0)
    expect(f.touch('touchmove', target, 132).defaultPrevented).toBe(true)
    f.pointer('lostpointercapture', target, 50, 132, { pointerType: 'touch' })
    expect(popup.opened).toBe(true)
    f.pointer('pointerup', f.root, 50, 132, { pointerType: 'touch' })
    expect(popup.opened).toBe(false)
    expect(f.touch('touchend', target, 132).defaultPrevented).toBe(true)
    expect(emit(f.document, 'click', { target: action, detail: 1 }).defaultPrevented).toBe(true)
  }
})

test('upward popup scrolling and downward scrolling away from the top remain native', () => {
  using f = fixture()
  const { popup, list, action } = f.pairs[1]!
  for (const scrolled of [popup, list]) for (const dy of [-40, 40]) {
    popup.showPopover()
    scrolled.scrollTop = dy > 0 ? 60 : 0
    f.pointer('pointerdown', action, 50, 100, { pointerType: 'touch' })
    f.touch('touchstart', action, 100)
    expect(f.touch('touchmove', action, 100 + dy).defaultPrevented).toBe(false)
    scrolled.scrollTop = 0
    expect(f.touch('touchmove', action, 180).defaultPrevented).toBe(false)
    f.pointer('pointerup', action, 50, 180, { pointerType: 'touch' })
    expect(popup.opened).toBe(true)
    expect(f.root.captures.size).toBe(0)
  }
})

test('small taps and horizontal motion are not swipes; secondary input never opens', () => {
  using f = fixture()
  const { button, popup } = f.pairs[0]!
  for (const [x, y] of [[50, 140], [90, 155]]) {
    f.pointer('pointerdown', button)
    f.pointer('pointermove', button, x, y)
    f.pointer('pointerup', button, x, y)
    expect(popup.opened).toBe(false)
    expect(emit(f.document, 'click', { detail: 1 }).defaultPrevented).toBe(false)
  }
  f.pointer('pointerdown', button, 50, 150, { button: 2 })
  f.pointer('pointermove', button, 50, 100)
  f.pointer('pointerup', button)
  expect(popup.opened).toBe(false)
})

test('cancellation, extra pointers, reset, disabled state and abort never finish a claimed swipe', () => {
  for (const cancel of ['pointercancel', 'lostpointercapture', 'second', 'touchcancel', 'reset', 'disabled', 'abort', 'blur', 'hidden', 'escape']) {
    using f = fixture()
    const { button, popup } = f.pairs[0]!
    f.pointer('pointerdown', button)
    f.pointer('pointermove', button, 50, 110)
    if (cancel === 'second') f.pointer('pointerdown', button, 50, 150, { pointerId: 2, isPrimary: false })
    else if (cancel === 'reset') f.reset()
    else if (cancel === 'disabled') f.disable()
    else if (cancel === 'abort') f.controller.abort()
    else if (cancel === 'blur') emit(f.document.defaultView, 'blur')
    else if (cancel === 'escape') emit(f.document, 'keydown', { key: 'Escape' })
    else if (cancel === 'hidden') { f.document.hidden = true; emit(f.document, 'visibilitychange') }
    else {
      if (cancel === 'lostpointercapture') f.root.captures.delete(1)
      f.pointer(cancel, button)
    }
    f.pointer('pointerup', button, 50, 110)
    expect(popup.opened).toBe(false)
    expect(f.root.captures.size).toBe(0)
  }
})

test('reset cancels the deferred open; opening survives native pointerup light-dismiss', async () => {
  using f = fixture()
  const { button, popup } = f.pairs[0]!
  for (const cancel of [false, true]) {
    popup.showPopover()
    f.pointer('pointerdown', button)
    f.pointer('pointermove', button, 50, 110)
    popup.hidePopover()
    f.pointer('pointerup', button, 50, 110)
    if (cancel) f.reset()
    await Bun.sleep(1)
    expect(popup.opened).toBe(!cancel)
  }
})

test('mouse hover preserves slot-to-popup travel and focused content, then closes after leaving both', async () => {
  using f = fixture()
  const { slot, popup, action } = f.pairs[0]!
  const enter = (target: ElementStub, pointerType = 'mouse') => emit(target, 'pointerenter', { pointerType, buttons: 0 })
  enter(slot, 'touch')
  expect(popup.opened).toBe(false)
  enter(slot)
  expect(popup.opened).toBe(true)
  emit(slot, 'pointerleave', { pointerType: 'mouse' })
  enter(popup)
  await Bun.sleep(210)
  expect(popup.opened).toBe(true)
  f.document.activeElement = action
  enter(f.pairs[1]!.slot)
  expect(f.pairs[1]!.popup.opened).toBe(false)
  emit(popup, 'pointerleave', { pointerType: 'mouse' })
  await Bun.sleep(210)
  expect(popup.opened).toBe(true)
  f.document.activeElement = null
  emit(popup, 'focusout')
  await Bun.sleep(210)
  expect(popup.opened).toBe(false)
  enter(slot)
  expect(popup.opened).toBe(true)
  slot.hovered = true
  popup.hidePopover()
  enter(slot)
  expect(popup.opened).toBe(false)
  slot.hovered = false
  f.pointer('pointermove', slot, 200, 50, { buttons: 0 })
  enter(slot)
  expect(popup.opened).toBe(true)
  emit(slot, 'pointerleave', { pointerType: 'mouse' })
  f.reset()
  await Bun.sleep(210)
  expect(popup.opened).toBe(true)
  popup.hidePopover()
  f.disable()
  f.pointer('pointermove', slot, 200, 50, { buttons: 0 })
  enter(slot)
  expect(popup.opened).toBe(false)
})
