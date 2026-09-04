import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopGsSkillsApi,
  desktopGsSkillsPaths,
  parseGsSkillsView,
} from '../src/client/gs-skills-api.ts'

const synced = Object.freeze({
  status: 'ok' as const,
  syncedAt: '2026-01-02T03:04:05.000Z',
  skills: Object.freeze([
    Object.freeze({
      name: 'code-review',
      displayName: 'Code Review',
      version: '1.0.0',
      description: 'Reviews code changes',
    }),
  ]),
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseGsSkillsView', () => {
  it('accepts every status and strips extra keys', () => {
    expect(parseGsSkillsView(synced)).toEqual(synced)
    expect(parseGsSkillsView({ status: 'idle', skills: [], extra: true }))
      .toEqual({ status: 'idle', skills: [] })
    expect(parseGsSkillsView({ status: 'signed-out', skills: [] }))
      .toEqual({ status: 'signed-out', skills: [] })
    expect(parseGsSkillsView({
      status: 'error',
      syncedAt: '2026-01-02T03:04:05.000Z',
      skills: [{ name: 'code-review', description: 'Reviews code changes' }],
    })).toEqual({
      status: 'error',
      syncedAt: '2026-01-02T03:04:05.000Z',
      skills: [{ name: 'code-review', description: 'Reviews code changes' }],
    })
  })

  it('rejects malformed status, syncedAt, and skills shapes', () => {
    expect(() => parseGsSkillsView(undefined)).toThrow('invalid gs-server skills response')
    expect(() => parseGsSkillsView({ status: 'unknown', skills: [] })).toThrow('invalid gs-server skills response')
    expect(() => parseGsSkillsView({ status: 'ok', skills: {} })).toThrow('invalid gs-server skills response')
    expect(() => parseGsSkillsView({ status: 'ok', skills: [], syncedAt: 42 }))
      .toThrow('invalid gs-server skills response')
    expect(() => parseGsSkillsView({
      status: 'ok',
      skills: Array.from({ length: 501 }, () => ({ name: 'x', description: '' })),
    })).toThrow('invalid gs-server skills response')
  })

  it('accepts and passes through the masterOff and switchedOff fields', () => {
    expect(parseGsSkillsView({ status: 'ok', skills: [], masterOff: true, switchedOff: 0 }))
      .toEqual({ status: 'ok', skills: [], masterOff: true, switchedOff: 0 })
    expect(parseGsSkillsView({ status: 'ok', skills: [], masterOff: false, switchedOff: 2 }))
      .toEqual({ status: 'ok', skills: [], masterOff: false, switchedOff: 2 })
  })

  it('rejects malformed masterOff and switchedOff fields', () => {
    expect(() => parseGsSkillsView({ status: 'ok', skills: [], masterOff: 'yes' }))
      .toThrow('invalid gs-server skills response')
    expect(() => parseGsSkillsView({ status: 'ok', skills: [], switchedOff: '2' }))
      .toThrow('invalid gs-server skills response')
    expect(() => parseGsSkillsView({ status: 'ok', skills: [], switchedOff: -1 }))
      .toThrow('invalid gs-server skills response')
    expect(() => parseGsSkillsView({ status: 'ok', skills: [], switchedOff: 1.5 }))
      .toThrow('invalid gs-server skills response')
    expect(() => parseGsSkillsView({ status: 'ok', skills: [], switchedOff: 501 }))
      .toThrow('invalid gs-server skills response')
  })

  it('rejects malformed skill entries', () => {
    expect(() => parseGsSkillsView({ status: 'ok', skills: [{ name: '', description: '' }] }))
      .toThrow('invalid gs-server skill entry')
    expect(() => parseGsSkillsView({ status: 'ok', skills: [{ name: 'x' }] }))
      .toThrow('invalid gs-server skill entry')
    expect(() => parseGsSkillsView({ status: 'ok', skills: [{ name: 'x', description: '', displayName: 7 }] }))
      .toThrow('invalid gs-server skill entry')
    expect(() => parseGsSkillsView({ status: 'ok', skills: ['code-review'] }))
      .toThrow('invalid gs-server skill entry')
  })
})

describe('createDesktopGsSkillsApi', () => {
  it('reads the skills view through the same-origin route', async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, synced))
    const api = createDesktopGsSkillsApi(fetcher)
    await expect(api.readSkills()).resolves.toEqual(synced)
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe(desktopGsSkillsPaths.skills)
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
  })

  it('rejects non-JSON and failing responses', async () => {
    const failing = createDesktopGsSkillsApi(vi.fn(async () => jsonResponse(500, { error: 'boom' })))
    await expect(failing.readSkills()).rejects.toThrow('gs-server skills request failed (500)')
    const malformed = createDesktopGsSkillsApi(vi.fn(async () => new Response('nope', { status: 200 })))
    await expect(malformed.readSkills()).rejects.toThrow('gs-server skills response was not JSON')
  })
})
