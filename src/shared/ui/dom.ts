export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export function listen<K extends keyof HTMLElementEventMap>(signal: AbortSignal, target: EventTarget, type: K, listener: (event: HTMLElementEventMap[K]) => void) {
  target.addEventListener(type, listener as EventListener, { signal })
}
