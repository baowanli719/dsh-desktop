/** Same-origin browser client for the Host-owned gs-server brand route. */

import {
  GS_SERVER_BRAND_PATH,
  type GsBrandView,
} from '../server/gs-contract.ts'

/** Brand view consumed by Desktop brand slots, settings copy, and the hero. */
export interface DesktopGsBrandApi {
  readBrand(): Promise<GsBrandView>
}

const MAX_NAME_LENGTH = 64
const MAX_HEADLINE_LENGTH = 128

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate the brand view before it reaches React state. */
export function parseGsBrandView(value: unknown): GsBrandView {
  if (!isObject(value)
    || typeof value.name !== 'string'
    || value.name.length === 0
    || value.name.length > MAX_NAME_LENGTH
    || typeof value.headline !== 'string'
    || value.headline.length === 0
    || value.headline.length > MAX_HEADLINE_LENGTH) {
    throw new Error('dsh-plugin-desktop: invalid gs-server brand response')
  }
  return Object.freeze({ name: value.name, headline: value.headline })
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: gs-server brand request failed (${String(response.status)})`)
  }
  try {
    return await response.json() as unknown
  } catch {
    throw new Error('dsh-plugin-desktop: gs-server brand response was not JSON')
  }
}

/** Construct the default same-origin brand API, with a fetch seam for tests. */
export function createDesktopGsBrandApi(fetcher: FetchLike = globalThis.fetch.bind(globalThis)): DesktopGsBrandApi {
  return Object.freeze({
    async readBrand() {
      const response = await fetcher(GS_SERVER_BRAND_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      })
      return parseGsBrandView(await readResponse(response))
    },
  })
}

export const desktopGsBrandPaths = Object.freeze({
  brand: GS_SERVER_BRAND_PATH,
})
