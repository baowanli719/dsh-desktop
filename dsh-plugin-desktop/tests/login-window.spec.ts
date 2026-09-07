import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopLoginRpcEnvelope,
  DesktopLoginWindowInput,
} from '../src/login-contract.ts'
import { GatewayError } from '../src/server/gs-client.ts'
import type GsServerService from '../src/server/gs-server-service.ts'

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const windows: BrowserWindow[] = []
  class BrowserWindow {
    readonly onceListeners = new Map<string, Listener>()
    readonly listeners = new Map<string, Listener>()
    readonly webListeners = new Map<string, Listener>()
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: Listener) => { this.webListeners.set(event, listener) }),
      executeJavaScript: vi.fn(async () => undefined),
    }
    accessibleTitle = ''
    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    readonly removeMenu = vi.fn()
    readonly destroy = vi.fn()
    readonly loadFile = vi.fn(async () => {})
    readonly once = vi.fn((event: string, listener: Listener) => { this.onceListeners.set(event, listener) })
    readonly on = vi.fn((event: string, listener: Listener) => { this.listeners.set(event, listener) })
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) { windows.push(this) }
  }
  return {
    app: { isHidden: vi.fn(() => false), show: vi.fn() },
    BrowserWindow,
    windows,
  }
})

vi.mock('electron', () => ({ app: electron.app, BrowserWindow: electron.BrowserWindow }))

import {
  buildDesktopLoginRpcHref,
  desktopLoginRpcDeliveryScript,
  DESKTOP_LOGIN_RPC_HOOK,
  parseDesktopLoginResult,
  parseDesktopLoginRpc,
} from '../src/login-contract.ts'
import { DesktopLoginWindow, desktopLoginFailureEnvelope } from '../src/login-window.ts'

const input: DesktopLoginWindowInput = { platform: 'win32', clientVersion: '2.0.4' }

const sessionView = Object.freeze({
  status: 'signed-in' as const,
  endpoint: 'http://127.0.0.1:18300/gsclaw',
  user: Object.freeze({ id: 7, username: 'worker', displayName: '办公用户', role: 'user' }),
})

function serviceStub(): GsServerService {
  return {
    getMeta: vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:18300/gsclaw',
      meta: {
        serviceName: 'gsclaw-server',
        serviceVersion: '1.0.0',
        loginMethods: ['password', 'email_code'],
        minimumClientVersion: '2.0.0',
        llmProxy: true,
      },
    })),
    fetchCaptcha: vi.fn(async () => null),
    loginWithPassword: vi.fn(async () => sessionView),
    sendEmailCode: vi.fn(async () => ({ ok: true, maskedEmail: 'w***@example.com', expiresIn: 300, resendIn: 60 })),
    loginWithEmailCode: vi.fn(async () => sessionView),
  } as unknown as GsServerService
}

function navigate(window: InstanceType<typeof electron.BrowserWindow>, href: string): ReturnType<typeof vi.fn> {
  const event = { preventDefault: vi.fn() }
  const listener = window.webListeners.get('will-navigate') as ((navigationEvent: typeof event, href: string) => void) | undefined
  listener?.(event, href)
  return event.preventDefault
}

function deliveredEnvelopes(window: InstanceType<typeof electron.BrowserWindow>): DesktopLoginRpcEnvelope[] {
  const calls = window.webContents.executeJavaScript.mock.calls as unknown as [string][]
  return calls.map(([script]) => {
    const match = /^\w+\["__dshLoginRpcResolve"\]\(\d+,(".*")\)$/u.exec(script)
    expect(match).not.toBeNull()
    return JSON.parse(JSON.parse(match?.[1] ?? '""') as string) as DesktopLoginRpcEnvelope
  })
}

describe('desktop login result parser', () => {
  it('accepts only the parameter-free success navigation', () => {
    expect(parseDesktopLoginResult('dsh-login://success')).toEqual({ action: 'success' })
    expect(parseDesktopLoginResult('dsh-login://success?from=form')).toBeUndefined()
    expect(parseDesktopLoginResult('dsh-login://rpc?id=1&op=meta')).toBeUndefined()
    expect(parseDesktopLoginResult('https://success/')).toBeUndefined()
    expect(parseDesktopLoginResult('dsh-login://user:pass@success')).toBeUndefined()
    expect(parseDesktopLoginResult('dsh-login://success/#fragment')).toBeUndefined()
    expect(parseDesktopLoginResult(`dsh-login://success${'x'.repeat(8192)}`)).toBeUndefined()
    expect(parseDesktopLoginResult('not a url')).toBeUndefined()
  })
})

describe('desktop login RPC parser', () => {
  it('round-trips every operation through the href builder', () => {
    expect(parseDesktopLoginRpc(buildDesktopLoginRpcHref({ id: 1, op: 'meta' }))).toEqual({ id: 1, op: 'meta' })
    expect(parseDesktopLoginRpc(buildDesktopLoginRpcHref({ id: 2, op: 'captcha' }))).toEqual({ id: 2, op: 'captcha' })
    expect(parseDesktopLoginRpc(buildDesktopLoginRpcHref({
      id: 3,
      op: 'password-login',
      data: { username: 'worker', password: 'secret', captchaId: 'c1', captchaCode: '9' },
    }))).toEqual({
      id: 3,
      op: 'password-login',
      data: { username: 'worker', password: 'secret', captchaId: 'c1', captchaCode: '9' },
    })
    expect(parseDesktopLoginRpc(buildDesktopLoginRpcHref({ id: 4, op: 'email-code', data: { account: 'w' } })))
      .toEqual({ id: 4, op: 'email-code', data: { account: 'w' } })
    expect(parseDesktopLoginRpc(buildDesktopLoginRpcHref({ id: 5, op: 'email-login', data: { account: 'w', code: '123456' } })))
      .toEqual({ id: 5, op: 'email-login', data: { account: 'w', code: '123456' } })
  })

  it('rejects malformed, duplicated, mis-scoped, and oversized requests', () => {
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=1&op=unknown')).toBeUndefined()
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=-1&op=meta')).toBeUndefined()
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=1.5&op=meta')).toBeUndefined()
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=1&id=2&op=meta')).toBeUndefined()
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=1')).toBeUndefined()
    expect(parseDesktopLoginRpc('dsh-login://rpc?op=meta')).toBeUndefined()
    // Read operations never carry a body; credential operations always do.
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=1&op=meta&data=eyJ9')).toBeUndefined()
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=1&op=password-login')).toBeUndefined()
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=1&op=email-login')).toBeUndefined()
    // Malformed base64url and non-JSON bodies are rejected.
    expect(parseDesktopLoginRpc('dsh-login://rpc?id=1&op=email-code&data=!!!')).toBeUndefined()
    expect(parseDesktopLoginRpc(buildDesktopLoginRpcHref({ id: 6, op: 'email-code', data: 'x'.repeat(8192) }))).toBeUndefined()
    expect(parseDesktopLoginRpc('https://rpc?id=1&op=meta')).toBeUndefined()
  })

  it('serializes responses as a double-encoded hook call that server text cannot escape', () => {
    const envelope: DesktopLoginRpcEnvelope = {
      ok: false,
      error: '";process.exit(1);//</script>',
      code: 'invalid_credentials',
      status: 401,
    }
    const script = desktopLoginRpcDeliveryScript(7, envelope)
    expect(script.startsWith(`globalThis["${DESKTOP_LOGIN_RPC_HOOK}"](7,`)).toBe(true)
    let delivered: { id: number, payload: string } | undefined
    ;(globalThis as Record<string, unknown>)[DESKTOP_LOGIN_RPC_HOOK] = (id: number, payload: string) => {
      delivered = { id, payload }
    }
    try {
      ;(0, eval)(script)
      expect(delivered?.id).toBe(7)
      expect(JSON.parse(delivered?.payload ?? '')).toEqual(envelope)
    } finally {
      delete (globalThis as Record<string, unknown>)[DESKTOP_LOGIN_RPC_HOOK]
    }
  })
})

describe('desktopLoginFailureEnvelope', () => {
  it('maps gateway, storage, and unexpected failures onto the stable envelope', () => {
    const report = vi.fn()
    expect(desktopLoginFailureEnvelope(new GatewayError('rate_limited', 429, 'slow down', { retryAfter: 30 }), report))
      .toEqual({ ok: false, error: 'slow down', code: 'rate_limited', status: 429, retryAfter: 30 })
    expect(desktopLoginFailureEnvelope(new GatewayError('network', 0, 'gsclaw-server is unreachable'), report))
      .toEqual({ ok: false, error: 'gsclaw-server is unreachable', code: 'network', status: 0 })
    expect(desktopLoginFailureEnvelope(new Error('boom'), report))
      .toEqual({ ok: false, error: 'unexpected login failure', code: 'internal', status: 500 })
    expect(report).toHaveBeenCalledOnce()
  })
})

describe('DesktopLoginWindow', () => {
  beforeEach(() => {
    electron.windows.length = 0
    vi.clearAllMocks()
  })

  it('loads bounded local state in a sandboxed window with no IPC or new-window path', async () => {
    const result = new DesktopLoginWindow({ locale: 'zh', input, service: serviceStub() }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    const window = electron.windows[0]
    expect(window?.options).toEqual(expect.objectContaining({
      useContentSize: true,
      show: true,
      maximizable: false,
      fullscreenable: false,
      icon: expect.stringMatching(/app-icon\.png$/u),
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        partition: 'dsh-login',
      }),
    }))
    expect(window?.options.webPreferences).not.toHaveProperty('preload')
    const deny = window?.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as (() => unknown) | undefined
    expect(deny?.()).toEqual({ action: 'deny' })
    const loadCall = window?.loadFile.mock.calls[0] as unknown as [string, { query: Record<string, string> }] | undefined
    expect(loadCall?.[0]).toMatch(/[\\/]native-ui[\\/]login\.html$/u)
    expect(loadCall?.[1].query).toMatchObject({ locale: 'zh', platform: 'win32' })
    expect(JSON.parse(Buffer.from(loadCall?.[1].query.state ?? '', 'base64url').toString('utf8'))).toEqual(input)

    const prevented = navigate(window!, 'dsh-login://success')
    await expect(result).resolves.toEqual({ action: 'success' })
    expect(prevented).toHaveBeenCalledOnce()
    expect(window?.destroy).toHaveBeenCalledOnce()
  })

  it('executes renderer RPCs against the service and delivers the envelope', async () => {
    const service = serviceStub()
    const result = new DesktopLoginWindow({ locale: 'en', input, service }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    const window = electron.windows[0]!

    navigate(window, buildDesktopLoginRpcHref({ id: 1, op: 'meta' }))
    await vi.waitFor(() => { expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce() })
    expect(service.getMeta).toHaveBeenCalledOnce()
    expect(deliveredEnvelopes(window)[0]).toEqual(expect.objectContaining({ ok: true }))

    navigate(window, buildDesktopLoginRpcHref({ id: 2, op: 'password-login', data: { username: 'worker', password: 'secret' } }))
    await vi.waitFor(() => { expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2) })
    expect(service.loginWithPassword).toHaveBeenCalledWith({ username: 'worker', password: 'secret' })
    expect(deliveredEnvelopes(window)[1]).toEqual({ ok: true, data: sessionView })

    navigate(window, 'dsh-login://success')
    await expect(result).resolves.toEqual({ action: 'success' })
  })

  it('delivers gateway failures without leaking unexpected errors', async () => {
    const service = serviceStub()
    ;(service.loginWithEmailCode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new GatewayError('rate_limited', 429, 'too many attempts', { retryAfter: 42 }),
    )
    const reportError = vi.fn()
    const result = new DesktopLoginWindow({ locale: 'en', input, service, reportError }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    const window = electron.windows[0]!

    navigate(window, buildDesktopLoginRpcHref({ id: 1, op: 'email-login', data: { account: 'w', code: '000000' } }))
    await vi.waitFor(() => { expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce() })
    expect(deliveredEnvelopes(window)[0]).toEqual({
      ok: false,
      error: 'too many attempts',
      code: 'rate_limited',
      status: 429,
      retryAfter: 42,
    })

    navigate(window, buildDesktopLoginRpcHref({ id: 2, op: 'email-login', data: { code: '000000' } }))
    await vi.waitFor(() => { expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2) })
    expect(deliveredEnvelopes(window)[1]).toEqual(expect.objectContaining({ ok: false, code: 'bad_request', status: 400 }))
    expect(reportError).not.toHaveBeenCalled()

    window.listeners.get('closed')?.()
    await expect(result).resolves.toEqual({ action: 'quit' })
  })

  it('maps an ordinary window close to quit instead of success', async () => {
    const window_ = new DesktopLoginWindow({ locale: 'en', input, service: serviceStub() })
    const result = window_.run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    window_.show()
    expect(electron.windows[0]?.show).toHaveBeenCalledOnce()
    electron.windows[0]?.listeners.get('closed')?.()
    await expect(result).resolves.toEqual({ action: 'quit' })
    window_.show()
    expect(electron.windows[0]?.show).toHaveBeenCalledOnce()
  })

  it('reads a close after a completed login RPC as success', async () => {
    const result = new DesktopLoginWindow({ locale: 'en', input, service: serviceStub() }).run()
    await vi.waitFor(() => { expect(electron.windows).toHaveLength(1) })
    const window = electron.windows[0]!
    navigate(window, buildDesktopLoginRpcHref({ id: 1, op: 'email-login', data: { account: 'w', code: '123456' } }))
    await vi.waitFor(() => { expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce() })
    window.listeners.get('closed')?.()
    await expect(result).resolves.toEqual({ action: 'success' })
  })
})
