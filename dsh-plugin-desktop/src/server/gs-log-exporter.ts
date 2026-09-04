/**
 * Client runtime log upload for gsclaw-server.
 *
 * Cordis logger exporter that buffers rendered, secret-masked messages and
 * posts them in batches to `POST /api/logs/client` through the authorized
 * gateway client. Uploads are strictly best-effort: a full queue drops the
 * oldest records, a failed batch is discarded without retry, and shutdown
 * flushes what remains under a short timeout without blocking the exit.
 */

import { Logger, type Exporter, type Message } from '@deepseek-ai/cordis'
import { shouldEmit, type LogLevel, type LogType } from '../log-level.ts'
import { maskSecrets } from '../mask-secrets.ts'
import { authorizedJson, type GsRequest, type GsSessionTokenSource } from './gs-client.ts'

/** Gateway route accepting client runtime log batches. */
const CLIENT_LOGS_PATH = '/api/logs/client'
/** Flush as soon as this many records are buffered. */
export const GS_LOG_FLUSH_COUNT = 50
/** Flush whatever is buffered at least this often. */
export const GS_LOG_FLUSH_INTERVAL_MS = 10_000
/** The server accepts at most this many records per batch. */
export const GS_LOG_BATCH_LIMIT = 200
/** Leave headroom under the server's 256KB request-body cap. */
export const GS_LOG_BATCH_BYTES = 192 * 1024
/** Bounded buffer; the oldest records are dropped past this cap. */
export const GS_LOG_QUEUE_LIMIT = 2000
/** Per-message render cap; the server additionally truncates at 2000 chars. */
const GS_LOG_MESSAGE_LENGTH = 2000
/** Grace allowed for the final shutdown flush. */
export const GS_LOG_CLOSE_TIMEOUT_MS = 2_000

/** One serialized client log record accepted by `/api/logs/client`. */
export interface GsClientLogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly scope?: string
  readonly ts: number
}

/** Inputs for the client log uploader. */
export interface GsLogExporterOptions {
  /** Effective endpoint resolver; read per request so overrides apply live. */
  readonly endpoint: () => string
  /** Session source backing the authorized upload. */
  readonly session: GsSessionTokenSource
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
  /**
   * Local sink for uploader diagnostics: a `warn` when the bounded queue
   * starts dropping records, a `debug` when a batch is discarded. Must not
   * route back into the Cordis logger, or uploads would recurse.
   */
  readonly localLog?: (level: LogType, line: string) => void
  /** Initial verbosity threshold; mirrors the file exporter semantics. */
  readonly threshold?: LogLevel
  /** Grace for the shutdown flush; tests and hosts may shorten it. */
  readonly closeTimeoutMs?: number
}

/** Map one Cordis severity onto the server whitelist. */
function toServerLevel(type: LogType): 'debug' | 'info' | 'warn' | 'error' {
  switch (type) {
    case 'error': return 'error'
    case 'warn': return 'warn'
    case 'debug': return 'debug'
    default: return 'info'
  }
}

/** Cordis exporter that batches masked client logs to gsclaw-server. */
export class GsLogExporter implements Exporter {
  formatters = {}
  maxLength = GS_LOG_MESSAGE_LENGTH
  // Cordis filters by `levels` before calling `export` (default INFO=1 would
  // drop warn=2 and debug=3). Pass everything through and let `shouldEmit`
  // own the threshold, mirroring the file exporter.
  levels = { default: 3 }

  private threshold: LogLevel
  private readonly queue: GsClientLogRecord[] = []
  private readonly timer: ReturnType<typeof setInterval>
  private inFlight: Promise<void> | undefined
  private overflowNotified = false
  private closed = false

  constructor(private readonly options: GsLogExporterOptions) {
    this.threshold = options.threshold ?? 'info'
    this.timer = setInterval(() => { void this.flush() }, GS_LOG_FLUSH_INTERVAL_MS)
    // Never keep the process alive for a log upload.
    const handle: { unref?: () => void } = this.timer
    handle.unref?.()
  }

  /** Update the verbosity threshold in place on a hot-reloaded setting change. */
  setThreshold(level: LogLevel): void {
    this.threshold = level
  }

  export(message: Message): void {
    if (this.closed || !shouldEmit(message.type, this.threshold)) return
    this.queue.push({
      level: toServerLevel(message.type),
      message: maskSecrets(Logger.format(this, message)),
      scope: message.name,
      ts: message.ts,
    })
    if (this.queue.length > GS_LOG_QUEUE_LIMIT) {
      this.queue.shift()
      if (!this.overflowNotified) {
        this.overflowNotified = true
        this.localLog('warn',
          `dsh-plugin-desktop: client log upload queue full (${String(GS_LOG_QUEUE_LIMIT)}); dropping the oldest records`)
      }
    }
    if (this.queue.length >= GS_LOG_FLUSH_COUNT) void this.flush()
  }

  /** Send one bounded batch now; no-op while a previous batch is in flight. */
  async flush(): Promise<void> {
    if (this.inFlight !== undefined) {
      await this.inFlight
      return
    }
    const batch = this.takeBatch()
    if (batch.length === 0) return
    const task = this.send(batch)
    this.inFlight = task
    try {
      await task
    } finally {
      if (this.inFlight === task) this.inFlight = undefined
    }
  }

  /**
   * Stop the interval and best-effort flush the remaining queue under a short
   * timeout. Never rejects and never blocks the exit beyond the grace.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    const controller = new AbortController()
    // The signal cancels a well-behaved fetch; racing it additionally
    // unblocks the drain when the underlying request ignores cancellation.
    const aborted = new Promise<void>(resolve => {
      controller.signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    const timeout = setTimeout(() => { controller.abort() }, this.options.closeTimeoutMs ?? GS_LOG_CLOSE_TIMEOUT_MS)
    try {
      if (this.inFlight !== undefined) await Promise.race([this.inFlight, aborted])
      while (this.queue.length > 0 && !controller.signal.aborted) {
        await Promise.race([this.send(this.takeBatch(), controller.signal), aborted])
      }
    } finally {
      clearTimeout(timeout)
      this.queue.length = 0
    }
  }

  /** Drain up to one server-acceptable batch from the queue. */
  private takeBatch(): GsClientLogRecord[] {
    const batch: GsClientLogRecord[] = []
    let bytes = 0
    while (batch.length < GS_LOG_BATCH_LIMIT && this.queue.length > 0) {
      const next = this.queue[0] as GsClientLogRecord
      const size = Buffer.byteLength(next.message, 'utf8') + 64
      if (batch.length > 0 && bytes + size > GS_LOG_BATCH_BYTES) break
      bytes += size
      batch.push(next)
      this.queue.shift()
    }
    if (this.queue.length === 0) this.overflowNotified = false
    return batch
  }

  /** Post one batch; every failure mode silently discards it. */
  private async send(batch: GsClientLogRecord[], signal?: AbortSignal): Promise<void> {
    try {
      await authorizedJson<{ ok: boolean, count: number }>({
        endpoint: this.options.endpoint(),
        path: CLIENT_LOGS_PATH,
        method: 'POST',
        body: { logs: batch },
        session: this.options.session,
        ...(this.options.request === undefined ? {} : { request: this.options.request }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (cause) {
      // Signed out, offline, rate limited, or a server failure: drop the
      // batch without retry and leave only a local debug note.
      const detail = cause instanceof Error ? cause.message : String(cause)
      this.localLog('debug',
        `dsh-plugin-desktop: dropped ${String(batch.length)} client log record(s): ${detail}`)
    }
  }

  private localLog(level: LogType, line: string): void {
    try {
      this.options.localLog?.(level, line)
    } catch {
      // Uploader diagnostics are best-effort.
    }
  }
}
