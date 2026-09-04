/** Same-origin browser client for the private Desktop window-control routes. */

const WINDOW_STATE_PATH = '/api/desktop/window/state'
const WINDOW_MINIMIZE_PATH = '/api/desktop/window/minimize'
const WINDOW_TOGGLE_MAXIMIZE_PATH = '/api/desktop/window/toggle-maximize'
const WINDOW_CLOSE_PATH = '/api/desktop/window/close'

/** Maximization projection returned by the window state route. */
export interface DesktopWindowState {
  readonly maximized: boolean
}

/** Browser operations consumed by the renderer-drawn Windows caption buttons. */
export interface DesktopWindowControlsApi {
  readState(): Promise<DesktopWindowState>
  minimize(): Promise<void>
  /** Toggle maximization. @returns the acknowledged new maximized state. */
  toggleMaximize(): Promise<boolean>
  close(): Promise<void>
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: Desktop window request failed (${String(response.status)})`)
  }
  try {
    return await response.json() as unknown
  } catch {
    throw new Error('dsh-plugin-desktop: Desktop window response was not JSON')
  }
}

/** Validate the maximization projection before it reaches React state. */
export function parseDesktopWindowState(value: unknown): DesktopWindowState {
  if (!isObject(value)
    || Object.keys(value).length !== 1
    || typeof value.maximized !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid Desktop window state response')
  }
  return Object.freeze({ maximized: value.maximized })
}

/** Validate the exact acknowledgement returned by a window-control side effect. */
export function parseDesktopWindowActionAcceptance(value: unknown): void {
  if (!isObject(value) || value.accepted !== true) {
    throw new Error('dsh-plugin-desktop: invalid Desktop window action response')
  }
}

function parseDesktopWindowToggle(value: unknown): boolean {
  if (!isObject(value) || value.accepted !== true || typeof value.maximized !== 'boolean') {
    throw new Error('dsh-plugin-desktop: invalid Desktop window toggle response')
  }
  return value.maximized
}

function post(fetcher: FetchLike, path: string): Promise<Response> {
  return fetcher(path, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
}

/** Construct the default same-origin API, with a fetch seam for focused tests. */
export function createDesktopWindowControlsApi(
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): DesktopWindowControlsApi {
  return Object.freeze({
    async readState() {
      const response = await fetcher(WINDOW_STATE_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      })
      return parseDesktopWindowState(await readResponse(response))
    },
    async minimize() {
      parseDesktopWindowActionAcceptance(await readResponse(await post(fetcher, WINDOW_MINIMIZE_PATH)))
    },
    async toggleMaximize() {
      return parseDesktopWindowToggle(await readResponse(await post(fetcher, WINDOW_TOGGLE_MAXIMIZE_PATH)))
    },
    async close() {
      parseDesktopWindowActionAcceptance(await readResponse(await post(fetcher, WINDOW_CLOSE_PATH)))
    },
  })
}

export const desktopWindowControlsPaths = Object.freeze({
  state: WINDOW_STATE_PATH,
  minimize: WINDOW_MINIMIZE_PATH,
  toggleMaximize: WINDOW_TOGGLE_MAXIMIZE_PATH,
  close: WINDOW_CLOSE_PATH,
})
