import { parseCommand } from '../editors/model/protocol'
import { connectRemote } from './remote'
import type { ModelCommandEvent, ModelDispatch } from '../editors/model/editor'

export function connectIntegrations(host: {
  root: HTMLElement
  menu: HTMLElement
  dispatch: ModelDispatch
  revision(): number
  subscribe(listener: (event: ModelCommandEvent & { sequence: number }) => void): () => void
  notify(message: string, tone?: 'normal' | 'warning'): void
}) {
  let disposed = false
  let disposeAssistant: (() => void) | undefined
  if (import.meta.env.VITE_CANVAS_ASSISTANT === 'true') {
    void import('../../plugins/assistant/client').then(({ mountAssistant }) => {
      if (disposed) return
      disposeAssistant = mountAssistant({
        root: host.root,
        menu: host.menu,
        execute: (command, { signal, ifRevision }) => host.dispatch(parseCommand(command), 'assistant', ifRevision, undefined, signal),
        subscribe: listener => host.subscribe(event => listener({ source: event.source, command: event.command.type, revision: event.outcome.revision, changed: event.outcome.changed })),
      })
    }).catch(() => { if (!disposed) host.notify('The optional assistant could not be loaded.', 'warning') })
  }
  const disconnectRemote = connectRemote({
    dispatch: request => host.dispatch(request.command, 'remote', request.ifRevision),
    revision: host.revision,
    subscribe: listener => host.subscribe(event => {
      if (event.source !== 'remote') listener({ sequence: event.sequence, revision: event.outcome.revision, source: event.source, command: event.command.type, changed: event.outcome.changed })
    }),
    onStatus(status, message) {
      if (disposed) return
      if (status === 'connected') host.notify('Remote scripting connected.')
      if (status === 'error' && message) host.notify(message, 'warning')
    },
  })
  return () => { disposed = true; disposeAssistant?.(); disconnectRemote() }
}
