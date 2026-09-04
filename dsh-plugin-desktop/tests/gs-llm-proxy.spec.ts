import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GsSessionTokenSource } from '../src/server/gs-client.ts'
import {
  createGsLlmProxyToken,
  GsLlmProxyServer,
  isGsLlmProxyLoopbackAddress,
  MAX_GS_LLM_PROXY_BODY_BYTES,
} from '../src/server/gs-llm-proxy.ts'

interface UpstreamCall {
  readonly authorization: string | undefined
  readonly accept: string | undefined
  readonly path: string
  readonly body: string
}

type UpstreamAnswer = (call: UpstreamCall, res: import('node:http').ServerResponse) => void

const cleanups: Array<() => Promise<void> | void> = []

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  cleanups.push(() => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeIdleConnections()
  }))
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

interface ProxyHarness {
  readonly proxy: GsLlmProxyServer
  readonly token: string
  readonly session: {
    accessToken(): string | undefined
    refreshAccessToken: ReturnType<typeof vi.fn>
  }
  readonly calls: UpstreamCall[]
  readonly url: (providerId: string) => string
  setAnswer(answer: UpstreamAnswer): void
}

async function startProxyHarness(initialToken: string | undefined): Promise<ProxyHarness> {
  const calls: UpstreamCall[] = []
  let answer: UpstreamAnswer = (call, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ echoed: call.authorization }))
  }
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => { chunks.push(chunk as Buffer) })
    req.on('end', () => {
      const call: UpstreamCall = {
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
        accept: typeof req.headers.accept === 'string' ? req.headers.accept : undefined,
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      }
      calls.push(call)
      answer(call, res)
    })
  })
  const upstreamPort = await listen(upstream)
  let current = initialToken
  const session = {
    accessToken: () => current,
    refreshAccessToken: vi.fn(async () => {
      current = 'refreshed-token'
      return 'refreshed-token'
    }),
  }
  const token = createGsLlmProxyToken()
  const proxy = new GsLlmProxyServer({
    endpoint: () => `http://127.0.0.1:${String(upstreamPort)}/gateway`,
    session,
    token,
  })
  await proxy.start()
  cleanups.push(() => proxy.close())
  return {
    proxy,
    token,
    session,
    calls,
    url: providerId => `${proxy.origin}/v1/${providerId}/chat/completions`,
    setAnswer: next => { answer = next },
  }
}

function post(url: string, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
}

describe('gsclaw-server LLM loopback proxy', () => {
  it('swaps the placeholder token for the session token and forwards to the provider route', async () => {
    const harness = await startProxyHarness('session-token')
    const response = await post(harness.url('acme'), harness.token, { model: 'acme-large', messages: [] })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ echoed: 'Bearer session-token' })
    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]!.path).toBe('/gateway/api/v1/llm/acme/v1/chat/completions')
    expect(harness.calls[0]!.authorization).toBe('Bearer session-token')
    expect(harness.calls[0]!.body).toBe(JSON.stringify({ model: 'acme-large', messages: [] }))
  })

  it('streams SSE answers through without buffering', async () => {
    const harness = await startProxyHarness('session-token')
    let upstreamFinished = false
    let releaseSecondChunk!: () => void
    const secondChunk = new Promise<void>((resolve) => { releaseSecondChunk = resolve })
    harness.setAnswer((_call, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.flushHeaders()
      res.write('data: {"one":1}\n\n')
      void secondChunk.then(() => {
        upstreamFinished = true
        res.end('data: {"two":2}\n\n')
      })
    })

    const response = await post(harness.url('acme'), harness.token, { model: 'acme-large', stream: true })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const first = await reader.read()
    // The first chunk arrived while the upstream was still holding the stream open.
    expect(upstreamFinished).toBe(false)
    expect(new TextDecoder().decode(first.value)).toBe('data: {"one":1}\n\n')
    releaseSecondChunk()
    const rest = await new Response(new ReadableStream({
      start(controller) {
        void (async () => {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            controller.enqueue(chunk.value)
          }
          controller.close()
        })()
      },
    })).text()
    expect(rest).toBe('data: {"two":2}\n\n')
  })

  it('refreshes the access token single-flight after a 401 and retries once', async () => {
    const harness = await startProxyHarness('stale-token')
    harness.setAnswer((call, res) => {
      if (call.authorization === 'Bearer stale-token') {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ code: 'token_expired', message: 'expired' }))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: call.authorization }))
    })

    const response = await post(harness.url('acme'), harness.token, { model: 'acme-large' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: 'Bearer refreshed-token' })
    expect(harness.session.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(harness.calls.map(call => call.authorization)).toEqual(['Bearer stale-token', 'Bearer refreshed-token'])
  })

  it('passes a second 401 through after the refresh retry', async () => {
    const harness = await startProxyHarness('stale-token')
    harness.setAnswer((_call, res) => {
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 'token_invalid', message: 'still rejected' }))
    })

    const response = await post(harness.url('acme'), harness.token, { model: 'acme-large' })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'token_invalid', message: 'still rejected' })
    expect(harness.session.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(harness.calls).toHaveLength(2)
  })

  it('passes the original 401 through when the refresh itself is rejected', async () => {
    const harness = await startProxyHarness('stale-token')
    harness.session.refreshAccessToken.mockRejectedValue(new Error('family revoked'))
    harness.setAnswer((_call, res) => {
      res.statusCode = 401
      res.end(JSON.stringify({ code: 'token_expired', message: 'expired' }))
    })

    const response = await post(harness.url('acme'), harness.token, { model: 'acme-large' })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'token_expired', message: 'expired' })
    expect(harness.calls).toHaveLength(1)
  })

  it('answers 401 without forwarding when there is no session', async () => {
    const harness = await startProxyHarness(undefined)
    const response = await post(harness.url('acme'), harness.token, { model: 'acme-large' })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { message: 'not signed in to gsclaw-server', type: 'authentication_error' },
    })
    expect(harness.calls).toHaveLength(0)
  })

  it('rejects requests without the per-boot placeholder token', async () => {
    const harness = await startProxyHarness('session-token')
    const missing = await post(harness.url('acme'), undefined, { model: 'acme-large' })
    expect(missing.status).toBe(403)
    const wrong = await post(harness.url('acme'), createGsLlmProxyToken(), { model: 'acme-large' })
    expect(wrong.status).toBe(403)
    expect(harness.calls).toHaveLength(0)
  })

  it('rejects non-POST methods and unknown or unsafe routes', async () => {
    const harness = await startProxyHarness('session-token')
    const get = await fetch(harness.url('acme'), {
      method: 'GET',
      headers: { authorization: `Bearer ${harness.token}` },
    })
    expect(get.status).toBe(405)

    expect((await post(`${harness.proxy.origin}/v1/chat/completions`, harness.token, {})).status).toBe(404)
    expect((await post(`${harness.proxy.origin}/v1/bad%20id/chat/completions`, harness.token, {})).status).toBe(404)
    expect((await post(`${harness.proxy.origin}/v1/..%2F..%2Fetc/chat/completions`, harness.token, {})).status).toBe(404)
    expect((await post(`${harness.proxy.origin}/api/v1/llm/acme/v1/chat/completions`, harness.token, {})).status).toBe(404)
    expect(harness.calls).toHaveLength(0)
  })

  it('caps request bodies at the documented limit', async () => {
    const harness = await startProxyHarness('session-token')
    const oversized = 'x'.repeat(MAX_GS_LLM_PROXY_BODY_BYTES + 1)
    const response = await post(harness.url('acme'), harness.token, { padding: oversized })
    expect(response.status).toBe(413)
    expect(harness.calls).toHaveLength(0)
  })

  it('passes upstream error statuses, bodies, and Retry-After through untouched', async () => {
    const harness = await startProxyHarness('session-token')
    harness.setAnswer((_call, res) => {
      res.statusCode = 429
      res.setHeader('content-type', 'application/json')
      res.setHeader('retry-after', '30')
      res.end(JSON.stringify({ code: 'rate_limited', message: 'slow down' }))
    })

    const response = await post(harness.url('acme'), harness.token, { model: 'acme-large' })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(await response.json()).toEqual({ code: 'rate_limited', message: 'slow down' })
    expect(harness.session.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('answers 502 when the upstream gateway is unreachable', async () => {
    const errors: string[] = []
    const token = createGsLlmProxyToken()
    const session: GsSessionTokenSource = {
      accessToken: () => 'session-token',
      refreshAccessToken: () => Promise.resolve('unused'),
    }
    // Port 1 on loopback refuses connections deterministically.
    const proxy = new GsLlmProxyServer({
      endpoint: () => 'http://127.0.0.1:1',
      session,
      token,
      onError: line => { errors.push(line) },
    })
    await proxy.start()
    cleanups.push(() => proxy.close())

    const response = await post(`${proxy.origin}/v1/acme/chat/completions`, token, { model: 'acme-large' })
    expect(response.status).toBe(502)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('exposes the provider baseURL route used by the mirrored profiles', async () => {
    const harness = await startProxyHarness('session-token')
    expect(harness.proxy.providerBaseUrl('acme')).toBe(`${harness.proxy.origin}/v1/acme`)
    expect(() => harness.proxy.providerBaseUrl('../escape')).toThrow(/route grammar/)
  })

  it('recognizes loopback peer addresses only', () => {
    expect(isGsLlmProxyLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isGsLlmProxyLoopbackAddress('::1')).toBe(true)
    expect(isGsLlmProxyLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isGsLlmProxyLoopbackAddress('192.168.1.10')).toBe(false)
    expect(isGsLlmProxyLoopbackAddress('::ffff:192.168.1.10')).toBe(false)
    expect(isGsLlmProxyLoopbackAddress(undefined)).toBe(false)
  })
})
