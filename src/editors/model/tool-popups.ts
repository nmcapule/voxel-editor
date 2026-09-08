export function bindToolPopups(root: HTMLElement, signal: AbortSignal, enabled: () => boolean) {
  const document = root.ownerDocument
  const pairs = [...root.querySelectorAll<HTMLElement>('.tool-slot')].flatMap(slot => {
    const popup = slot.querySelector<HTMLButtonElement>('[data-tool-popup]')?.popoverTargetElement
    return popup instanceof HTMLElement && popup.matches('.tool-popup, .layer-panel')
      ? [{ slot, popup, blocked: false, timer: undefined as ReturnType<typeof setTimeout> | undefined }] : []
  })
  type Pair = typeof pairs[number]
  let gesture: { pair: Pair; slot: boolean; id: number; touch?: number; x: number; y: number; top: boolean; action?: 'open' | 'close' }
    | undefined
  const pointers = new Set<number>()
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let suppressClick = false
  let consumedTouch: number | undefined
  const on = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, listener: (event: HTMLElementEventMap[K]) => void, options: AddEventListenerOptions = {}) =>
    target.addEventListener(type, listener as EventListener, { ...options, signal })
  const atTop = (popup: HTMLElement) => popup.scrollTop <= 0 && (popup.querySelector<HTMLElement>('.layer-list')?.scrollTop ?? 0) <= 0

  function cancelGesture() {
    const previous = gesture
    gesture = undefined
    if (previous && root.hasPointerCapture(previous.id)) root.releasePointerCapture(previous.id)
  }

  function reset() {
    cancelGesture()
    clearTimeout(openTimer)
    for (const pair of pairs) clearTimeout(pair.timer)
  }

  function leave(pair: Pair) {
    clearTimeout(pair.timer)
    pair.timer = setTimeout(() => {
      if (enabled() && !gesture && !pair.slot.matches(':hover') && !pair.popup.matches(':hover')
        && !pair.popup.contains(document.activeElement) && pair.popup.matches(':popover-open')) pair.popup.hidePopover()
    }, 180)
  }

  for (const pair of pairs) {
    on(pair.slot, 'pointerenter', event => {
      clearTimeout(pair.timer)
      if (event.pointerType !== 'mouse' || event.buttons || pair.blocked || gesture || !enabled()) return
      if (pairs.some(other => other !== pair && other.popup.contains(document.activeElement))) return
      if (!pair.popup.matches(':popover-open')) pair.popup.showPopover()
    })
    on(pair.popup, 'pointerenter', () => clearTimeout(pair.timer))
    for (const element of [pair.slot, pair.popup]) on(element, 'pointerleave', event => {
      if (event.pointerType === 'mouse') leave(pair)
    })
    on(pair.popup, 'focusout', () => leave(pair))
    on(pair.popup, 'beforetoggle', event => {
      if ((event as ToggleEvent).newState !== 'closed') return
      pair.blocked ||= pair.slot.matches(':hover')
      clearTimeout(pair.timer)
      if (gesture?.pair === pair && !gesture.action) cancelGesture()
    })
  }

  on(document, 'pointerdown', event => {
    clearTimeout(openTimer)
    if (!pointers.size) { suppressClick = false; consumedTouch = undefined }
    pointers.add(event.pointerId)
    if (pointers.size !== 1) { cancelGesture(); return }
    if (!enabled() || event.button !== 0 || !event.isPrimary || !(event.target instanceof Node)) return
    const target = event.target
    const pair = pairs.find(pair => pair.slot.contains(target) || pair.popup.contains(target))
    if (!pair) return
    clearTimeout(pair.timer)
    gesture = { pair, slot: pair.slot.contains(target), id: event.pointerId, x: event.clientX, y: event.clientY, top: atTop(pair.popup) }
  }, { capture: true })

  function move(x: number, y: number, event: Event) {
    if (!gesture) return
    if (!enabled()) { cancelGesture(); return }
    const dx = Math.abs(x - gesture.x), dy = y - gesture.y
    if (!gesture.action) {
      if (dx > Math.abs(dy) && dx >= 6 || !gesture.slot && (dy < -6 || dy > 0 && (!gesture.top || !atTop(gesture.pair.popup)))) {
        cancelGesture()
        return
      }
      if (Math.abs(dy) <= dx || !gesture.slot && dy <= 0) return
      // Reserve the first downward touchmove, before the browser takes over scrolling.
      if (event.cancelable) event.preventDefault()
      if (Math.abs(dy) < 24) return
      gesture.action = dy < 0 ? 'open' : 'close'
      if (gesture.action === 'close') gesture.pair.blocked = true
      suppressClick = true
      consumedTouch = gesture.touch
      root.setPointerCapture(gesture.id)
    }
    if (event.cancelable) event.preventDefault()
  }

  on(document, 'pointermove', event => {
    if (event.pointerType === 'mouse' && !event.buttons) {
      for (const pair of pairs) {
        const box = pair.slot.getBoundingClientRect()
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) pair.blocked = false
      }
    }
    // Touchmove owns scroll arbitration; pointermove cannot prevent native touch scrolling.
    if (gesture?.id === event.pointerId && event.pointerType !== 'touch') move(event.clientX, event.clientY, event)
  }, { capture: true })
  on(document, 'touchstart', event => {
    if (event.touches.length !== 1) { cancelGesture(); return }
    if (gesture) gesture.touch = event.changedTouches[0]?.identifier
  }, { capture: true, passive: true })
  on(document, 'touchmove', event => {
    if (event.touches.length !== 1) { cancelGesture(); return }
    const touch = [...event.changedTouches].find(touch => touch.identifier === gesture?.touch)
    if (touch) move(touch.clientX, touch.clientY, event)
  }, { capture: true, passive: false })
  on(document, 'touchend', event => {
    if ([...event.changedTouches].some(touch => touch.identifier === consumedTouch) && event.cancelable) event.preventDefault()
  }, { capture: true, passive: false })
  on(document, 'touchcancel', cancelGesture, { capture: true })

  on(document, 'pointerup', event => {
    pointers.delete(event.pointerId)
    if (gesture?.id !== event.pointerId) return
    const { pair, action } = gesture
    // Keep capture through pointerup; hiding mid-drag can expose controls under the popup.
    gesture = undefined
    if (action && enabled()) {
      // Finish opening after native pointerup light-dismiss, including hover-opened popups.
      if (action === 'open') openTimer = setTimeout(() => {
        if (!enabled() || signal.aborted) return
        if (!pair.popup.matches(':popover-open')) pair.popup.showPopover()
        if (event.pointerType === 'mouse') leave(pair)
      }, 0)
      if (action === 'close' && pair.popup.matches(':popover-open')) pair.popup.hidePopover()
    }
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId)
    if (action === 'close' && event.pointerType === 'mouse') leave(pair)
  }, { capture: true })
  on(document, 'pointercancel', event => {
    pointers.delete(event.pointerId)
    if (gesture?.id === event.pointerId) cancelGesture()
  }, { capture: true })
  on(document, 'lostpointercapture', event => {
    // Taking capture from the original touch target also emits lostpointercapture there.
    if (gesture?.id === event.pointerId && !root.hasPointerCapture(event.pointerId)) cancelGesture()
  }, { capture: true })
  on(document, 'click', event => {
    // A real new pointerdown re-arms clicks; keyboard/programmatic activation always works.
    if (!suppressClick || event.detail === 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }, { capture: true })
  on(document, 'keydown', event => { if (event.key === 'Escape') reset() }, { capture: true })
  on(document.defaultView!, 'blur', () => { reset(); pointers.clear() })
  document.addEventListener('visibilitychange', () => { if (document.hidden) { reset(); pointers.clear() } }, { signal })
  signal.addEventListener('abort', reset, { once: true })
  return reset
}
