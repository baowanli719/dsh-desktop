/**
 * Host-owned gsclaw-server client service.
 *
 * Composes the endpoint store, the authentication state machine, and the
 * ClientConfig cache into the `gsServer` Cordis service consumed by the
 * desktop shell routes and, in later stages, profile composition and the
 * LLM proxy.
 */

import {
  GsAuthService,
  type GsAuthSnapshot,
  type GsClientIdentity,
  type GsEmailLogin,
  type GsPasswordLogin,
  type GsSafeStorage,
} from './gs-auth.ts'
import { GsBrandStore } from './gs-brand.ts'
import type { GsRequest } from './gs-client.ts'
import { GsClientConfigCache, type GsClientConfigSnapshot } from './gs-config.ts'
import type {
  GsCaptcha,
  GsClientConfig,
  GsEmailCodeResponse,
  GsServerMetaView,
  GsSessionView,
} from './gs-contract.ts'
import { GsEndpointStore } from './gs-endpoint.ts'

/** Inputs for the Host-owned gsclaw-server client. */
export interface GsServerServiceOptions {
  /** Absolute Electron userData directory for endpoint and credential state. */
  readonly userDataDir: string
  /** Environment endpoint override; defaults to the GSCLAW_ENDPOINT seam. */
  readonly environment?: string | undefined
  /** OS-backed secret storage for the refresh token. */
  readonly safeStorage: GsSafeStorage
  /** Client identity embedded in login and refresh requests. */
  readonly client: GsClientIdentity
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
  /** Fired when the server rejects the session; logout does not fire it. */
  readonly onSessionLost?: (reason: 'expired' | 'disabled') => void
}

/** Cordis service face of the gsclaw-server client layer. */
export class GsServerService {
  /** Absolute Electron userData directory backing endpoint and credential state. */
  readonly userDataDir: string
  readonly endpoints: GsEndpointStore
  readonly auth: GsAuthService
  readonly config: GsClientConfigCache
  readonly brand: GsBrandStore

  private constructor(
    userDataDir: string,
    endpoints: GsEndpointStore,
    auth: GsAuthService,
    config: GsClientConfigCache,
    brand: GsBrandStore,
  ) {
    this.userDataDir = userDataDir
    this.endpoints = endpoints
    this.auth = auth
    this.config = config
    this.brand = brand
    // Every ClientConfig push refreshes the brand store; a persist failure
    // only loses the offline cache, so it never faults the push path.
    this.config.subscribe((snapshot) => {
      void this.brand.applyServerBrand(snapshot?.config.brand).catch(() => {})
    })
  }

  /** Load persisted endpoint and brand state and compose the client layer. */
  static async load(options: GsServerServiceOptions): Promise<GsServerService> {
    const endpoints = await GsEndpointStore.load({
      userDataDir: options.userDataDir,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    })
    const brand = await GsBrandStore.load({ userDataDir: options.userDataDir })
    let config: GsClientConfigCache | undefined
    const auth = new GsAuthService({
      endpoint: () => endpoints.resolve(),
      userDataDir: options.userDataDir,
      safeStorage: options.safeStorage,
      client: options.client,
      ...(options.request === undefined ? {} : { request: options.request }),
      onConfig: (user, next) => { config?.update(user, next) },
      onSessionLost: (reason) => {
        config?.clear()
        options.onSessionLost?.(reason)
      },
    })
    config = new GsClientConfigCache({
      endpoint: () => endpoints.resolve(),
      session: auth,
      ...(options.request === undefined ? {} : { request: options.request }),
    })
    return new GsServerService(options.userDataDir, endpoints, auth, config, brand)
  }

  /** Token-free session view for renderer projections. */
  sessionView(): GsSessionView {
    return { endpoint: this.endpoints.resolve(), ...this.auth.snapshot() }
  }

  /** Live server handshake against the effective endpoint. */
  async getMeta(): Promise<GsServerMetaView> {
    const meta = await this.auth.getMeta()
    // The pre-login handshake doubles as the brand delivery channel; servers
    // that predate the field simply omit it and keep the cached brand.
    if (meta.brand !== undefined) {
      await this.brand.applyServerBrand(meta.brand).catch(() => {})
    }
    return { endpoint: this.endpoints.resolve(), meta }
  }

  /** One-time graphical captcha; null when the server predates captchas. */
  fetchCaptcha(): Promise<GsCaptcha | null> {
    return this.auth.fetchCaptcha()
  }

  /** Password login; resolves with the fresh session view. */
  async loginWithPassword(login: GsPasswordLogin): Promise<GsSessionView> {
    await this.auth.loginWithPassword(login)
    return this.sessionView()
  }

  /** Send one email verification code to the account's registered address. */
  sendEmailCode(account: string): Promise<GsEmailCodeResponse> {
    return this.auth.sendEmailCode(account)
  }

  /** Email-code login; resolves with the fresh session view. */
  async loginWithEmailCode(login: GsEmailLogin): Promise<GsSessionView> {
    await this.auth.loginWithEmailCode(login)
    return this.sessionView()
  }

  /** Restore the persisted session after a restart, single-flight. */
  restoreSession(): Promise<boolean> {
    return this.auth.restoreSession()
  }

  /** Actively pull `/api/client-config` and update the cache. */
  getClientConfig(): Promise<GsClientConfigSnapshot> {
    return this.config.getClientConfig()
  }

  /** Latest pushed ClientConfig, or undefined before the first login. */
  clientConfig(): GsClientConfig | undefined {
    return this.config.snapshot()?.config
  }

  /** Revoke the session family and drop all local credential state. */
  async logout(): Promise<GsAuthSnapshot> {
    await this.auth.logout()
    this.config.clear()
    return this.auth.snapshot()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned gsclaw-server client: endpoint, auth, and ClientConfig cache. */
    gsServer: GsServerService
  }
}

export default GsServerService
