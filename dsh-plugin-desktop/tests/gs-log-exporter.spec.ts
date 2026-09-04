import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GS_LOG_BATCH_LIMIT,
  GS_LOG_CLOSE_TIMEOUT_MS,
  GS_LOG_FLUSH_COUNT,
  GS_LOG_FLUSH_INTERVAL_MS,
  GS_LOG_QUEUE_LIMIT,
  GsLogExporter,
  type GsClientLogRecord,
} from '../src/server/gs-log-exporter.ts'
import type { GsRequest, GsSessionTokenSource } from '../src/server/gs-client.ts'
import type { LogType } from '../src/log-level.ts'

const ENDPOINT = 'http://127.0.0.1:18300/gsclaw'

interface CapturedCall {
  readonly url: string
  readonly body: { logs: GsClientLogRecord[] }
}

function session(token: string | undefined): GsSessionTokenSource {
  return {
    accessToken: () => token,
    refreshAccessToken: async () => 'token-2',
  }
}

/** Request mock that records every call and answers with the server envelope. */
function recordingRequest(calls: CapturedCall[]): GsRequest {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body as string) as { logs: GsClientLogRecord[] } })
    return Response.json({ ok: true, count: 1 })
  }
}

function message(text: string, type: LogType = 'info', name = 'test'): {
  sn: number, ts: number, name: string, type: LogType, level: number, args: unknown[]
} {
  const levels: Record<LogType, number> = { error: 0, info: 1, warn: 2, debug: 3 }
  return { sn: 0, ts: 1_700_000_000_000, name, type, level: levels[type], args: [text] }
}

function exporter(
  options: {
    request?: GsRequest
    token?: string | undefined
    localLog?: (level: LogType, line: string) => void
    threshold?: 'debug' | 'info' | 'warn' | 'error'
  } = {},
): { e: GsLogExporter, calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const e = new GsLogExporter({
    endpoint: () => ENDPOINT,
    session: session('token' in options ? options.token : 'token-1'),
    request: options.request ?? recordingRequest(calls),
    ...(options.localLog === undefined ? {} : { localLog: options.localLog }),
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
  })
  return { e, calls }
}

describe('GsLogExporter', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('flushes immediately once the buffered count threshold is reached', async () => {
    const { e, calls } = exporter()
    for (let i = 0; i < GS_LOG_FLUSH_COUNT - 1; i++) e.export(message(`line ${String(i)}`))
    // The request mock records synchronously; below the threshold no batch left.
    expect(calls).toHaveLength(0)
    e.export(message('last'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ENDPOINT}/api/logs/client`)
    expect(calls[0]?.body.logs).toHaveLength(GS_LOG_FLUSH_COUNT)
    await e.close()
  })

  it('flushes whatever is buffered after the interval elapses', async () => {
    const { e, calls } = exporter()
    e.export(message('one'))
    e.export(message('two'))
    await vi.advanceTimersByTimeAsync(GS_LOG_FLUSH_INTERVAL_MS)
    await e.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.logs).toHaveLength(2)
    await e.close()
  })

  it('caps one batch at the server limit and keeps the remainder queued', async () => {
    let release!: () => void
    const calls: CapturedCall[] = []
    // The first batch hangs so the export loop cannot drain the queue; the
    // count threshold would otherwise flush every 50 records.
    const request: GsRequest = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body as string) as { logs: GsClientLogRecord[] } })
      if (calls.length === 1) {
        return new Promise<Response>(resolve => {
          release = () => { resolve(Response.json({ ok: true, count: 1 })) }
        })
      }
      return Promise.resolve(Response.json({ ok: true, count: 1 }))
    }
    const { e } = exporter({ request })
    for (let i = 0; i < GS_LOG_FLUSH_COUNT + GS_LOG_BATCH_LIMIT + 10; i++) e.export(message(`line ${String(i)}`))
    release()
    await e.flush() // waits out the in-flight first batch
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.logs).toHaveLength(GS_LOG_FLUSH_COUNT)
    await e.flush() // sends one capped batch and keeps the rest queued
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body.logs).toHaveLength(GS_LOG_BATCH_LIMIT)
    await e.flush()
    expect(calls[2]?.body.logs).toHaveLength(10)
    await e.close()
  })

  it('drops the oldest records past the queue cap and warns locally once', async () => {
    const notes: Array<{ level: LogType, line: string }> = []
    const { e } = exporter({
      request: () => new Promise<Response>(() => {}), // hang: keep the queue full
      localLog: (level, line) => { notes.push({ level, line }) },
    })
    // One threshold batch is in flight; the rest fill the bounded queue.
    for (let i = 0; i < GS_LOG_FLUSH_COUNT + GS_LOG_QUEUE_LIMIT + 25; i++) e.export(message(`line ${String(i)}`))
    const warns = notes.filter(note => note.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.line).toContain('queue full')
    const closing = e.close()
    await vi.advanceTimersByTimeAsync(GS_LOG_CLOSE_TIMEOUT_MS)
    await closing
  })

  it('masks secrets and maps levels onto the server whitelist', async () => {
    const { e, calls } = exporter({ threshold: 'debug' })
    e.export(message('token sk-abcdefghijklmnop leaked', 'error', 'host'))
    e.export(message('warning', 'warn', 'client'))
    e.export(message('note', 'info', 'app'))
    e.export(message('trace', 'debug', 'app'))
    await e.flush()
    expect(calls).toHaveLength(1)
    const logs = calls[0]?.body.logs ?? []
    expect(logs.map(log => log.level)).toEqual(['error', 'warn', 'info', 'debug'])
    expect(logs.map(log => log.scope)).toEqual(['host', 'client', 'app', 'app'])
    expect(logs[0]?.message).not.toContain('sk-abcdefghijklmnop')
    expect(logs[0]?.message).toContain('sk-****')
    expect(logs[0]?.ts).toBe(1_700_000_000_000)
    await e.close()
  })

  it('drops debug records below the info threshold', async () => {
    const { e, calls } = exporter()
    e.export(message('hidden', 'debug'))
    await vi.advanceTimersByTimeAsync(GS_LOG_FLUSH_INTERVAL_MS)
    await e.flush()
    expect(calls).toHaveLength(0)
    await e.close()
  })

  it('silently discards a batch when the server fails', async () => {
    const notes: Array<{ level: LogType, line: string }> = []
    const calls: CapturedCall[] = []
    const request: GsRequest = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body as string) as { logs: GsClientLogRecord[] } })
      return Promise.resolve(Response.json({ error: 'oops', message: 'boom' }, { status: 500 }))
    }
    const { e } = exporter({
      request,
      localLog: (level, line) => { notes.push({ level, line }) },
    })
    e.export(message('lost'))
    await e.flush()
    expect(calls).toHaveLength(1)
    const debugs = notes.filter(note => note.level === 'debug')
    expect(debugs).toHaveLength(1)
    expect(debugs[0]?.line).toContain('dropped 1 client log record')
    // A failure must not wedge the uploader: the next batch still goes out.
    e.export(message('next'))
    await e.flush()
    expect(calls).toHaveLength(2)
    await e.close()
  })

  it('silently skips uploads while signed out', async () => {
    const notes: Array<{ level: LogType, line: string }> = []
    const calls: CapturedCall[] = []
    const { e } = exporter({
      token: undefined,
      request: recordingRequest(calls),
      localLog: (level, line) => { notes.push({ level, line }) },
    })
    e.export(message('no session'))
    await e.flush()
    expect(calls).toHaveLength(0)
    expect(notes.some(note => note.level === 'debug' && note.line.includes('dropped 1'))).toBe(true)
    await e.close()
  })

  it('flushes the remaining queue on close and ignores later messages', async () => {
    const { e, calls } = exporter()
    e.export(message('pending one'))
    e.export(message('pending two'))
    await e.close()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.logs.map(log => log.message)).toEqual(['pending one', 'pending two'])
    e.export(message('after close'))
    await vi.advanceTimersByTimeAsync(GS_LOG_FLUSH_INTERVAL_MS * 2)
    expect(calls).toHaveLength(1)
    await e.close() // idempotent
  })

  it('bounds the shutdown flush by its timeout when the request hangs', async () => {
    const calls: CapturedCall[] = []
    const request: GsRequest = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body as string) as { logs: GsClientLogRecord[] } })
      return new Promise<Response>(() => {})
    }
    const { e } = exporter({ request })
    e.export(message('stuck'))
    const closing = e.close()
    let closed = false
    void closing.then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(GS_LOG_CLOSE_TIMEOUT_MS)
    await closing
    expect(closed).toBe(true)
    expect(calls).toHaveLength(1)
  })
})
