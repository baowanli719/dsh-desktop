/**
 * Loopback LLM proxy in front of the gsclaw-server model gateway.
 *
 * The DSH Agent loop never talks to a model provider directly: `llm-pi-ai`
 * provider profiles point at this 127.0.0.1 server with a per-boot placeholder
 * token as their apiKey, and the proxy swaps it for the in-memory gsclaw-server
 * access token before forwarding to
 * `{endpoint}/api/v1/llm/{providerId}/v1/chat/completions`. Bodies stream both
 * ways, so SSE answers reach the adapter without buffering, and an expired-token
 * 401 runs one single-flight refresh through the session source before the
 * request is retried exactly once.
 *
 * Abuse surface: the listener binds loopback only, every request must carry
 * the boot token as `Authorization: Bearer …`, and the token never leaves
 * process memory — the settings document carries only the credential
 * *reference* the token resolves through.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { GsRequest, GsSessionTokenSource } from './gs-client.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/** Maximum chat-completions request body the proxy accepts. */
export const MAX_GS_LLM_PROXY_BODY_BYTES = 4 * 1024 * 1024

/** Maximum upstream error body buffered while deciding on a refresh retry. */
const MAX_UPSTREAM_ERROR_BODY_BYTES = 256 * 1024

/** Boot-token shape: 32 random bytes, base64url (mirrors the renderer access token). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

/** Provider route grammar accepted in proxy URLs and stamped into provider profiles. */
export const GS_LLM_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

const ROUTE_PATTERN = /^\/v1\/([^/]+)\/chat\/completions$/u

/** Mint one unpredictable per-boot placeholder token. */
export function createGsLlmProxyToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Whether one peer address belongs to the loopback host. */
export function isGsLlmProxyLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Inputs for the loopback LLM proxy. */
export interface GsLlmProxyOptions {
  /** Effective gsclaw-server endpoint resolver; read per request so overrides apply live. */
  readonly endpoint: () => string
  /** Session source backing the Bearer swap and the single-flight 401 refresh. */
  readonly session: GsSessionTokenSource
  /** Boot token; defaults to a fresh random one. */
  readonly token?: string
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
  /** Sink for unexpected per-request failures that cannot reach the client. */
  readonly onError?: (line: string) => void
}

function writeJson(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.destroyed || res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({ error: { message, type } }))
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || !TOKEN_PATTERN.test(actual) || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

/** One buffered upstream answer awaiting a refresh decision or passthrough. */
interface BufferedUpstream {
  readonly status: number
  readonly contentType: string | null
  readonly retryAfter: string | null
  readonly body: Buffer
}

/**
 * 127.0.0.1-only HTTP proxy swapping the per-boot placeholder token for the
 * live gsclaw-server access token. One instance serves one boot generation;
 * `start` picks a random port and `origin` feeds the mirrored provider
 * profiles.
 */
export class GsLlmProxyServer {
  /** Per-boot placeholder token the provider profiles name through their credential reference. */
  readonly token: string
  private server: Server | undefined
  private boundPort: number | undefined

  constructor(private readonly options: GsLlmProxyOptions) {
    const token = options.token ?? createGsLlmProxyToken()
    if (!TOKEN_PATTERN.test(token)) {
      throw new TypeError(`${BIN_NAME}: LLM proxy token must be 32 base64url bytes`)
    }
    this.token = token
  }

  /** Loopback origin of the running proxy; throws before `start` settles. */
  get origin(): string {
    if (this.boundPort === undefined) {
      throw new Error(`${BIN_NAME}: LLM proxy is not listening yet`)
    }
    return `http://127.0.0.1:${String(this.boundPort)}`
  }

  /** Provider-profile baseURL route for one server provider id. */
  providerBaseUrl(providerId: string): string {
    if (!GS_LLM_PROVIDER_ID_PATTERN.test(providerId)) {
      throw new Error(`${BIN_NAME}: LLM provider id ${JSON.stringify(providerId)} is outside the proxy route grammar`)
    }
    return `${this.origin}/v1/${providerId}`
  }

  /** Bind the loopback listener on a random port. */
  async start(): Promise<void> {
    if (this.server !== undefined) {
      throw new Error(`${BIN_NAME}: LLM proxy is already started`)
    }
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((cause: unknown) => {
        const line = `${BIN_NAME}: LLM proxy request failed: ${cause instanceof Error ? cause.message : String(cause)}`
        this.options.onError?.(line)
        if (!res.headersSent) writeJson(res, 500, 'server_error', 'LLM proxy failure')
        if (!res.writableEnded) res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.boundPort = (server.address() as AddressInfo).port
    this.server = server
  }

  /** Stop accepting connections and drain idle ones; in-flight streams end with their sockets. */
  async close(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    this.boundPort = undefined
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeIdleConnections()
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isGsLlmProxyLoopbackAddress(req.socket.remoteAddress)) {
      writeJson(res, 403, 'permission_error', 'LLM proxy accepts loopback connections only')
      return
    }
    const authorization = req.headers.authorization
    const presented = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
    if (!sameToken(presented, this.token)) {
      writeJson(res, 403, 'permission_error', 'LLM proxy request carries no valid boot token')
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      writeJson(res, 405, 'invalid_request_error', 'LLM proxy route accepts POST only')
      return
    }
    const route = ROUTE_PATTERN.exec(req.url ?? '')
    const providerId = route?.[1] === undefined ? undefined : decodeURIComponent(route[1])
    if (providerId === undefined || !GS_LLM_PROVIDER_ID_PATTERN.test(providerId)) {
      writeJson(res, 404, 'invalid_request_error', 'unknown LLM proxy route')
      return
    }
    const body = await this.readBody(req, res)
    if (body === undefined) return
    const accessToken = this.options.session.accessToken()
    if (accessToken === undefined) {
      writeJson(res, 401, 'authentication_error', 'not signed in to gsclaw-server')
      return
    }

    const upstream = await this.forward(providerId, body, accessToken, req, res)
    if (upstream === undefined) return
    if (upstream.status === 401) {
      // One expired-token 401 buys one single-flight refresh and exactly one
      // retry; a second 401 (or a rejected refresh) passes the answer through.
      let refreshed: string | undefined
      try {
        refreshed = await this.options.session.refreshAccessToken()
      } catch {
        refreshed = undefined
      }
      if (refreshed !== undefined && !res.destroyed && !res.writableEnded) {
        // `forward` streams every non-401 answer and buffers only a second
        // 401, so a defined result here is the passthrough case.
        const retried = await this.forward(providerId, body, refreshed, req, res)
        if (retried === undefined) return
        this.writeUpstream(res, retried)
        return
      }
      this.writeUpstream(res, upstream)
      return
    }
    this.writeUpstream(res, upstream)
  }

  /** Read the bounded request body; answers 413 itself when the cap trips. */
  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += (chunk as Buffer).byteLength
      if (bytes > MAX_GS_LLM_PROXY_BODY_BYTES) {
        req.pause()
        const socket = req.socket
        res.setHeader('connection', 'close')
        writeJson(res, 413, 'invalid_request_error', 'LLM proxy request body is too large')
        res.on('finish', () => { socket.destroy() })
        return undefined
      }
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }

  /**
   * Forward one buffered request upstream. 401 answers are buffered whole so
   * the refresh-retry dance can still pass the original body through; every
   * other status streams straight into the client response.
   */
  private async forward(
    providerId: string,
    body: Buffer,
    accessToken: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<BufferedUpstream | undefined> {
    const request = this.options.request ?? ((url, init) => globalThis.fetch(url, init))
    const abort = new AbortController()
    // `res` closes exactly once: prematurely on client disconnect, normally
    // after `res.end()`. Aborting on the former tears down the upstream read;
    // `writableEnded` tells the two apart. (`req` 'close' fires at message
    // completion since Node 16, so it cannot detect a disconnect here.)
    const onClose = (): void => {
      if (!res.writableEnded) abort.abort()
    }
    res.on('close', onClose)
    let response: Response
    try {
      response = await request(
        `${this.options.endpoint()}/api/v1/llm/${encodeURIComponent(providerId)}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
            authorization: `Bearer ${accessToken}`,
          },
          body: new Uint8Array(body),
          cache: 'no-store',
          redirect: 'error',
          signal: abort.signal,
        },
      )
    } catch (cause) {
      if (!abort.signal.aborted) {
        writeJson(res, 502, 'server_error', 'gsclaw-server LLM gateway is unreachable')
        this.options.onError?.(
          `${BIN_NAME}: LLM proxy upstream request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
      return undefined
    }

    const contentType = response.headers.get('content-type')
    const retryAfter = response.headers.get('retry-after')
    if (response.status !== 401) {
      // Streaming passthrough: SSE and JSON answers alike pipe without
      // buffering; the client disconnect aborts the upstream read.
      res.statusCode = response.status
      if (contentType !== null) res.setHeader('content-type', contentType)
      if (retryAfter !== null) res.setHeader('retry-after', retryAfter)
      res.setHeader('cache-control', 'no-store')
      res.flushHeaders()
      if (response.body === null) {
        res.end()
        return undefined
      }
      const stream = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)
      res.on('close', () => { stream.destroy() })
      stream.on('error', () => { res.end() })
      stream.pipe(res)
      return undefined
    }

    const errorBody = await readUpstreamErrorBody(response)
    return { status: response.status, contentType, retryAfter, body: errorBody }
  }

  /** Pass one buffered upstream answer through untouched. */
  private writeUpstream(res: ServerResponse, upstream: BufferedUpstream): void {
    if (res.writableEnded) return
    res.statusCode = upstream.status
    res.setHeader('content-type', upstream.contentType ?? 'application/json; charset=utf-8')
    if (upstream.retryAfter !== null) res.setHeader('retry-after', upstream.retryAfter)
    res.setHeader('cache-control', 'no-store')
    res.end(upstream.body)
  }
}

/** Drain one bounded upstream error body for a later passthrough decision. */
async function readUpstreamErrorBody(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = (response.body as unknown as WebReadableStream<Uint8Array>).getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_UPSTREAM_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}
