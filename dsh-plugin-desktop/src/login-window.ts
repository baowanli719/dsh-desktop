/** Isolated pre-Host gsclaw-server login window with a strict result channel. */

import { BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import {
  auxiliaryWindowChromeOptions,
  auxiliaryWindowHasCustomFrame,
} from './auxiliary-window-options.ts'
import { revealApplication } from './electron-reveal.ts'
import {
  desktopLoginRpcDeliveryScript,
  isDesktopLoginWindowInput,
  parseDesktopLoginEmailCodeData,
  parseDesktopLoginEmailLoginData,
  parseDesktopLoginPasswordData,
  parseDesktopLoginResult,
  parseDesktopLoginRpc,
  type DesktopLoginRpcEnvelope,
  type DesktopLoginRpcOp,
  type DesktopLoginRpcRequest,
  type DesktopLoginResult,
  type DesktopLoginWindowInput,
} from './login-contract.ts'
import { desktopLoginCopy } from './login-copy.ts'
import type { DesktopLocale } from './runtime.ts'
import { GsAuthStorageError } from './server/gs-auth.ts'
import { GatewayError } from './server/gs-client.ts'
import type GsServerService from './server/gs-server-service.ts'

const LOGIN_DOCUMENT = fileURLToPath(new URL('./native-ui/login.html', import.meta.url))

export interface DesktopLoginWindowOptions {
  readonly locale: DesktopLocale
  readonly input: DesktopLoginWindowInput
  /** Pre-boot gsclaw-server client executing every renderer RPC. */
  readonly service: GsServerService
  readonly reportError?: (operation: string, cause: unknown) => void
}

function invalidRequestEnvelope(): DesktopLoginRpcEnvelope {
  return Object.freeze({ ok: false as const, error: 'invalid login request', code: 'bad_request', status: 400 })
}

/** Map one service failure onto the stable renderer error envelope. */
export function desktopLoginFailureEnvelope(
  cause: unknown,
  reportError: (operation: string, cause: unknown) => void,
): DesktopLoginRpcEnvelope {
  if (cause instanceof GatewayError) {
    return Object.freeze({
      ok: false as const,
      error: cause.message,
      code: cause.code,
      status: cause.status,
      ...(cause.retryAfter === undefined ? {} : { retryAfter: cause.retryAfter }),
    })
  }
  if (cause instanceof GsAuthStorageError) {
    return Object.freeze({
      ok: false as const,
      error: cause.message,
      code: 'safe_storage_unavailable',
      status: 503,
    })
  }
  reportError('run gs-server login operation', cause)
  return Object.freeze({ ok: false as const, error: 'unexpected login failure', code: 'internal', status: 500 })
}

/** One-shot native login window; close is distinct from a successful login. */
export class DesktopLoginWindow {
  private started = false
  private window: BrowserWindow | undefined

  constructor(private readonly options: DesktopLoginWindowOptions) {}

  /** Bring the running login window forward for app activation and second-instance events. */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    revealApplication(window, this.options.input.platform)
  }

  private async perform(
    request: DesktopLoginRpcRequest,
    reportError: (operation: string, cause: unknown) => void,
  ): Promise<{ readonly envelope: DesktopLoginRpcEnvelope, readonly signedIn: boolean }> {
    const { service } = this.options
    const run = async (op: DesktopLoginRpcOp, data: unknown): Promise<{ envelope: DesktopLoginRpcEnvelope, signedIn: boolean }> => {
      switch (op) {
        case 'meta':
          return { envelope: { ok: true, data: await service.getMeta() }, signedIn: false }
        case 'captcha':
          return { envelope: { ok: true, data: await service.fetchCaptcha() }, signedIn: false }
        case 'password-login': {
          const login = parseDesktopLoginPasswordData(data)
          if (login === undefined) return { envelope: invalidRequestEnvelope(), signedIn: false }
          return { envelope: { ok: true, data: await service.loginWithPassword(login) }, signedIn: true }
        }
        case 'email-code': {
          const body = parseDesktopLoginEmailCodeData(data)
          if (body === undefined) return { envelope: invalidRequestEnvelope(), signedIn: false }
          return { envelope: { ok: true, data: await service.sendEmailCode(body.account) }, signedIn: false }
        }
        case 'email-login': {
          const login = parseDesktopLoginEmailLoginData(data)
          if (login === undefined) return { envelope: invalidRequestEnvelope(), signedIn: false }
          return { envelope: { ok: true, data: await service.loginWithEmailCode(login) }, signedIn: true }
        }
      }
    }
    try {
      return await run(request.op, request.data)
    } catch (cause) {
      return { envelope: desktopLoginFailureEnvelope(cause, reportError), signedIn: false }
    }
  }

  async run(): Promise<DesktopLoginResult> {
    if (this.started) throw new Error('dsh-plugin-desktop: login window can only run once')
    this.started = true
    if (!isDesktopLoginWindowInput(this.options.input)) {
      throw new TypeError('dsh-plugin-desktop: invalid login window input')
    }
    const { input } = this.options
    const reportError = this.options.reportError ?? (() => {})
    const copy = desktopLoginCopy(this.options.locale)
    const state = Buffer.from(JSON.stringify(input), 'utf8').toString('base64url')
    const customFrame = auxiliaryWindowHasCustomFrame(input.platform)
    const window = new BrowserWindow({
      title: copy.title,
      ...auxiliaryWindowChromeOptions(input.platform),
      width: 440,
      height: 700,
      minWidth: 380,
      minHeight: 620,
      useContentSize: true,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      // Mirror the Setup Wizard: the first hidden Win32 HWND may never accept
      // show(), so the login surface starts visible on Windows.
      show: input.platform === 'win32',
      autoHideMenuBar: true,
      backgroundColor: '#202124',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        partition: 'dsh-login',
      },
    })
    this.window = window
    window.accessibleTitle = copy.title
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })

    return await new Promise<DesktopLoginResult>((resolve, reject) => {
      let settled = false
      // A completed login RPC means the Host already holds the session; an
      // accidental close before the success navigation must not read as quit.
      let signedIn = false
      const finish = (result: DesktopLoginResult): void => {
        if (settled) return
        settled = true
        if (this.window === window) this.window = undefined
        if (!window.isDestroyed()) window.destroy()
        resolve(result)
      }
      const respond = (request: DesktopLoginRpcRequest): void => {
        void this.perform(request, reportError).then(({ envelope, signedIn: ok }) => {
          if (ok) signedIn = true
          if (settled || window.isDestroyed()) return
          return window.webContents.executeJavaScript(
            desktopLoginRpcDeliveryScript(request.id, envelope),
          ).catch((cause: unknown) => {
            reportError('deliver gs-server login response', cause)
          })
        })
      }
      const navigate = (event: Electron.Event, href: string): void => {
        event.preventDefault()
        const result = parseDesktopLoginResult(href)
        if (result !== undefined) {
          finish(result)
          return
        }
        const request = parseDesktopLoginRpc(href)
        if (request !== undefined) respond(request)
      }
      window.webContents.on('will-navigate', navigate)
      window.webContents.on('will-redirect', navigate)
      window.once('ready-to-show', () => {
        if (!settled && this.window === window && !window.isDestroyed()) {
          revealApplication(window, input.platform)
        }
      })
      window.on('closed', () => {
        if (this.window === window) this.window = undefined
        finish(signedIn
          ? Object.freeze({ action: 'success' as const })
          : Object.freeze({ action: 'quit' as const }))
      })
      void window.loadFile(LOGIN_DOCUMENT, {
        query: {
          locale: this.options.locale,
          state,
          platform: input.platform,
          frame: String(customFrame),
        },
      }).catch((cause: unknown) => {
        if (settled) return
        settled = true
        if (this.window === window) this.window = undefined
        if (!window.isDestroyed()) window.destroy()
        reject(cause)
      })
    })
  }
}
