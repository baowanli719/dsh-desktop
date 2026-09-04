/** Strict loopback HTTP handlers for the private Desktop window-control API. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginLoopbackRequest } from './desktop-settings-route.ts'

export const DESKTOP_WINDOW_STATE_PATH = '/api/desktop/window/state'
export const DESKTOP_WINDOW_MINIMIZE_PATH = '/api/desktop/window/minimize'
export const DESKTOP_WINDOW_TOGGLE_MAXIMIZE_PATH = '/api/desktop/window/toggle-maximize'
export const DESKTOP_WINDOW_CLOSE_PATH = '/api/desktop/window/close'

/** Main-window control surface behind the private loopback window routes. */
export interface DesktopWindowControlTarget {
  /** Minimize the main window. */
  minimizeWindow(): void
  /** Toggle the main window's maximized state. @returns the new maximized state. */
  toggleWindowMaximize(): boolean
  /** Close the main window through the standard close flow. */
  closeWindow(): void
  /** Whether the main window is currently maximized. */
  isWindowMaximized(): boolean
}

/** Maximization projection consumed by the renderer-drawn caption buttons. */
export interface DesktopWindowStateResponse {
  readonly maximized: boolean
}

function finishJson(
  res: ServerResponse,
  statusCode: number,
  value: object,
  allow?: 'GET' | 'POST',
): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function error(message: string): { readonly error: string } {
  return { error: message }
}

type WindowReportError = (operation: string, cause: unknown) => void

function state(target: DesktopWindowControlTarget): DesktopWindowStateResponse {
  return Object.freeze({ maximized: target.isWindowMaximized() })
}

/** Serve the main window's maximized state to the same-origin renderer. */
export function handleDesktopWindowStateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  target: DesktopWindowControlTarget,
  reportError: WindowReportError = () => {},
): void {
  if (req.method !== 'GET') return finishJson(res, 405, error('method not allowed'), 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, error('forbidden'))
  }
  try {
    finishJson(res, 200, state(target))
  } catch (cause) {
    reportError('read window state', cause)
    finishJson(res, 500, error('window state unavailable'))
  }
}

/** Minimize the main window from a same-origin renderer request. */
export function handleDesktopWindowMinimizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  target: DesktopWindowControlTarget,
  reportError: WindowReportError = () => {},
): void {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  try {
    target.minimizeWindow()
    finishJson(res, 200, { accepted: true })
  } catch (cause) {
    reportError('minimize window', cause)
    finishJson(res, 500, error('window could not be minimized'))
  }
}

/** Toggle the main window's maximized state from a same-origin renderer request. */
export function handleDesktopWindowToggleMaximizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  target: DesktopWindowControlTarget,
  reportError: WindowReportError = () => {},
): void {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  try {
    const maximized = target.toggleWindowMaximize()
    finishJson(res, 200, { accepted: true, maximized })
  } catch (cause) {
    reportError('toggle window maximized state', cause)
    finishJson(res, 500, error('window maximized state could not be toggled'))
  }
}

/** Close the main window from a same-origin renderer request. */
export function handleDesktopWindowCloseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  target: DesktopWindowControlTarget,
  reportError: WindowReportError = () => {},
): void {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  try {
    target.closeWindow()
    finishJson(res, 200, { accepted: true })
  } catch (cause) {
    reportError('close window', cause)
    finishJson(res, 500, error('window could not be closed'))
  }
}
