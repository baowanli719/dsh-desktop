import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import type { GsRequest } from '../src/server/gs-client.ts'
import type { GsSkillControl } from '../src/server/gs-contract.ts'
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_TOTAL_BYTES,
  SERVER_SKILL_PROVIDER_NAME,
  SERVER_SKILL_RANK,
  ServerSkillProvider,
  createGsSkillSyncTracker,
  safeSkillRelativePath,
  stripSkillFrontmatter,
  type GsSkillServerFace,
  type GsSkillSyncTracker,
} from '../src/server-skill-provider.ts'

const ENDPOINT = 'http://127.0.0.1:18300/gsclaw'

const roots: string[] = []

function temporaryCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-skills-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface RecordedCall {
  readonly url: string
  readonly init: RequestInit
}

interface ProviderHarness {
  readonly provider: ServerSkillProvider
  readonly calls: RecordedCall[]
  readonly controls: { current: Record<string, GsSkillControl> | undefined }
  readonly invalidate: ReturnType<typeof vi.fn<() => void>>
  readonly sync: GsSkillSyncTracker
  readonly loggerWarn: ReturnType<typeof vi.fn<(format: string, ...param: unknown[]) => void>>
  notifyConfig(): void
  setToken(token: string | undefined): void
}

function createProvider(
  handler: (call: RecordedCall) => Response,
  cacheRoot = temporaryCacheRoot(),
): ProviderHarness {
  const calls: RecordedCall[] = []
  let token: string | undefined = 'access-1'
  const controls: { current: Record<string, GsSkillControl> | undefined } = { current: undefined }
  const listeners = new Set<() => void>()
  const invalidate = vi.fn<() => void>()
  const sync = createGsSkillSyncTracker()
  const loggerWarn = vi.fn<(format: string, ...param: unknown[]) => void>()
  const request: GsRequest = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }
  const face: GsSkillServerFace = {
    accessToken: () => token,
    refreshAccessToken: async () => 'refreshed-1',
    endpoint: () => ENDPOINT,
    skillControls: () => controls.current,
    subscribeConfig: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const provider = new ServerSkillProvider(face, { cacheRoot, request, logger: { warn: loggerWarn } }, {
    signal: new AbortController().signal,
    invalidate,
  }, sync)
  return {
    provider,
    calls,
    controls,
    invalidate,
    sync,
    loggerWarn,
    notifyConfig() { for (const listener of listeners) listener() },
    setToken(next) { token = next },
  }
}

function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'skill-1',
    name: 'code-review',
    displayName: 'Code Review',
    description: 'Reviews code changes',
    version: '1.0.0',
    content: '',
    enabled: true,
    runtimeType: 'prompt',
    ...overrides,
  }
}

function skillsResponse(skills: readonly Record<string, unknown>[]): Response {
  return Response.json({ skills })
}

function filesResponse(files: readonly { path: string, base64: string }[]): Response {
  return Response.json({ name: 'code-review', files })
}

function textFile(path: string, text: string): { path: string, base64: string } {
  return { path, base64: Buffer.from(text, 'utf8').toString('base64') }
}

function candidateFrom(overrides: Record<string, unknown> = {}): SkillCandidate {
  return {
    name: 'code-review',
    description: 'Reviews code changes',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'server',
    provider: SERVER_SKILL_PROVIDER_NAME,
    rank: SERVER_SKILL_RANK,
    locator: { id: 'skill-1', name: 'code-review', version: '1.0.0' },
    ...overrides,
  }
}

describe('safeSkillRelativePath', () => {
  it('accepts ordinary relative paths', () => {
    expect(safeSkillRelativePath('SKILL.md')).toEqual(['SKILL.md'])
    expect(safeSkillRelativePath('scripts/run.sh')).toEqual(['scripts', 'run.sh'])
  })

  it('rejects escapes and non-portable shapes', () => {
    for (const path of [
      '../evil',
      'a/../../evil',
      '/absolute',
      'C:\\windows',
      'c:/windows',
      'back\\slash',
      'a//b',
      'a/./b',
      './a',
      '',
      'nul\0',
    ]) {
      expect(safeSkillRelativePath(path)).toBeUndefined()
    }
    expect(safeSkillRelativePath(42)).toBeUndefined()
  })
})

describe('stripSkillFrontmatter', () => {
  it('removes a leading frontmatter block and leaves other content alone', () => {
    expect(stripSkillFrontmatter('---\nname: x\n---\n# Body\n')).toBe('# Body\n')
    expect(stripSkillFrontmatter('# Body\n---\nnot frontmatter\n')).toBe('# Body\n---\nnot frontmatter\n')
  })
})

describe('ServerSkillProvider.list', () => {
  it('maps server skills into candidates ranked above bundled local sources', async () => {
    const harness = createProvider(() => skillsResponse([skill()]))
    const candidates = await harness.provider.list({})

    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.name).toBe('code-review')
    expect(candidate.description).toBe('Reviews code changes')
    expect(candidate.provider).toBe(SERVER_SKILL_PROVIDER_NAME)
    expect(candidate.source).toBe('server')
    expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(candidate.rank).toBeGreaterThan(BUNDLED_SKILL_RANK)
    expect(candidate.locator).toEqual({ id: 'skill-1', name: 'code-review', version: '1.0.0' })
    expect(candidate.metadata).toEqual(expect.objectContaining({ version: '1.0.0', runtimeType: 'prompt' }))
    expect(harness.calls[0]?.url).toBe(`${ENDPOINT}/api/skills`)
  })

  it('returns an empty catalog while signed out without touching the network', async () => {
    const harness = createProvider(() => skillsResponse([skill()]))
    harness.setToken(undefined)

    await expect(harness.provider.list({})).resolves.toEqual([])
    expect(harness.calls).toHaveLength(0)
  })

  it('returns an empty catalog when the server is unreachable or rejects', async () => {
    const offline = createProvider(() => { throw new Error('connection refused') })
    await expect(offline.provider.list({})).resolves.toEqual([])

    const rejected = createProvider(() => new Response('oops', { status: 502 }))
    await expect(rejected.provider.list({})).resolves.toEqual([])
  })

  it('passes the enabled set through when the switch table is empty', async () => {
    const harness = createProvider(() => skillsResponse([
      skill(),
      skill({ id: 'skill-2', name: 'disabled-skill', enabled: false }),
      skill({ id: 'skill-3', name: 'Not A Skill' }),
    ]))
    harness.controls.current = {}

    const candidates = await harness.provider.list({})
    expect(candidates.map(candidate => candidate.name)).toEqual(['code-review'])
  })

  it('passes unlisted skills while an explicit per-skill off blocks only that skill', async () => {
    const harness = createProvider(() => skillsResponse([
      skill(),
      skill({ id: 'skill-2', name: 'other-skill' }),
      skill({ id: 'skill-3', name: 'third-skill' }),
    ]))
    // A non-empty switch table must not act as a whitelist: `on` and unlisted
    // skills follow the delivered catalog.
    harness.controls.current = { 'other-skill': 'off', 'code-review': 'on' }

    const candidates = await harness.provider.list({})
    expect(candidates.map(candidate => candidate.name)).toEqual(['code-review', 'third-skill'])

    const state = harness.sync.snapshot()
    expect(state.masterOff).toBe(false)
    expect(state.switchedOff).toBe(1)
    expect(state.skills?.map(item => item.name)).toEqual(['code-review', 'third-skill'])
  })

  it('empties the whole catalog when the reserved SKILLs master switch is off', async () => {
    const harness = createProvider(() => skillsResponse([
      skill(),
      skill({ id: 'skill-2', name: 'other-skill' }),
    ]))
    // The master switch suppresses the entire feature; per-skill offs are not
    // evaluated and do not count into switchedOff.
    harness.controls.current = { 'SKILLs': 'off', 'code-review': 'off' }

    await expect(harness.provider.list({})).resolves.toEqual([])

    const state = harness.sync.snapshot()
    expect(state.masterOff).toBe(true)
    expect(state.switchedOff).toBe(0)
    expect(state.skills).toEqual([])

    harness.controls.current = { 'SKILLs': 'on' }
    const candidates = await harness.provider.list({})
    expect(candidates.map(candidate => candidate.name)).toEqual(['code-review', 'other-skill'])
    expect(harness.sync.snapshot().masterOff).toBe(false)
  })

  it('invalidates catalogs when the server pushes a config change', () => {
    const harness = createProvider(() => skillsResponse([]))
    harness.notifyConfig()
    expect(harness.invalidate).toHaveBeenCalledTimes(1)
  })

  it('reports the effective installed set once per catalog', async () => {
    const harness = createProvider((call) => {
      if (call.url.endsWith('/api/skills')) return skillsResponse([skill()])
      if (call.url.endsWith('/api/skills/report-installed')) return Response.json({ ok: true })
      throw new Error(`unexpected call ${call.url}`)
    })

    await harness.provider.list({})
    await harness.provider.list({})
    await vi.waitFor(() => {
      expect(harness.calls.filter(call => call.url.endsWith('report-installed'))).toHaveLength(1)
    })

    const report = harness.calls.find(call => call.url.endsWith('report-installed'))!
    expect(report.init.method).toBe('POST')
    expect(JSON.parse(String(report.init.body))).toEqual({
      skills: [{ id: 'skill-1', name: 'code-review', source: 'server' }],
    })
  })
})

describe('ServerSkillProvider sync tracking', () => {
  it('starts idle before the first list', () => {
    const harness = createProvider(() => skillsResponse([]))
    expect(harness.sync.snapshot()).toEqual({ status: 'idle' })
  })

  it('records a successful sync with the lite catalog and timestamp', async () => {
    const harness = createProvider(() => skillsResponse([skill()]))

    await harness.provider.list({})

    const state = harness.sync.snapshot()
    expect(state.status).toBe('ok')
    expect(state.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    expect(state.skills).toEqual([{
      name: 'code-review',
      displayName: 'Code Review',
      version: '1.0.0',
      description: 'Reviews code changes',
    }])
  })

  it('keeps the last good snapshot when a later fetch fails and logs a warning', async () => {
    let fail = false
    const harness = createProvider(() => {
      if (fail) throw new Error('connection refused')
      return skillsResponse([skill()])
    })

    await harness.provider.list({})
    fail = true
    await expect(harness.provider.list({})).resolves.toEqual([])

    const state = harness.sync.snapshot()
    expect(state.status).toBe('error')
    expect(state.syncedAt).toBeDefined()
    expect(state.skills).toHaveLength(1)
    expect(harness.loggerWarn).toHaveBeenCalledTimes(1)
    expect(harness.loggerWarn.mock.calls[0]?.[0]).toContain('server skill sync failed')
  })

  it('records signed-out without touching the network', async () => {
    const harness = createProvider(() => skillsResponse([skill()]))
    harness.setToken(undefined)

    await harness.provider.list({})

    expect(harness.sync.snapshot()).toEqual({ status: 'signed-out' })
    expect(harness.calls).toHaveLength(0)
    expect(harness.loggerWarn).not.toHaveBeenCalled()
  })
})

describe('ServerSkillProvider.get', () => {
  it('materializes the bundle into a versioned cache directory and strips frontmatter', async () => {
    const harness = createProvider((call) => {
      if (call.url.endsWith('/api/skills/code-review/files')) {
        return filesResponse([
          textFile('SKILL.md', '---\nname: code-review\n---\n# Review carefully\n'),
          textFile('scripts/check.sh', '#!/bin/sh\n'),
        ])
      }
      throw new Error(`unexpected call ${call.url}`)
    })

    const definition = await harness.provider.get(candidateFrom(), {})

    expect(definition).toBeDefined()
    expect(definition!.content).toBe('# Review carefully\n')
    expect(definition!.provider).toBe(SERVER_SKILL_PROVIDER_NAME)
    expect(definition!.source).toBe('server')
    expect(definition!.resourceBase).toEqual({
      kind: 'directory',
      path: expect.stringContaining(join('code-review@1.0.0')),
    })
    expect(definition!.path).toBe(join(String(definition!.resourceBase && (definition!.resourceBase as { path: string }).path), 'SKILL.md'))
  })

  it('serves repeat loads from the cache without refetching', async () => {
    const harness = createProvider(() => filesResponse([textFile('SKILL.md', '# Body\n')]))

    await harness.provider.get(candidateFrom(), {})
    await harness.provider.get(candidateFrom(), {})

    expect(harness.calls.filter(call => call.url.endsWith('/files'))).toHaveLength(1)
  })

  it('refetches on version change and removes the superseded cache directory', async () => {
    const cacheRoot = temporaryCacheRoot()
    const harness = createProvider(() => filesResponse([textFile('SKILL.md', '# Body\n')]), cacheRoot)

    await harness.provider.get(candidateFrom(), {})
    const upgraded = candidateFrom({ locator: { id: 'skill-1', name: 'code-review', version: '2.0.0' } })
    await harness.provider.get(upgraded, {})

    expect(harness.calls.filter(call => call.url.endsWith('/files'))).toHaveLength(2)
    expect(readdirSync(cacheRoot).sort()).toEqual(['code-review@2.0.0'])
  })

  it('refuses path escapes without writing anything', async () => {
    const cacheRoot = temporaryCacheRoot()
    const harness = createProvider(() => filesResponse([
      textFile('SKILL.md', '# Body\n'),
      textFile('../evil.md', 'escape'),
    ]), cacheRoot)

    await expect(harness.provider.get(candidateFrom(), {})).resolves.toBeUndefined()
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('refuses bundles over the file, total, and count limits', async () => {
    const tooBig = createProvider(() => filesResponse([
      textFile('SKILL.md', '# Body\n'),
      { path: 'blob.bin', base64: Buffer.alloc(MAX_SKILL_FILE_BYTES + 1).toString('base64') },
    ]))
    await expect(tooBig.provider.get(candidateFrom(), {})).resolves.toBeUndefined()

    const tooLargeTotal = createProvider(() => filesResponse([
      textFile('SKILL.md', '# Body\n'),
      { path: 'a.bin', base64: Buffer.alloc(MAX_SKILL_TOTAL_BYTES).toString('base64') },
    ]))
    await expect(tooLargeTotal.provider.get(candidateFrom(), {})).resolves.toBeUndefined()

    const tooMany = createProvider(() => filesResponse([
      textFile('SKILL.md', '# Body\n'),
      ...Array.from({ length: MAX_SKILL_FILES }, (_, index) => textFile(`f${String(index)}.txt`, 'x')),
    ]))
    await expect(tooMany.provider.get(candidateFrom(), {})).resolves.toBeUndefined()
  })

  it('refuses bundles without an entry document and never caches them', async () => {
    const cacheRoot = temporaryCacheRoot()
    const harness = createProvider(() => filesResponse([textFile('README.md', 'no entry')]), cacheRoot)

    await expect(harness.provider.get(candidateFrom(), {})).resolves.toBeUndefined()
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('loads bundles whose files response exceeds the default gateway byte cap', async () => {
    // ~4.5 MB decoded → ~6 MB base64: the JSON body clears the shared 1 MB
    // gateway cap only because the files call raises its own ceiling, and the
    // strict base64 check must not overflow the regex stack on this size.
    const cacheRoot = temporaryCacheRoot()
    const harness = createProvider(() => filesResponse([
      textFile('SKILL.md', '# Body\n'),
      { path: 'scripts/index.js', base64: Buffer.alloc(Math.floor(4.5 * 1024 * 1024), 65).toString('base64') },
    ]), cacheRoot)

    const definition = await harness.provider.get(candidateFrom(), {})

    expect(definition).toBeDefined()
    expect(readdirSync(cacheRoot)).toEqual(['code-review@1.0.0'])
  })

  it('refuses files with malformed base64 characters or padding', async () => {
    for (const bad of ['QUJDRA==!', 'QUJD=AAA', 'QUJD====', 'QU JD']) {
      const harness = createProvider(() => filesResponse([
        textFile('SKILL.md', '# Body\n'),
        { path: 'blob.bin', base64: bad },
      ]))
      await expect(harness.provider.get(candidateFrom(), {})).resolves.toBeUndefined()
    }
  })

  it('returns undefined for unreachable servers and unsafe locators', async () => {
    const offline = createProvider(() => new Response('oops', { status: 503 }))
    await expect(offline.provider.get(candidateFrom(), {})).resolves.toBeUndefined()

    const harness = createProvider(() => filesResponse([textFile('SKILL.md', '# Body\n')]))
    const unsafe = candidateFrom({ locator: { id: 'skill-1', name: 'code-review', version: '../1.0' } })
    await expect(harness.provider.get(unsafe, {})).resolves.toBeUndefined()
    expect(harness.calls).toHaveLength(0)
  })
})
