import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopGsBrandApi,
  desktopGsBrandPaths,
  parseGsBrandView,
} from '../src/client/gs-brand-api.ts'

const brand = Object.freeze({ name: '办公 Agent', headline: '探索未至之境' })

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseGsBrandView', () => {
  it('accepts the brand view and strips extra keys', () => {
    expect(parseGsBrandView(brand)).toEqual(brand)
    expect(parseGsBrandView({ ...brand, extra: true })).toEqual(brand)
  })

  it('rejects malformed brand shapes', () => {
    expect(() => parseGsBrandView(undefined)).toThrow('invalid gs-server brand response')
    expect(() => parseGsBrandView({ headline: 'x' })).toThrow('invalid gs-server brand response')
    expect(() => parseGsBrandView({ name: '', headline: 'x' })).toThrow('invalid gs-server brand response')
    expect(() => parseGsBrandView({ name: 'x', headline: '' })).toThrow('invalid gs-server brand response')
    expect(() => parseGsBrandView({ name: 'x'.repeat(65), headline: 'x' }))
      .toThrow('invalid gs-server brand response')
    expect(() => parseGsBrandView({ name: 'x', headline: 'x'.repeat(129) }))
      .toThrow('invalid gs-server brand response')
    expect(() => parseGsBrandView({ name: 42, headline: 'x' })).toThrow('invalid gs-server brand response')
  })
})

describe('createDesktopGsBrandApi', () => {
  it('reads the brand view through the same-origin route', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, brand))
    const api = createDesktopGsBrandApi(fetcher)
    await expect(api.readBrand()).resolves.toEqual(brand)
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe(desktopGsBrandPaths.brand)
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
  })

  it('rejects non-JSON and failing responses', async () => {
    const failing = createDesktopGsBrandApi(vi.fn(async () => jsonResponse(500, { error: 'boom' })))
    await expect(failing.readBrand()).rejects.toThrow('gs-server brand request failed (500)')
    const malformed = createDesktopGsBrandApi(vi.fn(async () => new Response('nope', { status: 200 })))
    await expect(malformed.readBrand()).rejects.toThrow('gs-server brand response was not JSON')
  })
})
