// Run `bunx vite --config tests/vite.config.ts --port 5188`, open /tests/transparency.html,
// then execute in the browser console (run suites sequentially):
// import('/tests/performance-monitor.ts').then(m => m.runPerformanceMonitorChecks())
import { mountPerformanceMonitor } from '../src/app/performance-monitor'
import type { Viewport } from '../src/shared/rendering/viewport'

export function runPerformanceMonitorChecks() {
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const key = 'voxel-studio-performance-monitor', storage = localStorage, savedPreference = storage.getItem(key)
  const restores: (() => void)[] = []
  const patch = (target: object, name: string, descriptor: PropertyDescriptor) => {
    const saved = Object.getOwnPropertyDescriptor(target, name)
    Object.defineProperty(target, name, { configurable: true, ...descriptor })
    restores.push(() => saved ? Object.defineProperty(target, name, saved) : Reflect.deleteProperty(target, name))
  }
  const fixture = document.createElement('div'), shell = document.createElement('div')
  const toggles = [document.createElement('input'), document.createElement('input')]
  const outside = document.createElement('input'), ordinary = document.createElement('input')
  for (const toggle of [...toggles, outside]) {
    toggle.type = 'checkbox'
    toggle.dataset.performanceMonitor = ''
  }
  shell.append(...toggles, ordinary)
  fixture.hidden = true
  fixture.append(shell, outside)
  const viewport = { renderMode: false, settings: { pathTracing: false } } as Viewport
  const originalSetInterval = window.setInterval.bind(window), originalClearInterval = window.clearInterval.bind(window)
  const timers = new Map<number, () => void>(), callbacks = new Set<TimerHandler>()
  let dispose: (() => void) | undefined
  let now = 1000, hidden = false, nextTimer = 0, settingsInputs = 0, ownCall = false
  let memory: { usedJSHeapSize: number; jsHeapSizeLimit: number } | undefined = { usedJSHeapSize: 64 * 1048576, jsHeapSizeLimit: 256 * 1048576 }
  const scoped = <T>(action: () => T) => {
    ownCall = true
    try { return action() } finally { ownCall = false }
  }
  const input = (toggle: HTMLInputElement, checked: boolean) => scoped(() => {
    toggle.checked = checked
    toggle.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const onSettingsInput = (event: Event) => { if (fixture.contains(event.target as Node)) settingsInputs++ }
  const tick = () => {
    check(timers.size === 1, 'Enabled, visible monitor must own exactly one interval')
    now += 500
    timers.values().next().value!()
  }
  try {
    storage.removeItem(key)
    document.body.append(fixture) // Sibling of the app, never inside its editor/settings roots.
    document.addEventListener('input', onSettingsInput)
    patch(document, 'hidden', { get: () => hidden })
    patch(performance, 'now', { value: () => now })
    patch(performance, 'memory', { get: () => memory })
    // No awaits: capture only fixture calls and its known callbacks on visibility changes.
    patch(window, 'setInterval', { value: (callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (!ownCall && !callbacks.has(callback)) return originalSetInterval(callback, delay, ...args)
      check(delay === 500 && typeof callback === 'function', 'Monitor must schedule a 500ms callback')
      callbacks.add(callback)
      timers.set(--nextTimer, () => { if (typeof callback === 'function') callback(...args) })
      return nextTimer
    } })
    patch(window, 'clearInterval', { value: (id?: number) => {
      if (!timers.delete(id!)) originalClearInterval(id)
    } })
    dispose = scoped(() => mountPerformanceMonitor(shell, viewport))
    const overlay = shell.querySelector<HTMLElement>('.performance-monitor')!
    const values = () => [...overlay.querySelectorAll('dd span')].map(value => value.textContent).join(',')
    check(overlay?.hidden && toggles.every(toggle => !toggle.checked) && !viewport.performanceMonitor
      && timers.size === 0 && !overlay.querySelector('canvas'), 'Disabled by default without hooks, panels or interval')
    ordinary.dispatchEvent(new Event('input', { bubbles: true }))
    outside.dispatchEvent(new Event('input', { bubbles: true }))
    check(settingsInputs === 2 && overlay.hidden && timers.size === 0, 'Ordinary and outside inputs must bubble without enabling the monitor')
    settingsInputs = 0

    input(toggles[0], true)
    check(toggles.every(toggle => toggle.checked) && !outside.checked && !overlay.hidden
      && viewport.performanceMonitor && timers.size === 1 && storage.getItem(key) === 'true', 'First toggle enables and synchronizes only its shell')
    const canvases = [...overlay.querySelectorAll('canvas')]
    check(canvases.length === 3 && canvases.every(canvas => canvas.getContext('2d') && canvas.getAttribute('aria-hidden') === 'true'), 'Use three real Stats.Panel canvases')
    check(values() === 'Idle,Idle,64', 'Initial readings must show idle rendering and JS heap in MiB')
    viewport.performanceMonitor!.onFps(59.876)
    viewport.performanceMonitor!.onRender(2)
    viewport.performanceMonitor!.onRender(6)
    tick()
    check(values() === '59.88,4,64' && canvases.every(canvas => canvas.style.visibility === 'visible'), 'Active metrics must show FPS, average render ms and heap')
    tick()
    check(values() === 'Idle,Idle,64' && canvases.slice(0, 2).every(canvas => canvas.style.visibility === 'hidden'), 'Idle viewport must not retain stale FPS or render ms')
    memory = undefined
    tick()
    check(values() === 'Idle,Idle,Unavailable' && canvases[2].style.visibility === 'hidden', 'Unsupported heap must say Unavailable, not zero')

    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    check(overlay.hidden && !viewport.performanceMonitor && timers.size === 0 && toggles.every(toggle => toggle.checked), 'Hidden document must detach hooks and stop its interval without disabling the preference')
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    check(!overlay.hidden && viewport.performanceMonitor && timers.size === 1 && values() === 'Idle,Idle,Unavailable'
      && [...overlay.querySelectorAll('canvas')].every((canvas, index) => canvas === canvases[index]), 'Visibility resume must reset metrics and reuse panels with one interval')
    viewport.performanceMonitor!.onFps(30)
    viewport.performanceMonitor!.onRender(8)
    tick()
    check(values() === '30,8,Unavailable', 'Resumed hooks must publish fresh metrics')
    input(toggles[1], false)
    check(toggles.every(toggle => !toggle.checked) && overlay.hidden && !viewport.performanceMonitor
      && timers.size === 0 && storage.getItem(key) === 'false', 'Second toggle disables and synchronizes both controls')
    document.dispatchEvent(new Event('visibilitychange'))
    check(timers.size === 0 && !viewport.performanceMonitor, 'Visibility must not restart a disabled monitor')
    check(settingsInputs === 0, 'Monitor inputs must never bubble into document settings handlers')

    input(toggles[1], true)
    dispose()
    check(!shell.contains(overlay) && !viewport.performanceMonitor && timers.size === 0, 'Disposal must remove the overlay, hooks and interval')
    input(toggles[0], false)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    check(settingsInputs === 1 && toggles[1].checked && !viewport.performanceMonitor && timers.size === 0
      && !shell.querySelector('.performance-monitor') && storage.getItem(key) === 'true', 'Disposed input and visibility listeners must remain detached')

    patch(window, 'localStorage', { get: () => { throw new DOMException('Test: storage denied', 'SecurityError') } })
    dispose = scoped(() => mountPerformanceMonitor(shell, viewport))
    const fallback = shell.querySelector<HTMLElement>('.performance-monitor')!
    check(fallback.hidden && toggles.every(toggle => !toggle.checked) && !viewport.performanceMonitor && timers.size === 0, 'Denied storage reads must fall back to disabled')
    input(toggles[0], true)
    check(!fallback.hidden && toggles.every(toggle => toggle.checked) && viewport.performanceMonitor && timers.size === 1, 'Denied storage writes must still enable the session preference')
    input(toggles[1], false)
    check(fallback.hidden && toggles.every(toggle => !toggle.checked) && !viewport.performanceMonitor && timers.size === 0, 'Session-only preference must still disable')
    check(storage.getItem(key) === 'true', 'Denied storage must leave the stored preference untouched')
    input(toggles[1], true)
    dispose()
    check(!shell.contains(fallback) && !viewport.performanceMonitor && timers.size === 0, 'Session-only monitor must also dispose while active')
    return { ok: true }
  } finally {
    try { dispose?.() } finally {
      document.removeEventListener('input', onSettingsInput)
      fixture.remove()
      for (const restore of restores.reverse()) restore()
      if (savedPreference === null) storage.removeItem(key)
      else storage.setItem(key, savedPreference)
    }
  }
}
