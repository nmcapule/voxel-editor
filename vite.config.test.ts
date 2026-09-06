import { describe, expect, test } from 'bun:test'
import { acceptsGzip } from './vite.config'

describe('dev gzip negotiation', () => {
  test('honors explicit and wildcard quality values', () => {
    expect(acceptsGzip('br, gzip')).toBe(true)
    expect(acceptsGzip('gzip;q=0, *;q=1')).toBe(false)
    expect(acceptsGzip('br;q=1, *;q=0.5')).toBe(true)
    expect(acceptsGzip()).toBe(false)
  })
})
