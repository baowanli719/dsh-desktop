import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createDesktopBrowserAccess,
  type DesktopBrowserAccess,
} from '../src/desktop-browser-access.ts'
import { DESKTOP_WEB_PORT_RETRY_LIMIT } from '../src/desktop-port.ts'
import DesktopWebServer from '../src/webserver.ts'

const occupied: Server[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(occupied.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function occupy(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  occupied.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not expose an address')
  return { server, port: address.port }
}

/** Hold `length` consecutive loopback ports starting at a discovered free base. */
async function occupyRange(length: number): Promise<number> {
  for (let tries = 0; tries < 20; tries += 1) {
    const probe = await occupy()
    const base = probe.port
    const held: Server[] = []
    let complete = true
    for (let offset = 1; offset < length; offset += 1) {
      const server = createServer()
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(base + offset, '127.0.0.1', () => resolve())
        })
        held.push(server)
        occupied.push(server)
      } catch {
        complete = false
        await new Promise<void>(resolve => server.close(() => resolve()))
        break
      }
    }
    if (complete) return base
    await Promise.all(held.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    occupied.splice(occupied.indexOf(probe.server), 1)
    await new Promise<void>(resolve => probe.server.close(() => resolve()))
  }
  throw new Error('could not find a free consecutive port range for the test')
}

async function startWebServer(access?: DesktopBrowserAccess): Promise<DesktopWebServer> {
  const context = new Context()
  contexts.push(context)
  if (access !== undefined) context.provide('desktopBrowserAccess', access)
  await context.plugin(DesktopWebServer, { host: '127.0.0.1', port: 0 })
  const server = context.get('webServer')
  if (!(server instanceof DesktopWebServer)) throw new Error('Desktop WebServer did not start')
  return server
}

async function requestUpgrade(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setTimeout(2_000)
    socket.once('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${String(port)}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ].join('\r\n'))
    })
    socket.on('data', chunk => { response += chunk.toString('utf8') })
    socket.once('end', () => { resolve(response) })
    socket.once('error', reject)
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('test upgrade request timed out'))
    })
  })
}

describe('Desktop WebServer port policy', () => {
  it('fails closed when asked to bind all interfaces before LAN HTTPS exists', async () => {
    const context = new Context()
    contexts.push(context)

    await expect(context.plugin(DesktopWebServer, { host: '0.0.0.0', port: 0 }))
      .rejects.toThrow('requires loopback until LAN HTTPS is available')
  })

  it('increments only after the requested loopback bind reports EADDRINUSE', async () => {
    const blocked = await occupy()
    const context = new Context()
    contexts.push(context)

    await context.plugin(DesktopWebServer, { host: '127.0.0.1', port: blocked.port })

    const selectedPort = context.get('webServer')?.port ?? 0
    expect(selectedPort).toBeGreaterThan(blocked.port)
    expect(selectedPort).toBeLessThanOrEqual(blocked.port + DESKTOP_WEB_PORT_RETRY_LIMIT)
  })

  it('preserves an OS-assigned port when the explicit value is zero', async () => {
    const context = new Context()
    contexts.push(context)

    await context.plugin(DesktopWebServer, { host: '127.0.0.1', port: 0 })

    expect(context.get('webServer')?.port).toBeGreaterThan(0)
  })

  it('falls back to an OS-assigned port when every retry candidate is in use', async () => {
    const base = await occupyRange(DESKTOP_WEB_PORT_RETRY_LIMIT + 1)
    const context = new Context()
    contexts.push(context)

    await context.plugin(DesktopWebServer, { host: '127.0.0.1', port: base })

    const selectedPort = context.get('webServer')?.port ?? 0
    expect(selectedPort).toBeGreaterThan(0)
    expect(selectedPort < base || selectedPort > base + DESKTOP_WEB_PORT_RETRY_LIMIT).toBe(true)
  })
})

describe('Desktop WebServer browser gate', () => {
  it('keeps an ordinary dsh launch unrestricted when the launcher service is absent', async () => {
    const server = await startWebServer()
    server.registerFallback((_req, res) => { res.end('ordinary dsh') })

    const response = await fetch(`http://127.0.0.1:${String(server.port)}/anything`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('ordinary dsh')
  })

  it('requires the exact Electron capability while ordinary browser access is disabled', async () => {
    const access = createDesktopBrowserAccess(false, Buffer.alloc(32, 3).toString('base64url'))
    const server = await startWebServer(access)
    server.register({
      kind: 'exact',
      path: '/api/private',
      handler: (_req, res) => { res.end('private') },
    })
    server.registerFallback((_req, res) => { res.end('fallback') })
    const root = `http://127.0.0.1:${String(server.port)}`

    expect((await fetch(`${root}/api/private`)).status).toBe(403)
    expect((await fetch(`${root}/api/private`, {
      headers: { [access.rendererHeader.name]: 'wrong' },
    })).status).toBe(403)
    const exact = await fetch(`${root}/api/private`, {
      headers: { [access.rendererHeader.name]: access.rendererHeader.value },
    })
    expect(exact.status).toBe(200)
    await expect(exact.text()).resolves.toBe('private')
    const fallback = await fetch(`${root}/assets/app.js`, {
      headers: { [access.rendererHeader.name]: access.rendererHeader.value },
    })
    expect(fallback.status).toBe(200)
    await expect(fallback.text()).resolves.toBe('fallback')
  })

  it('allows marker-free browser routes but rejects Desktop marker impersonation', async () => {
    const access = createDesktopBrowserAccess(true, Buffer.alloc(32, 4).toString('base64url'))
    const server = await startWebServer(access)
    server.registerFallback((_req, res) => { res.end('browser') })
    const root = `http://127.0.0.1:${String(server.port)}`

    const browser = await fetch(`${root}/?workspace=one`)
    expect(browser.status).toBe(200)
    await expect(browser.text()).resolves.toBe('browser')
    const forged = await fetch(`${root}/?dsh-desktop-mode=compatibility`)
    expect(forged.status).toBe(403)
    expect(forged.headers.get('cache-control')).toBe('no-store')
  })

  it('applies the same gate to WebSocket upgrades', async () => {
    const access = createDesktopBrowserAccess(false, Buffer.alloc(32, 5).toString('base64url'))
    const server = await startWebServer(access)
    server.registerUpgrade({
      path: '/socket',
      handler: (_req, socket) => {
        socket.end([
          'HTTP/1.1 101 Switching Protocols',
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ].join('\r\n'))
      },
    })

    await expect(requestUpgrade(server.port, '/socket')).resolves.toContain('403 Forbidden')
    await expect(requestUpgrade(server.port, '/socket', {
      [access.rendererHeader.name]: access.rendererHeader.value,
    })).resolves.toContain('101 Switching Protocols')
  })
})
