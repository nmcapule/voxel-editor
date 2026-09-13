export function bindMobileWheels(root: HTMLElement, signal: AbortSignal, enabled: () => boolean, beforeOpen: () => void, commit: (kind: 'brush' | 'action', value: string) => void) {
  const document = root.ownerDocument
  const wheels = [...root.querySelectorAll<HTMLElement>('[data-mobile-wheel]')].map(picker => ({
    picker,
    trigger: picker.querySelector<HTMLButtonElement>('[data-wheel-trigger]')!,
    panel: picker.querySelector<HTMLElement>('[data-wheel-panel]')!,
    drum: picker.querySelector<HTMLElement>('[role="listbox"]')!,
    options: [...picker.querySelectorAll<HTMLButtonElement>('[data-wheel-value]')],
  }))
  let active: typeof wheels[number] | undefined
  let position = 0
  let drag: { id: number; y: number; position: number; option: number; moved: boolean } | undefined
  let suppressClick = false
  const on = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, handler: (event: HTMLElementEventMap[K]) => void, options: AddEventListenerOptions = {}) =>
    target.addEventListener(type, handler as EventListener, { ...options, signal })

  function close(focus = false) {
    if (!active) return
    const wheel = active, pointer = drag?.id
    active = undefined; drag = undefined
    wheel.panel.hidden = true
    wheel.trigger.setAttribute('aria-expanded', 'false')
    if (pointer !== undefined && wheel.picker.hasPointerCapture(pointer)) wheel.picker.releasePointerCapture(pointer)
    if (focus) wheel.trigger.focus({ preventScroll: true })
  }

  function turn(next: number) {
    if (!active) return
    position = Math.max(0, Math.min(active.options.findLastIndex(option => !option.disabled), next))
    const centered = Math.round(position)
    for (const [index, option] of active.options.entries()) {
      const offset = index - position, distance = Math.min(Math.abs(offset), 3)
      option.style.transform = `translateY(${offset * 44}px) rotateX(${-offset * 22}deg) scale(${1 - distance * 0.07})`
      option.style.opacity = String(option.disabled ? 0.3 : 1 - distance * 0.2)
      option.dataset.centered = String(index === centered)
    }
    active.drum.setAttribute('aria-activedescendant', active.options[centered]!.id)
  }

  function open(wheel: typeof wheels[number]) {
    close()
    beforeOpen()
    active = wheel
    wheel.panel.hidden = false
    wheel.trigger.setAttribute('aria-expanded', 'true')
    turn(wheel.options.findIndex(option => option.getAttribute('aria-selected') === 'true'))
    wheel.drum.focus({ preventScroll: true })
  }

  function choose(index = Math.round(position)) {
    if (!active || !enabled()) { close(); return }
    const option = active.options[index], kind = active.picker.dataset.mobileWheel as 'brush' | 'action'
    if (!option || option.disabled) return
    close(true)
    commit(kind, option.dataset.wheelValue!)
  }

  on(document, 'pointerdown', event => {
    if (drag) { if (drag.id !== event.pointerId) close(); return }
    suppressClick = false
    const wheel = wheels.find(wheel => wheel.picker.contains(event.target as Node))
    if (!wheel) { close(); return }
    if (!enabled() || event.button !== 0 || !event.isPrimary) return
    const fromTrigger = wheel.trigger.contains(event.target as Node)
    if (!fromTrigger && (wheel.panel.hidden || !wheel.drum.contains(event.target as Node))) return
    if (active !== wheel) open(wheel)
    event.preventDefault()
    drag = { id: event.pointerId, y: event.clientY, position, moved: false,
      option: fromTrigger ? -1 : wheel.options.findIndex(option => option.contains(event.target as Node)) }
    wheel.picker.setPointerCapture(event.pointerId)
  }, { capture: true })

  function move(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return
    if (!enabled()) { close(); return }
    drag.moved ||= Math.abs(event.clientY - drag.y) >= 5
    if (drag.moved) turn(drag.position + (drag.y - event.clientY) / 44)
  }
  on(document, 'pointermove', move, { capture: true })
  on(document, 'pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return
    move(event)
    if (!drag || !active) return
    const { moved, option } = drag, picker = active.picker
    drag = undefined
    suppressClick = true
    if (picker.hasPointerCapture(event.pointerId)) picker.releasePointerCapture(event.pointerId)
    if (moved) choose()
    else if (option >= 0) choose(option)
  }, { capture: true })
  on(document, 'pointercancel', () => close(), { capture: true })
  on(document, 'lostpointercapture', event => {
    if (drag?.id === event.pointerId && !active?.picker.hasPointerCapture(event.pointerId)) close()
  }, { capture: true })
  on(document, 'click', event => {
    const wheel = wheels.find(wheel => wheel.picker.contains(event.target as Node))
    if (!wheel) return
    event.stopPropagation()
    // Pointer release already handled this click; keyboard/AT activation stays available.
    if (suppressClick && event.detail !== 0) { event.preventDefault(); return }
    if (!enabled()) return
    if (wheel.trigger.contains(event.target as Node)) active === wheel ? close() : open(wheel)
    else if (active === wheel) choose(wheel.options.findIndex(option => option.contains(event.target as Node)))
  }, { capture: true })
  on(document, 'keydown', event => {
    if (!active) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (!active.picker.contains(event.target as Node)) return
    if (event.key === 'Tab') { close(); return }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    if (!enabled()) { close(); return }
    if (event.key === 'Enter' || event.key === ' ') { choose(); return }
    turn(event.key === 'Home' ? 0 : event.key === 'End' ? active.options.length - 1 : Math.round(position) + (event.key === 'ArrowUp' ? -1 : 1))
  }, { capture: true })
  on(document.defaultView!, 'blur', () => close())
  on(document.defaultView!, 'resize', () => close())
  document.addEventListener('visibilitychange', () => { if (document.hidden) close() }, { signal })
  signal.addEventListener('abort', () => close(), { once: true })
  return close
}
