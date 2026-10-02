export function bindMobileWheels(root: HTMLElement, signal: AbortSignal, enabled: () => boolean, beforeOpen: () => void, commit: (kind: 'brush' | 'action' | 'material', value: string) => void) {
  const document = root.ownerDocument
  const wheels = [...root.querySelectorAll<HTMLElement>('[data-mobile-wheel]')].map(picker => {
    const material = picker.dataset.mobileWheel === 'material'
    const panel = material ? root.querySelector<HTMLElement>('#material-picker')! : picker.querySelector<HTMLElement>('[data-wheel-panel]')!
    return {
      picker, panel, material,
      trigger: picker.querySelector<HTMLButtonElement>('[data-wheel-trigger]')!,
      drum: material ? panel.querySelector<HTMLElement>('#material-picker-grid')! : picker.querySelector<HTMLElement>('[role="listbox"]')!,
      get options() { return [...(material ? panel : picker).querySelectorAll<HTMLButtonElement>('[data-wheel-value]')] },
      contains(node: Node) { return picker.contains(node) || panel.contains(node) },
    }
  })
  let active: typeof wheels[number] | undefined
  let inspected = -1
  let pointer: number | undefined
  let tapStart: { x: number; y: number } | undefined
  // Consume secondary and canceled pointers until their own release.
  const blocked = new Set<number>()
  let touching = false
  let suppressClick = false
  const on = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, handler: (event: HTMLElementEventMap[K]) => void, options: AddEventListenerOptions = {}) =>
    target.addEventListener(type, handler as EventListener, { ...options, signal })
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
  const nativePanel = (event: Event) => active?.material && pointer === undefined && !blocked.size && !touching && active.panel.contains(event.target as Node)

  function inspect(index: number) {
    if (!active) return
    inspected = active.options[index] && !active.options[index]!.disabled ? index : -1
    for (const [i, option] of active.options.entries()) {
      if (i === inspected) option.dataset.inspected = 'true'
      else delete option.dataset.inspected
    }
    if (inspected < 0) active.drum.removeAttribute('aria-activedescendant')
    else {
      const option = active.options[inspected]!
      if (!option.id) option.id = `mobile-wheel-${active.picker.dataset.mobileWheel}-${option.dataset.wheelValue}`
      active.drum.setAttribute('aria-activedescendant', option.id)
    }
  }

  function close(focus = false) {
    if (!active) return
    const wheel = active, id = pointer
    inspect(-1)
    active = undefined; pointer = undefined; tapStart = undefined
    wheel.panel.hidden = true
    wheel.trigger.setAttribute('aria-expanded', 'false')
    if (id !== undefined && wheel.picker.hasPointerCapture(id)) wheel.picker.releasePointerCapture(id)
    if (focus) wheel.trigger.focus({ preventScroll: true })
  }

  function open(wheel: typeof wheels[number], keyboard = false) {
    close()
    beforeOpen()
    if (signal.aborted || !enabled()) return
    active = wheel
    wheel.panel.hidden = false
    const rect = (wheel.material ? wheel.trigger : wheel.picker).getBoundingClientRect(), width = wheel.panel.getBoundingClientRect().width
    const left = Math.max(12, Math.min(rect.left + (rect.width - width) / 2, document.documentElement.clientWidth - width - 12))
    wheel.panel.style.left = `${left}px`
    wheel.panel.style.setProperty('--callout-x', `${rect.left + rect.width / 2 - left}px`)
    wheel.trigger.setAttribute('aria-expanded', 'true')
    const selected = wheel.options.findIndex(option => !option.disabled && option.getAttribute('aria-selected') === 'true')
    inspect(keyboard ? (selected < 0 ? wheel.options.findIndex(option => !option.disabled) : selected) : -1)
    if (keyboard) {
      wheel.drum.focus({ preventScroll: true })
      if (wheel.material) wheel.options[inspected]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  function hit(event: PointerEvent) {
    if (active?.material) {
      const rect = active.drum.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return -1
    }
    return active?.options.findIndex(option => {
      const rect = option.getBoundingClientRect()
      return !option.disabled && !option.hidden && (!active!.material || option.checkVisibility({ visibilityProperty: true })) && rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom
    }) ?? -1
  }

  function choose(index = inspected) {
    if (!active) return
    const option = active.options[index], kind = active.picker.dataset.mobileWheel as 'brush' | 'action' | 'material'
    const valid = enabled() && option && !option.disabled
    close(true)
    if (valid) commit(kind, option.dataset.wheelValue!)
  }

  on(document, 'pointerdown', event => {
    // A fresh primary press can follow blur without the old release reaching us.
    if (pointer === undefined && event.isPrimary) { blocked.clear(); touching = false }
    if (pointer !== undefined || blocked.size) {
      stop(event); blocked.add(event.pointerId)
      return
    }
    suppressClick = false
    const wheel = wheels.find(wheel => wheel.contains(event.target as Node))
    if (nativePanel(event)) return
    if (active && !wheel && (event.target as HTMLElement).closest?.('button, summary, input, select')) {
      close()
      return
    }
    if (active || wheel) stop(event)
    if (active && !wheel) {
      blocked.add(event.pointerId); suppressClick = true; close()
      return
    }
    if (!wheel || !enabled() || event.button !== 0 || !event.isPrimary) return
    if (!wheel.trigger.contains(event.target as Node) && (wheel.panel.hidden || !wheel.drum.contains(event.target as Node))) return
    blocked.add(event.pointerId); suppressClick = true
    const fromTrigger = wheel.trigger.contains(event.target as Node)
    if (active === wheel && fromTrigger) { close(); return }
    if (active !== wheel) open(wheel)
    if (!active) return
    pointer = event.pointerId
    tapStart = fromTrigger ? { x: event.clientX, y: event.clientY } : undefined
    inspect(hit(event))
    wheel.picker.setPointerCapture(event.pointerId)
  }, { capture: true })

  on(document, 'pointermove', event => {
    if (nativePanel(event)) return
    if (!active && !blocked.has(event.pointerId)) return
    stop(event)
    if (!enabled()) { close(); return }
    if (pointer === event.pointerId && tapStart && Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) > 5) tapStart = undefined
    if (active && (pointer === event.pointerId || (pointer === undefined && event.isPrimary && !blocked.size))) inspect(hit(event))
  }, { capture: true })
  on(document, 'pointerup', event => {
    if (nativePanel(event)) return
    if (!active && !blocked.has(event.pointerId)) return
    stop(event)
    blocked.delete(event.pointerId)
    if (pointer !== event.pointerId || !active) return
    const index = hit(event), rect = active.trigger.getBoundingClientRect()
    if (enabled() && index < 0 && tapStart && Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) <= 5
      && event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) {
      pointer = undefined; tapStart = undefined
      if (active.picker.hasPointerCapture(event.pointerId)) active.picker.releasePointerCapture(event.pointerId)
      active.drum.focus({ preventScroll: true })
      return
    }
    choose(index)
  }, { capture: true })
  on(document, 'pointercancel', event => {
    if (nativePanel(event)) return
    if (!active && !blocked.has(event.pointerId)) return
    stop(event)
    blocked.delete(event.pointerId)
    if (pointer === event.pointerId) close()
  }, { capture: true })
  on(document, 'lostpointercapture', event => {
    if (pointer === event.pointerId && !active?.picker.hasPointerCapture(event.pointerId)) { stop(event); close() }
  }, { capture: true })
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
    on(document, type, event => {
      if (nativePanel(event)) return
      if (!active && !blocked.size && !touching) return
      stop(event)
      touching = event.touches.length > 0
    }, { capture: true, passive: false })
  }
  for (const type of ['mousedown', 'mouseup', 'contextmenu'] as const) {
    on(document, type, event => {
      if (nativePanel(event)) return
      if (active || blocked.size || suppressClick || wheels.some(wheel => wheel.contains(event.target as Node))) stop(event)
    }, { capture: true })
  }
  on(document, 'click', event => {
    const wheel = wheels.find(wheel => wheel.contains(event.target as Node))
    const fromPointer = event.detail !== 0 || !!(event as PointerEvent).pointerType
       || !!(event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }).sourceCapabilities?.firesTouchEvents
    if (nativePanel(event) && !(suppressClick && fromPointer)) {
      const index = active!.options.findIndex(option => option.contains(event.target as Node))
      if (index >= 0) { stop(event); choose(index) }
      else if ((event.target as HTMLElement).closest?.('button, summary, input, select')) close()
      return
    }
    if (!wheel && active && !fromPointer && (event.target as HTMLElement).closest?.('button, summary, input, select')) {
      close()
      return
    }
    if (!wheel && !active && !(suppressClick && fromPointer)) return
    stop(event)
    if (fromPointer || pointer !== undefined || blocked.size) return
    if (!enabled()) { close(); return }
    if (!wheel) { close(); return }
    if (wheel.trigger.contains(event.target as Node)) active === wheel ? close(true) : open(wheel, true)
    else if (active === wheel) choose(wheel.options.findIndex(option => option.contains(event.target as Node)))
  }, { capture: true })
  on(document, 'keydown', event => {
    if (!active) return
    if (event.key === 'Escape') { stop(event); close(true); return }
    if (!active.contains(event.target as Node)) return
    if (event.key === 'Tab') { if (!active.material) close(); return }
    if (active.material && !active.drum.contains(event.target as Node) && !active.trigger.contains(event.target as Node)) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
    stop(event)
    if (!enabled()) { close(); return }
    if (pointer !== undefined) return
    if (event.key === 'Enter' || event.key === ' ') { choose(); return }
    const indices = active.options.flatMap((option, index) => option.disabled ? [] : [index])
    const step = active.material && (event.key === 'ArrowUp' || event.key === 'ArrowDown') ? 5 : 1
    const next = indices.indexOf(inspected) + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : step)
    inspect(indices[event.key === 'Home' ? 0 : event.key === 'End' ? indices.length - 1 : Math.max(0, Math.min(indices.length - 1, next))] ?? -1)
    if (active.material) active.options[inspected]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, { capture: true })
  on(document, 'focusin', event => { if (active && !active.contains(event.target as Node)) close() })
  on(document.defaultView!, 'blur', () => close())
  on(document.defaultView!, 'resize', () => close())
  document.addEventListener('visibilitychange', () => { if (document.hidden) close() }, { signal })
  signal.addEventListener('abort', () => { close(); blocked.clear(); touching = false }, { once: true })
  return close
}
