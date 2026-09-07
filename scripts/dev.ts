import { resolve } from 'node:path'
import { createModelServer, PROJECT_ROOT } from './model-server'

let library: ReturnType<typeof createModelServer> | undefined
let vite: ReturnType<typeof Bun.spawn> | undefined
let stopping: Promise<void> | undefined

function stop() {
  stopping ??= (async () => {
    vite?.kill('SIGTERM')
    const timeout = setTimeout(() => vite?.kill('SIGKILL'), 5000)
    timeout.unref()
    try { await Promise.all([library?.close(), vite?.exited]) }
    finally { clearTimeout(timeout) }
  })()
  return stopping
}

const interrupt = () => { process.exitCode = 130; void stop().catch(report) }
const terminate = () => { process.exitCode = 143; void stop().catch(report) }
function report(error: unknown) {
  console.error('Voxel Studio server failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
}

process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
try {
  const args = Bun.argv.slice(2)
  const preview = args[0] === '--preview'
  if (preview) args.shift()
  library = createModelServer({ port: 0, trustProxy: true, hostsValidatedByProxy: true })
  // Bun's Vite runtime hangs when restarting a connected dev server after config changes.
  vite = Bun.spawn(['node', resolve(PROJECT_ROOT, 'node_modules/vite/bin/vite.js'), ...(preview ? ['preview'] : []), ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, VOXEL_MODEL_PORT: String(library.server.port) },
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  const code = await vite.exited
  if (!stopping) process.exitCode = code
} catch (error) { report(error) }
finally {
  await stop().catch(report)
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
}
