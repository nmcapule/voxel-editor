import { gzip } from 'node:zlib'
import { defineConfig, minify } from 'vite'

export function acceptsGzip(header = '') {
  let wildcard = 0
  let explicit: number | undefined
  for (const value of header.toLowerCase().split(',')) {
    const [name, ...parameters] = value.trim().split(';')
    const quality = Number(parameters.find(parameter => parameter.trim().startsWith('q='))?.split('=')[1] ?? 1)
    if (name === 'gzip') explicit = Number.isFinite(quality) ? quality : 0
    if (name === '*') wildcard = Number.isFinite(quality) ? quality : 0
  }
  return (explicit ?? wildcard) > 0
}

export default defineConfig({
  define: { 'import.meta.env.VITE_CANVAS_ASSISTANT': JSON.stringify(process.env.VOXEL_ASSISTANT_PORT ? 'true' : 'false') },
  plugins: [{
    name: 'minify-dev-bundles',
    apply: 'serve',
    async renderChunk(code, chunk) {
      const result = await minify(chunk.fileName, code, { module: true, sourcemap: true })
      if (result.errors.length) this.error(result.errors[0].message)
      return { code: result.code, map: result.map }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || req.headers.range) { next(); return }
        const vary = String(res.getHeader('Vary') ?? '')
        if (vary !== '*' && !/(^|,)\s*accept-encoding\s*(,|$)/i.test(vary)) res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding')
        const end = res.end
        res.end = function (chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) {
          const type = String(res.getHeader('Content-Type') ?? '')
          const compressible = /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg\+xml)/i.test(type)
          if (chunk === undefined || res.headersSent || !compressible || [204, 205, 206, 304].includes(res.statusCode) || res.hasHeader('Content-Encoding')) {
            return end.call(res, chunk as never, encoding as never, callback)
          }
          if (!acceptsGzip(req.headers['accept-encoding'])) return end.call(res, chunk as never, encoding as never, callback)
          const done = typeof encoding === 'function' ? encoding : callback
          const input = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string'
            ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined) : Buffer.from(chunk as Uint8Array)
          if (input.byteLength < 1024) return end.call(res, chunk as never, encoding as never, callback)
          gzip(input, (error, compressed) => {
            if (error) { end.call(res, chunk as never, encoding as never, callback); return }
            res.setHeader('Content-Encoding', 'gzip')
            res.setHeader('Content-Length', compressed.byteLength)
            end.call(res, compressed, done as never)
          })
          return res
        } as typeof res.end
        next()
      })
    },
  }],
  experimental: {
    bundledDev: true,
  },
  server: {
    allowedHosts: ['.exe.xyz'],
    // Vite preview inherits server.proxy. Preserve Host and browser Origin for the API's origin check.
    proxy: {
      ...(process.env.VOXEL_MODEL_PORT ? {
        '^/api/models(?:[/?]|$)': { target: `http://127.0.0.1:${process.env.VOXEL_MODEL_PORT}`, changeOrigin: false },
        '^/api/scenes(?:[/?]|$)': { target: `http://127.0.0.1:${process.env.VOXEL_MODEL_PORT}`, changeOrigin: false },
      } : {}),
      ...(process.env.VOXEL_ASSISTANT_PORT ? {
        '^/__assistant/socket$': { target: `http://127.0.0.1:${process.env.VOXEL_ASSISTANT_PORT}`, ws: true },
      } : {}),
    },
  },
})
