/**
 * Strict loopback HTTP handlers for the private gs-server client API.
 *
 * The bundled renderer talks to these routes instead of holding gateway
 * tokens itself; credential state never leaves the main process.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginLoopbackRequest } from '../desktop-settings-route.ts'
import { GsAuthStorageError } from './gs-auth.ts'
import { GatewayError } from './gs-client.ts'
import type {
  GsEmailCodeRequest,
  GsEmailLoginRequest,
  GsPasswordLoginRequest,
  GsServerErrorResponse,
  GsSkillsView,
} from './gs-contract.ts'
import type GsServerService from './gs-server-service.ts'

const MAX_GS_ROUTE_BODY_BYTES = 16 * 1024

class BodyTooLargeError extends Error {}

function finishJson(
  res: ServerResponse,
  statusCode: number,
  value: object,
  allow?: 'GET' | 'POST',
): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function error(
  message: string,
  detail: { readonly code?: string, readonly retryAfter?: number } = {},
): GsServerErrorResponse {
  return {
    error: message,
    ...(detail.code === undefined ? {} : { code: detail.code }),
    ...(detail.retryAfter === undefined ? {} : { retryAfter: detail.retryAfter }),
  }
}

/** Map gateway and storage failures onto the stable renderer error shape. */
function finishOperationFailure(res: ServerResponse, cause: unknown): void {
  if (cause instanceof GatewayError) {
    finishJson(res, cause.status === 0 ? 502 : cause.status, error(cause.message, {
      code: cause.code,
      ...(cause.retryAfter === undefined ? {} : { retryAfter: cause.retryAfter }),
    }))
    return
  }
  if (cause instanceof GsAuthStorageError) {
    finishJson(res, 503, error(cause.message, { code: 'safe_storage_unavailable' }))
    return
  }
  throw cause
}

function isJsonRequest(req: IncomingMessage): boolean {
  return req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) throw new SyntaxError('invalid content length')
    if (Number(declaredLength) > MAX_GS_ROUTE_BODY_BYTES) throw new BodyTooLargeError()
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_GS_ROUTE_BODY_BYTES) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

const INVALID_BODY = Symbol('invalid body')

async function parsePostBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | typeof INVALID_BODY> {
  if (!isJsonRequest(req)) {
    finishJson(res, 415, error('content type must be application/json'))
    return INVALID_BODY
  }
  try {
    return await readJson(req)
  } catch (cause) {
    const tooLarge = cause instanceof BodyTooLargeError
    finishJson(res, tooLarge ? 413 : 400, error(tooLarge ? 'request body is too large' : 'invalid JSON request'))
    return INVALID_BODY
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parsePasswordLoginRequest(value: unknown): GsPasswordLoginRequest | undefined {
  if (!isRecord(value) || typeof value.username !== 'string' || typeof value.password !== 'string') return undefined
  const captchaId = optionalString(value.captchaId)
  const captchaCode = optionalString(value.captchaCode)
  return {
    username: value.username,
    password: value.password,
    ...(captchaId === undefined ? {} : { captchaId }),
    ...(captchaCode === undefined ? {} : { captchaCode }),
  }
}

function parseEmailCodeRequest(value: unknown): GsEmailCodeRequest | undefined {
  if (!isRecord(value) || typeof value.account !== 'string') return undefined
  return { account: value.account }
}

function parseEmailLoginRequest(value: unknown): GsEmailLoginRequest | undefined {
  if (!isRecord(value) || typeof value.account !== 'string' || typeof value.code !== 'string') return undefined
  return { account: value.account, code: value.code }
}

function isEmptyRequest(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0
}

type ReportError = (operation: string, cause: unknown) => void

/** Serve the configured endpoint plus the live server handshake. */
export async function handleGsServerMetaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServerService,
  reportError: ReportError = () => {},
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, error('method not allowed'), 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, error('forbidden'))
  }
  try {
    finishJson(res, 200, await service.getMeta())
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('read gs-server meta', unexpected)
      finishJson(res, 500, error('gs-server metadata unavailable'))
    }
  }
}

/** Serve the token-free session view. */
export async function handleGsSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServerService,
  // Uniform with the other gs-server handlers so routes compose in one table.
  _reportError: ReportError = () => {},
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, error('method not allowed'), 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, error('forbidden'))
  }
  finishJson(res, 200, service.sessionView())
}

/** Serve the effective brand copy resolved by the Host brand store. */
export async function handleGsBrandRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServerService,
  // Uniform with the other gs-server handlers so routes compose in one table.
  _reportError: ReportError = () => {},
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, error('method not allowed'), 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, error('forbidden'))
  }
  finishJson(res, 200, service.brand.view())
}

/** Serve the server-skill catalog and its latest sync status. */
export async function handleGsSkillsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  // Resolved lazily per request so the route does not depend on plugin load order.
  readSkillsView: () => Promise<GsSkillsView>,
  reportError: ReportError = () => {},
  setEnabled?: (name: string, enabled: boolean) => Promise<void>,
  // The POST response reads the tracker snapshot directly: setEnabled already
  // refreshed it, and a registry re-list here would force a full server
  // re-sync (and a syncedAt bump) on every toggle.
  readSkillsSnapshot?: () => GsSkillsView,
): Promise<void> {
  if (req.method !== 'GET' && !(req.method === 'POST' && setEnabled !== undefined)) return finishJson(res, 405, error('method not allowed'), 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, req.method === 'POST')) {
    return finishJson(res, 403, error('forbidden'))
  }
  try {
    if (req.method === 'POST') {
      const body = await parsePostBody(req, res)
      if (body === INVALID_BODY) return
      if (!isRecord(body) || typeof body.name !== 'string' || body.name.length > 256
        || typeof body.enabled !== 'boolean' || Object.keys(body).some(key => key !== 'name' && key !== 'enabled')) {
        return finishJson(res, 400, error('invalid skill preference'))
      }
      // Refresh visibility before accepting a user choice.
      const view = await readSkillsView()
      if (view.status !== 'ok' || view.masterOff || !view.skills.some(skill => skill.name === body.name && skill.available !== false)) {
        return finishJson(res, 409, error('skill unavailable'))
      }
      await setEnabled?.(body.name, body.enabled)
      if (readSkillsSnapshot !== undefined) return finishJson(res, 200, readSkillsSnapshot())
    }
    finishJson(res, 200, await readSkillsView())
  } catch (cause) {
    reportError('read gs-server skills', cause)
    finishJson(res, 500, error('gs-server skills unavailable'))
  }
}

/** Issue a fresh graphical captcha, or null on a legacy server. */
export async function handleGsCaptchaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServerService,
  reportError: ReportError = () => {},
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, error('method not allowed'), 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, error('forbidden'))
  }
  try {
    finishJson(res, 200, { captcha: await service.fetchCaptcha() })
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('issue gs-server captcha', unexpected)
      finishJson(res, 500, error('gs-server captcha unavailable'))
    }
  }
}

/** Password login through the Host-owned credential channel. */
export async function handleGsLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServerService,
  reportError: ReportError = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parsePasswordLoginRequest(value)
  if (request === undefined) return finishJson(res, 400, error('invalid login request'))
  try {
    finishJson(res, 200, await service.loginWithPassword(request))
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('gs-server login', unexpected)
      finishJson(res, 500, error('gs-server login failed'))
    }
  }
}

/** Send one email verification code for the submitted account. */
export async function handleGsEmailCodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServerService,
  reportError: ReportError = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseEmailCodeRequest(value)
  if (request === undefined) return finishJson(res, 400, error('invalid email code request'))
  try {
    finishJson(res, 200, await service.sendEmailCode(request.account))
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('send gs-server email code', unexpected)
      finishJson(res, 500, error('email code could not be sent'))
    }
  }
}

/** Email-code login through the Host-owned credential channel. */
export async function handleGsEmailLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServerService,
  reportError: ReportError = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseEmailLoginRequest(value)
  if (request === undefined) return finishJson(res, 400, error('invalid email login request'))
  try {
    finishJson(res, 200, await service.loginWithEmailCode(request))
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('gs-server email login', unexpected)
      finishJson(res, 500, error('gs-server email login failed'))
    }
  }
}

/** Revoke the session family and drop all local credential state. */
export async function handleGsLogoutRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServerService,
  reportError: ReportError = () => {},
  onLoggedOut: () => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  if (!isEmptyRequest(value)) return finishJson(res, 400, error('invalid logout request'))
  try {
    await service.logout()
    finishJson(res, 200, { accepted: true })
    onLoggedOut()
  } catch (cause) {
    reportError('gs-server logout', cause)
    finishJson(res, 500, error('gs-server logout failed'))
  }
}
