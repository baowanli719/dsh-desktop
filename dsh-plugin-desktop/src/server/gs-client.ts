/**
 * Low-level gsclaw-server HTTP client.
 *
 * The gateway speaks two error envelopes: legacy `/api/*` routes answer
 * `{ error, message }` while `/api/v1/*` routes answer `{ code, message,
 * traceId }`; rate limits add a `Retry-After` header. Both are normalized
 * into {@link GatewayError}. `authorizedJson` injects the in-memory access
 * token and performs the single-flight refresh-and-retry dance on an
 * expired-token 401.
 */

/** Maximum response body bytes accepted from the gateway. */
export const MAX_GS_RESPONSE_BYTES = 1024 * 1024

/** Fetch-compatible request function used against the gateway. */
export type GsRequest = (url: string, init: RequestInit) => Promise<Response>

/** Normalized gateway failure carrying both envelope shapes. */
export class GatewayError extends Error {
  constructor(
    /** Machine code from either envelope, or `http_<status>` as a fallback. */
    readonly code: string,
    /** HTTP status; zero marks a client-side transport failure. */
    readonly status: number,
    message: string,
    options: { readonly traceId?: string, readonly retryAfter?: number, readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GatewayError'
    if (options.traceId !== undefined) this.traceId = options.traceId
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter
  }

  readonly traceId?: string
  readonly retryAfter?: number
}

/** 401 codes from either envelope that mark an expired or invalid access token. */
const REFRESHABLE_AUTH_CODES = new Set(['token_expired', 'token_invalid', 'unauthorized'])

/** Whether one failure is an access-token rejection worth one refresh retry. */
export function isRefreshableAuthError(error: unknown): error is GatewayError {
  return error instanceof GatewayError
    && error.status === 401
    && REFRESHABLE_AUTH_CODES.has(error.code.toLowerCase())
}

/**
 * In-memory access-token source with a single-flight refresh.
 * Implemented by the auth state machine; defined here to keep this module
 * free of persistence concerns.
 */
export interface GsSessionTokenSource {
  /** Current in-memory access token, or undefined while signed out. */
  accessToken(): string | undefined
  /** Single-flight refresh resolving to a fresh access token. */
  refreshAccessToken(): Promise<string>
}

/** Inputs for one JSON request against the gateway. */
export interface GsJsonRequestOptions {
  /** Validated base endpoint, e.g. `http://127.0.0.1:18300/gsclaw`. */
  readonly endpoint: string
  /** Absolute API path beginning with `/`. */
  readonly path: string
  readonly method?: 'GET' | 'POST'
  /** JSON-serializable request body; omitted sends no body. */
  readonly body?: unknown
  /** Bearer token attached when present. */
  readonly accessToken?: string
  /** Caller-owned cancellation signal; the client creates no timeout. */
  readonly signal?: AbortSignal
  /** Response body byte cap; defaults to {@link MAX_GS_RESPONSE_BYTES}. */
  readonly maxBytes?: number
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
}

/** Inputs for one authorized JSON request. */
export type GsAuthorizedRequestOptions = Omit<GsJsonRequestOptions, 'accessToken'> & {
  /** Session source used for the Bearer token and the 401 refresh retry. */
  readonly session: GsSessionTokenSource
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

async function readLimitedText(response: Response, maxBytes = MAX_GS_RESPONSE_BYTES): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maxBytes)) {
    throw new GatewayError('response_too_large', response.status, 'gsclaw-server response is too large')
  }

  if (response.body === null) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new GatewayError('response_too_large', response.status, 'gsclaw-server response is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseRetryAfter(response: Response): number | undefined {
  if (response.status !== 429) return undefined
  const header = response.headers.get('retry-after')
  if (header === null || !/^[0-9]+$/u.test(header.trim())) return undefined
  return Number(header.trim())
}

/** Normalize one non-2xx gateway response into a {@link GatewayError}. */
export async function parseGatewayError(response: Response): Promise<GatewayError> {
  const retryAfter = parseRetryAfter(response)
  let body = ''
  try {
    body = await readLimitedText(response)
  } catch (cause) {
    if (cause instanceof GatewayError) return cause
  }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    value = undefined
  }
  const base = { ...(retryAfter === undefined ? {} : { retryAfter }) }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const message = typeof record.message === 'string' ? record.message : `gsclaw-server request failed (${String(response.status)})`
    if (typeof record.code === 'string') {
      // /api/v1/* envelope: { code, message, traceId }
      return new GatewayError(record.code, response.status, message, {
        ...base,
        ...(typeof record.traceId === 'string' ? { traceId: record.traceId } : {}),
      })
    }
    if (typeof record.error === 'string') {
      // legacy /api/* envelope: { error, message }
      return new GatewayError(record.error, response.status, message, base)
    }
  }
  return new GatewayError(`http_${String(response.status)}`, response.status,
    `gsclaw-server request failed (${String(response.status)})`, base)
}

/**
 * Run one JSON request against the gateway.
 * Resolves with the parsed body (undefined for empty 204 responses) and
 * rejects with {@link GatewayError} on transport and non-2xx outcomes.
 */
export async function gsJsonRequest<T>(options: GsJsonRequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.accessToken !== undefined) headers.Authorization = `Bearer ${options.accessToken}`
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    cache: 'no-store',
    redirect: 'error',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const request = options.request ?? defaultRequest

  let response: Response
  try {
    response = await request(`${options.endpoint}${options.path}`, init)
  } catch (cause) {
    throw new GatewayError('network', 0, 'gsclaw-server is unreachable', { cause })
  }
  if (!response.ok) throw await parseGatewayError(response)
  if (response.status === 204) return undefined as T
  const body = await readLimitedText(response, options.maxBytes)
  if (body === '') return undefined as T
  try {
    return JSON.parse(body) as T
  } catch (cause) {
    throw new GatewayError('bad_response', response.status, 'gsclaw-server returned malformed JSON', { cause })
  }
}

/**
 * Authorized variant of {@link gsJsonRequest}: injects the session Bearer
 * token, and on an expired-token 401 runs one single-flight refresh through
 * the session source before retrying the request exactly once.
 */
export async function authorizedJson<T>(options: GsAuthorizedRequestOptions): Promise<T> {
  const token = options.session.accessToken()
  if (token === undefined) {
    throw new GatewayError('unauthorized', 401, 'not signed in to gsclaw-server')
  }
  try {
    return await gsJsonRequest<T>({ ...options, accessToken: token })
  } catch (cause) {
    if (!isRefreshableAuthError(cause)) throw cause
    const refreshed = await options.session.refreshAccessToken()
    return gsJsonRequest<T>({ ...options, accessToken: refreshed })
  }
}
