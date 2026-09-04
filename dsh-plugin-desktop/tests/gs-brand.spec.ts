import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { currentBrand, GS_BRAND_DEFAULT } from '../src/brand.ts'
import {
  GS_BRAND_RELATIVE_PATH,
  gsBrandStatePath,
  GsBrandStore,
  resolveGsBrandConfig,
} from '../src/server/gs-brand.ts'

const roots: string[] = []

async function userData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-gs-brand-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('gsclaw-server brand resolution', () => {
  it('ships the built-in default brand', () => {
    expect(GS_BRAND_DEFAULT).toEqual({ name: '办公 Agent', headline: '探索未至之境' })
  })

  it('fills absent fields with the built-in defaults', () => {
    expect(resolveGsBrandConfig(undefined)).toBeUndefined()
    expect(resolveGsBrandConfig(null)).toBeUndefined()
    expect(resolveGsBrandConfig({})).toEqual(GS_BRAND_DEFAULT)
    expect(resolveGsBrandConfig({ name: '  自定义助手  ' })).toEqual({
      name: '自定义助手',
      headline: GS_BRAND_DEFAULT.headline,
    })
    expect(resolveGsBrandConfig({ name: '', headline: 'x'.repeat(129) })).toEqual(GS_BRAND_DEFAULT)
    expect(resolveGsBrandConfig({ name: 'x'.repeat(65), headline: 42 as unknown as string }))
      .toEqual({ name: GS_BRAND_DEFAULT.name, headline: GS_BRAND_DEFAULT.headline })
  })
})

describe('gsclaw-server brand store', () => {
  it('falls back to the built-in default without a cache or push', async () => {
    const store = await GsBrandStore.load({ userDataDir: await userData() })
    expect(store.current()).toEqual(GS_BRAND_DEFAULT)
    expect(store.view()).toEqual(GS_BRAND_DEFAULT)
    expect(currentBrand()).toEqual(GS_BRAND_DEFAULT)
  })

  it('prefers the persisted cache over the built-in default', async () => {
    const dir = await userData()
    await writeFile(join(dir, GS_BRAND_RELATIVE_PATH), `${JSON.stringify({ name: '缓存助手', headline: '缓存标题' })}\n`)
    const store = await GsBrandStore.load({ userDataDir: dir })
    expect(store.current()).toEqual({ name: '缓存助手', headline: '缓存标题' })
    expect(currentBrand()).toEqual({ name: '缓存助手', headline: '缓存标题' })
  })

  it('treats a corrupt cache as absent', async () => {
    const dir = await userData()
    const statePath = gsBrandStatePath(dir)
    await writeFile(statePath, '{not json')
    let store = await GsBrandStore.load({ userDataDir: dir })
    expect(store.current()).toEqual(GS_BRAND_DEFAULT)

    await writeFile(statePath, JSON.stringify({ name: 42 }))
    store = await GsBrandStore.load({ userDataDir: dir })
    expect(store.current()).toEqual(GS_BRAND_DEFAULT)

    await writeFile(statePath, JSON.stringify(['品牌']))
    store = await GsBrandStore.load({ userDataDir: dir })
    expect(store.current()).toEqual(GS_BRAND_DEFAULT)
  })

  it('lets a server push win, persists it, and notifies subscribers', async () => {
    const dir = await userData()
    const store = await GsBrandStore.load({ userDataDir: dir })
    const seen: string[] = []
    const unsubscribe = store.subscribe(brand => { seen.push(brand.name) })

    await store.applyServerBrand({ name: '推送助手', headline: '推送标题' })

    expect(store.current()).toEqual({ name: '推送助手', headline: '推送标题' })
    expect(currentBrand()).toEqual({ name: '推送助手', headline: '推送标题' })
    expect(seen).toEqual(['推送助手'])
    const persisted: unknown = JSON.parse(await readFile(join(dir, GS_BRAND_RELATIVE_PATH), 'utf8'))
    expect(persisted).toEqual({ name: '推送助手', headline: '推送标题' })

    // The push outlives the store instance through the persisted cache.
    const reloaded = await GsBrandStore.load({ userDataDir: dir })
    expect(reloaded.current()).toEqual({ name: '推送助手', headline: '推送标题' })
    unsubscribe()
  })

  it('clears the push on a null config so the persisted cache applies again', async () => {
    const dir = await userData()
    await writeFile(join(dir, GS_BRAND_RELATIVE_PATH), JSON.stringify({ name: '缓存助手', headline: '缓存标题' }))
    const store = await GsBrandStore.load({ userDataDir: dir })
    expect(store.current()).toEqual({ name: '缓存助手', headline: '缓存标题' })

    // A push both wins and rewrites the cache, so clearing it later still
    // leaves the last server-delivered brand instead of the built-in default.
    await store.applyServerBrand({ name: '推送助手' })
    expect(store.current()).toEqual({ name: '推送助手', headline: GS_BRAND_DEFAULT.headline })

    await store.applyServerBrand(null)
    expect(store.current()).toEqual({ name: '推送助手', headline: GS_BRAND_DEFAULT.headline })
    expect(currentBrand()).toEqual({ name: '推送助手', headline: GS_BRAND_DEFAULT.headline })
  })

  it('rejects unsafe userData directories', async () => {
    await expect(GsBrandStore.load({ userDataDir: 'relative' })).rejects.toThrow('absolute path')
  })
})
