import { expect, test } from 'bun:test'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { createAssistantService, sameOrigin } from './server'
import { needsApproval, parseCanvasCommand, type ServerMessage } from './shared'

const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket

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

test('authenticated bridge streams edits, guards revisions, isolates calls, and stops without replay', async () => {
  let emit = (_event: unknown) => {}
  let sessionCount = 0
  let promptCount = 0
  let aborted = false
  let finishPrompt = () => {}
  const started = Promise.withResolvers<void>()
  let upstreamMessageID = ''
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const path = new URL(request.url).pathname
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
  const bridge = createAssistantService(createOpencodeClient({ baseUrl: `http://127.0.0.1:${upstream.port}` }), 'browser-test-key', 'internal-test-key')
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
    expect((await fetch(`${origin}/__assistant/socket`, { headers: { origin: 'https://attacker.test' } })).status).toBe(403)
    const rejected = new Socket(url, { headers: { origin } })
    const rejectedCode = new Promise<number>(resolve => { rejected.onclose = event => resolve(event.code) })
    rejected.onopen = () => rejected.send(JSON.stringify({ type: 'auth', token: 'wrong' }))
    expect(await rejectedCode).toBe(4401)
    expect(sessionCount).toBe(0)

    socket = new Socket(url, { headers: { origin } })
    socket.onmessage = event => inbox.push(JSON.parse(String(event.data)))
    await new Promise<void>(resolve => { socket!.onopen = () => { socket!.send(JSON.stringify({ type: 'auth', token: 'browser-test-key' })); resolve() } })
    await next('ready')
    socket.send(JSON.stringify({ type: 'prompt', text: 'Build a tower' }))
    const run = await next('run') as Extract<ServerMessage, { type: 'run' }>
    const initial = await next('command') as Extract<ServerMessage, { type: 'command' }>
    expect(initial.command.type).toBe('state.get')
    socket.send(JSON.stringify({ type: 'result', runID: run.runID, id: initial.id, response: { ok: true, revision: 7, result: {} } }))
    await started.promise
    expect(upstreamMessageID).toStartWith('msg_')
    expect(await next('part')).toMatchObject({ text: 'Building' })
    expect(await next('part')).toMatchObject({ text: 'Building a tower' })

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
