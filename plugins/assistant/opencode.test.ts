import { expect, mock, spyOn, test } from 'bun:test'
import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import plugin from './opencode'

test('canvas execute attaches each named inspection PNG without base64 in output and preserves capture', async () => {
  const hooks = await plugin({} as PluginInput)
  const context: ToolContext = {
    sessionID: 'session', messageID: 'message', agent: 'canvas-assistant', directory: '.', worktree: '.',
    abort: new AbortController().signal, metadata() {}, async ask() {},
  }
  const images = [
    { name: 'front', width: 32, height: 16, mime: 'image/png', dataBase64: 'ZnJvbnQ=', direction: '+Z (max z)', pixelAxes: 'u=x, v=Y-1-y' },
    { name: 'iso-back-left', width: 512, height: 512, mime: 'image/png', dataBase64: 'aXNv', direction: '-X +Y -Z' },
  ]
  const response = { ok: true, changed: false, revision: 7, result: { revision: 7, images } }
  const mocked = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response))
  try {
    const result = await hooks.tool!.canvas.execute({ command: JSON.stringify({ type: 'view.inspect', views: images.map(image => image.name) }) }, context)
    if (typeof result === 'string') throw new Error('Expected image attachments')
    expect(result.attachments).toEqual(images.map(image => ({ type: 'file', mime: 'image/png', filename: `${image.name}.png`, url: `data:image/png;base64,${image.dataBase64}` })))
    expect(JSON.parse(result.output)).toEqual({ ...response, result: { revision: 7, images: images.map(({ dataBase64: _data, ...metadata }) => metadata) } })
    expect(result.output).not.toContain('dataBase64')
    for (const image of images) expect(result.output).not.toContain(image.dataBase64)
    const request = mocked.mock.calls[0][1]!
    expect(request.signal).toBe(context.abort)
    expect(JSON.parse(request.body as string)).toEqual({ sessionID: 'session', messageID: 'message', command: { type: 'view.inspect', views: ['front', 'iso-back-left'] } })

    mocked.mockResolvedValueOnce(Response.json({ ok: true, revision: 8, result: { mime: 'image/png', dataBase64: 'cG5n', view: { zoom: 1 }, revision: 8 } }))
    const capture = await hooks.tool!.canvas.execute({ command: '{"type":"view.capture"}' }, context)
    if (typeof capture === 'string') throw new Error('Expected capture attachment')
    expect(capture.attachments).toEqual([{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,cG5n' }])
    expect(JSON.parse(capture.output).result).toEqual({ mime: 'image/png', view: { zoom: 1 }, revision: 8 })

    const failure = { ok: false, error: { code: 'revision_conflict', message: 'Refresh state' } }
    mocked.mockResolvedValueOnce(Response.json(failure))
    expect(await hooks.tool!.canvas.execute({ command: '{"type":"view.inspect"}' }, context)).toBe(JSON.stringify(failure))
  } finally {
    mocked.mockRestore()
  }
})

test('canvas batches forward requests and metadata, preserve results, and attach distinct images even on failure', async () => {
  const hooks = await plugin({} as PluginInput)
  const metadata = mock()
  const context: ToolContext = {
    sessionID: 'session', messageID: 'message', agent: 'canvas-assistant', directory: '.', worktree: '.',
    abort: new AbortController().signal, metadata, async ask() {},
  }
  const editCommand = { type: 'document.rename', name: 'Tower' }
  const stateCommand = { type: 'state.get' }
  const edit = { ok: true, changed: true, revision: 8, result: { name: 'Tower' } }
  const state = { ok: true, changed: false, revision: 8, result: { name: 'Tower' } }
  const plainCommands = [editCommand, stateCommand]
  const plainResponse = { ok: true, results: [edit, state] }
  const mocked = spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(plainResponse))
  try {
    expect(await hooks.tool!.canvas.execute({ command: JSON.stringify(plainCommands) }, context)).toBe(JSON.stringify(plainResponse))

    const image = { name: 'front', width: 32, height: 16, mime: 'image/png', direction: '+Z (max z)', pixelAxes: 'u=x, v=Y-1-y' }
    const viewport = { mime: 'image/png', view: { zoom: 1 }, revision: 8 }
    const inspection = { ok: true, changed: false, revision: 8, result: { revision: 8, images: [{ ...image, dataBase64: 'ZnJvbnQ=' }] } }
    const capture = { ok: true, changed: false, revision: 8, result: { ...viewport, dataBase64: 'cG5n' } }
    const successfulResults = [state, inspection, capture, inspection, capture]
    const textResults = [
      state,
      { ...inspection, result: { revision: 8, images: [image] } },
      { ...capture, result: viewport },
      { ...inspection, result: { revision: 8, images: [image] } },
      { ...capture, result: viewport },
    ]
    const imageCommands = [
      stateCommand,
      { type: 'view.inspect', views: ['front'] },
      { type: 'view.capture' },
      { type: 'view.inspect', views: ['front'] },
      { type: 'view.capture' },
      editCommand,
      stateCommand,
    ]
    const failure = { ok: false, error: { code: 'revision_conflict', message: 'Refresh state' } }
    for (const response of [
      { ok: true, results: [...successfulResults, { ...edit, revision: 9 }, { ...state, revision: 9 }] },
      { ...failure, failedIndex: 5, results: [...successfulResults, failure] },
    ]) {
      mocked.mockResolvedValueOnce(Response.json(response))
      const result = await hooks.tool!.canvas.execute({ command: JSON.stringify(imageCommands) }, context)
      if (typeof result === 'string') throw new Error('Expected batch image attachments')
      expect(result.title).toBe('Canvas batch (7 commands)')
      expect(result.attachments).toEqual([
        { type: 'file', mime: 'image/png', filename: 'command-1-front.png', url: 'data:image/png;base64,ZnJvbnQ=' },
        { type: 'file', mime: 'image/png', filename: 'command-2-viewport.png', url: 'data:image/png;base64,cG5n' },
        { type: 'file', mime: 'image/png', filename: 'command-3-front.png', url: 'data:image/png;base64,ZnJvbnQ=' },
        { type: 'file', mime: 'image/png', filename: 'command-4-viewport.png', url: 'data:image/png;base64,cG5n' },
      ])
      expect(JSON.parse(result.output)).toEqual({ ...response, results: [...textResults, ...response.results.slice(5)] })
      expect(result.output).not.toContain('dataBase64')
      expect(result.output).not.toContain('ZnJvbnQ=')
      expect(result.output).not.toContain('cG5n')
    }

    expect(mocked).toHaveBeenCalledTimes(3)
    expect(metadata).toHaveBeenCalledTimes(3)
    for (const [index, command] of [plainCommands, imageCommands, imageCommands].entries()) {
      const request = mocked.mock.calls[index][1]!
      expect(request.method).toBe('POST')
      expect(request.signal).toBe(context.abort)
      expect(JSON.parse(request.body as string)).toEqual({ sessionID: 'session', messageID: 'message', command })
      expect(metadata).toHaveBeenNthCalledWith(index + 1, { title: `Canvas batch (${command.length} commands)` })
    }
  } finally {
    mocked.mockRestore()
  }
})
