import { describe, expect, it, vi } from 'vitest'
import {
  GatewayError,
  authorizedJson,
  gsJsonRequest,
  isRefreshableAuthError,
  parseGatewayError,
  type GsRequest,
  type GsSessionTokenSource,
} from '../src/server/gs-client.ts'

const ENDPOINT = 'http://127.0.0.1:18300/gsclaw'

describe('gateway error envelopes', () => {
  it('parses the legacy /api/* envelope with its uppercase code', async () => {
    const response = Response.json({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' }, { status: 401 })
    const error = await parseGatewayError(response)
    expect(error).toBeInstanceOf(GatewayError)
    expect(error.code).toBe('INVALID_CREDENTIALS')
    expect(error.status).toBe(401)
    expect(error.message).toBe('用户名或密码错误')
    expect(error.traceId).toBeUndefined()
    expect(error.retryAfter).toBeUndefined()
  })

  it('parses the /api/v1/* envelope with code, message, and traceId', async () => {
    const response = Response.json(
      { code: 'unauthorized', message: '登录已过期，请重新登录', traceId: 'trace-1' },
      { status: 401 },
    )
    const error = await parseGatewayError(response)
    expect(error.code).toBe('unauthorized')
    expect(error.traceId).toBe('trace-1')
  })

  it('extracts Retry-After on 429 responses', async () => {
    const response = Response.json(
      { error: 'TOO_MANY_ATTEMPTS', message: '失败次数过多' },
      { status: 429, headers: { 'retry-after': '300' } },
    )
    const error = await parseGatewayError(response)
    expect(error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(error.retryAfter).toBe(300)
  })

  it('falls back to an http_<status> code for non-JSON failures', async () => {
    const error = await parseGatewayError(new Response('oops', { status: 502 }))
    expect(error.code).toBe('http_502')
    expect(error.status).toBe(502)
  })

  it('recognizes refreshable 401 codes from both envelopes, case-insensitively', () => {
    expect(isRefreshableAuthError(new GatewayError('TOKEN_INVALID', 401, 'expired'))).toBe(true)
    expect(isRefreshableAuthError(new GatewayError('token_expired', 401, 'expired'))).toBe(true)
    expect(isRefreshableAuthError(new GatewayError('unauthorized', 401, 'expired'))).toBe(true)
    expect(isRefreshableAuthError(new GatewayError('USER_DISABLED', 403, 'disabled'))).toBe(false)
    expect(isRefreshableAuthError(new GatewayError('INVALID_CREDENTIALS', 401, 'wrong password'))).toBe(false)
    expect(isRefreshableAuthError(new Error('boom'))).toBe(false)
  })
})

describe('gsJsonRequest', () => {
  it('sends JSON bodies with the Bearer token and parses the response', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: GsRequest = async (url, init) => {
      calls.push({ url, init })
      return Response.json({ ok: true })
    }

    await expect(gsJsonRequest<{ ok: boolean }>({
      endpoint: ENDPOINT,
      method: 'POST',
      path: '/api/auth/login',
      body: { username: 'u' },
      accessToken: 'access-1',
      request,
    })).resolves.toEqual({ ok: true })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ENDPOINT}/api/auth/login`)
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer access-1')
    expect(headers.get('content-type')).toBe('application/json')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ username: 'u' }))
  })

  it('maps transport failures to a status-0 network error', async () => {
    const request: GsRequest = async () => { throw new Error('ECONNREFUSED') }
    await expect(gsJsonRequest({ endpoint: ENDPOINT, path: '/api/v1/meta', request }))
      .rejects.toMatchObject({ code: 'network', status: 0 })
  })

  it('caps response bodies at the default limit unless maxBytes overrides it', async () => {
    const oversized = JSON.stringify({ data: 'x'.repeat(1024 * 1024) })
    const request: GsRequest = async () => new Response(oversized, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    await expect(gsJsonRequest({ endpoint: ENDPOINT, path: '/api/big', request }))
      .rejects.toMatchObject({ code: 'response_too_large' })
    await expect(gsJsonRequest({ endpoint: ENDPOINT, path: '/api/big', request, maxBytes: 2 * 1024 * 1024 }))
      .resolves.toEqual({ data: 'x'.repeat(1024 * 1024) })
  })
})

describe('authorizedJson', () => {
  function session(token: string | undefined, refresh?: () => Promise<string>): GsSessionTokenSource {
    return {
      accessToken: () => token,
      refreshAccessToken: refresh ?? (async () => { throw new Error('no refresh') }),
    }
  }

  it('refuses to run without an access token', async () => {
    const request = vi.fn(async () => Response.json({}))
    await expect(authorizedJson({ endpoint: ENDPOINT, path: '/api/client-config', session: session(undefined), request }))
      .rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    expect(request).not.toHaveBeenCalled()
  })

  it('refreshes once on a token 401 and retries with the rotated token', async () => {
    const seen: Array<string | null> = []
    let calls = 0
    const request: GsRequest = async (_url, init) => {
      seen.push(new Headers(init.headers).get('authorization'))
      calls += 1
      if (calls === 1) {
        return Response.json({ error: 'TOKEN_INVALID', message: 'expired' }, { status: 401 })
      }
      return Response.json({ ok: true })
    }
    const refresh = vi.fn(async () => 'access-2')

    await expect(authorizedJson<{ ok: boolean }>({
      endpoint: ENDPOINT,
      path: '/api/client-config',
      session: session('access-1', refresh),
      request,
    })).resolves.toEqual({ ok: true })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['Bearer access-1', 'Bearer access-2'])
  })

  it('does not retry more than once', async () => {
    const request: GsRequest = async () =>
      Response.json({ code: 'unauthorized', message: 'no', traceId: 't' }, { status: 401 })
    const refresh = vi.fn(async () => 'access-2')

    await expect(authorizedJson({
      endpoint: ENDPOINT,
      path: '/api/client-config',
      session: session('access-1', refresh),
      request,
    })).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('propagates non-auth failures without refreshing', async () => {
    const request: GsRequest = async () =>
      Response.json({ error: 'USER_DISABLED', message: 'disabled' }, { status: 403 })
    const refresh = vi.fn(async () => 'access-2')

    await expect(authorizedJson({
      endpoint: ENDPOINT,
      path: '/api/client-config',
      session: session('access-1', refresh),
      request,
    })).rejects.toMatchObject({ code: 'USER_DISABLED', status: 403 })
    expect(refresh).not.toHaveBeenCalled()
  })
})
