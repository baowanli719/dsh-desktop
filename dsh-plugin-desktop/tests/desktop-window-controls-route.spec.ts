import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  handleDesktopWindowCloseRequest,
  handleDesktopWindowMinimizeRequest,
  handleDesktopWindowStateRequest,
  handleDesktopWindowToggleMaximizeRequest,
  type DesktopWindowControlTarget,
} from '../src/desktop-window-controls-route.ts'

const ORIGIN = 'http://127.0.0.1:43120'

function request(method: string, origin: string | undefined = ORIGIN): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage
  req.method = method
  req.headers = {
    host: '127.0.0.1:43120',
    ...(origin === undefined ? {} : { origin }),
    'sec-fetch-site': 'same-origin',
  }
  Object.defineProperty(req, 'socket', {
    configurable: true,
    value: { remoteAddress: '127.0.0.1' },
  })
  return req
}

function response(): ServerResponse & {
  body: string
  end: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
} {
  const res = {
    body: '',
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

function target(overrides: Partial<DesktopWindowControlTarget> = {}): DesktopWindowControlTarget {
  return {
    minimizeWindow: vi.fn(),
    toggleWindowMaximize: vi.fn(() => true),
    closeWindow: vi.fn(),
    isWindowMaximized: vi.fn(() => false),
    ...overrides,
  }
}

const handlers = [
  ['state', 'GET', handleDesktopWindowStateRequest],
  ['minimize', 'POST', handleDesktopWindowMinimizeRequest],
  ['toggle-maximize', 'POST', handleDesktopWindowToggleMaximizeRequest],
  ['close', 'POST', handleDesktopWindowCloseRequest],
] as const

describe('desktop window-control routes', () => {
  it.each(handlers)('%s rejects other methods with 405', (_name, method, handler) => {
    const res = response()
    handler(request(method === 'GET' ? 'POST' : 'GET'), res, ORIGIN, target())
    expect(res.statusCode).toBe(405)
    expect(res.setHeader).toHaveBeenCalledWith('allow', method)
  })

  it.each(handlers)('%s rejects cross-origin requests with 403', (_name, method, handler) => {
    const window = target()
    const res = response()
    handler(request(method, 'https://example.com'), res, ORIGIN, window)
    expect(res.statusCode).toBe(403)
    expect(window.minimizeWindow).not.toHaveBeenCalled()
    expect(window.toggleWindowMaximize).not.toHaveBeenCalled()
    expect(window.closeWindow).not.toHaveBeenCalled()
  })

  it.each(handlers)('%s rejects non-loopback sockets with 403', (_name, method, handler) => {
    const req = request(method)
    Object.defineProperty(req, 'socket', {
      configurable: true,
      value: { remoteAddress: '192.0.2.10' },
    })
    const res = response()
    handler(req, res, ORIGIN, target())
    expect(res.statusCode).toBe(403)
  })

  it('serves the current maximized state', () => {
    const res = response()
    handleDesktopWindowStateRequest(request('GET'), res, ORIGIN, target({
      isWindowMaximized: vi.fn(() => true),
    }))
    expect(res.statusCode).toBe(200)
    expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(JSON.parse(res.body)).toEqual({ maximized: true })
  })

  it('minimizes the main window and acknowledges', () => {
    const window = target()
    const res = response()
    handleDesktopWindowMinimizeRequest(request('POST'), res, ORIGIN, window)
    expect(window.minimizeWindow).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ accepted: true })
  })

  it('toggles maximization and returns the acknowledged state', () => {
    const window = target({ toggleWindowMaximize: vi.fn(() => false) })
    const res = response()
    handleDesktopWindowToggleMaximizeRequest(request('POST'), res, ORIGIN, window)
    expect(window.toggleWindowMaximize).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ accepted: true, maximized: false })
  })

  it('closes the main window through the standard close flow', () => {
    const window = target()
    const res = response()
    handleDesktopWindowCloseRequest(request('POST'), res, ORIGIN, window)
    expect(window.closeWindow).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ accepted: true })
  })

  it.each(handlers)('%s reports a runtime failure as a stable 500', (_name, method, handler) => {
    const failing = target({
      minimizeWindow: vi.fn(() => { throw new Error('private native failure') }),
      toggleWindowMaximize: vi.fn(() => { throw new Error('private native failure') }),
      closeWindow: vi.fn(() => { throw new Error('private native failure') }),
      isWindowMaximized: vi.fn(() => { throw new Error('private native failure') }),
    })
    const reportError = vi.fn()
    const res = response()
    handler(request(method), res, ORIGIN, failing, reportError)
    expect(res.statusCode).toBe(500)
    expect(reportError).toHaveBeenCalledOnce()
    expect(String(JSON.parse(res.body).error)).not.toContain('private native failure')
  })
})
