import { describe, expect, it } from 'vitest'
import {
  encodeDesktopLoginBase64Url,
  type DesktopLoginWindowInput,
} from '../src/login-contract.ts'
import { desktopLoginCopy, type DesktopLoginCopy } from '../src/login-copy.ts'
import {
  captchaFieldVisible,
  clientBelowMinimum,
  compareClientVersions,
  decodeDesktopLoginInput,
  desktopLoginFailureView,
  desktopLoginSubmitBlocked,
  resolveLoginMethod,
  tickCountdown,
  type DesktopLoginSubmitState,
} from '../src/native-ui/login/logic.ts'

const input: DesktopLoginWindowInput = { platform: 'darwin', clientVersion: '2.0.4' }

function loginSearch(state: DesktopLoginWindowInput = input): string {
  const query = new URLSearchParams({
    locale: 'zh',
    state: encodeDesktopLoginBase64Url(JSON.stringify(state)),
    platform: state.platform,
    frame: 'true',
  })
  return `?${query.toString()}`
}

function submitState(overrides: Partial<DesktopLoginSubmitState> = {}): DesktopLoginSubmitState {
  return {
    submitting: false,
    offline: false,
    clientTooOld: false,
    metaReady: true,
    lockRemaining: 0,
    account: 'worker',
    credential: 'secret',
    method: 'password',
    captchaSupported: true,
    captchaInput: '9',
    ...overrides,
  }
}

describe('client version gating', () => {
  it('compares dotted numeric versions segment by segment', () => {
    expect(compareClientVersions('2.0.4', '2.0.4')).toBe(0)
    expect(compareClientVersions('2.0.4', '2.0.5')).toBe(-1)
    expect(compareClientVersions('2.1.0', '2.0.9')).toBe(1)
    expect(compareClientVersions('2.0.4', '2.0.4.1')).toBe(-1)
    expect(compareClientVersions('2.0.4.1', '2.0.4')).toBe(1)
    expect(compareClientVersions('10.0.0', '9.9.9')).toBe(1)
    // Non-numeric suffixes parse as zero instead of failing the gate, and any
    // extra numeric suffix segment counts like a normal version segment.
    expect(compareClientVersions('2.0.4-alpha', '2.0.4')).toBe(0)
    expect(compareClientVersions('2.0.4-alpha.1', '2.0.4')).toBe(1)
  })

  it('blocks only clients strictly below the server minimum', () => {
    expect(clientBelowMinimum('2.0.4', '2.0.5')).toBe(true)
    expect(clientBelowMinimum('2.0.5', '2.0.5')).toBe(false)
    expect(clientBelowMinimum('2.0.6', '2.0.5')).toBe(false)
  })
})

describe('login form state', () => {
  it('prefers the email code and falls back to the advertised methods', () => {
    expect(resolveLoginMethod(['password', 'email_code'])).toBe('email_code')
    expect(resolveLoginMethod(['password'])).toBe('password')
    expect(resolveLoginMethod(['email_code'])).toBe('email_code')
    expect(resolveLoginMethod([])).toBe('email_code')
  })

  it('shows the captcha field only for password login on a supporting server', () => {
    expect(captchaFieldVisible('password', true)).toBe(true)
    expect(captchaFieldVisible('password', false)).toBe(false)
    expect(captchaFieldVisible('email_code', true)).toBe(false)
  })

  it('ticks countdowns down to zero and never below', () => {
    expect(tickCountdown(3)).toBe(2)
    expect(tickCountdown(1)).toBe(0)
    expect(tickCountdown(0)).toBe(0)
  })

  it('blocks submission on every transient or invalid form state', () => {
    expect(desktopLoginSubmitBlocked(submitState())).toBe(false)
    expect(desktopLoginSubmitBlocked(submitState({ submitting: true }))).toBe(true)
    expect(desktopLoginSubmitBlocked(submitState({ offline: true }))).toBe(true)
    expect(desktopLoginSubmitBlocked(submitState({ clientTooOld: true }))).toBe(true)
    expect(desktopLoginSubmitBlocked(submitState({ metaReady: false }))).toBe(true)
    expect(desktopLoginSubmitBlocked(submitState({ lockRemaining: 30 }))).toBe(true)
    expect(desktopLoginSubmitBlocked(submitState({ account: '  ' }))).toBe(true)
    expect(desktopLoginSubmitBlocked(submitState({ credential: '' }))).toBe(true)
    // Password login requires the captcha answer while the field exists.
    expect(desktopLoginSubmitBlocked(submitState({ captchaInput: ' ' }))).toBe(true)
    // A legacy server without captchas never blocks on the hidden field.
    expect(desktopLoginSubmitBlocked(submitState({ captchaInput: '', captchaSupported: false }))).toBe(false)
    // The email-code flow has no captcha requirement at all.
    expect(desktopLoginSubmitBlocked(submitState({ method: 'email_code', captchaInput: '' }))).toBe(false)
  })
})

describe('login failure mapping', () => {
  it('maps transport failures to the offline state', () => {
    expect(desktopLoginFailureView({ status: 0, message: 'unreachable' }, 'fallback'))
      .toEqual({ kind: 'offline' })
  })

  it('maps 429 to the lock countdown, defaulting to fifteen minutes', () => {
    expect(desktopLoginFailureView({ status: 429, retryAfter: 42 }, 'fallback'))
      .toEqual({ kind: 'locked', retryAfter: 42 })
    expect(desktopLoginFailureView({ status: 429 }, 'fallback'))
      .toEqual({ kind: 'locked', retryAfter: 900 })
    expect(desktopLoginFailureView({ status: 429, retryAfter: -5 }, 'fallback'))
      .toEqual({ kind: 'locked', retryAfter: 900 })
  })

  it('keeps the gateway message for ordinary failures', () => {
    expect(desktopLoginFailureView(new Error('密码或验证码错误'), 'fallback'))
      .toEqual({ kind: 'message', message: '密码或验证码错误' })
    expect(desktopLoginFailureView('boom', 'fallback'))
      .toEqual({ kind: 'message', message: 'fallback' })
  })
})

describe('login window input decoding', () => {
  it('round-trips the exact state tuple emitted by the main process', () => {
    expect(decodeDesktopLoginInput(loginSearch())).toEqual({ locale: 'zh', input, frame: true })
  })

  it('rejects partial, extra, mismatched, and malformed queries', () => {
    expect(decodeDesktopLoginInput('')).toBeUndefined()
    expect(decodeDesktopLoginInput(`${loginSearch()}&extra=1`)).toBeUndefined()
    expect(decodeDesktopLoginInput(loginSearch().replace('locale=zh', 'locale=fr'))).toBeUndefined()
    // The query platform must agree with the embedded state platform.
    expect(decodeDesktopLoginInput(loginSearch().replace('platform=darwin', 'platform=win32'))).toBeUndefined()
    expect(decodeDesktopLoginInput(loginSearch({ platform: 'linux', clientVersion: '' }))).toBeUndefined()
  })
})

describe('login copy', () => {
  it('provides the same key set in both locales', () => {
    const zh = desktopLoginCopy('zh')
    const en = desktopLoginCopy('en')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(zh) as (keyof DesktopLoginCopy)[]) {
      const value: unknown = zh[key]
      if (typeof value === 'function') {
        expect((value as (...args: unknown[]) => string)('x', 1)).toBeTruthy()
      } else {
        expect(value).toBeTruthy()
      }
    }
  })
})
