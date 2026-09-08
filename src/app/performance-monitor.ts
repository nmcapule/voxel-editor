import Stats from 'three/addons/libs/stats.module.js'
import type { Viewport } from '../shared/rendering/viewport'

export function mountPerformanceMonitor(shell: HTMLElement, viewport: Viewport) {
  const key = 'voxel-studio-performance-monitor'
  const lifetime = new AbortController()
  const overlay = document.createElement('dl')
  overlay.className = 'performance-monitor'
  overlay.setAttribute('aria-label', 'Performance monitor')
  overlay.setAttribute('aria-live', 'off')
  overlay.hidden = true
  shell.append(overlay)
  const toggles = shell.querySelectorAll<HTMLInputElement>('[data-performance-monitor]')
  const panels: { panel: Stats.Panel; value: HTMLElement }[] = []
  let enabled = false
  try { enabled = localStorage.getItem(key) === 'true' } catch { /* Session-only when storage is unavailable. */ }
  let timer: ReturnType<typeof setInterval> | undefined
  let fps: number | undefined, renderMs: number | undefined
  let renderTotal = 0, renderCount = 0, lastRender = -Infinity

  const monitor: NonNullable<Viewport['performanceMonitor']> = {
    onFps(value) { fps = value },
    onRender(milliseconds) {
      renderTotal += milliseconds
      renderCount++
      lastRender = performance.now()
    },
  }

  function update() {
    const active = performance.now() - lastRender < 1000
    if (renderCount) renderMs = renderTotal / renderCount
    renderTotal = renderCount = 0
    // Chromium's optional heap estimate excludes GPU memory and may exclude workers.
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
    const heap = memory && Number.isFinite(memory.usedJSHeapSize) && memory.usedJSHeapSize >= 0 ? memory.usedJSHeapSize / 1048576 : undefined
    const values = [active ? fps : undefined, active ? renderMs : undefined, heap]
    const scales = [100, 50, Math.max(1, heap ?? 0, (memory?.jsHeapSizeLimit ?? 0) / 1048576)]
    panels.forEach(({ panel, value }, index) => {
      const reading = values[index]
      value.textContent = reading === undefined ? index === 2 ? 'Unavailable' : active ? 'Measuring' : 'Idle' : String(Number(reading.toFixed(2)))
      panel.dom.style.visibility = reading === undefined ? 'hidden' : 'visible'
      if (reading !== undefined) panel.update(reading, scales[index])
    })
  }

  function sync() {
    clearInterval(timer)
    timer = undefined
    viewport.performanceMonitor = undefined
    fps = renderMs = undefined
    renderTotal = renderCount = 0
    lastRender = -Infinity
    for (const toggle of toggles) toggle.checked = enabled
    overlay.hidden = !enabled || document.hidden
    if (overlay.hidden) return
    if (!panels.length) {
      for (const [name, label, color, background, description] of [
        ['FPS', 'FPS', '#0ff', '#002', 'Rendered frames per second; completed full samples while tracing.'],
        ['MS', 'Render ms', '#0f0', '#020', 'Average synchronous main-thread render work per pass, including post-processing. Not CPU utilization or GPU time; excludes workers and other tasks.'],
        ['MiB', 'JS heap MiB', '#f08', '#201', 'Browser JavaScript heap estimate where supported. Not total RAM or GPU memory.'],
      ]) {
        const metric = document.createElement('div')
        metric.style.color = color
        metric.style.background = background
        metric.title = description
        metric.innerHTML = `<dt>${label}</dt><dd><span></span></dd>`
        const panel = new Stats.Panel(name, color, background)
        panel.dom.setAttribute('aria-hidden', 'true')
        metric.querySelector('dd')!.append(panel.dom)
        panels.push({ panel, value: metric.querySelector('span')! })
        overlay.append(metric)
      }
    }
    viewport.performanceMonitor = monitor
    update()
    timer = setInterval(update, 500)
  }

  shell.addEventListener('input', event => {
    const target = event.target
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-performance-monitor]')) return
    // Keep this browser preference out of the editors' document-setting handlers.
    event.stopPropagation()
    enabled = target.checked
    try { localStorage.setItem(key, String(enabled)) } catch { /* Keep the session preference. */ }
    sync()
  }, { capture: true, signal: lifetime.signal })
  document.addEventListener('visibilitychange', sync, { signal: lifetime.signal })
  sync()
  return () => {
    lifetime.abort()
    clearInterval(timer)
    viewport.performanceMonitor = undefined
    overlay.remove()
  }
}
