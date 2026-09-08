import type { Viewport } from '../shared/rendering/viewport'

export function mountRenderingPreferences(shell: HTMLElement, viewport: Pick<Viewport, 'setAutoSimplifyRendering'>) {
  const key = 'voxel-studio-auto-simplify-rendering'
  const lifetime = new AbortController()
  const toggles = shell.querySelectorAll<HTMLInputElement>('[data-auto-simplify-rendering]')
  let enabled = false
  try { enabled = localStorage.getItem(key) === 'true' } catch { /* Session-only when storage is unavailable. */ }

  function sync() {
    for (const toggle of toggles) toggle.checked = enabled
    viewport.setAutoSimplifyRendering(enabled)
  }

  shell.addEventListener('input', event => {
    const target = event.target
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-auto-simplify-rendering]')) return
    // Keep this browser preference out of the editors' document-setting handlers.
    event.stopPropagation()
    enabled = target.checked
    try { localStorage.setItem(key, String(enabled)) } catch { /* Keep the session preference. */ }
    sync()
  }, { capture: true, signal: lifetime.signal })
  sync()
  return () => lifetime.abort()
}
