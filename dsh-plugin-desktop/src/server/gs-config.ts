/**
 * ClientConfig cache for the gsclaw-server client layer.
 *
 * Login and refresh responses push the effective config; `getClientConfig()`
 * actively pulls `/api/client-config`. Later stages (profile composition,
 * LLM proxy, skill provider) subscribe to snapshots instead of polling.
 */

import {
  authorizedJson,
  type GsRequest,
  type GsSessionTokenSource,
} from './gs-client.ts'
import type {
  GsAuthUser,
  GsClientConfig,
  GsClientConfigResponse,
} from './gs-contract.ts'

/** One effective user + configuration pair. */
export interface GsClientConfigSnapshot {
  readonly user: GsAuthUser
  readonly config: GsClientConfig
}

/** Subscriber notified whenever the cached snapshot changes. */
export type GsClientConfigListener = (snapshot: GsClientConfigSnapshot | undefined) => void

/** Inputs for the ClientConfig cache. */
export interface GsClientConfigCacheOptions {
  /** Effective endpoint resolver; read per request so overrides apply live. */
  readonly endpoint: () => string
  /** Session source backing the authorized pull. */
  readonly session: GsSessionTokenSource
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
}

/** Process-local ClientConfig cache with push updates and an active pull. */
export class GsClientConfigCache {
  private current: GsClientConfigSnapshot | undefined
  private readonly listeners = new Set<GsClientConfigListener>()

  constructor(private readonly options: GsClientConfigCacheOptions) {}

  /** Latest snapshot, or undefined before the first login/refresh. */
  snapshot(): GsClientConfigSnapshot | undefined {
    return this.current
  }

  /** Accept one config pushed by a login or refresh response. */
  update(user: GsAuthUser, config: GsClientConfig): void {
    this.current = { user, config }
    this.notify()
  }

  /** Drop the cache when the session ends. */
  clear(): void {
    if (this.current === undefined) return
    this.current = undefined
    this.notify()
  }

  /** Subscribe to snapshot changes; returns the unsubscribe function. */
  subscribe(listener: GsClientConfigListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Actively pull `/api/client-config` and cache the answer. */
  async getClientConfig(): Promise<GsClientConfigSnapshot> {
    const response = await authorizedJson<GsClientConfigResponse>({
      endpoint: this.options.endpoint(),
      path: '/api/client-config',
      session: this.options.session,
      ...(this.options.request === undefined ? {} : { request: this.options.request }),
    })
    this.current = { user: response.user, config: response.config }
    this.notify()
    return this.current
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.current)
  }
}
