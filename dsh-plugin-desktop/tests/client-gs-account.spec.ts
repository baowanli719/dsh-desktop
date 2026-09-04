import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopGsAccountApi,
  desktopGsAccountPaths,
  parseGsSessionView,
} from '../src/client/gs-account-api.ts'

const signedIn = Object.freeze({
  status: 'signed-in' as const,
  endpoint: 'http://127.0.0.1:18300/gsclaw',
  user: Object.freeze({ id: 7, username: 'worker', displayName: '办公用户', role: 'user' }),
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseGsSessionView', () => {
  it('accepts the signed-in and signed-out views and strips extra keys', () => {
    expect(parseGsSessionView(signedIn)).toEqual(signedIn)
    expect(parseGsSessionView({ status: 'signed-out', endpoint: 'http://127.0.0.1:18300/gsclaw' }))
      .toEqual({ status: 'signed-out', endpoint: 'http://127.0.0.1:18300/gsclaw' })
  })

  it('rejects malformed status, endpoint, and user shapes', () => {
    expect(() => parseGsSessionView(undefined)).toThrow('invalid gs-server session response')
    expect(() => parseGsSessionView({ status: 'unknown', endpoint: 'x' })).toThrow('invalid gs-server session response')
    expect(() => parseGsSessionView({ status: 'signed-out', endpoint: '' })).toThrow('invalid gs-server session response')
    expect(() => parseGsSessionView({ status: 'signed-in', endpoint: 'x' })).toThrow('invalid gs-server session user')
    expect(() => parseGsSessionView({ status: 'signed-in', endpoint: 'x', user: { id: '7', username: 'w', displayName: 'd', role: 'user' } }))
      .toThrow('invalid gs-server session user')
    expect(() => parseGsSessionView({ status: 'signed-in', endpoint: 'x', user: { id: 7, username: '', displayName: 'd', role: 'user' } }))
      .toThrow('invalid gs-server session user')
  })
})

describe('createDesktopGsAccountApi', () => {
  it('reads the session through the same-origin route', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, signedIn))
    const api = createDesktopGsAccountApi(fetcher)
    await expect(api.readSession()).resolves.toEqual(signedIn)
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe(desktopGsAccountPaths.session)
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
  })

  it('posts an empty logout body and requires the exact acknowledgement', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { accepted: true }))
    const api = createDesktopGsAccountApi(fetcher)
    await expect(api.logout()).resolves.toBeUndefined()
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe(desktopGsAccountPaths.logout)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')

    const bad = createDesktopGsAccountApi(vi.fn(async () => jsonResponse(200, { accepted: false })))
    await expect(bad.logout()).rejects.toThrow('invalid gs-server logout response')
  })

  it('rejects non-JSON and failing responses', async () => {
    const failing = createDesktopGsAccountApi(vi.fn(async () => jsonResponse(500, { error: 'boom' })))
    await expect(failing.readSession()).rejects.toThrow('gs-server account request failed (500)')
    const malformed = createDesktopGsAccountApi(vi.fn(async () => new Response('nope', { status: 200 })))
    await expect(malformed.readSession()).rejects.toThrow('gs-server account response was not JSON')
  })
})
