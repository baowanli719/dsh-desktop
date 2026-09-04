/** Same-origin browser client for the Host-owned gs-server session routes. */

import {
  GS_SERVER_LOGOUT_PATH,
  GS_SERVER_SESSION_PATH,
  type GsSessionView,
} from '../server/gs-contract.ts'

/** Account operations consumed by the Desktop settings section. */
export interface DesktopGsAccountApi {
  readSession(): Promise<GsSessionView>
  logout(): Promise<void>
}

const MAX_ENDPOINT_LENGTH = 2048
const MAX_NAME_LENGTH = 256

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH
}

/** Validate the token-free session view before it reaches React state. */
export function parseGsSessionView(value: unknown): GsSessionView {
  if (!isObject(value)
    || (value.status !== 'signed-out' && value.status !== 'signed-in')
    || typeof value.endpoint !== 'string'
    || value.endpoint.length === 0
    || value.endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new Error('dsh-plugin-desktop: invalid gs-server session response')
  }
  if (value.status === 'signed-out') {
    return Object.freeze({ status: 'signed-out', endpoint: value.endpoint })
  }
  if (!isObject(value.user)
    || typeof value.user.id !== 'number'
    || !Number.isSafeInteger(value.user.id)
    || !isBoundedName(value.user.username)
    || !isBoundedName(value.user.displayName)
    || !isBoundedName(value.user.role)) {
    throw new Error('dsh-plugin-desktop: invalid gs-server session user')
  }
  return Object.freeze({
    status: 'signed-in',
    endpoint: value.endpoint,
    user: Object.freeze({
      id: value.user.id,
      username: value.user.username,
      displayName: value.user.displayName,
      role: value.user.role,
    }),
  })
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: gs-server account request failed (${String(response.status)})`)
  }
  try {
    return await response.json() as unknown
  } catch {
    throw new Error('dsh-plugin-desktop: gs-server account response was not JSON')
  }
}

/** Construct the default same-origin account API, with a fetch seam for tests. */
export function createDesktopGsAccountApi(fetcher: FetchLike = globalThis.fetch.bind(globalThis)): DesktopGsAccountApi {
  return Object.freeze({
    async readSession() {
      const response = await fetcher(GS_SERVER_SESSION_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      })
      return parseGsSessionView(await readResponse(response))
    },
    async logout() {
      const response = await fetcher(GS_SERVER_LOGOUT_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      const value = await readResponse(response)
      if (!isObject(value) || Object.keys(value).length !== 1 || value.accepted !== true) {
        throw new Error('dsh-plugin-desktop: invalid gs-server logout response')
      }
    },
  })
}

export const desktopGsAccountPaths = Object.freeze({
  session: GS_SERVER_SESSION_PATH,
  logout: GS_SERVER_LOGOUT_PATH,
})
