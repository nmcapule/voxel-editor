import { PROTOCOL, parseRequest, type RemoteRequest, type RemoteResponse } from '../editors/model/protocol'
import { StudioCommandError } from '../shared/errors'

export interface RemoteStateEvent {
  sequence: number
  revision: number
  source: 'ui' | 'renderer' | 'assistant'
  command: string
  changed: boolean
}

interface RemoteOptions {
  dispatch: (request: RemoteRequest) => Promise<{ revision: number; result: unknown }>
  revision: () => number
  subscribe: (listener: (event: RemoteStateEvent) => void) => () => void
  onStatus?: (status: 'connected' | 'disconnected' | 'error', message?: string) => void
}

const STORAGE_KEY = 'voxel-studio-relay'

function relayUrl() {
  const hash = new URLSearchParams(location.hash.slice(1))
  const supplied = hash.get('relay')
  if (supplied) {
    try { sessionStorage.setItem(STORAGE_KEY, supplied) } catch { /* The explicit URL still works for this page load. */ }
    hash.delete('relay')
    history.replaceState(null, '', `${location.pathname}${location.search}${hash.size ? `#${hash}` : ''}`)
  }
  let value = supplied
  if (!value) try { value = sessionStorage.getItem(STORAGE_KEY) } catch { /* No reconnect persistence. */ }
  if (!value) return
  const url = new URL(value)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('The scripting relay must use WebSocket.')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('The scripting relay must run on this machine.')
  return url.href
}

function responseError(id: string | null, sequence: number, revision: number, error: unknown): RemoteResponse {
  const known = error instanceof StudioCommandError
  return {
    protocol: PROTOCOL,
    id,
    sequence,
    revision,
    ok: false,
    error: {
      code: known ? error.code : 'internal_error',
      message: error instanceof Error ? error.message : 'The command could not be completed.',
      details: known ? error.details : undefined,
    },
  }
}

export function connectRemote(options: RemoteOptions) {
  let url: string | undefined
  try { url = relayUrl() }
  catch (error) {
    options.onStatus?.('error', error instanceof Error ? error.message : 'Invalid scripting relay URL.')
    return () => {}
  }
  if (!url) return () => {}

  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let attempts = 0
  let requestSequence = 0
  let responseOrder = Promise.resolve()

  const send = (value: unknown) => {
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(value))
  }
  const respond = (response: () => RemoteResponse | Promise<RemoteResponse>) => {
    responseOrder = responseOrder.then(async () => send(await response())).catch(() => {})
  }
  const unsubscribe = options.subscribe(event => send({ protocol: PROTOCOL, event: 'state.changed', ...event }))

  const open = () => {
    socket = new WebSocket(url)
    socket.addEventListener('open', () => {
      attempts = 0
      options.onStatus?.('connected')
    })
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') {
        const sequence = ++requestSequence
        respond(() => responseError(null, sequence, options.revision(), new StudioCommandError('invalid_request', 'Commands must be JSON text messages.')))
        return
      }
      let value: unknown
      try { value = JSON.parse(event.data) }
      catch {
        const sequence = ++requestSequence
        respond(() => responseError(null, sequence, options.revision(), new StudioCommandError('invalid_request', 'The command is not valid JSON.')))
        return
      }
      if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'peer') return
      const sequence = ++requestSequence
      let request: RemoteRequest
      try { request = parseRequest(value) }
      catch (error) {
        const candidate = value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined
        const id = typeof candidate === 'string' && candidate.length <= 128 ? candidate : null
        respond(() => responseError(id, sequence, options.revision(), error))
        return
      }
      const response = options.dispatch(request).then(({ revision, result }) => {
        const response: RemoteResponse = { protocol: PROTOCOL, id: request.id, sequence, revision, ok: true, result }
        return response
      }).catch(error => responseError(request.id, sequence, options.revision(), error))
      respond(() => response)
    })
    socket.addEventListener('close', () => {
      options.onStatus?.('disconnected')
      if (stopped || attempts >= 5) return
      retry = setTimeout(open, Math.min(5000, 500 * 2 ** attempts++))
    })
    socket.addEventListener('error', () => options.onStatus?.('error', 'The scripting relay connection failed.'))
  }

  open()
  return () => {
    stopped = true
    if (retry) clearTimeout(retry)
    unsubscribe()
    socket?.close()
  }
}
