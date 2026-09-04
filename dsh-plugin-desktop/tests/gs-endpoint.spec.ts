import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GS_DEFAULT_ENDPOINT,
  GS_ENDPOINT_RELATIVE_PATH,
  assertGsEndpoint,
  gsEndpointStatePath,
  GsEndpointStore,
  parseGsEndpointOverride,
} from '../src/server/gs-endpoint.ts'

const roots: string[] = []

async function userData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-gs-endpoint-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('gsclaw-server endpoint validation', () => {
  it('accepts the built-in default and strips trailing slashes', () => {
    expect(GS_DEFAULT_ENDPOINT).toBe('http://192.168.230.108:8151/gsworker')
    expect(assertGsEndpoint('http://192.168.230.108:8151/gsworker/')).toBe(GS_DEFAULT_ENDPOINT)
    expect(assertGsEndpoint('http://192.168.230.108:8151/gsworker///')).toBe(GS_DEFAULT_ENDPOINT)
  })

  it.each([
    'http://localhost:18300/gsclaw',
    'http://127.0.0.1:18300/gsclaw',
    'http://[::1]:18300/gsclaw',
    'http://192.168.1.10:18300/gsclaw',
    'http://10.20.30.40/gsclaw',
  ])('allows plain http for loopback and private LAN host %s', endpoint => {
    expect(assertGsEndpoint(endpoint)).toBe(endpoint.replace(/\/+$/u, ''))
  })

  it('requires https outside loopback and private LAN hosts', () => {
    expect(() => assertGsEndpoint('http://gsclaw.example.com/gsclaw')).toThrow('requires https')
    expect(() => assertGsEndpoint('http://172.16.0.5/gsclaw')).toThrow('requires https')
    expect(assertGsEndpoint('https://gsclaw.example.com/gsclaw')).toBe('https://gsclaw.example.com/gsclaw')
  })

  it.each([
    'not-a-url',
    'ftp://127.0.0.1/gsclaw',
    'http://user:pass@127.0.0.1/gsclaw',
    'http://127.0.0.1/gsclaw?token=1',
    'http://127.0.0.1/gsclaw#frag',
  ])('rejects unsafe endpoint %s', endpoint => {
    expect(() => assertGsEndpoint(endpoint)).toThrow()
    expect(parseGsEndpointOverride(endpoint)).toBeUndefined()
  })

  it('parses override candidates conservatively', () => {
    expect(parseGsEndpointOverride(undefined)).toBeUndefined()
    expect(parseGsEndpointOverride('')).toBeUndefined()
    expect(parseGsEndpointOverride('  ')).toBeUndefined()
    expect(parseGsEndpointOverride(' https://gsclaw.example.com/gsclaw ')).toBe('https://gsclaw.example.com/gsclaw')
  })
})

describe('gsclaw-server endpoint store', () => {
  it('falls back to the built-in default without overrides', async () => {
    const store = await GsEndpointStore.load({ userDataDir: await userData(), environment: undefined })
    expect(store.resolve()).toBe(GS_DEFAULT_ENDPOINT)
    expect(store.persistedOverride).toBeUndefined()
  })

  it('prefers the environment seam over the built-in default', async () => {
    const store = await GsEndpointStore.load({
      userDataDir: await userData(),
      environment: 'https://gsclaw.example.com/gsclaw',
    })
    expect(store.resolve()).toBe('https://gsclaw.example.com/gsclaw')
  })

  it('ignores an invalid environment override', async () => {
    const store = await GsEndpointStore.load({
      userDataDir: await userData(),
      environment: 'http://gsclaw.example.com/gsclaw',
    })
    expect(store.resolve()).toBe(GS_DEFAULT_ENDPOINT)
  })

  it('persists a runtime override that wins over the environment', async () => {
    const root = await userData()
    const statePath = gsEndpointStatePath(root)
    expect(statePath).toBe(join(root, GS_ENDPOINT_RELATIVE_PATH))

    const store = await GsEndpointStore.load({
      userDataDir: root,
      environment: 'https://gsclaw.example.com/gsclaw',
    })
    await store.setOverride('http://192.168.0.20:18300/gsclaw/')
    expect(store.resolve()).toBe('http://192.168.0.20:18300/gsclaw')
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ endpoint: 'http://192.168.0.20:18300/gsclaw' })

    const reloaded = await GsEndpointStore.load({
      userDataDir: root,
      environment: 'https://gsclaw.example.com/gsclaw',
    })
    expect(reloaded.resolve()).toBe('http://192.168.0.20:18300/gsclaw')
    expect(reloaded.persistedOverride).toBe('http://192.168.0.20:18300/gsclaw')

    await reloaded.clearOverride()
    expect(reloaded.resolve()).toBe('https://gsclaw.example.com/gsclaw')
  })

  it('rejects an invalid runtime override without touching persisted state', async () => {
    const store = await GsEndpointStore.load({ userDataDir: await userData(), environment: undefined })
    await expect(store.setOverride('http://gsclaw.example.com/gsclaw')).rejects.toThrow('requires https')
    expect(store.resolve()).toBe(GS_DEFAULT_ENDPOINT)
  })

  it('treats corrupt persisted state as no override', async () => {
    const root = await userData()
    await writeFile(gsEndpointStatePath(root), 'not json at all')
    const store = await GsEndpointStore.load({ userDataDir: root, environment: undefined })
    expect(store.resolve()).toBe(GS_DEFAULT_ENDPOINT)
  })

  it('rejects a relative userData directory', () => {
    expect(() => gsEndpointStatePath('relative/dir')).toThrow('absolute path')
  })
})
