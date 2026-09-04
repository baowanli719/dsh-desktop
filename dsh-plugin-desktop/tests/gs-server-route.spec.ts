import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleGsLogoutRequest } from '../src/server/gs-server-route.ts'
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

