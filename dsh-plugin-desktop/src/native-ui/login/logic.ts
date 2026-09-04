/**
 * Pure form-state logic for the login document.
 *
 * Everything here is headless-testable: version gating, method resolution,
 * captcha visibility, submit blocking, countdown ticking, and failure mapping.
 */

import {
  decodeDesktopLoginBase64Url,
  isDesktopLoginWindowInput,
  type DesktopLoginWindowInput,
} from '../../login-contract.ts'
import type { DesktopLocale } from '../../runtime.ts'

export type DesktopLoginMethod = 'password' | 'email_code'

/** Semantic-ish numeric compare of dotted versions; returns -1 / 0 / 1. */
export function compareClientVersions(current: string, minimum: string): number {
  const parse = (value: string): number[] => value.split(/[.-]/u).map(part => Number.parseInt(part, 10) || 0)
  const left = parse(current)
  const right = parse(minimum)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** Whether the running client is below the server-required minimum. */
export function clientBelowMinimum(current: string, minimum: string): boolean {
  return compareClientVersions(current, minimum) < 0
}

/** Default to the email code; fall back to the server's first method. */
export function resolveLoginMethod(methods: readonly string[]): DesktopLoginMethod {
  if (methods.includes('email_code')) return 'email_code'
  if (methods.includes('password')) return 'password'
  return 'email_code'
}

/** The captcha field only exists for password login on a supporting server. */
export function captchaFieldVisible(method: DesktopLoginMethod, captchaSupported: boolean): boolean {
  return method === 'password' && captchaSupported
}

/** One countdown interval tick; never below zero. */
export function tickCountdown(value: number): number {
  return Math.max(value - 1, 0)
}

/** Renderer view of one failed login operation. */
export type DesktopLoginFailureView =
  | { readonly kind: 'offline' }
  | { readonly kind: 'locked', readonly retryAfter: number }
  | { readonly kind: 'message', readonly message: string }

const DEFAULT_LOCK_SECONDS = 15 * 60

/**
 * Map one RPC failure onto display state: status 0 is an unreachable server,
 * 429 starts the retryAfter lock countdown, everything else is its message.
 */
export function desktopLoginFailureView(cause: unknown, fallback: string): DesktopLoginFailureView {
  const status = (cause as { readonly status?: unknown } | null)?.status
  if (status === 0) return { kind: 'offline' }
  if (status === 429) {
    const retryAfter = (cause as { readonly retryAfter?: unknown }).retryAfter
    return {
      kind: 'locked',
      retryAfter: typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter)
        : DEFAULT_LOCK_SECONDS,
    }
  }
  return { kind: 'message', message: cause instanceof Error ? cause.message : fallback }
}

/** Inputs of the submit-button guard, kept flat for focused unit tests. */
export interface DesktopLoginSubmitState {
  readonly submitting: boolean
  readonly offline: boolean
  readonly clientTooOld: boolean
  readonly metaReady: boolean
  readonly lockRemaining: number
  readonly account: string
  readonly credential: string
  readonly method: DesktopLoginMethod
  readonly captchaSupported: boolean
  readonly captchaInput: string
}

/** Whether the submit button must stay disabled. */
export function desktopLoginSubmitBlocked(state: DesktopLoginSubmitState): boolean {
  if (state.submitting || state.offline || state.clientTooOld || !state.metaReady) return true
  if (state.lockRemaining > 0) return true
  if (state.account.trim().length === 0 || state.credential.trim().length === 0) return true
  return captchaFieldVisible(state.method, state.captchaSupported) && state.captchaInput.trim().length === 0
}

/** Decode only the exact state/query tuple emitted by DesktopLoginWindow. */
export function decodeDesktopLoginInput(
  search: string,
): { readonly locale: DesktopLocale, readonly input: DesktopLoginWindowInput, readonly frame: boolean } | undefined {
  const query = new URLSearchParams(search)
  const expected = ['locale', 'state', 'platform', 'frame']
  const keys = [...query.keys()]
  if (keys.length !== expected.length
    || keys.some(key => !expected.includes(key))
    || expected.some(key => query.getAll(key).length !== 1)) return undefined
  const locale = query.get('locale')
  const frame = query.get('frame')
  if ((locale !== 'en' && locale !== 'zh') || (frame !== 'true' && frame !== 'false')) return undefined
  const state = query.get('state')
  if (state === null) return undefined
  const decoded = decodeDesktopLoginBase64Url(state)
  if (decoded === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(decoded) as unknown } catch { return undefined }
  if (!isDesktopLoginWindowInput(value) || query.get('platform') !== value.platform) return undefined
  return Object.freeze({ locale, input: value, frame: frame === 'true' })
}
