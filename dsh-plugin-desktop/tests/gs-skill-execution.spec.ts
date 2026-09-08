import { describe, expect, it, vi } from 'vitest'
import { GatewayError, type GsRequest } from '../src/server/gs-client.ts'
import type { GsSkillExecuteRequest } from '../src/server/gs-contract.ts'
import { GsSkillExecutionClient } from '../src/server/gs-skill-execution.ts'

const ENDPOINT = 'http://127.0.0.1:18300/gsclaw'

interface RecordedCall {
  readonly url: string
  readonly init: RequestInit
}

interface ClientHarness {
  readonly client: GsSkillExecutionClient
  readonly calls: RecordedCall[]
  readonly refresh: ReturnType<typeof vi.fn<() => Promise<string>>>
  setToken(token: string | undefined): void
}

function createClient(handler: (call: RecordedCall) => Response | Promise<Response>): ClientHarness {
  const calls: RecordedCall[] = []
  let token: string | undefined = 'access-1'
  const refresh = vi.fn<() => Promise<string>>(async () => 'refreshed-1')
  const request: GsRequest = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }
  const client = new GsSkillExecutionClient({
    endpoint: () => ENDPOINT,
    session: { accessToken: () => token, refreshAccessToken: refresh },
    request,
  })
  return {
    client,
    calls,
    refresh,
    setToken(next) { token = next },
  }
}

function executeRequest(overrides: Record<string, unknown> = {}): GsSkillExecuteRequest {
  return {
    requestId: 'req-1',
    sessionId: 'session-1',
    definitionRevision: 'rev-1',
    arguments: { query: 'customer_summary', params: { start_date: '2026-08-01' } },
    ...overrides,
  }
}

function okResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    requestId: 'req-1',
    traceId: 'trace-1',
    status: 'ok',
    content: [{ type: 'text', text: '42 rows' }],
    truncated: false,
    ...overrides,
  })
}

describe('GsSkillExecutionClient catalog and definition', () => {
  it('issues authorized GET requests for catalog and definition', async () => {
    const harness = createClient((call) => {
      if (call.url.endsWith('/api/v1/skills/catalog')) {
        return Response.json({ skills: [{ name: 'a', runtimeType: 'data-query', definitionRevision: 'r1' }] })
      }
      if (call.url.endsWith('/api/v1/skills/customer-analysis/definition')) {
        return Response.json({ name: 'customer-analysis', definitionRevision: 'r1', content: '# body' })
      }
      throw new Error(`unexpected call ${call.url}`)
    })

    await expect(harness.client.catalog()).resolves.toEqual({
      skills: [{ name: 'a', runtimeType: 'data-query', definitionRevision: 'r1' }],
    })
    await expect(harness.client.definition('customer-analysis')).resolves.toEqual(
      expect.objectContaining({ name: 'customer-analysis', content: '# body' }),
    )
    for (const call of harness.calls) {
      expect(call.init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer access-1' }))
    }
  })

  it('rejects catalog calls while signed out without touching the network', async () => {
    const harness = createClient(() => Response.json({ skills: [] }))
    harness.setToken(undefined)
    await expect(harness.client.catalog()).rejects.toThrow('not signed in')
    expect(harness.calls).toHaveLength(0)
  })
})

/** A request that never answers but rejects on abort, like real fetch. */
function hangingResponse(call: RecordedCall): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    call.init.signal?.addEventListener('abort', () => { reject(call.init.signal?.reason as Error) })
  })
}

describe('GsSkillExecutionClient execute', () => {
  it('normalizes a successful execution', async () => {
    const harness = createClient(() => okResponse())

    const outcome = await harness.client.execute('customer-analysis', executeRequest())

    expect(outcome).toEqual({
      status: 'ok',
      requestId: 'req-1',
      traceId: 'trace-1',
      text: '42 rows',
      truncated: false,
    })
    const call = harness.calls[0]!
    expect(call.url).toBe(`${ENDPOINT}/api/v1/skills/customer-analysis/execute`)
    expect(call.init.method).toBe('POST')
    expect(JSON.parse(String(call.init.body))).toEqual(executeRequest())
  })

  it('joins multiple text blocks and carries the truncation flag', async () => {
    const harness = createClient(() => okResponse({
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      truncated: true,
    }))

    const outcome = await harness.client.execute('customer-analysis', executeRequest())
    expect(outcome).toEqual(expect.objectContaining({ status: 'ok', text: 'a\nb', truncated: true }))
  })

  it('normalizes a business failure envelope without turning it into empty success', async () => {
    const harness = createClient(() => Response.json({
      requestId: 'req-1',
      traceId: 'trace-9',
      status: 'error',
      error: { code: 'invalid_arguments', message: 'unknown query template' },
    }))

    const outcome = await harness.client.execute('customer-analysis', executeRequest())
    expect(outcome).toEqual({
      status: 'error',
      code: 'invalid_arguments',
      message: 'unknown query template',
      traceId: 'trace-9',
    })
  })

  it('normalizes HTTP error envelopes with code and traceId', async () => {
    const harness = createClient(() => Response.json(
      { code: 'skill_unavailable', message: 'skill is not available', traceId: 'trace-404' },
      { status: 404 },
    ))

    const outcome = await harness.client.execute('ghost', executeRequest())
    expect(outcome).toEqual({
      status: 'error',
      code: 'skill_unavailable',
      message: 'skill is not available',
      traceId: 'trace-404',
    })
  })

  it('refreshes an expired token once and retries exactly once', async () => {
    let attempts = 0
    const harness = createClient((call) => {
      attempts += 1
      if (attempts === 1) {
        return Response.json({ code: 'token_expired', message: 'expired', traceId: 't-1' }, { status: 401 })
      }
      expect(call.init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer refreshed-1' }))
      return okResponse()
    })

    const outcome = await harness.client.execute('customer-analysis', executeRequest())
    expect(outcome.status).toBe('ok')
    expect(harness.refresh).toHaveBeenCalledTimes(1)
    expect(attempts).toBe(2)
  })

  it('never replays timeouts, 5xx, or rate limits', async () => {
    for (const status of [500, 502, 429]) {
      let attempts = 0
      const harness = createClient(() => {
        attempts += 1
        return Response.json({ code: 'boom', message: 'failure' }, { status })
      })
      const outcome = await harness.client.execute('customer-analysis', executeRequest())
      expect(outcome.status).toBe('error')
      expect(attempts).toBe(1)
      expect(harness.refresh).not.toHaveBeenCalled()
    }

    let networkAttempts = 0
    const offline = createClient(() => {
      networkAttempts += 1
      throw new Error('connection refused')
    })
    const outcome = await offline.client.execute('customer-analysis', executeRequest())
    expect(outcome).toEqual(expect.objectContaining({ status: 'error', code: 'network' }))
    expect(networkAttempts).toBe(1)
  })

  it('reports a client-side timeout without replaying', async () => {
    let attempts = 0
    const harness = createClient((call) => {
      attempts += 1
      return hangingResponse(call)
    })

    const outcome = await harness.client.execute('customer-analysis', executeRequest(), { timeoutMs: 20 })
    expect(outcome).toEqual(expect.objectContaining({ status: 'error', code: 'client_timeout' }))
    expect(attempts).toBe(1)
  })

  it('propagates caller cancellation as an abort', async () => {
    const harness = createClient(call => hangingResponse(call))
    const controller = new AbortController()
    const pending = harness.client.execute('customer-analysis', executeRequest(), { signal: controller.signal })
    controller.abort(new Error('user cancelled'))
    await expect(pending).rejects.toThrow('user cancelled')
  })

  it('rejects a malformed execute body instead of guessing', async () => {
    const harness = createClient(() => Response.json({ status: 'ok', content: 'not-an-array' }))
    await expect(harness.client.execute('customer-analysis', executeRequest()))
      .rejects.toThrow(GatewayError)
  })
})
