import { expect, test } from 'bun:test'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { createAssistantService, sameOrigin } from './server'
import { isInspection, needsApproval, parseCanvasCommand, type ServerMessage, type ToolResponse } from './shared'

const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket
const selection = { providerID: 'connected', modelID: 'vision' }
const model = (id: string) => ({ id, name: id, status: 'active', capabilities: { toolcall: true, input: { image: true, text: true }, output: { text: true } }, options: { apiKey: 'model-secret' }, headers: { authorization: 'header-secret' } })
const catalog = () => ({
  all: [{ id: 'connected', name: 'Connected Provider', key: 'provider-secret', options: { apiKey: 'option-secret' }, models: { vision: model('vision'), other: model('other') } }],
  connected: ['connected'], default: { connected: 'other' },
})

test('canvas policy allows inspection without approval and validates view choices', () => {
  for (const input of [{ type: 'view.inspect' }, { type: 'view.inspect', views: ['front', 'iso-back-left'] }, { type: 'view.capture' }]) {
    const command = parseCanvasCommand(input)
    expect(isInspection(command)).toBe(true)
    expect(needsApproval(command)).toBe(false)
  }
  expect(() => parseCanvasCommand({ type: 'view.inspect', views: ['front', 'front'] })).toThrow('unique')
  expect(() => parseCanvasCommand({ type: 'view.inspect', views: ['invalid'] })).toThrow('command.views')
})

test('canvas policy bounds edits, requires explicit scope, and strips model approval', () => {
  expect(() => parseCanvasCommand({ type: 'history.undo' })).toThrow('not available')
  expect(() => parseCanvasCommand({ type: 'edit.paint', color: 5 })).toThrow('layerId')
  expect(() => parseCanvasCommand({ type: 'edit.paint', layerId: 1, color: 5 })).toThrow('cells')
  expect(() => parseCanvasCommand({ type: 'edit.fill', layerId: 1, shape: 'box', color: 5, min: { x: 0, y: 0, z: 0 }, max: { x: 255, y: 255, z: 255 } })).toThrow('32768')
  const resize = parseCanvasCommand({ type: 'document.resize', dimensions: { x: 16, y: 16, z: 16 }, anchor: 'origin', allowCrop: true })
  expect(resize).toHaveProperty('allowCrop', false)
  expect(needsApproval(resize)).toBe(true)
  expect(needsApproval(parseCanvasCommand({ type: 'document.new' }))).toBe(true)
  expect(sameOrigin(new Request('http://127.0.0.1:4000/__assistant/socket', { headers: { host: 'pandayan.exe.xyz:5180', origin: 'https://pandayan.exe.xyz:5180' } }))).toBe(true)
  expect(sameOrigin(new Request('http://127.0.0.1:4000/__assistant/socket', { headers: { host: '127.0.0.1:5180', 'x-forwarded-host': 'pandayan.exe.xyz', origin: 'https://pandayan.exe.xyz' } }))).toBe(true)
  expect(sameOrigin(new Request('http://127.0.0.1:4000/__assistant/socket', { headers: { host: 'pandayan.exe.xyz', origin: 'https://attacker.test' } }))).toBe(false)
  expect(sameOrigin(new Request('http://127.0.0.1:4000/__assistant/socket', { headers: { host: '127.0.0.1:5180', 'x-forwarded-host': 'pandayan.exe.xyz', origin: 'https://attacker.test' } }))).toBe(false)
})

test('same-origin bridge streams edits, guards revisions, isolates calls, and stops without replay', async () => {
  let emit = (_event: unknown) => {}
  let sessionCount = 0
  let promptCount = 0
  let aborted = false
  let finishPrompt = () => {}
  const started = Promise.withResolvers<void>()
  let upstreamMessageID = ''
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const path = new URL(request.url).pathname
    if (path === '/provider') return Response.json(catalog())
    if (path === '/config') return Response.json({})
    if (path === '/event') return new Response(new ReadableStream({ start(controller) {
      emit = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
      emit({ type: 'server.connected', properties: {} })
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (path === '/session' && request.method === 'POST') { sessionCount++; return Response.json({ id: `ses_${sessionCount}` }) }
    if (path.endsWith('/abort')) { aborted = true; finishPrompt(); return Response.json(true) }
    if (request.method === 'DELETE') return Response.json(true)
    if (path.includes('/message/msg_old')) return Response.json({ info: { role: 'assistant', parentID: 'msg_previous_run' }, parts: [] })
    if (path.endsWith('/message')) {
      promptCount++
      const body = await request.json() as { messageID: string }
      upstreamMessageID = body.messageID
      emit({ type: 'message.updated', properties: { info: { id: 'msg_reply', role: 'assistant', parentID: body.messageID, sessionID: 'ses_1' } } })
      emit({ type: 'message.part.updated', properties: { part: { id: 'part_1', sessionID: 'ses_1', messageID: 'msg_reply', type: 'text', text: 'Building' } } })
      emit({ type: 'message.part.delta', properties: { sessionID: 'ses_1', partID: 'part_1', field: 'text', delta: ' a tower' } })
      started.resolve()
      await new Promise<void>(resolve => { finishPrompt = resolve })
      return Response.json({ info: { id: 'msg_reply' }, parts: [] })
    }
    return new Response('Not found', { status: 404 })
  } })
  const bridge = createAssistantService(createOpencodeClient({ baseUrl: `http://127.0.0.1:${upstream.port}` }), 'internal-test-key')
  const origin = `http://127.0.0.1:${bridge.server.port}`
  const url = `ws://127.0.0.1:${bridge.server.port}/__assistant/socket`
  const inbox: ServerMessage[] = []
  let socket: WebSocket | undefined
  const next = async (type: ServerMessage['type']) => {
    for (let i = 0; i < 300; i++) {
      const index = inbox.findIndex(message => message.type === type)
      if (index !== -1) return inbox.splice(index, 1)[0]
      await Bun.sleep(10)
    }
    throw new Error(`Timed out waiting for ${type}`)
  }
  const tool = (sessionID: string, command: unknown, messageID = 'msg_reply') => fetch(`${origin}/tool`, { method: 'POST', headers: { authorization: 'Bearer internal-test-key', 'content-type': 'application/json' }, body: JSON.stringify({ sessionID, messageID, command }) })
  try {
    await bridge.ready
    expect((await fetch(`${origin}/tool`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${origin}/tool`, { method: 'POST', headers: { authorization: 'Bearer wrong-key' } })).status).toBe(401)
    expect((await fetch(`${origin}/__assistant/socket`, { headers: { origin: 'https://attacker.test' } })).status).toBe(403)
    expect(sessionCount).toBe(0)

    socket = new Socket(url, { headers: { origin } })
    socket.onmessage = event => inbox.push(JSON.parse(String(event.data)))
    await next('ready')
    socket.send(JSON.stringify({ type: 'prompt', text: 'Build a tower', model: selection }))
    const run = await next('run') as Extract<ServerMessage, { type: 'run' }>
    const initial = await next('command') as Extract<ServerMessage, { type: 'command' }>
    expect(initial.command.type).toBe('state.get')
    socket.send(JSON.stringify({ type: 'result', runID: run.runID, id: initial.id, response: { ok: true, revision: 7, result: {} } }))
    await started.promise
    expect(upstreamMessageID).toStartWith('msg_')
    expect(await next('part')).toMatchObject({ text: 'Building' })
    expect(await next('part')).toMatchObject({ text: 'Building a tower' })

    const rejected = new Socket(url, { headers: { origin } })
    const rejectedMessages: unknown[] = []
    const rejectedCode = new Promise<number>(resolve => { rejected.onclose = event => resolve(event.code) })
    rejected.onmessage = event => rejectedMessages.push(event.data)
    rejected.onopen = () => {
      rejected.send(JSON.stringify({ type: 'prompt', text: 'Intrude', model: selection }))
      rejected.send(JSON.stringify({ type: 'stop', runID: run.runID }))
    }
    expect(await rejectedCode).toBe(4409)
    expect(rejectedMessages).toEqual([])
    expect(sessionCount).toBe(1)
    expect(promptCount).toBe(1)
    expect(aborted).toBe(false)

    const inspect = tool('ses_1', { type: 'view.inspect', views: ['front', 'iso-front-right'] })
    const inspectCommand = await next('command') as Extract<ServerMessage, { type: 'command' }>
    expect(inspectCommand.command).toEqual({ type: 'view.inspect', views: ['front', 'iso-front-right'] })
    expect(inspectCommand.ifRevision).toBe(7)
    const inspection = { ok: true, changed: false, revision: 7, result: { revision: 7, images: [{ name: 'front', width: 16, height: 16, mime: 'image/png', dataBase64: 'cG5n', direction: '+Z (max z)', pixelAxes: 'u=x, v=Y-1-y' }] } }
    socket.send(JSON.stringify({ type: 'result', runID: run.runID, id: inspectCommand.id, response: inspection }))
    expect(await (await inspect).json()).toEqual(inspection)

    const edit = tool('ses_1', { type: 'edit.setVoxels', layerId: 1, voxels: [{ x: 1, y: 1, z: 1, color: 5 }] })
    const command = await next('command') as Extract<ServerMessage, { type: 'command' }>
    expect(command.ifRevision).toBe(7)
    socket.send(JSON.stringify({ type: 'result', runID: run.runID, id: command.id, response: { ok: false, error: { code: 'revision_conflict', message: 'User edited' } } }))
    expect(await (await edit).json()).toHaveProperty('error.code', 'revision_conflict')
    expect(await (await tool('ses_1', { type: 'document.rename', name: 'Stale' })).json()).toHaveProperty('error.code', 'revision_conflict')
    expect(await (await tool('ses_1', { type: 'view.get' })).json()).toHaveProperty('error.code', 'revision_conflict')
    expect((await tool('ses_unowned', { type: 'state.get' })).status).toBe(409)
    expect((await tool('ses_1', { type: 'state.get' }, 'msg_old')).status).toBe(409)

    const refresh = tool('ses_1', { type: 'state.get' })
    const refreshCommand = await next('command') as Extract<ServerMessage, { type: 'command' }>
    expect(refreshCommand.ifRevision).toBeUndefined()
    socket.send(JSON.stringify({ type: 'result', runID: run.runID, id: refreshCommand.id, response: { ok: true, revision: 8, result: {} } }))
    await refresh
    const pending = tool('ses_1', { type: 'document.rename', name: 'Tower' })
    const pendingCommand = await next('command') as Extract<ServerMessage, { type: 'command' }>
    expect(pendingCommand.ifRevision).toBe(8)
    socket.send(JSON.stringify({ type: 'stop', runID: run.runID }))
    expect(await (await pending).json()).toHaveProperty('error.code', 'aborted')
    expect(await next('done')).toMatchObject({ stopped: true })
    expect(aborted).toBe(true)
    expect((await tool('ses_1', { type: 'state.get' })).status).toBe(409)
    socket.send(JSON.stringify({ type: 'ping' }))
    await next('pong')
    expect(promptCount).toBe(1)
    socket.send(JSON.stringify({ type: 'new' }))
    await next('reset')
  } finally {
    socket?.close()
    finishPrompt()
    await bridge.close()
    upstream.stop(true)
  }
}, 15_000)

test('rapid upgrades admit only one canvas; unavailable service closes without discovery', async () => {
  for (const available of [true, false]) {
    const requests: string[] = []
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === '/event') return new Response(new ReadableStream({ start(controller) {
        if (available) controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
      } }), { headers: { 'content-type': 'text/event-stream' } })
      if (path === '/provider') return Response.json(catalog())
      if (path === '/config') return Response.json({})
      return new Response('Not found', { status: 404 })
    } })
    const bridge = createAssistantService(createOpencodeClient({ baseUrl: `http://127.0.0.1:${upstream.port}` }), 'internal-key')
    const origin = `http://127.0.0.1:${bridge.server.port}`
    const sockets: WebSocket[] = []
    try {
      if (available) await bridge.ready
      const outcomes = await Promise.all(Array.from({ length: available ? 6 : 1 }, () => {
        const socket = new Socket(origin.replace('http:', 'ws:') + '/__assistant/socket', { headers: { origin } })
        sockets.push(socket)
        return new Promise<{ socket: WebSocket; code?: number; reason?: string }>(resolve => {
          socket.onmessage = event => {
            if (JSON.parse(String(event.data)).type === 'ready') resolve({ socket })
          }
          socket.onclose = event => resolve({ socket, code: event.code, reason: event.reason })
        })
      }))
      if (available) {
        expect(outcomes.filter(outcome => outcome.code === undefined)).toHaveLength(1)
        expect(outcomes.filter(outcome => outcome.code === 4409)).toHaveLength(5)
        expect(requests.filter(path => path === '/provider')).toHaveLength(1)
        expect(requests.filter(path => path === '/config')).toHaveLength(1)
        const winner = outcomes.find(outcome => outcome.code === undefined)!.socket
        const pong = new Promise<string>(resolve => { winner.onmessage = event => resolve(JSON.parse(String(event.data)).type) })
        winner.send(JSON.stringify({ type: 'ping' }))
        expect(await pong).toBe('pong')
      } else {
        expect(outcomes[0]).toMatchObject({ code: 1011, reason: 'OpenCode is not available' })
        expect(requests.filter(path => path !== '/event')).toEqual([])
      }
    } finally {
      for (const socket of sockets) socket.close()
      await bridge.close()
      upstream.stop(true)
    }
  }
})

async function modelBridge(providerResponse = async () => Response.json(catalog()), configResponse = async () => Response.json({ model: 'connected/vision', secret: 'config-secret' }), pendingPrompt?: Promise<void>) {
  const requests: string[] = []
  const prompts: { path: string; body: { model: unknown; messageID: string } }[] = []
  const prompted = Promise.withResolvers<void>()
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    if (path === '/event') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (path === '/provider') return providerResponse()
    if (path === '/config') return configResponse()
    if (path === '/session' && request.method === 'POST') return Response.json({ id: 'ses_shared' })
    if (path.endsWith('/message')) {
      prompts.push({ path, body: await request.json() as { model: unknown; messageID: string } })
      prompted.resolve()
      await pendingPrompt
      return Response.json({ info: { id: `reply_${prompts.length}` }, parts: [] })
    }
    if (path.endsWith('/message/reply_1')) return Response.json({ info: { role: 'assistant', parentID: prompts[0].body.messageID }, parts: [] })
    if (request.method === 'DELETE' || path.endsWith('/abort')) return Response.json(true)
    return new Response('Not found', { status: 404 })
  } })
  const bridge = createAssistantService(createOpencodeClient({ baseUrl: `http://127.0.0.1:${upstream.port}` }), 'internal-key')
  await bridge.ready
  const origin = `http://127.0.0.1:${bridge.server.port}`
  const socket = new Socket(origin.replace('http:', 'ws:') + '/__assistant/socket', { headers: { origin } })
  const inbox: ServerMessage[] = []
  socket.onmessage = event => inbox.push(JSON.parse(String(event.data)))
  await new Promise<void>(resolve => { socket.onopen = () => resolve() })
  return {
    socket, requests, prompts, inbox, prompted: prompted.promise,
    send(message: unknown) { socket.send(JSON.stringify(message)) },
    async tool(command: unknown) {
      const response = await fetch(`${origin}/tool`, { method: 'POST', headers: { authorization: 'Bearer internal-key', 'content-type': 'application/json' }, body: JSON.stringify({ sessionID: 'ses_shared', messageID: 'reply_1', command }) })
      expect(response.status).toBe(200)
      return response.json()
    },
    async next<T extends ServerMessage['type']>(type: T, timeout = 3000) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const index = inbox.findIndex(message => message.type === type)
        if (index !== -1) return inbox.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>
        await Bun.sleep(10)
      }
      throw new Error(`Timed out waiting for ${type}`)
    },
    async close() { socket.close(); await bridge.close(); upstream.stop(true) },
  }
}

test('batches validate all inputs first, preserve returned revisions, and stop on conflicts', async () => {
  const pending = Promise.withResolvers<void>()
  const fixture = await modelBridge(undefined, undefined, pending.promise)
  try {
    await fixture.next('ready')
    fixture.send({ type: 'prompt', text: 'Build', model: selection })
    const run = await fixture.next('run')
    const respond = (command: Extract<ServerMessage, { type: 'command' }>, response: ToolResponse) => fixture.send({ type: 'result', runID: run.runID, id: command.id, response })
    respond(await fixture.next('command'), { ok: true, revision: 7, result: {} })
    await fixture.prompted

    for (const input of [[], Array(17).fill({ type: 'state.get' })]) {
      expect(await fixture.tool(input)).toEqual({ ok: false, error: { code: 'invalid_argument', message: 'Use 1 to 16 commands per batch.' }, results: [], failedIndex: null })
    }
    for (const invalid of [null, [{ type: 'state.get' }], { type: 'history.undo' }, { type: 'edit.paint', color: 5 }, { type: 'edit.setVoxels', layerId: 1, voxels: Array(4097).fill({ x: 1, y: 1, z: 1, color: 5 }) }]) {
      expect(await fixture.tool([{ type: 'document.rename', name: 'Must not execute' }, invalid])).toMatchObject({ ok: false, error: { code: 'invalid_argument' }, results: [], failedIndex: 1 })
    }
    expect(fixture.inbox.some(message => message.type === 'command')).toBe(false)

    const commands = [{ type: 'palette.setColor', index: 5, color: 15909198 }, { type: 'view.frame' }, { type: 'document.rename', name: 'Tower' }, { type: 'view.get' }] as const
    const results: ToolResponse[] = []
    const batch = fixture.tool(commands)
    let revision = 7
    for (const [index, nextRevision] of [9, 9, 12, 12].entries()) {
      const command = await fixture.next('command')
      expect(command.command).toEqual(commands[index])
      expect(command.ifRevision).toBe(revision)
      const response = { ok: true as const, revision: nextRevision, changed: nextRevision !== revision, result: { index } }
      respond(command, response)
      results.push(response)
      revision = nextRevision
    }
    expect(await batch).toEqual({ ok: true, results })

    const conflict = fixture.tool([{ type: 'view.get' }, { type: 'document.rename', name: 'Stale' }, { type: 'state.get' }])
    const inspected = { ok: true as const, revision: 12, result: {} }
    respond(await fixture.next('command'), inspected)
    const stale = await fixture.next('command')
    expect(stale.ifRevision).toBe(12)
    const failure = { ok: false as const, error: { code: 'revision_conflict', message: 'User edited' } }
    respond(stale, failure)
    expect(await conflict).toEqual({ ...failure, failedIndex: 1, results: [inspected, failure] })
    expect(await fixture.tool([{ type: 'view.get' }])).toMatchObject({ ok: false, error: { code: 'revision_conflict' }, failedIndex: 0 })
    expect(fixture.inbox.some(message => message.type === 'command')).toBe(false)

    const refreshed = fixture.tool([{ type: 'state.get' }, { type: 'document.rename', name: 'Updated' }])
    const inspect = await fixture.next('command')
    expect(inspect.command.type).toBe('state.get')
    expect(inspect.ifRevision).toBeUndefined()
    respond(inspect, { ok: true, revision: 15, result: {} })
    const rename = await fixture.next('command')
    expect(rename.ifRevision).toBe(15)
    respond(rename, { ok: true, revision: 16, result: {} })
    expect(await refreshed).toMatchObject({ ok: true, results: [{ revision: 15 }, { revision: 16 }] })
  } finally { pending.resolve(); await fixture.close() }
})

test.each(['stop', 'approval_denied'])('batches preserve individual approvals, do not interleave, and cancel queued work on %s', async action => {
  const pending = Promise.withResolvers<void>()
  const fixture = await modelBridge(undefined, undefined, pending.promise)
  try {
    await fixture.next('ready')
    fixture.send({ type: 'prompt', text: 'Build', model: selection })
    const run = await fixture.next('run')
    const respond = (command: Extract<ServerMessage, { type: 'command' }>, response: ToolResponse) => fixture.send({ type: 'result', runID: run.runID, id: command.id, response })
    respond(await fixture.next('command'), { ok: true, revision: 7, result: {} })
    await fixture.prompted

    const batch = fixture.tool([
      { type: 'document.rename', name: 'Keep this edit' },
      { type: 'document.resize', dimensions: { x: 16, y: 16, z: 16 }, anchor: 'origin', allowCrop: true },
      { type: 'layer.delete', id: 1, allowNonEmpty: true },
      { type: 'view.get' },
    ])
    const edited = { ok: true as const, revision: 8, result: { name: 'Keep this edit' } }
    respond(await fixture.next('command'), edited)
    const resize = await fixture.next('command')
    expect(resize).toMatchObject({ ifRevision: 8, command: { type: 'document.resize', allowCrop: false } })
    expect(needsApproval(resize.command)).toBe(true)

    // Overflow confirms all 16 waiting calls were admitted before releasing this command.
    const waiting = Array.from({ length: 17 }, () => fixture.tool([{ type: 'document.rename', name: 'Must not execute' }]))
    expect(await Promise.race(waiting)).toEqual({ ok: false, error: { code: 'limit_exceeded', message: 'The command queue is full.' }, results: [], failedIndex: null })
    const resized = { ok: true as const, revision: 9, result: {} }
    respond(resize, resized)
    const deletion = await fixture.next('command')
    expect(deletion).toMatchObject({ ifRevision: 9, command: { type: 'layer.delete', allowNonEmpty: false } })
    expect(needsApproval(deletion.command)).toBe(true)

    if (action === 'stop') fixture.send({ type: 'stop', runID: run.runID })
    else respond(deletion, { ok: false, error: { code: 'approval_denied', message: 'Declined' } })
    const code = action === 'stop' ? 'aborted' : 'approval_denied'
    expect(await batch).toMatchObject({ ok: false, error: { code }, failedIndex: 2, results: [edited, resized, { ok: false, error: { code } }] })
    const queuedResults = await Promise.all(waiting)
    expect(queuedResults.filter(result => result.error.code === 'limit_exceeded')).toHaveLength(1)
    const aborted = queuedResults.filter(result => result.error.code === 'aborted')
    expect(aborted).toHaveLength(16)
    for (const result of aborted) expect(result).toMatchObject({ failedIndex: 0, results: [{ ok: false, error: { code: 'aborted' } }] })
    expect(await fixture.next('done')).toMatchObject({ stopped: true })
    expect(fixture.inbox.some(message => message.type === 'command')).toBe(false)
  } finally { pending.resolve(); await fixture.close() }
})

test('each command in a batch counts toward the run limit, including initial inspection', async () => {
  const pending = Promise.withResolvers<void>()
  const fixture = await modelBridge(undefined, undefined, pending.promise)
  try {
    await fixture.next('ready')
    fixture.send({ type: 'prompt', text: 'Inspect', model: selection })
    const run = await fixture.next('run')
    const initial = await fixture.next('command')
    const response = { ok: true, revision: 7, result: {} }
    fixture.send({ type: 'result', runID: run.runID, id: initial.id, response })
    await fixture.prompted
    let executed = 0
    fixture.socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as ServerMessage
      if (message.type !== 'command') { fixture.inbox.push(message); return }
      executed++
      expect(message.command.type).toBe('view.get')
      expect(message.ifRevision).toBe(7)
      fixture.send({ type: 'result', runID: run.runID, id: message.id, response })
    }
    for (let batch = 0; batch < 8; batch++) {
      const result = await fixture.tool(Array(16).fill({ type: 'view.get' }))
      if (batch < 7) expect(result).toEqual({ ok: true, results: Array(16).fill(response) })
      else {
        expect(result).toMatchObject({ ok: false, error: { code: 'limit_exceeded' }, failedIndex: 15 })
        expect(result.results).toHaveLength(16)
        expect(result.results.slice(0, 15)).toEqual(Array(15).fill(response))
        expect(result.results[15]).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } })
      }
    }
    expect(await fixture.tool({ type: 'state.get' })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } })
    expect(executed).toBe(127)
  } finally { pending.resolve(); await fixture.close() }
})

test('connection sends ready without a client frame, filters incompatible models, and excludes secrets', async () => {
  const data = catalog()
  const models: Record<string, ReturnType<typeof model>> = data.all[0]!.models
  models.deprecated = { ...model('deprecated'), status: 'deprecated' }
  for (const capability of ['toolcall', 'image', 'inputText', 'outputText']) {
    const excluded = model(capability)
    if (capability === 'toolcall') excluded.capabilities.toolcall = false
    if (capability === 'image') excluded.capabilities.input.image = false
    if (capability === 'inputText') excluded.capabilities.input.text = false
    if (capability === 'outputText') excluded.capabilities.output.text = false
    models[capability] = excluded
  }
  data.all.push({ ...data.all[0]!, id: 'disconnected' })
  const fixture = await modelBridge(async () => Response.json(data))
  try {
    expect(await fixture.next('ready')).toEqual({ type: 'ready', models: [
      { ...selection, providerName: 'Connected Provider', name: 'vision' },
      { providerID: 'connected', modelID: 'other', providerName: 'Connected Provider', name: 'other' },
    ], defaultModel: selection })
    fixture.send({ type: 'ping' })
    await fixture.next('pong')
    expect(fixture.requests.filter(path => path === 'GET /provider')).toHaveLength(1)
    expect(fixture.inbox).toEqual([])
  } finally { await fixture.close() }
})

test('incompatible configured default falls back to provider default, then first; empty catalog is valid', async () => {
  for (const mode of ['provider', 'first', 'empty']) {
    const data = catalog()
    if (mode === 'first') data.default.connected = 'missing'
    if (mode === 'empty') data.connected = []
    const fixture = await modelBridge(async () => Response.json(data), async () => Response.json({ model: 'disconnected/vision' }))
    try {
      const ready = await fixture.next('ready')
      expect(ready.modelsError).toBeUndefined()
      expect(ready.defaultModel).toEqual(mode === 'empty' ? undefined : { providerID: 'connected', modelID: mode === 'provider' ? 'other' : 'vision' })
      if (mode === 'empty') expect(ready.models).toEqual([])
    } finally { await fixture.close() }
  }
})

test('explicit model selection is forwarded for sequential runs without replacing the session', async () => {
  const fixture = await modelBridge()
  try {
    await fixture.next('ready')
    for (const modelID of ['vision', 'other']) {
      fixture.send({ type: 'prompt', text: 'Build', model: { providerID: 'connected', modelID, options: { secret: 'must-not-forward' } } })
      const run = await fixture.next('run')
      const command = await fixture.next('command')
      fixture.send({ type: 'result', runID: run.runID, id: command.id, response: { ok: true, revision: 0, result: {} } })
      expect(await fixture.next('done')).toMatchObject({ stopped: false })
    }
    expect(fixture.requests.filter(path => path === 'POST /session')).toHaveLength(1)
    expect(fixture.prompts.map(prompt => ({ path: prompt.path, model: prompt.body.model }))).toEqual([
      { path: '/session/ses_shared/message', model: selection },
      { path: '/session/ses_shared/message', model: { providerID: 'connected', modelID: 'other' } },
    ])
  } finally { await fixture.close() }
})

test('unknown and malformed models are rejected before any run or upstream request', async () => {
  for (const requested of [undefined, null, [], 'vision', {}, { providerID: 1, modelID: 'vision' }, { providerID: 'connected', modelID: 1 }, { providerID: 'connected', modelID: 'unknown' }, { providerID: 'disconnected', modelID: 'vision' }]) {
    const fixture = await modelBridge()
    try {
      await fixture.next('ready')
      const before = [...fixture.requests]
      fixture.send({ type: 'prompt', text: 'Build', model: requested })
      expect((await fixture.next('error')).message).toContain('compatible model')
      expect(fixture.requests).toEqual(before)
      expect(fixture.inbox.some(message => message.type === 'run')).toBe(false)
    } finally { await fixture.close() }
  }
})

test('provider/config discovery failures send sanitized empty readiness', async () => {
  for (const endpoint of ['provider', 'config']) {
    const failed = async () => new Response('upstream-secret', { status: 500 })
    const fixture = await modelBridge(endpoint === 'provider' ? failed : undefined, endpoint === 'config' ? failed : undefined)
    try {
      const ready = await fixture.next('ready')
      expect(ready.models).toEqual([])
      expect(ready.defaultModel).toBeUndefined()
      expect(ready.modelsError).toContain('reconnect to retry')
      expect(JSON.stringify(ready)).not.toContain('secret')
    } finally { await fixture.close() }
  }
})

test('discovery times out within ten seconds and stays ready without models', async () => {
  const pending = Promise.withResolvers<Response>()
  const fixture = await modelBridge(() => pending.promise)
  try {
    const started = Date.now()
    const ready = await fixture.next('ready', 9500)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(ready.models).toEqual([])
    expect(ready.modelsError).toContain('reconnect to retry')
  } finally { pending.resolve(Response.json(catalog())); await fixture.close() }
}, 12_000)

test('closing during discovery never sends readiness', async () => {
  const pending = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const fixture = await modelBridge(() => { requested.resolve(); return pending.promise })
  try {
    await requested.promise
    const closed = new Promise<void>(resolve => { fixture.socket.onclose = () => resolve() })
    fixture.socket.close()
    await closed
    pending.resolve(Response.json(catalog()))
    await Bun.sleep(30)
    expect(fixture.inbox).toEqual([])
  } finally { pending.resolve(Response.json(catalog())); await fixture.close() }
})
