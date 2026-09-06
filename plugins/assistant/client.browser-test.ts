// Run via /plugins/assistant/check.html on the Vite dev server.
import { mountAssistant } from './client'
import type { AssistantHost, ClientMessage, ServerMessage } from './shared'

export async function runAssistantChecks() {
  const originalSocket = window.WebSocket
  const originalInterval = window.setInterval
  const originalNow = Date.now
  const originalURL = location.href
  const originalModel = localStorage.getItem('voxel-assistant-model')
  const defaultModel = { providerID: 'beta', modelID: 'vision' }
  const secondModel = { providerID: 'alpha', modelID: 'vision' }
  const defaultValue = JSON.stringify([defaultModel.providerID, defaultModel.modelID])
  const secondValue = JSON.stringify([secondModel.providerID, secondModel.modelID])
  const ready: Extract<ServerMessage, { type: 'ready' }> = {
    type: 'ready',
    models: [
      { ...defaultModel, providerName: 'Beta', name: 'Vision' },
      { providerID: 'alpha', modelID: 'vision-pro', providerName: 'Alpha', name: 'Vision Pro' },
      { ...secondModel, providerName: 'Alpha', name: 'Vision' },
    ],
    defaultModel,
  }
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
  const prompts = (socket: TestSocket) => socket.sent.filter((message): message is Extract<ClientMessage, { type: 'prompt' }> => message.type === 'prompt')
  const modelSelect = () => root.querySelector('select')!
  const sendButton = () => root.querySelector<HTMLButtonElement>('.assistant-footer button[type=submit]')!
  let dispose = () => {}
  try {
    window.WebSocket = TestSocket as unknown as typeof WebSocket
    check(window.WebSocket.OPEN === undefined && window.WebSocket.CLOSING === undefined, 'Mock must cover constructors without state constants')
    Date.now = () => now
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 15_000 && typeof handler === 'function') tick = handler as () => void
      return originalInterval(handler, timeout, ...args)
    }) as typeof window.setInterval
    localStorage.removeItem('voxel-assistant-model')
    dispose = mountAssistant(host)
    check(sockets.length === 0 && !root.querySelector('.voxel-assistant'), 'Mount must remain disabled before enable')
    click('Enable assistant')
    check(sockets.length === 1 && !root.querySelector('input, .assistant-connection'), 'Enable must immediately connect without key fields')
    click('Disable')
    check(sockets[0].readyState === 3 && !root.querySelector('.voxel-assistant') && menu.children.length === 1, 'Disable must close the socket and retain only the menu entry')
    dispose()

    dispose = mountAssistant(host)
    check(sockets.length === 1 && !root.querySelector('.voxel-assistant'), 'Remount must remain disabled before enable')
    click('Enable assistant')
    check(sockets.length === 2 && location.href === originalURL, 'Enable must create a socket without changing the page URL')
    const socket = sockets.at(-1)!
    const connectedCount = sockets.length
    const url = new URL(socket.url)
    check(url.host === location.host && url.pathname === '/__assistant/socket' && url.protocol === (location.protocol === 'https:' ? 'wss:' : 'ws:') && !url.search && !url.hash, 'Socket must use the same-origin endpoint without search or hash')
    check(socket.sent.length === 0, 'Connecting must not send any frames')
    socket.open()
    check(socket.sent.length === 0 && root.querySelector('.assistant-status')!.textContent === 'Loading models', 'Socket open must wait for ready without sending any frames')
    submit('Build a cube')
    check(!socket.sent.some(message => message.type === 'prompt'), 'Prompt must wait for ready')
    check(modelSelect().disabled && sendButton().disabled, 'Model and Send must be disabled before ready')
    socket.receive(ready)
    const groups = [...modelSelect().querySelectorAll('optgroup')]
    check(groups.length === 2 && groups[0].label === 'Alpha' && groups[1].label === 'Beta', 'Compatible models must be grouped by provider name')
    check(JSON.stringify(groups.map(group => [...group.querySelectorAll('option')].map(option => [option.textContent, option.value]))) === JSON.stringify([
      [['Vision', secondValue], ['Vision Pro', JSON.stringify(['alpha', 'vision-pro'])]],
      [['Vision', defaultValue]],
    ]), 'Selector must show exactly the advertised compatible models with provider-qualified values')
    check(modelSelect().value === defaultValue && !modelSelect().disabled && !sendButton().disabled, 'Server default must be selected even when it is not the first model')
    check(sendButton().form === root.querySelector('form.assistant-composer') && !!sendButton().closest('.assistant-footer'), 'Persistent Send must submit the composer from outside the scrolling body')
    socket.receive({ type: 'command', runID: 'unrequested', id: 'unsafe', command: { type: 'state.get' } })
    check(calls.length === 0, 'Commands without a run must not execute')
    submit('Build a cube')
    check(prompts(socket).length === 1 && prompts(socket)[0].text === 'Build a cube' && JSON.stringify(prompts(socket)[0].model) === JSON.stringify(defaultModel), 'Prompt must include the selected model explicitly')
    check(modelSelect().disabled && sendButton().disabled, 'Model and Send must be disabled while starting a run')
    socket.receive({ type: 'run', runID: 'r1' })
    check(modelSelect().disabled, 'Model must remain disabled during a run')
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
    check(modelSelect().disabled, 'Model must remain disabled until stopping finishes')
    check(root.querySelector<HTMLElement>('.assistant-approval')!.hidden, 'Stop must immediately settle approval')
    check(socket.sent.some(message => message.type === 'stop' && message.runID === 'r1'), 'Stop must send the run ID')
    socket.receive({ type: 'part', runID: 'r1', id: 'late', kind: 'text', text: 'DO NOT DISPLAY' })
    socket.receive({ type: 'done', runID: 'r1', stopped: true })
    check(!modelSelect().disabled, 'Model must be re-enabled after a stopped run')
    modelSelect().value = secondValue
    modelSelect().dispatchEvent(new Event('change', { bubbles: true }))
    check(localStorage.getItem('voxel-assistant-model') === secondValue, 'Model selection must persist in localStorage')
    submit('Follow up')
    check(prompts(socket).length === 2 && JSON.stringify(prompts(socket)[1].model) === JSON.stringify(secondModel) && sockets.length === connectedCount, 'Second run must use the changed model without opening another socket')
    check(modelSelect().disabled, 'Second run must disable model selection again')
    socket.receive({ type: 'run', runID: 'r1' })
    socket.receive({ type: 'command', runID: 'r1', id: 'late-command', command: { type: 'state.get' } })
    socket.receive({ type: 'run', runID: 'r2' })
    hold = true
    socket.receive({ type: 'command', runID: 'r2', id: 'held', command: { type: 'state.get' } })
    await waitFor(() => calls.length === 4)
    check(!root.textContent!.includes('DO NOT DISPLAY') && sockets.length === connectedCount, 'Late events must be ignored; followups must reuse the socket')
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
    check(!modelSelect().disabled && modelSelect().value === secondValue, 'Successful completion must re-enable and retain the selected model')
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
    check(replacement.sent.length === 0 && modelSelect().disabled && sendButton().disabled, 'Reconnect must wait for ready without sending any frames')
    replacement.receive(ready)
    check(modelSelect().value === secondValue && !modelSelect().disabled, 'Reconnect must retain the saved model instead of applying the server default')
    check(replacement.sent.length === 0, 'Reconnect must not send any frames or replay prompts or commands')
    replacement.close(1008)
    check(!root.querySelector<HTMLElement>('.assistant-reconnect')!.hidden && !root.querySelector('input, .assistant-connection') && modelSelect().disabled && sendButton().disabled, 'Disconnect must offer reconnect without key fields and block submission')
    click('Reconnect')
    const failed = sockets.at(-1)!
    failed.dispatchEvent(new Event('error'))
    check(failed.readyState === 3 && !root.querySelector<HTMLElement>('.assistant-reconnect')!.hidden && root.querySelector('.assistant-notice')!.textContent === 'Assistant connection failed. Check that bun run dev:assistant is running, then reconnect. Completed edits remain.', 'Failed connection must close the socket and offer actionable reconnect guidance')
    click('Reconnect')
    const occupied = sockets.at(-1)!
    occupied.open()
    occupied.close(4409)
    check(occupied.sent.length === 0 && !root.querySelector<HTMLElement>('.assistant-reconnect')!.hidden && root.querySelector('.assistant-notice')!.textContent === 'Another canvas is connected. Disable its assistant, then reconnect here.', 'Second socket rejection must explain how to release the connected canvas and reconnect')
    dispose()
    check(!root.querySelector('.voxel-assistant') && menu.children.length === 0 && !document.querySelector('style[data-voxel-assistant]'), 'Dispose must remove all owned UI and styles')
    const count = sockets.length
    tick()
    check(sockets.length === count, 'Disposed timers must not reconnect')

    dispose = mountAssistant(host)
    click('Enable assistant')
    const remounted = sockets.at(-1)!
    remounted.open()
    remounted.receive(ready)
    check(modelSelect().value === secondValue && localStorage.getItem('voxel-assistant-model') === secondValue, 'Remount must restore the saved model over the server default')
    submit('Use saved model')
    check(prompts(remounted).length === 1 && JSON.stringify(prompts(remounted)[0].model) === JSON.stringify(secondModel), 'Remounted prompt must send the persisted model')
    remounted.receive({ type: 'run', runID: 'saved' })
    remounted.receive({ type: 'done', runID: 'saved', stopped: false })
    remounted.close()
    click('Reconnect')
    const unavailable = sockets.at(-1)!
    unavailable.open()
    unavailable.receive({ ...ready, models: ready.models.filter(model => model.providerID !== secondModel.providerID) })
    check(modelSelect().value === '' && !modelSelect().disabled && root.querySelector('.assistant-notice')!.textContent!.includes('unavailable'), 'Unavailable saved model must require an explicit choice, not silently fall back to the default')
    submit('Must not fall back')
    check(sendButton().disabled && prompts(unavailable).length === 0 && localStorage.getItem('voxel-assistant-model') === secondValue, 'Unavailable saved model must block submission without overwriting the saved choice')
    unavailable.close()

    for (const modelsError of [undefined, 'Model discovery failed']) {
      click('Reconnect')
      const empty = sockets.at(-1)!
      empty.open()
      empty.receive({ type: 'ready', models: [], ...(modelsError ? { modelsError } : {}) })
      if (modelsError) check(!root.querySelector<HTMLElement>('.assistant-notice')!.hidden && root.querySelector('.assistant-notice')!.textContent === modelsError, 'Discovery failure must display the server error')
      submit('No model available')
      check(modelSelect().disabled && sendButton().disabled && prompts(empty).length === 0, 'Empty models or discovery failure must disable selection and block submission')
      check([...root.querySelectorAll('button')].find(button => button.textContent === 'New conversation')!.disabled, 'No models must disable New conversation and preserve the discovery status')
      check(!root.querySelector<HTMLElement>('.assistant-reconnect')!.hidden, 'Empty models or discovery failure must offer reconnect on the open socket')
      const beforeReconnect = sockets.length
      click('Reconnect')
      const recovered = sockets.at(-1)!
      check(empty.readyState === 3 && sockets.length === beforeReconnect + 1 && recovered !== empty, 'Model discovery reconnect must close the old socket and open a new one')
      recovered.open()
      recovered.receive(ready)
      check(modelSelect().value === secondValue && !modelSelect().disabled && !sendButton().disabled && prompts(recovered).length === 0, 'Successful rediscovery must restore selection and enable Send without replaying the blocked prompt')
      recovered.close()
    }
    check(location.href === originalURL, 'Assistant lifecycle must leave the page URL unchanged')
    return 'Assistant browser checks passed: lifecycle, tokenless connection, model groups/default, explicit model, model switching, persistence, unavailable models, discovery recovery, session reuse, stream bounds, approval, revision, serialization, cancellation, keyboard isolation, heartbeat, reconnect, connection failure, second canvas rejection, cleanup.'
  } finally {
    release?.()
    dispose()
    root.remove()
    window.WebSocket = originalSocket
    window.setInterval = originalInterval
    Date.now = originalNow
    if (originalModel === null) localStorage.removeItem('voxel-assistant-model')
    else localStorage.setItem('voxel-assistant-model', originalModel)
  }
}
