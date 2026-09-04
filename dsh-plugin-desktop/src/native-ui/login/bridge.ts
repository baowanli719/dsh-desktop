/**
 * Renderer side of the login RPC channel.
 *
 * Requests are `dsh-login://rpc` navigations the main process intercepts and
 * cancels; responses arrive through the single global hook the main process
 * evaluates with `executeJavaScript`. No token or credential response ever
 * crosses this channel — only the token-free session view and form data.
 */

import {
  buildDesktopLoginRpcHref,
  type DesktopLoginRpcEnvelope,
  type DesktopLoginRpcOp,
} from '../../login-contract.ts'

/** Failure rejected from {@link desktopLoginRpc}, mirroring GatewayError. */
export class DesktopLoginRpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'DesktopLoginRpcError'
  }
}

type Settle = (envelope: DesktopLoginRpcEnvelope) => void

const pending = new Map<number, Settle>()
let nextRpcId = 0

declare global {
  interface Window {
    __dshLoginRpcResolve?: (id: number, payload: string) => void
  }
}

/** Install the global response hook exactly once before any RPC is issued. */
export function installDesktopLoginRpcBridge(): void {
  window.__dshLoginRpcResolve = (id, payload) => {
    const settle = pending.get(id)
    if (settle === undefined) return
    pending.delete(id)
    try {
      settle(JSON.parse(payload) as DesktopLoginRpcEnvelope)
    } catch {
      settle({ ok: false, error: 'malformed login RPC response', status: 0 })
    }
  }
}

/** Issue one RPC by navigating to its href; the main process cancels it. */
export function desktopLoginRpc<T>(op: DesktopLoginRpcOp, data?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    nextRpcId = nextRpcId >= Number.MAX_SAFE_INTEGER ? 1 : nextRpcId + 1
    const id = nextRpcId
    pending.set(id, (envelope) => {
      if (envelope.ok) {
        resolve(envelope.data as T)
        return
      }
      reject(new DesktopLoginRpcError(
        envelope.error,
        ...(envelope.code === undefined ? [] : [envelope.code]),
        ...(envelope.status === undefined ? [] : [envelope.status]),
        ...(envelope.retryAfter === undefined ? [] : [envelope.retryAfter]),
      ))
    })
    window.location.href = buildDesktopLoginRpcHref({
      id,
      op,
      ...(data === undefined ? {} : { data }),
    })
  })
}
