/**
 * Server skill-execution client for the `/api/v1/skills/*` protocol.
 *
 * Every call goes through the shared authorized gateway client, so the only
 * replay is the single-flight 401 refresh-and-retry inside `authorizedJson`:
 * timeouts, disconnects, 5xx, and 429 responses are never replayed here.
 * Business failures keep their machine code and traceId instead of collapsing
 * into empty-data success.
 */

import { GatewayError, authorizedJson, type GsRequest, type GsSessionTokenSource } from './gs-client.ts'
import type {
  GsSkillCatalogResponse,
  GsSkillDefinitionResponse,
  GsSkillExecuteRequest,
  GsServerMeta,
} from './gs-contract.ts'

/** Default ceiling for one execute call when the caller sets no deadline. */
export const DEFAULT_SKILL_EXECUTE_TIMEOUT_MS = 120_000

/** Client-side outcome codes that never came from the server envelope. */
export const GS_SKILL_CLIENT_TIMEOUT_CODE = 'client_timeout'

/** Normalized result of one `POST /api/v1/skills/:name/execute` call. */
export type GsSkillExecuteOutcome =
  | {
    readonly status: 'ok'
    readonly requestId: string
    readonly traceId: string
    /** Text blocks joined in order. */
    readonly text: string
    readonly truncated: boolean
  }
  | {
    readonly status: 'error'
    /** Server machine code, the gateway envelope code, or `client_timeout`. */
    readonly code: string
    readonly message: string
    readonly traceId?: string
  }

/** Per-call controls shared by every method of the execution client. */
export interface GsSkillCallOptions {
  /** Caller-owned cancellation, forwarded to the fetch layer. */
  readonly signal?: AbortSignal
  /** Client-side ceiling for this call; omitted waits on the caller's signal alone. */
  readonly timeoutMs?: number
}

/** Inputs for the server skill-execution client. */
export interface GsSkillExecutionClientOptions {
  /** Effective gsclaw-server endpoint, read per request. */
  readonly endpoint: () => string
  /** Session source for the Bearer token and the 401 refresh retry. */
  readonly session: GsSessionTokenSource
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
}

/** Combined caller cancellation and an optional client-side timeout. */
interface LinkedSignal {
  readonly signal: AbortSignal
  /** Whether the caller's own signal fired (as opposed to the timeout). */
  readonly callerAborted: () => boolean
  /** Whether the client-side timeout fired. */
  readonly timedOut: () => boolean
  readonly release: () => void
}

function linkSignal(options: GsSkillCallOptions): LinkedSignal {
  const controller = new AbortController()
  let timedOut = false
  const caller = options.signal
  const onCallerAbort = () => { controller.abort(caller?.reason as unknown) }
  if (caller !== undefined) {
    if (caller.aborted) controller.abort(caller.reason as unknown)
    else caller.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timer = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`gsclaw-server skill execution timed out after ${String(options.timeoutMs)}ms`))
    }, options.timeoutMs)
  return {
    signal: controller.signal,
    callerAborted: () => caller?.aborted === true,
    timedOut: () => timedOut,
    release: () => {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Parse one execute body, refusing malformed envelopes instead of guessing. */
export function parseSkillExecuteResponse(value: unknown): GsSkillExecuteOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GatewayError('bad_response', 200, 'gsclaw-server returned a malformed execute response')
  }
  const record = value as Record<string, unknown>
  const traceId = typeof record.traceId === 'string' ? record.traceId : ''
  if (record.status === 'ok') {
    if (!Array.isArray(record.content)
      || record.content.some(block => typeof block !== 'object' || block === null
        || (block as { type?: unknown }).type !== 'text'
        || typeof (block as { text?: unknown }).text !== 'string')) {
      throw new GatewayError('bad_response', 200, 'gsclaw-server returned a malformed execute response')
    }
    return {
      status: 'ok',
      requestId: typeof record.requestId === 'string' ? record.requestId : '',
      traceId,
      text: (record.content as readonly { text: string }[]).map(block => block.text).join('\n'),
      truncated: record.truncated === true,
    }
  }
  const error = typeof record.error === 'object' && record.error !== null
    ? record.error as { code?: unknown, message?: unknown }
    : undefined
  return {
    status: 'error',
    code: typeof error?.code === 'string' ? error.code : 'execution_failed',
    message: typeof error?.message === 'string' ? error.message : 'gsclaw-server skill execution failed',
    ...(traceId === '' ? {} : { traceId }),
  }
}

/**
 * Authorized client for the server skill-execution protocol. The access token
 * never leaves the Host process: renderer and model only see arguments and
 * normalized results.
 */
export class GsSkillExecutionClient {
  constructor(private readonly options: GsSkillExecutionClientOptions) {}

  /** Server handshake metadata; the public `GET /api/v1/meta` needs no session. */
  async meta(options: GsSkillCallOptions = {}): Promise<GsServerMeta> {
    const linked = linkSignal(options)
    try {
      return await authorizedJson<GsServerMeta>({
        endpoint: this.options.endpoint(),
        path: '/api/v1/meta',
        session: this.options.session,
        signal: linked.signal,
        ...(this.options.request === undefined ? {} : { request: this.options.request }),
      })
    } finally {
      linked.release()
    }
  }

  /** Full catalog including the server-executed runtime types. */
  async catalog(options: GsSkillCallOptions = {}): Promise<GsSkillCatalogResponse> {
    const linked = linkSignal(options)
    try {
      return await authorizedJson<GsSkillCatalogResponse>({
        endpoint: this.options.endpoint(),
        path: '/api/v1/skills/catalog',
        session: this.options.session,
        signal: linked.signal,
        ...(this.options.request === undefined ? {} : { request: this.options.request }),
      })
    } finally {
      linked.release()
    }
  }

  /** Loadable definition of one server-executed skill. */
  async definition(skillName: string, options: GsSkillCallOptions = {}): Promise<GsSkillDefinitionResponse> {
    const linked = linkSignal(options)
    try {
      return await authorizedJson<GsSkillDefinitionResponse>({
        endpoint: this.options.endpoint(),
        path: `/api/v1/skills/${encodeURIComponent(skillName)}/definition`,
        session: this.options.session,
        signal: linked.signal,
        ...(this.options.request === undefined ? {} : { request: this.options.request }),
      })
    } finally {
      linked.release()
    }
  }

  /**
   * Execute one server-executed skill operation. Caller cancellation rethrows
   * the caller's abort reason; a client-side timeout and every server or
   * transport failure normalize into an `error` outcome — nothing is replayed.
   */
  async execute(
    skillName: string,
    request: GsSkillExecuteRequest,
    options: GsSkillCallOptions = {},
  ): Promise<GsSkillExecuteOutcome> {
    const linked = linkSignal({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs ?? DEFAULT_SKILL_EXECUTE_TIMEOUT_MS,
    })
    let body: unknown
    try {
      body = await authorizedJson<unknown>({
        endpoint: this.options.endpoint(),
        path: `/api/v1/skills/${encodeURIComponent(skillName)}/execute`,
        method: 'POST',
        body: request,
        session: this.options.session,
        signal: linked.signal,
        ...(this.options.request === undefined ? {} : { request: this.options.request }),
      })
    } catch (cause) {
      if (linked.callerAborted()) throw (options.signal?.reason ?? cause) as unknown
      if (linked.timedOut()) {
        return { status: 'error', code: GS_SKILL_CLIENT_TIMEOUT_CODE, message: 'gsclaw-server skill execution timed out' }
      }
      if (cause instanceof GatewayError) {
        return {
          status: 'error',
          code: cause.code,
          message: cause.message,
          ...(cause.traceId === undefined ? {} : { traceId: cause.traceId }),
        }
      }
      throw cause
    } finally {
      linked.release()
    }
    return parseSkillExecuteResponse(body)
  }
}
