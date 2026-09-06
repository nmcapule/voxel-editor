import css from './style.css?inline'
import { StudioCommandError } from '../../src/studio'
import { isInspection, needsApproval, parseCanvasCommand, type AssistantHost, type AssistantModel, type ClientMessage, type ServerMessage, type ToolResponse } from './shared'

export function mountAssistant(host: AssistantHost): () => void {
  const lifetime = new AbortController()
  const modelStorageKey = 'voxel-assistant-model'
  let modelChoice = ''
  try { modelChoice = localStorage.getItem(modelStorageKey) ?? '' } catch { /* Keep model choice in memory if storage is disabled. */ }
  const modelKey = (model: { providerID: string; modelID: string }) => JSON.stringify([model.providerID, model.modelID])
  const style = document.createElement('style')
  style.dataset.voxelAssistant = ''
  style.textContent = css
  document.head.append(style)

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function button(text: string, className = '') {
    const node = element('button', className, text)
    node.type = 'button'
    return node
  }

  const toggle = button('Enable assistant', 'voxel-assistant-toggle')
  toggle.setAttribute('role', 'menuitemcheckbox')
  toggle.setAttribute('aria-checked', 'false')
  host.menu.append(toggle)
  let disable: (() => void) | undefined
  // Keep the queue across disable/re-enable, so an aborting host task cannot overlap a new one.
  let commands = Promise.resolve()

  function enable() {
    if (disable || lifetime.signal.aborted) return
    const panelLifetime = new AbortController()
    const events = { signal: panelLifetime.signal }
    const root = element('div', 'voxel-assistant')
    const panel = element('aside', 'assistant-panel')
    panel.setAttribute('aria-label', 'Canvas assistant')
    const launcher = button('Assistant', 'assistant-launcher')
    launcher.hidden = true
    launcher.setAttribute('aria-expanded', 'false')
    launcher.setAttribute('aria-live', 'polite')
    const header = element('header', 'assistant-header')
    const heading = element('div', 'assistant-heading')
    const status = element('p', 'assistant-status', 'Not connected')
    status.setAttribute('role', 'status')
    heading.append(element('h2', '', 'Canvas assistant'), status)
    const collapse = button('Collapse', 'assistant-quiet')
    header.append(heading, collapse)
    const body = element('div', 'assistant-body')
    const notice = element('p', 'assistant-notice')
    notice.setAttribute('role', 'alert')
    notice.hidden = true

    const reconnect = button('Reconnect', 'assistant-reconnect')
    reconnect.hidden = true

    const approval = element('section', 'assistant-approval')
    approval.setAttribute('aria-label', 'Approve canvas change')
    approval.hidden = true
    const approvalTitle = element('h3', '', 'Approve canvas change?')
    const approvalNote = element('p', 'assistant-note')
    const approvalRevision = element('p', 'assistant-revision')
    const approvalJSON = element('pre', 'assistant-command')
    const approve = button('Approve change', 'assistant-primary')
    const cancel = button('Cancel')
    const approvalActions = element('div', 'assistant-actions')
    approvalActions.append(cancel, approve)
    approval.append(approvalTitle, approvalNote, approvalRevision, approvalJSON, approvalActions)

    const empty = element('p', 'assistant-empty', 'Ask for a canvas change, then follow up here. Replacing the model, resizing, and deleting layers require approval.')
    const shortened = element('p', 'assistant-note', 'Showing recent activity only.')
    shortened.hidden = true
    const activity = element('ol', 'assistant-activity')
    activity.setAttribute('role', 'log')
    activity.setAttribute('aria-label', 'Conversation activity')
    activity.setAttribute('aria-live', 'off')
    activity.tabIndex = 0
    activity.hidden = true
    const composer = element('form', 'assistant-composer')
    composer.id = 'assistant-message-form'
    const modelLabel = element('label', 'assistant-label', 'AI model')
    const modelSelect = element('select', '')
    modelSelect.setAttribute('aria-describedby', 'assistant-model-note')
    modelLabel.append(modelSelect)
    const modelNote = element('p', 'assistant-note', 'Connected models with tools and image support. Applies to your next message.')
    modelNote.id = 'assistant-model-note'
    const promptLabel = element('label', 'assistant-label', 'Message')
    const prompt = element('textarea', '')
    prompt.rows = 3
    prompt.maxLength = 8000
    prompt.placeholder = 'Describe a change to your canvas'
    promptLabel.append(prompt)
    const count = element('span', 'assistant-count', '0 / 8,000')
    const send = button('Send', 'assistant-primary')
    send.type = 'submit'
    send.setAttribute('form', composer.id)
    const stop = button('Stop')
    const sendActions = element('div', 'assistant-actions')
    sendActions.append(count, stop, send)
    composer.append(modelLabel, modelNote, promptLabel)
    const footer = element('footer', 'assistant-footer')
    const newConversation = button('New conversation', 'assistant-quiet')
    const disableButton = button('Disable', 'assistant-quiet')
    footer.append(sendActions, newConversation, disableButton)
    body.append(notice, reconnect, approval, empty, shortened, activity, composer)
    panel.append(header, body, footer)
    root.append(panel, launcher)
    host.root.append(root)
    toggle.setAttribute('aria-checked', 'true')

    type Run = { id?: string; controller: AbortController; lastActivity: number; stoppedAt?: number; seen: Set<string>; queued: number }
    let run: Run | undefined
    let socket: WebSocket | undefined
    let socketLifetime: AbortController | undefined
    let heartbeat: number | undefined
    let ready = false
    let models: AssistantModel[] = []
    let resettingAt: number | undefined
    let settleApproval: ((accepted: boolean) => void) | undefined
    const seenRuns = new Set<string>()
    const parts = new Map<string, { node: HTMLLIElement; content: HTMLElement; kind: string }>()

    function render() {
      const busy = !!run || resettingAt !== undefined
      send.disabled = !ready || busy || !modelSelect.value || !prompt.value.trim() || prompt.value.length > 8000
      modelSelect.disabled = !ready || busy || !models.length
      stop.disabled = !run || run.controller.signal.aborted
      newConversation.disabled = !ready || busy || !models.length
      reconnect.hidden = !!socket && !(ready && !models.length)
      composer.hidden = !ready
      sendActions.hidden = !ready
      count.textContent = `${prompt.value.length.toLocaleString('en-US')} / 8,000`
      launcher.textContent = settleApproval ? 'Approval needed' : busy ? 'Assistant working' : 'Assistant'
      launcher.setAttribute('aria-label', `${launcher.textContent}. Expand assistant`)
    }

    function report(message: string) {
      notice.textContent = message.slice(0, 2048)
      notice.hidden = !message
    }

    function addActivity(kind: string, text: string, id?: string) {
      const atBottom = activity.scrollHeight - activity.scrollTop - activity.clientHeight < 48
      let entry = id === undefined ? undefined : parts.get(id)
      if (!entry) {
        const node = element('li', 'assistant-entry')
        node.dataset.kind = kind
        const content = element('p', 'assistant-entry-text')
        const label = kind === 'user' ? 'You' : kind === 'text' ? 'Assistant' : kind === 'reasoning' ? 'Reasoning' : kind === 'tool' ? 'Tool activity' : 'Status'
        if (kind === 'reasoning' || kind === 'tool') {
          const details = element('details', '')
          details.append(element('summary', '', label), content)
          node.append(details)
        } else node.append(element('strong', 'assistant-entry-label', label), content)
        entry = { node, content, kind }
        activity.append(node)
        if (id !== undefined) parts.set(id, entry)
      }
      const limit = kind === 'tool' ? 4096 : kind === 'reasoning' ? 8192 : 16384
      // Stream events replace the whole part; they are not text deltas.
      entry.content.textContent = text.length > limit ? `${text.slice(0, limit)}\n[Display shortened]` : text
      if (kind === 'tool') entry.node.querySelector('summary')!.textContent = text.split('\n')[0].slice(0, 100) || 'Tool activity'
      while (activity.childElementCount > 80) {
        const oldest = activity.firstElementChild!
        oldest.remove()
        for (const [partID, part] of parts) if (part.node === oldest) parts.delete(partID)
        shortened.hidden = false
      }
      empty.hidden = true
      activity.hidden = false
      if (atBottom) activity.scrollTop = activity.scrollHeight
    }

    function closeSocket() {
      const current = socket
      run?.controller.abort()
      if (current && current.readyState === current.OPEN && run?.id) {
        try { current.send(JSON.stringify({ type: 'stop', runID: run.id } satisfies ClientMessage)) } catch { /* Closing below also stops the server session. */ }
      }
      run = undefined
      ready = false
      resettingAt = undefined
      window.clearInterval(heartbeat)
      heartbeat = undefined
      socketLifetime?.abort()
      socketLifetime = undefined
      socket = undefined
      seenRuns.clear()
      if (current && current.readyState < current.CLOSING) current.close()
    }

    function disconnected(message: string) {
      closeSocket()
      status.textContent = 'Not connected'
      report(message)
      addActivity('status', message)
      render()
    }

    function transmit(message: ClientMessage) {
      try {
        if (!socket || socket.readyState !== socket.OPEN) throw new Error('Socket is not open')
        socket.send(JSON.stringify(message))
        return true
      } catch {
        disconnected('Connection lost. Local work stopped; completed edits remain. Reconnect to start a new conversation. Nothing is replayed.')
        return false
      }
    }

    function requestApproval(command: ReturnType<typeof parseCanvasCommand>, ifRevision: number | undefined, signal: AbortSignal) {
      signal.throwIfAborted()
      approvalNote.textContent = command.type === 'document.new' ? 'This replaces the current model. Review the exact command before approving.' : command.type === 'document.resize' ? 'This can remove voxels outside the new bounds. Approval permits cropping.' : 'This deletes the layer, including any voxels it contains.'
      approvalRevision.textContent = ifRevision === undefined ? 'No revision guard was supplied.' : `Required canvas revision: ${ifRevision}`
      approvalJSON.textContent = JSON.stringify({ command, ifRevision: ifRevision ?? null }, null, 2)
      approval.hidden = false
      status.textContent = 'Approval needed'
      body.scrollTop = 0
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          window.clearTimeout(timeout)
          signal.removeEventListener('abort', aborted)
          settleApproval = undefined
          approval.hidden = true
          approvalJSON.textContent = ''
          status.textContent = signal.aborted ? 'Stopping' : 'Working'
          render()
          if (error) reject(error)
          else resolve()
        }
        const aborted = () => finish(new DOMException('Run stopped', 'AbortError'))
        const timeout = window.setTimeout(() => finish(new StudioCommandError('approval_timeout', 'Approval timed out after 60 seconds. No command was executed.')), 60_000)
        settleApproval = accepted => finish(accepted ? undefined : new StudioCommandError('approval_denied', 'The user declined this command.'))
        signal.addEventListener('abort', aborted, { once: true })
        render()
      })
    }

    function renderingOpportunity(signal: AbortSignal) {
      return new Promise<void>(resolve => {
        let frame = 0
        const finish = () => {
          cancelAnimationFrame(frame)
          window.clearTimeout(timeout)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        // Two frames allow paint between them; a background tab must not block acknowledgements.
        const timeout = window.setTimeout(finish, 200)
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish) })
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
      })
    }

    function enqueue(message: Extract<ServerMessage, { type: 'command' }>, current: Run) {
      if (current.seen.has(message.id)) return
      if (current.seen.size >= 2048 || current.queued >= 32) {
        disconnected('Assistant command limit exceeded. Local work stopped. Reconnect to start a new conversation.')
        return
      }
      current.seen.add(message.id)
      current.queued++
      const signal = current.controller.signal
      const active = () => run === current && !signal.aborted && !panelLifetime.signal.aborted
      commands = commands.then(async () => {
        if (!active()) return
        let response: ToolResponse
        try {
          if (message.ifRevision !== undefined && (!Number.isSafeInteger(message.ifRevision) || message.ifRevision < 0)) throw new StudioCommandError('invalid_argument', 'ifRevision must be a non-negative safe integer.')
          const command = parseCanvasCommand(message.command)
          if (!isInspection(command) && message.ifRevision === undefined) throw new StudioCommandError('invalid_argument', 'Canvas edits require a revision guard.')
          if (needsApproval(command)) {
            await requestApproval(command, message.ifRevision, signal)
            signal.throwIfAborted()
            if (command.type === 'document.resize') command.allowCrop = true
            if (command.type === 'layer.delete') command.allowNonEmpty = true
          }
          signal.throwIfAborted()
          const result = await host.execute(command, { ifRevision: message.ifRevision, signal })
          response = { ...result, ok: true }
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'execution_failed'
          const message = error instanceof Error ? error.message : 'Canvas command failed.'
          response = { ok: false, error: { code, message } }
          if (active()) addActivity('status', `${code}: ${message}`)
        }
        if (!active()) return
        await renderingOpportunity(signal)
        if (active()) transmit({ type: 'result', runID: current.id!, id: message.id, response })
      }).catch(() => {
        if (active()) disconnected('The canvas command could not be completed. Local work stopped. Reconnect to start a new conversation.')
      }).finally(() => { current.queued-- })
    }

    function connect() {
      if (socket || panelLifetime.signal.aborted) return
      report('')
      status.textContent = 'Connecting'
      const url = new URL('/__assistant/socket', location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      let current: WebSocket
      try { current = new WebSocket(url) } catch {
        disconnected('Could not open the assistant connection. Check that bun run dev:assistant is running, then reconnect.')
        return
      }
      socket = current
      socketLifetime = new AbortController()
      const socketEvents = { signal: socketLifetime.signal }
      const connectedAt = Date.now()
      let lastMessage = connectedAt
      const validID = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
      const malformed = () => disconnected('The assistant sent an invalid message. Local work stopped. Reconnect to start a new conversation.')
      current.addEventListener('open', () => {
        if (socket !== current) return
        status.textContent = 'Loading models'
      }, socketEvents)
      current.addEventListener('message', event => {
        if (socket !== current || panelLifetime.signal.aborted) return
        let message: ServerMessage
        try {
          if (typeof event.data !== 'string' || event.data.length > 1_048_576) throw new Error('Invalid message size')
          message = JSON.parse(event.data) as ServerMessage
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message')
        } catch { malformed(); return }
        lastMessage = Date.now()
        switch (message.type) {
          case 'pong': return
          case 'ready':
            if (ready) return
            if (!Array.isArray(message.models) || !message.models.every(model => model && typeof model === 'object' && ['providerID', 'modelID', 'providerName', 'name'].every(key => typeof model[key as keyof AssistantModel] === 'string' && model[key as keyof AssistantModel].length > 0)) || (message.modelsError !== undefined && typeof message.modelsError !== 'string')) { malformed(); return }
            models = message.models.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name) || a.modelID.localeCompare(b.modelID))
            modelSelect.replaceChildren(new Option(models.length ? 'Choose a model' : 'No compatible models', ''))
            {
              const groups = new Map<string, HTMLOptGroupElement>()
              for (const model of models) {
                let group = groups.get(model.providerID)
                if (!group) {
                  group = element('optgroup', '')
                  group.label = model.providerName
                  groups.set(model.providerID, group)
                  modelSelect.append(group)
                }
                group.append(new Option(model.name, modelKey(model)))
              }
              const preferred = modelChoice || (message.defaultModel ? modelKey(message.defaultModel) : '')
              modelSelect.value = models.some(model => modelKey(model) === preferred) ? preferred : ''
            }
            ready = true
            status.textContent = models.length ? 'Ready' : 'No compatible models'
            modelNote.textContent = models.length ? 'Connected models with tools and image support. Applies to your next message.' : 'Connect a provider with a tool-and-vision model in OpenCode, then reconnect here.'
            if (activity.childElementCount) addActivity('status', 'Connected to a new conversation. Earlier activity is shown for reference only; it was not sent again.')
            report(message.modelsError ?? (models.length && modelChoice && !modelSelect.value ? 'Your previous model is unavailable. Choose another model before sending.' : ''))
            render()
            return
          case 'error':
            if (typeof message.message !== 'string') { malformed(); return }
            disconnected(`Assistant error: ${message.message}. Check that bun run dev:assistant is running, then reconnect.`)
            return
          case 'reset':
            if (!ready || resettingAt === undefined || run) return
            activity.replaceChildren()
            parts.clear()
            activity.hidden = true
            empty.hidden = false
            shortened.hidden = true
            resettingAt = undefined
            status.textContent = 'Ready'
            report('')
            render()
            return
          case 'run':
            if (!validID(message.runID)) { malformed(); return }
            if (seenRuns.has(message.runID)) return
            if (!ready || !run) return
            if (run.id) {
              if (run.id !== message.runID) malformed()
              return
            }
            if (seenRuns.size >= 1024) { disconnected('This assistant session has reached its conversation limit. Reconnect to start a new session.'); return }
            seenRuns.add(message.runID)
            run.id = message.runID
            run.lastActivity = Date.now()
            if (run.controller.signal.aborted) transmit({ type: 'stop', runID: message.runID })
            else status.textContent = 'Working'
            return
          case 'done':
            if (!validID(message.runID)) { malformed(); return }
            if (!run || message.runID !== run.id) return
            if (typeof message.stopped !== 'boolean' || (message.error !== undefined && typeof message.error !== 'string')) { malformed(); return }
            {
              const stopped = message.stopped || run.controller.signal.aborted
              run.controller.abort()
              run = undefined
              status.textContent = message.error ? 'Run failed' : stopped ? 'Stopped' : 'Ready'
              if (message.error) { report(message.error); addActivity('status', `Run failed: ${message.error}`) }
              else if (stopped) addActivity('status', 'Stopped. Completed edits remain on the canvas.')
              render()
            }
            return
          case 'part':
          case 'command':
            if (!ready || !run?.id || message.runID !== run.id || run.controller.signal.aborted) return
            if (!validID(message.id)) { malformed(); return }
            run.lastActivity = Date.now()
            if (message.type === 'command') enqueue(message, run)
            else {
              if (!['text', 'reasoning', 'tool'].includes(message.kind) || typeof message.text !== 'string' || (parts.has(message.id) && parts.get(message.id)!.kind !== message.kind)) { malformed(); return }
              addActivity(message.kind, message.text, message.id)
            }
            return
          default: malformed()
        }
      }, socketEvents)
      current.addEventListener('close', event => {
        if (socket !== current) return
        disconnected(event.code === 4409 ? 'Another canvas is connected. Disable its assistant, then reconnect here.' : 'Connection closed. Local work stopped; completed edits remain. Check that bun run dev:assistant is running, then reconnect to start a new conversation without replaying commands.')
      }, socketEvents)
      current.addEventListener('error', () => {
        if (socket === current) disconnected('Assistant connection failed. Check that bun run dev:assistant is running, then reconnect. Completed edits remain.')
      }, socketEvents)
      heartbeat = window.setInterval(() => {
        const now = Date.now()
        if (now - lastMessage >= 45_000) disconnected('Assistant connection timed out. Local work stopped; completed edits remain. Reconnect to start a new conversation.')
        else if (!ready && now - connectedAt >= 20_000) disconnected('Assistant connection timed out. Check the service and reconnect.')
        else if (resettingAt !== undefined && now - resettingAt >= 15_000) disconnected('Starting a new conversation timed out. Reconnect before sending another message.')
        else if (run && (run.stoppedAt !== undefined ? now - run.stoppedAt >= 15_000 : now - run.lastActivity >= (run.id ? 120_000 : 30_000))) disconnected('The assistant did not respond in time. Local work stopped; completed edits remain. Reconnect to start a new conversation.')
        else if (current.readyState === current.OPEN) transmit({ type: 'ping' })
      }, 15_000)
      render()
    }

    function setCollapsed(collapsed: boolean) {
      const focusInside = panel.contains(document.activeElement)
      const focusLauncher = document.activeElement === launcher
      panel.hidden = collapsed
      launcher.hidden = !collapsed
      if (collapsed && focusInside) launcher.focus({ preventScroll: true })
      if (!collapsed && focusLauncher) collapse.focus({ preventScroll: true })
    }

    root.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        if (settleApproval) settleApproval(false)
        else setCollapsed(true)
      }
    }, events)
    root.addEventListener('keyup', event => event.stopPropagation(), events)
    collapse.addEventListener('click', () => setCollapsed(true), events)
    launcher.addEventListener('click', () => setCollapsed(false), events)
    disableButton.addEventListener('click', () => disable?.(), events)
    approve.addEventListener('click', () => settleApproval?.(true), events)
    cancel.addEventListener('click', () => settleApproval?.(false), events)
    prompt.addEventListener('input', render, events)
    modelSelect.addEventListener('change', () => {
      modelChoice = modelSelect.value
      try {
        if (modelChoice) localStorage.setItem(modelStorageKey, modelChoice)
        else localStorage.removeItem(modelStorageKey)
      } catch { /* The selection still works without local storage. */ }
      report('')
      render()
    }, events)
    reconnect.addEventListener('click', () => {
      if (ready && !models.length) closeSocket()
      connect()
    }, events)
    composer.addEventListener('submit', event => {
      event.preventDefault()
      const text = prompt.value.trim()
      if (!ready || run || resettingAt !== undefined || !text) return
      const model = models.find(model => modelKey(model) === modelSelect.value)
      if (!model) { report('Choose an available AI model before sending.'); return }
      if (prompt.value.length > 8000) { report('Keep each message to 8,000 characters or fewer.'); return }
      run = { controller: new AbortController(), lastActivity: Date.now(), seen: new Set(), queued: 0 }
      parts.clear()
      if (!transmit({ type: 'prompt', text, model: { providerID: model.providerID, modelID: model.modelID } })) return
      addActivity('user', text)
      prompt.value = ''
      report('')
      status.textContent = 'Starting'
      render()
    }, events)
    stop.addEventListener('click', () => {
      if (!run || run.controller.signal.aborted) return
      run.controller.abort()
      run.stoppedAt = Date.now()
      status.textContent = 'Stopping'
      addActivity('status', 'Stop requested. Local work is canceled; completed edits remain.')
      if (run.id) transmit({ type: 'stop', runID: run.id })
      render()
    }, events)
    newConversation.addEventListener('click', () => {
      if (!ready || run || resettingAt !== undefined) return
      resettingAt = Date.now()
      status.textContent = 'Starting new conversation'
      transmit({ type: 'new' })
      render()
    }, events)

    disable = () => {
      closeSocket()
      panelLifetime.abort()
      root.remove()
      parts.clear()
      prompt.value = ''
      toggle.setAttribute('aria-checked', 'false')
      disable = undefined
    }
    render()
    connect()
  }

  toggle.addEventListener('click', () => {
    if (disable) disable()
    else enable()
    host.menu.closest('details')?.removeAttribute('open')
  }, { signal: lifetime.signal })
  toggle.addEventListener('keydown', event => event.stopPropagation(), { signal: lifetime.signal })
  return () => {
    lifetime.abort()
    disable?.()
    toggle.remove()
    style.remove()
  }
}
