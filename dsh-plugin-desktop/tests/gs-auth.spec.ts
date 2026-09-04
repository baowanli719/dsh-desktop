import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GsRequest } from '../src/server/gs-client.ts'
import {
  GS_REFRESH_TOKEN_FILENAME,
  GsAuthService,
  GsAuthStorageError,
  gsClientPlatform,
  type GsSafeStorage,
} from '../src/server/gs-auth.ts'
import type { GsClientConfig, GsAuthUser } from '../src/server/gs-contract.ts'

const ENDPOINT = 'http://127.0.0.1:18300/gsclaw'
const CLIENT = { platform: 'windows' as const, version: '2.0.4' }
const USER: GsAuthUser = { id: 7, username: 'alice', displayName: 'Alice', role: 'user' }
const CONFIG: GsClientConfig = {
  version: 1,
  agent: { sandboxProfile: 'read-only', approvalPolicy: 'ask', dataClass: 'internal' },
  features: { customModel: false },
  settingsPages: {},
  permissions: { allowSubmit: true, allowExternalSkillInstall: false },
  skills: {},
  models: null,
  appUpdate: null,
  notice: null,
}

const roots: string[] = []

async function userData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-gs-auth-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function memorySafeStorage(available = true): GsSafeStorage {
  return {
    available: () => available,
    encrypt: plaintext => Buffer.from(plaintext, 'utf8'),
    decrypt: sealed => Buffer.from(sealed).toString('utf8'),
  }
}

interface Call { url: string, init: RequestInit }

function loginResponse(tokens = true): Response {
  return Response.json({
    token: 'access-1',
    ...(tokens ? { tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 1800 } } : {}),
    user: USER,
    config: CONFIG,
  })
}

function makeAuth(
  root: string,
  request: GsRequest,
  extra: {
    safeStorage?: GsSafeStorage
    onConfig?: (user: GsAuthUser, config: GsClientConfig) => void
    onSessionLost?: (reason: 'expired' | 'disabled') => void
  } = {},
): GsAuthService {
  return new GsAuthService({
    endpoint: () => ENDPOINT,
    userDataDir: root,
    safeStorage: extra.safeStorage ?? memorySafeStorage(),
    client: CLIENT,
    request,
    ...(extra.onConfig === undefined ? {} : { onConfig: extra.onConfig }),
    ...(extra.onSessionLost === undefined ? {} : { onSessionLost: extra.onSessionLost }),
  })
}

describe('gsclaw-server auth state machine', () => {
  it('logs in with password, keeps the access token in memory, and seals the refresh token', async () => {
    const root = await userData()
    const calls: Call[] = []
    const onConfig = vi.fn()
    const request: GsRequest = async (url, init) => {
      calls.push({ url, init })
      return loginResponse()
    }
    const auth = makeAuth(root, request, { onConfig })

    const snapshot = await auth.loginWithPassword({
      username: 'alice',
      password: 'secret',
      captchaId: 'cap-1',
      captchaCode: 'AB12',
    })

    expect(snapshot).toEqual({ status: 'signed-in', user: USER })
    expect(auth.accessToken()).toBe('access-1')
    expect(onConfig).toHaveBeenCalledWith(USER, CONFIG)

    expect(calls[0]?.url).toBe(`${ENDPOINT}/api/auth/login`)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      username: 'alice',
      password: 'secret',
      captchaId: 'cap-1',
      captchaCode: 'AB12',
      client: { platform: 'windows', version: '2.0.4' },
    })

    // The refresh token is sealed (here: identity "encryption") and base64-persisted.
    const sealed = await readFile(join(root, GS_REFRESH_TOKEN_FILENAME), 'utf8')
    expect(Buffer.from(sealed.trim(), 'base64').toString('utf8')).toBe('refresh-1')
  })

  it('surfaces INVALID_CREDENTIALS from the legacy envelope', async () => {
    const root = await userData()
    const request: GsRequest = async () =>
      Response.json({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' }, { status: 401 })
    const auth = makeAuth(root, request)

    await expect(auth.loginWithPassword({ username: 'alice', password: 'wrong' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 })
    expect(auth.snapshot()).toEqual({ status: 'signed-out' })
  })

  it('surfaces INVALID_CAPTCHA and TOO_MANY_ATTEMPTS with Retry-After', async () => {
    const root = await userData()
    const responses = [
      Response.json({ error: 'INVALID_CAPTCHA', message: '图形验证码错误或已过期' }, { status: 401 }),
      Response.json(
        { error: 'TOO_MANY_ATTEMPTS', message: '失败次数过多' },
        { status: 429, headers: { 'retry-after': '300' } },
      ),
    ]
    const request: GsRequest = async () => responses.shift()!
    const auth = makeAuth(root, request)

    await expect(auth.loginWithPassword({ username: 'a', password: 'b' }))
      .rejects.toMatchObject({ code: 'INVALID_CAPTCHA', status: 401 })
    await expect(auth.loginWithPassword({ username: 'a', password: 'b' }))
      .rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS', status: 429, retryAfter: 300 })
  })

  it('refuses login when OS-backed secret storage is unavailable', async () => {
    const root = await userData()
    const request: GsRequest = async () => loginResponse()
    const auth = makeAuth(root, request, { safeStorage: memorySafeStorage(false) })

    await expect(auth.loginWithPassword({ username: 'alice', password: 'secret' }))
      .rejects.toBeInstanceOf(GsAuthStorageError)
    expect(auth.snapshot()).toEqual({ status: 'signed-out' })
    await expect(readFile(join(root, GS_REFRESH_TOKEN_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a legacy memory-only session when the server issues no refresh token', async () => {
    const root = await userData()
    const request: GsRequest = async () => loginResponse(false)
    const auth = makeAuth(root, request, { safeStorage: memorySafeStorage(false) })

    const snapshot = await auth.loginWithPassword({ username: 'alice', password: 'secret' })
    expect(snapshot.status).toBe('signed-in')
    expect(auth.accessToken()).toBe('access-1')
    await expect(readFile(join(root, GS_REFRESH_TOKEN_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns null captcha on a legacy server and the captcha body otherwise', async () => {
    const root = await userData()
    const captcha = { captchaId: 'cap-1', svg: '<svg/>', expiresIn: 300 }
    const responses = [
      new Response('not found', { status: 404 }),
      Response.json(captcha),
    ]
    const request: GsRequest = async () => responses.shift()!
    const auth = makeAuth(root, request)

    await expect(auth.fetchCaptcha()).resolves.toBeNull()
    await expect(auth.fetchCaptcha()).resolves.toEqual(captcha)
  })

  it('logs out through the family-revoking endpoint and wipes local state', async () => {
    const root = await userData()
    const calls: Call[] = []
    const onSessionLost = vi.fn()
    const request: GsRequest = async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/api/auth/login')) return loginResponse()
      if (url.endsWith('/api/v1/auth/logout')) return new Response(null, { status: 204 })
      throw new Error(`unexpected ${url}`)
    }
    const auth = makeAuth(root, request, { onSessionLost })
    await auth.loginWithPassword({ username: 'alice', password: 'secret' })

    await auth.logout()

    const logout = calls.find(call => call.url.endsWith('/api/v1/auth/logout'))
    expect(JSON.parse(String(logout?.init.body))).toEqual({ refreshToken: 'refresh-1' })
    expect(new Headers(logout?.init.headers).get('authorization')).toBe('Bearer access-1')
    expect(auth.snapshot()).toEqual({ status: 'signed-out' })
    expect(auth.accessToken()).toBeUndefined()
    expect(onSessionLost).not.toHaveBeenCalled()
    await expect(readFile(join(root, GS_REFRESH_TOKEN_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores nothing without a persisted refresh token', async () => {
    const root = await userData()
    const request = vi.fn(async () => Response.json({}))
    const auth = makeAuth(root, request)

    await expect(auth.restoreSession()).resolves.toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('restores a persisted session and writes back the rotated refresh token', async () => {
    const root = await userData()
    // Seed persisted state through a first service instance.
    const loginRequest: GsRequest = async () => loginResponse()
    await makeAuth(root, loginRequest).loginWithPassword({ username: 'alice', password: 'secret' })

    const calls: Call[] = []
    const request: GsRequest = async (url, init) => {
      calls.push({ url, init })
      return Response.json({
        tokens: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 1800 },
        user: USER,
        config: CONFIG,
      })
    }
    const auth = makeAuth(root, request)

    await expect(auth.restoreSession()).resolves.toBe(true)
    expect(auth.accessToken()).toBe('access-2')
    expect(auth.snapshot()).toEqual({ status: 'signed-in', user: USER })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ENDPOINT}/api/v1/auth/refresh`)
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      refreshToken: 'refresh-1',
      client: { platform: 'windows', version: '2.0.4' },
    })

    const sealed = await readFile(join(root, GS_REFRESH_TOKEN_FILENAME), 'utf8')
    expect(Buffer.from(sealed.trim(), 'base64').toString('utf8')).toBe('refresh-2')
  })

  it('coalesces concurrent restores and refreshes into one gateway request', async () => {
    const root = await userData()
    const loginRequest: GsRequest = async () => loginResponse()
    await makeAuth(root, loginRequest).loginWithPassword({ username: 'alice', password: 'secret' })

    let refreshCalls = 0
    const request: GsRequest = async () => {
      refreshCalls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return Response.json({
        tokens: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 1800 },
        user: USER,
        config: CONFIG,
      })
    }
    const auth = makeAuth(root, request)

    const restored = await Promise.all([auth.restoreSession(), auth.restoreSession()])
    expect(restored).toEqual([true, true])
    expect(refreshCalls).toBe(1)

    const tokens = await Promise.all([auth.refreshAccessToken(), auth.refreshAccessToken()])
    expect(tokens).toEqual(['access-2', 'access-2'])
    // The concurrent refresh pair still costs exactly one gateway request.
    expect(refreshCalls).toBe(2)
  })

  it('wipes local state and reports session loss when the family is revoked', async () => {
    const root = await userData()
    const loginRequest: GsRequest = async () => loginResponse()
    await makeAuth(root, loginRequest).loginWithPassword({ username: 'alice', password: 'secret' })

    const onSessionLost = vi.fn()
    const request: GsRequest = async () =>
      Response.json({ code: 'unauthorized', message: '会话已被吊销，请重新登录', traceId: 't-1' }, { status: 401 })
    const auth = makeAuth(root, request, { onSessionLost })

    await expect(auth.restoreSession()).resolves.toBe(false)
    expect(onSessionLost).toHaveBeenCalledWith('expired')
    expect(auth.snapshot()).toEqual({ status: 'signed-out' })
    await expect(readFile(join(root, GS_REFRESH_TOKEN_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps persisted state when the refresh fails for transport reasons', async () => {
    const root = await userData()
    const loginRequest: GsRequest = async () => loginResponse()
    await makeAuth(root, loginRequest).loginWithPassword({ username: 'alice', password: 'secret' })

    const onSessionLost = vi.fn()
    const request: GsRequest = async () => { throw new Error('ECONNREFUSED') }
    const auth = makeAuth(root, request, { onSessionLost })

    await expect(auth.restoreSession()).rejects.toMatchObject({ code: 'network', status: 0 })
    expect(onSessionLost).not.toHaveBeenCalled()
    // The sealed refresh token survives a server outage.
    const sealed = await readFile(join(root, GS_REFRESH_TOKEN_FILENAME), 'utf8')
    expect(Buffer.from(sealed.trim(), 'base64').toString('utf8')).toBe('refresh-1')
  })

  it('maps Node platforms onto the gateway client identity', () => {
    expect(gsClientPlatform('win32')).toBe('windows')
    expect(gsClientPlatform('darwin')).toBe('macos')
    expect(gsClientPlatform('linux')).toBe('linux')
  })
})
