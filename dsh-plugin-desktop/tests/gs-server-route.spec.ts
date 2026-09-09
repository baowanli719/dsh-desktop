import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleGsLogoutRequest, handleGsSkillsRequest } from '../src/server/gs-server-route.ts'
import type GsServerService from '../src/server/gs-server-service.ts'

const ORIGIN = 'http://127.0.0.1:43120'

function request(): IncomingMessage {
  const req = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage
  Object.assign(req, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:43120',
      origin: ORIGIN,
      'content-type': 'application/json',
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req
}

function response() {
  const end = vi.fn()
  return {
    end,
    res: {
      statusCode: 0,
      setHeader: vi.fn(),
      end,
    } as unknown as ServerResponse,
  }
}

describe('gs-server logout route', () => {
  it('acknowledges revoked credentials before requesting the login-flow relaunch', async () => {
    const events: string[] = []
    const service = {
      logout: vi.fn(async () => { events.push('logout') }),
    } as unknown as GsServerService
    const { res, end } = response()

    await handleGsLogoutRequest(request(), res, ORIGIN, service, vi.fn(), () => { events.push('restart') })

    expect(res.statusCode).toBe(200)
    expect(end).toHaveBeenCalledWith('{"accepted":true}')
    expect(events).toEqual(['logout', 'restart'])
  })

  it('does not relaunch when credential revocation fails', async () => {
    const service = {
      logout: vi.fn(async () => { throw new Error('offline') }),
    } as unknown as GsServerService
    const reportError = vi.fn()
    const onLoggedOut = vi.fn()
    const { res } = response()

    await handleGsLogoutRequest(request(), res, ORIGIN, service, reportError, onLoggedOut)

    expect(res.statusCode).toBe(500)
    expect(reportError).toHaveBeenCalledWith('gs-server logout', expect.any(Error))
    expect(onLoggedOut).not.toHaveBeenCalled()
  })
})



describe('gs-server skill preference route', () => {
  function skillRequest(body: unknown, origin = ORIGIN) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', headers: { host: '127.0.0.1:43120', origin, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
    return req
  }
  const read = async () => ({ status: 'ok' as const, skills: [{ name: 'review', description: '', enabled: false }] })
  it('updates a visible skill and returns the refreshed view', async () => {
    const { res } = response()
    const set = vi.fn(async () => {})
    await handleGsSkillsRequest(skillRequest({ name: 'review', enabled: true }), res, ORIGIN, read, vi.fn(), set)
    expect(res.statusCode).toBe(200)
    expect(set).toHaveBeenCalledWith('review', true)
  })
  it('rejects foreign origins, invalid bodies and undelivered skills', async () => {
    for (const [body, origin, status] of [
      [{ name: 'review', enabled: true }, 'https://foreign.test', 403],
      [{ name: 'review', enabled: 'true' }, ORIGIN, 400],
      [{ name: 'missing', enabled: true }, ORIGIN, 409],
    ] as const) {
      const { res } = response()
      const set = vi.fn(async () => {})
      await handleGsSkillsRequest(skillRequest(body, origin), res, ORIGIN, read, vi.fn(), set)
      expect(res.statusCode).toBe(status)
      expect(set).not.toHaveBeenCalled()
    }
  })
})
