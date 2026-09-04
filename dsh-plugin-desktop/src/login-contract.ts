/**
 * Wire contract for the pre-boot gsclaw-server login window.
 *
 * The login window runs before the Host boots, so the `/api/gs-server/*`
 * renderer routes do not exist yet. The renderer speaks to the main process
 * through one navigation channel, mirroring the Setup Wizard: requests are
 * `dsh-login://rpc` navigations intercepted by the window, responses are
 * pushed back through a single global hook evaluated by the main process,
 * and the terminal result is the parameter-free `dsh-login://success`
 * navigation. Credential material and gateway tokens never touch the
 * renderer; every operation is executed by the Host-owned GsServerService.
 */

/** Custom scheme owning every login-window navigation. */
export const DESKTOP_LOGIN_SCHEME = 'dsh-login:'

/** Exact href the renderer navigates to after a successful login. */
export const DESKTOP_LOGIN_SUCCESS_HREF = 'dsh-login://success'

/** Global hook the main process evaluates to deliver one RPC response. */
export const DESKTOP_LOGIN_RPC_HOOK = '__dshLoginRpcResolve'

const MAX_HREF_BYTES = 8192
const MAX_RPC_DATA_BYTES = 4096
const MAX_RPC_ID = Number.MAX_SAFE_INTEGER

/** Platforms the login window chrome understands. */
export type DesktopLoginPlatform = 'darwin' | 'win32' | 'linux'

/** Immutable boot inputs handed to the login document via its query state. */
export interface DesktopLoginWindowInput {
  readonly platform: DesktopLoginPlatform
  /** Running client version, checked against meta.minimumClientVersion. */
  readonly clientVersion: string
}

/** Strict terminal result of the login window; close maps to quit. */
export type DesktopLoginResult =
  | { readonly action: 'success' }
  | { readonly action: 'quit' }

/** Operations the renderer may ask the main process to perform. */
export const DESKTOP_LOGIN_RPC_OPS = Object.freeze([
  'meta',
  'captcha',
  'password-login',
  'email-code',
  'email-login',
] as const)

export type DesktopLoginRpcOp = (typeof DESKTOP_LOGIN_RPC_OPS)[number]

/** One validated RPC request decoded from a `dsh-login://rpc` navigation. */
export interface DesktopLoginRpcRequest {
  readonly id: number
  readonly op: DesktopLoginRpcOp
  readonly data?: unknown
}

/** Stable RPC response envelope pushed back into the login document. */
export type DesktopLoginRpcEnvelope =
  | { readonly ok: true, readonly data: unknown }
  | {
    readonly ok: false
    readonly error: string
    readonly code?: string
    readonly status?: number
    readonly retryAfter?: number
  }

/** Exact password-login payload accepted from the login document. */
export interface DesktopLoginPasswordData {
  readonly username: string
  readonly password: string
  readonly captchaId?: string
  readonly captchaCode?: string
}

/** Exact email-code payload accepted from the login document. */
export interface DesktopLoginEmailCodeData {
  readonly account: string
}

/** Exact email-login payload accepted from the login document. */
export interface DesktopLoginEmailLoginData {
  readonly account: string
  readonly code: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Validate the exact boot-input tuple produced by the main process. */
export function isDesktopLoginWindowInput(value: unknown): value is DesktopLoginWindowInput {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false
  if (value.platform !== 'darwin' && value.platform !== 'win32' && value.platform !== 'linux') return false
  return typeof value.clientVersion === 'string'
    && value.clientVersion.length > 0
    && value.clientVersion.length <= 64
}

/** Validate one password-login RPC payload. */
export function parseDesktopLoginPasswordData(value: unknown): DesktopLoginPasswordData | undefined {
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

/** Validate one email-code RPC payload. */
export function parseDesktopLoginEmailCodeData(value: unknown): DesktopLoginEmailCodeData | undefined {
  if (!isRecord(value) || typeof value.account !== 'string') return undefined
  return { account: value.account }
}

/** Validate one email-login RPC payload. */
export function parseDesktopLoginEmailLoginData(value: unknown): DesktopLoginEmailLoginData | undefined {
  if (!isRecord(value) || typeof value.account !== 'string' || typeof value.code !== 'string') return undefined
  return { account: value.account, code: value.code }
}

/** Portable base64url encoding shared by the main process and the document. */
export function encodeDesktopLoginBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Strict base64url decoding; undefined on any malformed or oversized input. */
export function decodeDesktopLoginBase64Url(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_RPC_DATA_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return undefined
  }
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = standard.padEnd(standard.length + (4 - standard.length % 4) % 4, '=')
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function parseBoundedUrl(href: string): URL | undefined {
  if (new TextEncoder().encode(href).byteLength > MAX_HREF_BYTES) return undefined
  let url: URL
  try { url = new URL(href) } catch { return undefined }
  if (url.protocol !== DESKTOP_LOGIN_SCHEME
    || url.username !== '' || url.password !== '' || url.port !== ''
    || url.pathname !== '' || url.hash !== '') return undefined
  return url
}

/** Parse only the parameter-free terminal success navigation. */
export function parseDesktopLoginResult(href: string): { readonly action: 'success' } | undefined {
  const url = parseBoundedUrl(href)
  if (url === undefined || url.hostname !== 'success') return undefined
  if ([...url.searchParams.keys()].length !== 0) return undefined
  return Object.freeze({ action: 'success' as const })
}

/** Parse one bounded RPC request generated by the local login document. */
export function parseDesktopLoginRpc(href: string): DesktopLoginRpcRequest | undefined {
  const url = parseBoundedUrl(href)
  if (url === undefined || url.hostname !== 'rpc') return undefined
  const keys = [...url.searchParams.keys()]
  if (keys.some(key => key !== 'id' && key !== 'op' && key !== 'data')) return undefined
  if (url.searchParams.getAll('id').length !== 1 || url.searchParams.getAll('op').length !== 1) return undefined
  const rawId = url.searchParams.get('id') ?? ''
  if (!/^(?:0|[1-9]\d*)$/u.test(rawId)) return undefined
  const id = Number(rawId)
  if (!Number.isSafeInteger(id) || id > MAX_RPC_ID) return undefined
  const rawOp = url.searchParams.get('op')
  const op = DESKTOP_LOGIN_RPC_OPS.find(candidate => candidate === rawOp)
  if (op === undefined) return undefined
  const dataValues = url.searchParams.getAll('data')
  if (dataValues.length > 1) return undefined
  let data: unknown
  if (dataValues.length === 1) {
    const decoded = decodeDesktopLoginBase64Url(dataValues[0] ?? '')
    if (decoded === undefined) return undefined
    try {
      data = JSON.parse(decoded) as unknown
    } catch {
      return undefined
    }
  }
  // Only the credential operations carry a body; the reads never do.
  if ((op === 'meta' || op === 'captcha') !== (data === undefined)) return undefined
  return Object.freeze({
    id,
    op,
    ...(data === undefined ? {} : { data: data as unknown }),
  })
}

/** Build the exact RPC href the document navigates to for one request. */
export function buildDesktopLoginRpcHref(request: DesktopLoginRpcRequest): string {
  const url = new URL('dsh-login://rpc')
  url.searchParams.set('id', String(request.id))
  url.searchParams.set('op', request.op)
  if (request.data !== undefined) {
    url.searchParams.set('data', encodeDesktopLoginBase64Url(JSON.stringify(request.data)))
  }
  return url.href
}

/**
 * Serialize one RPC response into the script the main process evaluates.
 * The envelope is double-encoded as a JSON string literal so server-provided
 * text can never break out of the evaluated expression.
 */
export function desktopLoginRpcDeliveryScript(id: number, envelope: DesktopLoginRpcEnvelope): string {
  return `globalThis[${JSON.stringify(DESKTOP_LOGIN_RPC_HOOK)}](${JSON.stringify(id)},${JSON.stringify(JSON.stringify(envelope))})`
}
