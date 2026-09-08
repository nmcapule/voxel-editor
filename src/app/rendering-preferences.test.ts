import { expect, mock, test } from 'bun:test'
import { mountRenderingPreferences } from './rendering-preferences'

const key = 'voxel-studio-auto-simplify-rendering'

class InputStub {
  checked = false
  readonly selector: string
  constructor(selector = '[data-auto-simplify-rendering]') { this.selector = selector }
  matches(selector: string) { return selector === this.selector }
}

function fixture(stored: string | null = null, denied?: 'read' | 'write' | 'access') {
  const globals = ['HTMLInputElement', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const values = new Map<string, string>([['voxel-studio-performance-monitor', 'true']])
  if (stored !== null) values.set(key, stored)
  const storage = {
    getItem(name: string) {
      if (denied === 'read') throw new DOMException('Storage denied', 'SecurityError')
      return values.get(name) ?? null
    },
    setItem: mock((name: string, value: string) => {
      if (denied === 'write') throw new DOMException('Storage full', 'QuotaExceededError')
      values.set(name, value)
    }),
  }
  Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: InputStub })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() {
    if (denied === 'access') throw new DOMException('Storage denied', 'SecurityError')
    return storage
  } })
  const toggles = [new InputStub(), new InputStub()]
  let listener: (event: Event) => void, signal: AbortSignal
  const shell = {
    querySelectorAll(selector: string) { return toggles.filter(toggle => toggle.matches(selector)) },
    addEventListener(type: string, callback: (event: Event) => void, options: AddEventListenerOptions) {
      expect(type).toBe('input')
      expect(options.capture).toBe(true)
      listener = callback; signal = options.signal!
    },
  }
  const viewport = { setAutoSimplifyRendering: mock((_enabled: boolean) => {}) }
  const save = mock(() => {})
  const mount = () => mountRenderingPreferences(shell as unknown as HTMLElement, viewport)
  const dispose = mount()
  return { toggles, values, storage, viewport, save, mount, dispose,
    input(target: InputStub) {
      const event = new Event('input', { bubbles: true })
      Object.defineProperty(event, 'target', { value: target })
      // Model Render inputs reach a document-setting/save handler unless capture stops them.
      if (!signal.aborted) listener(event)
      if (!event.cancelBubble) save()
    },
    [Symbol.dispose]() {
      dispose()
      for (const [name, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

test('rendering preference defaults off and restores only an explicitly enabled browser value', () => {
  for (const stored of [null, 'false', 'invalid', 'true']) {
    using f = fixture(stored)
    expect(f.toggles.map(toggle => toggle.checked)).toEqual([stored === 'true', stored === 'true'])
    expect(f.viewport.setAutoSimplifyRendering).toHaveBeenCalledWith(stored === 'true')
    expect(f.storage.setItem).not.toHaveBeenCalled()
  }
})

test('both editors sync and persist without document/save routing or monitor coupling; cleanup removes routing', () => {
  using f = fixture()
  f.toggles[0].checked = true
  f.input(f.toggles[0])
  expect(f.toggles.map(toggle => toggle.checked)).toEqual([true, true])
  expect(f.values.get(key)).toBe('true')
  f.dispose()
  const dispose = f.mount()
  f.toggles[1].checked = false
  f.input(f.toggles[1])
  expect(f.toggles.map(toggle => toggle.checked)).toEqual([false, false])
  expect(f.values.get(key)).toBe('false')
  expect(f.viewport.setAutoSimplifyRendering.mock.calls.map(([value]) => value)).toEqual([false, true, true, false])
  expect(f.save).not.toHaveBeenCalled()
  f.input(new InputStub('[data-performance-monitor]'))
  expect(f.save).toHaveBeenCalledTimes(1)
  expect(f.values.get('voxel-studio-performance-monitor')).toBe('true')
  expect(f.storage.setItem).toHaveBeenCalledTimes(2)
  dispose()
  f.toggles[0].checked = true
  f.input(f.toggles[0])
  expect(f.viewport.setAutoSimplifyRendering).toHaveBeenCalledTimes(4)
  expect(f.storage.setItem).toHaveBeenCalledTimes(2)
})

test('storage access, read, and write failures retain a synced session preference', () => {
  for (const denied of ['access', 'read', 'write'] as const) {
    using f = fixture(null, denied)
    for (const enabled of [true, false, true]) {
      f.toggles[1].checked = enabled
      f.input(f.toggles[1])
      expect(f.toggles.map(toggle => toggle.checked)).toEqual([enabled, enabled])
      expect(f.viewport.setAutoSimplifyRendering).toHaveBeenLastCalledWith(enabled)
    }
    expect(f.save).not.toHaveBeenCalled()
  }
})
