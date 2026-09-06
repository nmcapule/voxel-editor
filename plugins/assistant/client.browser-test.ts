// Run via /plugins/assistant/check.html on the Vite dev server.
import { mountAssistant } from './client'
import type { AssistantHost, ClientMessage, ServerMessage } from './shared'

export async function runAssistantChecks() {
  const originalSocket = window.WebSocket
  const originalInterval = window.setInterval
  const originalNow = Date.now
  const originalURL = location.href
  const originalToken = sessionStorage.getItem('voxel-assistant-token')
  let now = originalNow()
  let tick = () => {}
  const sockets: TestSocket[] = []
  class TestSocket extends EventTarget {
    // Wrapped browser constructors can lose statics while instances keep their constants.
    readonly OPEN = 1
    readonly CLOSING = 2
    readyState = 0
    sent: ClientMessage[] = []
    readonly url: string | URL
    constructor(url: string | URL) { super(); this.url = url; sockets.push(this) }
    send(text: string) { this.sent.push(JSON.parse(text) as ClientMessage) }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
    receive(message: ServerMessage) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })) }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code })) }
  }
  const root = document.createElement('div')
  const menu = document.createElement('div')
  root.append(menu)
  document.body.append(root)
  const calls: { command: unknown; options: Parameters<AssistantHost['execute']>[1] }[] = []
  let release: (() => void) | undefined
  let hold = false
  const host: AssistantHost = {
    root, menu,
    async execute(command, options) {
      calls.push({ command, options })
      if (hold) await new Promise<void>(resolve => { release = resolve })
      return { revision: 7, changed: true, result: null }
    },
    subscribe: () => () => {},
  }
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Assistant check timed out')
  }
  const click = (text: string) => {
    const target = [...root.querySelectorAll('button')].find(node => node.textContent === text)
    check(target, `Missing button: ${text}`)
    target!.click()
  }
  const submit = (text: string) => {
    const textarea = root.querySelector('textarea')!
    textarea.value = text
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector('form.assistant-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  const results = (socket: TestSocket) => socket.sent.filter((message): message is Extract<ClientMessage, { type: 'result' }> => message.type === 'result')
  let dispose = () => {}
  try {
    window.WebSocket = TestSocket as unknown as typeof WebSocket
    check(window.WebSocket.OPEN === undefined && window.WebSocket.CLOSING === undefined, 'Mock must cover constructors without state constants')
    Date.now = () => now
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 15_000 && typeof handler === 'function') tick = handler as () => void
      return originalInterval(handler, timeout, ...args)
    }) as typeof window.setInterval
    sessionStorage.removeItem('voxel-assistant-token')
    history.replaceState(history.state, '', '#scene&keep=a%20b')
    dispose = mountAssistant(host)
    check(sockets.length === 0, 'Mount must not connect before enable')
    click('Enable assistant')
    check(sockets.length === 0 && root.querySelector('input[type=password]'), 'Missing key must show connection form, not connect')
    click('Disable')
    check(!root.querySelector('.voxel-assistant') && menu.children.length === 1, 'Disable must retain only the menu entry')
    dispose()

    history.replaceState(history.state, '', '#scene&assistant=test-key&keep=a%20b')
    dispose = mountAssistant(host)
    check(location.hash === '#scene&keep=a%20b', 'Token removal must preserve unrelated hash bytes')
    check(sessionStorage.getItem('voxel-assistant-token') === 'test-key', 'Key must be stored in the tab session')
    const socket = sockets.at(-1)!
    const url = new URL(socket.url)
    check(url.host === location.host && url.pathname === '/__assistant/socket' && url.protocol === (location.protocol === 'https:' ? 'wss:' : 'ws:') && !url.search && !url.hash, 'Socket must be same-origin without a key in the URL')
    check(socket.sent.length === 0, 'Authentication must wait for socket open')
    socket.open()
    check(socket.sent[0]?.type === 'auth' && socket.sent[0].token === 'test-key', 'Socket open must authenticate')
    submit('Build a cube')
    check(!socket.sent.some(message => message.type === 'prompt'), 'Prompt must wait for ready')
    socket.receive({ type: 'ready' })
    socket.receive({ type: 'command', runID: 'unrequested', id: 'unsafe', command: { type: 'state.get' } })
    check(calls.length === 0, 'Commands without a run must not execute')
    submit('Build a cube')
    socket.receive({ type: 'run', runID: 'r1' })
    socket.receive({ type: 'part', runID: 'r1', id: 'p1', kind: 'text', text: 'First' })
    socket.receive({ type: 'part', runID: 'r1', id: 'p1', kind: 'text', text: '<img src=x onerror=alert(1)> Replacement' })
    check(root.querySelectorAll('[data-kind=text]').length === 1 && !root.querySelector('img'), 'Stream parts must replace by ID and render literal text')
    check(!root.querySelector('[data-kind=text]')!.textContent!.includes('First'), 'Full replacement must not append deltas')
    socket.receive({ type: 'part', runID: 'r1', id: 'reason', kind: 'reasoning', text: 'A plan' })
    check(root.querySelector('[data-kind=reasoning] details:not([open])'), 'Reasoning must be a collapsed native disclosure')

    hold = true
    socket.receive({ type: 'command', runID: 'r1', id: 'c1', command: { type: 'state.get' }, ifRevision: 7 })
    socket.receive({ type: 'command', runID: 'r1', id: 'c2', command: { type: 'view.get' }, ifRevision: 7 })
    await waitFor(() => calls.length === 1)
    check(calls[0].options.ifRevision === 7 && results(socket).length === 0, 'Revision and unresolved execution must be preserved')
    hold = false
    release!()
    await waitFor(() => results(socket).length === 2)
    check(calls.length === 2 && results(socket).every(message => message.response.ok), 'Commands must serialize and acknowledge their results')
    socket.receive({ type: 'command', runID: 'r1', id: 'c2', command: { type: 'view.get' } })
    check(calls.length === 2, 'Duplicate command IDs must not execute twice')

    click('Collapse')
    socket.receive({ type: 'command', runID: 'r1', id: 'crop', command: { type: 'document.resize', dimensions: { x: 16, y: 16, z: 16 }, anchor: 'origin', allowCrop: true }, ifRevision: 7 })
    await waitFor(() => !root.querySelector<HTMLElement>('.assistant-approval')!.hidden)
    check(root.querySelector('.assistant-launcher')!.textContent === 'Approval needed' && root.querySelector('.assistant-launcher')!.getAttribute('aria-live') === 'polite', 'Collapsed approval must be visible and announced')
    click('Approval needed')
    check(calls.length === 2 && root.querySelector('.assistant-command')!.textContent!.includes('"allowCrop": false'), 'Server permission flags must not bypass frontend approval')
    click('Cancel')
    await waitFor(() => results(socket).length === 3)
    const denied = results(socket).at(-1)!.response
    check(!denied.ok && denied.error.code === 'approval_denied', 'Cancel must return an explicit error without executing')
    socket.receive({ type: 'command', runID: 'r1', id: 'delete', command: { type: 'layer.delete', id: 2, allowNonEmpty: true }, ifRevision: 7 })
    await waitFor(() => !root.querySelector<HTMLElement>('.assistant-approval')!.hidden)
    click('Approve change')
    await waitFor(() => results(socket).length === 4)
    check((calls[2].command as { allowNonEmpty: boolean }).allowNonEmpty === true && calls[2].options.ifRevision === 7, 'Only local approval may authorize deletion, with the received revision')
    socket.receive({ type: 'command', runID: 'r1', id: 'waiting', command: { type: 'layer.delete', id: 2 }, ifRevision: 7 })
    await waitFor(() => !root.querySelector<HTMLElement>('.assistant-approval')!.hidden)
    socket.receive({ type: 'command', runID: 'r1', id: 'queued', command: { type: 'state.get' } })
    click('Stop')
    check(root.querySelector<HTMLElement>('.assistant-approval')!.hidden, 'Stop must immediately settle approval')
    check(socket.sent.some(message => message.type === 'stop' && message.runID === 'r1'), 'Stop must send the run ID')
    socket.receive({ type: 'part', runID: 'r1', id: 'late', kind: 'text', text: 'DO NOT DISPLAY' })
    socket.receive({ type: 'done', runID: 'r1', stopped: true })
    submit('Follow up')
    socket.receive({ type: 'run', runID: 'r1' })
    socket.receive({ type: 'command', runID: 'r1', id: 'late-command', command: { type: 'state.get' } })
    socket.receive({ type: 'run', runID: 'r2' })
    hold = true
    socket.receive({ type: 'command', runID: 'r2', id: 'held', command: { type: 'state.get' } })
    await waitFor(() => calls.length === 4)
    check(!root.textContent!.includes('DO NOT DISPLAY') && sockets.length === 1, 'Late events must be ignored; followups must reuse the socket')
    click('Stop')
    check(calls[3].options.signal.aborted, 'Stop must abort the signal passed through to the host immediately')
    socket.receive({ type: 'done', runID: 'r2', stopped: true })
    submit('Another change')
    socket.receive({ type: 'run', runID: 'r3' })
    socket.receive({ type: 'command', runID: 'r3', id: 'after-held', command: { type: 'state.get' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    check(calls.length === 4, 'A later run must not overlap an aborting host command')
    hold = false
    release!()
    await waitFor(() => results(socket).some(message => message.id === 'after-held'))
    check(!results(socket).some(message => ['held', 'waiting', 'queued', 'late-command'].includes(message.id)), 'Canceled and late commands must not be acknowledged as completed')
    socket.receive({ type: 'done', runID: 'r3', stopped: false })
    click('New conversation')
    check(socket.sent.at(-1)?.type === 'new' && root.querySelectorAll('.assistant-entry').length > 0, 'New must wait for reset before clearing activity')
    socket.receive({ type: 'reset' })
    check(root.querySelectorAll('.assistant-entry').length === 0, 'Reset must clear activity')

    submit('Bounded activity')
    socket.receive({ type: 'run', runID: 'r4' })
    for (let index = 0; index < 100; index++) socket.receive({ type: 'part', runID: 'r4', id: `part-${index}`, kind: 'tool', text: 'x'.repeat(20_000) })
    check(root.querySelectorAll('.assistant-entry').length === 80 && root.querySelector('[data-kind=tool] p')!.textContent!.length < 4200, 'Transcript nodes and tool text must be bounded')
    let shortcuts = 0
    const shortcut = () => { shortcuts++ }
    document.addEventListener('keydown', shortcut)
    try {
      root.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      check(shortcuts === 0 && root.querySelector<HTMLElement>('.assistant-panel')!.hidden, 'Panel Escape must collapse without triggering editor shortcuts')
    } finally { document.removeEventListener('keydown', shortcut) }
    check(root.querySelector('.assistant-launcher')!.textContent === 'Assistant working', 'Collapsed state must report ongoing work')
    now += 15_000
    tick()
    check(socket.sent.at(-1)?.type === 'ping', 'Heartbeat must send ping')
    now += 46_000
    tick()
    check(socket.readyState === 3 && !root.querySelector<HTMLElement>('.assistant-reconnect')!.hidden, 'Missing heartbeat must fail closed and offer reconnect')
    const teardownStop = socket.sent.at(-1)
    check(teardownStop?.type === 'stop' && teardownStop.runID === 'r4', 'Teardown must send Stop before closing an open socket')
    click('Reconnect')
    const replacement = sockets.at(-1)!
    replacement.open()
    replacement.receive({ type: 'ready' })
    check(replacement.sent.length === 1 && replacement.sent[0].type === 'auth', 'Reconnect must not replay prompts or commands')
    replacement.close(1008)
    check(!sessionStorage.getItem('voxel-assistant-token') && !root.querySelector<HTMLElement>('.assistant-connection')!.hidden, 'Rejected authentication must remove the stored key')
    dispose()
    check(!root.querySelector('.voxel-assistant') && menu.children.length === 0 && !document.querySelector('style[data-voxel-assistant]'), 'Dispose must remove all owned UI and styles')
    const count = sockets.length
    tick()
    check(sockets.length === count, 'Disposed timers must not reconnect')
    return 'Assistant browser checks passed: lifecycle, auth, session reuse, stream bounds, approval, revision, serialization, cancellation, keyboard isolation, heartbeat, reconnect, cleanup.'
  } finally {
    release?.()
    dispose()
    root.remove()
    window.WebSocket = originalSocket
    window.setInterval = originalInterval
    Date.now = originalNow
    history.replaceState(history.state, '', originalURL)
    if (originalToken === null) sessionStorage.removeItem('voxel-assistant-token')
    else sessionStorage.setItem('voxel-assistant-token', originalToken)
  }
}
