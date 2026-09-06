import { createOpencodeServer } from '@opencode-ai/sdk/v2/server'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { generateCapabilityToken } from '../../scripts/relay'
import { createAssistantService } from './server'

const password = generateCapabilityToken()
const token = generateCapabilityToken()
const internalKey = generateCapabilityToken()
process.env.OPENCODE_SERVER_PASSWORD = password
process.env.OPENCODE_SERVER_USERNAME = 'opencode'
process.env.VOXEL_ASSISTANT_INTERNAL_KEY = internalKey

// Start the bridge first; the client URL is bound before the browser can connect.
let opencode: Awaited<ReturnType<typeof createOpencodeServer>> | undefined
const runtime = Promise.withResolvers<string>()
const forward: typeof fetch = Object.assign(async (request: RequestInfo | URL, init?: RequestInit) => {
  const baseURL = await runtime.promise
  const input = new Request(request, init)
  const target = new URL(input.url)
  return fetch(new Request(`${baseURL}${target.pathname}${target.search}`, input))
}, { preconnect: fetch.preconnect })
const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:1', directory: process.cwd(), headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` }, fetch: forward })
const bridge = createAssistantService(client, token, internalKey)
process.env.VOXEL_ASSISTANT_INTERNAL_URL = `http://127.0.0.1:${bridge.server.port}`
let vite: ReturnType<typeof Bun.spawn> | undefined
const startup = new AbortController()
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  startup.abort()
  runtime.reject(new Error('Assistant stopped during startup'))
  vite?.kill()
  await bridge.close()
  opencode?.close()
}
process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })

try {
  opencode = await createOpencodeServer({ hostname: '127.0.0.1', port: 0, timeout: 30_000, signal: startup.signal, config: {
    $schema: 'https://opencode.ai/config.json',
    plugin: [new URL('./opencode.ts', import.meta.url).href],
    default_agent: 'canvas-assistant',
    agent: { 'canvas-assistant': { description: 'Edit only the live voxel canvas', mode: 'primary', permission: { '*': 'deny', canvas: 'allow' } } },
    share: 'disabled', snapshot: false, autoupdate: false,
  } })
  runtime.resolve(opencode.url)
  await bridge.ready
  startup.signal.throwIfAborted()
  const tools = await client.tool.ids({}, { throwOnError: true, signal: AbortSignal.any([startup.signal, AbortSignal.timeout(15_000)]) })
  startup.signal.throwIfAborted()
  if (!tools.data.includes('canvas')) throw new Error('The Canvas Assistant OpenCode plugin did not load. Check the OpenCode logs.')
  console.log(`Assistant connection key: ${token}`)
  console.log('Open the app project menu, enable Assistant, and enter this key. It is not a model API key.')
  const { OPENCODE_SERVER_PASSWORD: _password, OPENCODE_SERVER_USERNAME: _username, VOXEL_ASSISTANT_INTERNAL_KEY: _key, VOXEL_ASSISTANT_INTERNAL_URL: _url, ...viteEnv } = process.env
  vite = Bun.spawn(['bun', 'run', 'dev', '--host', '0.0.0.0', '--strictPort', ...Bun.argv.slice(2)], {
    env: { ...viteEnv, VOXEL_ASSISTANT_PORT: String(bridge.server.port) }, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  process.exitCode = await vite.exited
} catch (error) {
  runtime.reject(error)
  console.error(error instanceof Error ? error.message : 'Assistant startup failed')
  process.exitCode = 1
} finally { await stop() }
