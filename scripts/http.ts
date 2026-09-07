export const MAX_REQUEST_BYTES = 100 * 1024 * 1024

export const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'Tags must be an array of strings.')
  const tags = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || /[\p{Cc},]/u.test(entry)) throw new HttpError(400, 'Each tag must be text without commas or control characters.')
    const tag = entry.trim().toLowerCase()
    if (tag.length > 40) throw new HttpError(400, 'Each tag must be at most 40 characters.')
    if (tag) tags.add(tag)
    if (tags.size > 20) throw new HttpError(400, 'Use at most 20 distinct tags.')
  }
  return [...tags]
}

export async function readBody(request: Request, limit: number, subject = 'model') {
  const tooLarge = () => new HttpError(413, `The ${subject} request is too large. The limit is ${limit / 1024 / 1024} MiB.`)
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw tooLarge()
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(400, `Send the ${subject} as application/json.`)
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw new HttpError(400, 'Send uncompressed JSON; encoded request bodies are not supported.')
  if (!request.body) throw new HttpError(400, 'A JSON body containing snapshot and tags is required.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        void reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  let input: unknown
  try { input = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
  catch { throw new HttpError(400, 'The request body must be valid JSON.') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'The request body must be an object containing snapshot and tags.')
  return input as Record<string, unknown>
}
