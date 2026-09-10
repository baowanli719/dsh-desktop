import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  createGsServerSkillCatalog,
  createGsSkillSyncTracker,
  safeSkillRelativePath,
  stripSkillFrontmatter,
  type GsServerSkillCatalogController,
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
  readonly catalog: GsServerSkillCatalogController
  readonly loggerWarn: ReturnType<typeof vi.fn<(format: string, ...param: unknown[]) => void>>
  notifyConfig(): void
  setToken(token: string | undefined): void
  setUserId(userId: number | undefined): void
}

function createProvider(
  handler: (call: RecordedCall) => Response | Promise<Response>,
  cacheRoot = temporaryCacheRoot(),
): ProviderHarness {
  const calls: RecordedCall[] = []
  let token: string | undefined = 'access-1'
  let userId: number | undefined = 1
  const controls: { current: Record<string, GsSkillControl> | undefined } = { current: undefined }
  const listeners = new Set<() => void>()
  const invalidate = vi.fn<() => void>()
  const sync = createGsSkillSyncTracker()
  const catalog = createGsServerSkillCatalog()
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
    userId: () => userId,
    skillControls: () => controls.current,
    subscribeConfig: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const provider = new ServerSkillProvider(face, { cacheRoot, request, logger: { warn: loggerWarn }, catalog }, {
    signal: new AbortController().signal,
    invalidate,
  }, sync)
  return {
    provider,
    calls,
    controls,
    invalidate,
    sync,
    catalog,
    loggerWarn,
    notifyConfig() { for (const listener of listeners) listener() },
    setToken(next) { token = next },
    setUserId(next) { userId = next },
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

/** Legacy handshake: no `skillExecution` field. */
function metaResponse(capability?: { types: readonly string[] }): Response {
  return Response.json({
    serviceName: 'gsclaw-server',
    serviceVersion: '1.0.0',
    loginMethods: ['password'],
    minimumClientVersion: '0.0.0',
    llmProxy: true,
    ...(capability === undefined ? {} : { skillExecution: { version: 1, types: capability.types } }),
  })
}

function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'customer-analysis',
    displayName: 'Customer Analysis',
    description: 'Analyses new customers',
    version: '2.0.0',
    runtimeType: 'data-query',
    definitionRevision: 'rev-1',
    ...overrides,
  }
}

function catalogResponse(skills: readonly Record<string, unknown>[]): Response {
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
    // The capability handshake runs first; a legacy answer selects /api/skills.
    expect(harness.calls.map(call => call.url).filter(url => !url.endsWith('report-installed'))).toEqual([
      `${ENDPOINT}/api/v1/meta`,
      `${ENDPOINT}/api/skills`,
    ])
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
      if (call.url.endsWith('/api/v1/meta')) return metaResponse()
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
      enabled: true,
      name: 'code-review',
      displayName: 'Code Review',
      version: '1.0.0',
      description: 'Reviews code changes',
      runtimeType: 'prompt',
    }])
    expect(state.execution).toEqual({ supported: false, types: [] })
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


/** Handler answering the capability handshake and the v1 catalog with the given entries. */
function v1Harness(
  entries: readonly Record<string, unknown>[],
  extra?: (call: RecordedCall) => Response | undefined,
  types: readonly string[] = ['data-query', 'server-mcp'],
): ProviderHarness {
  return createProvider((call) => {
    const answered = extra?.(call)
    if (answered !== undefined) return answered
    if (call.url.endsWith('/api/v1/meta')) return metaResponse({ types })
    if (call.url.endsWith('/api/v1/skills/catalog')) return catalogResponse(entries)
    if (call.url.endsWith('/api/skills/report-installed')) return Response.json({ ok: true })
    throw new Error(`unexpected call ${call.url}`)
  })
}

describe('ServerSkillProvider catalog protocol', () => {
  it('uses the v1 catalog when the server advertises skillExecution and splits runtime types', async () => {
    const harness = v1Harness([
      catalogEntry({ name: 'local-report', runtimeType: 'client' }),
      catalogEntry(),
      catalogEntry({ name: 'crm-lookup', runtimeType: 'server-mcp', definitionRevision: 'rev-9' }),
      catalogEntry({ name: 'mystery', runtimeType: 'shell', version: '3.1.0' }),
    ])

    const candidates = await harness.provider.list({})

    expect(harness.calls.map(call => call.url).filter(url => !url.endsWith('report-installed'))).toEqual([
      `${ENDPOINT}/api/v1/meta`,
      `${ENDPOINT}/api/v1/skills/catalog`,
    ])
    expect(candidates.map(candidate => candidate.name)).toEqual(['local-report', 'customer-analysis', 'crm-lookup'])
    const remote = candidates[1]!
    expect(remote.locator).toEqual({
      kind: 'remote',
      name: 'customer-analysis',
      version: '2.0.0',
      runtimeType: 'data-query',
      revision: 'rev-1',
    })
    expect(remote.metadata).toEqual(expect.objectContaining({
      execution: 'server',
      runtimeType: 'data-query',
      definitionRevision: 'rev-1',
    }))

    const state = harness.sync.snapshot()
    expect(state.execution).toEqual({ supported: true, types: ['data-query', 'server-mcp'] })
    expect(state.skills).toEqual([
      expect.objectContaining({ name: 'local-report', execution: 'desktop', available: true }),
      expect.objectContaining({ name: 'customer-analysis', execution: 'server-data-query', available: true }),
      expect.objectContaining({ name: 'crm-lookup', execution: 'server-mcp', available: true }),
      expect.objectContaining({
        name: 'mystery',
        runtimeType: 'shell',
        available: false,
        unavailableReason: 'runtime-unsupported',
      }),
    ])
    expect(harness.catalog.snapshot().remotes).toEqual([
      { name: 'customer-analysis', runtimeType: 'data-query', definitionRevision: 'rev-1' },
      { name: 'crm-lookup', runtimeType: 'server-mcp', definitionRevision: 'rev-9' },
    ])

    // Remote types carry no local bundle, so the installed-set report holds
    // only the client skill, with the unchanged report shape.
    await vi.waitFor(() => {
      expect(harness.calls.some(call => call.url.endsWith('report-installed'))).toBe(true)
    })
    const report = harness.calls.find(call => call.url.endsWith('report-installed'))!
    expect(JSON.parse(String(report.init.body))).toEqual({
      skills: [{ id: 'local-report', name: 'local-report', source: 'server' }],
    })
  })

  it('treats a remote type the handshake did not advertise as unavailable', async () => {
    const harness = v1Harness([catalogEntry()], undefined, ['server-mcp'])

    const candidates = await harness.provider.list({})

    expect(candidates).toEqual([])
    expect(harness.sync.snapshot().skills).toEqual([
      expect.objectContaining({ name: 'customer-analysis', available: false, unavailableReason: 'runtime-unsupported' }),
    ])
    expect(harness.catalog.snapshot().remotes).toEqual([])
  })

  it('honors the master and per-skill switches in the v1 catalog', async () => {
    const harness = v1Harness([catalogEntry(), catalogEntry({ name: 'crm-lookup', runtimeType: 'server-mcp' })])
    harness.controls.current = { 'crm-lookup': 'off' }

    const candidates = await harness.provider.list({})

    expect(candidates.map(candidate => candidate.name)).toEqual(['customer-analysis'])
    expect(harness.sync.snapshot().switchedOff).toBe(1)
    expect(harness.catalog.snapshot().remotes).toEqual([
      { name: 'customer-analysis', runtimeType: 'data-query', definitionRevision: 'rev-1' },
    ])
  })

  it('clears the published catalog on sign-out', async () => {
    const harness = v1Harness([catalogEntry()])
    await harness.provider.list({})
    expect(harness.catalog.snapshot().remotes).toHaveLength(1)

    harness.setToken(undefined)
    harness.setUserId(undefined)
    await expect(harness.provider.list({})).resolves.toEqual([])

    expect(harness.sync.snapshot()).toEqual({ status: 'signed-out' })
    expect(harness.catalog.snapshot()).toEqual({ supported: false, types: [], remotes: [] })
  })
})

describe('ServerSkillProvider remote definitions', () => {
  function definitionResponse(overrides: Record<string, unknown> = {}): Response {
    return Response.json({
      name: 'customer-analysis',
      version: '2.0.0',
      runtimeType: 'data-query',
      definitionRevision: 'rev-1',
      content: '# Analyse new customers\nUse run_data_query.\n',
      dataQuery: { queries: [{ name: 'customer_summary', params: [] }] },
      ...overrides,
    })
  }

  function remoteCandidate(overrides: Record<string, unknown> = {}): SkillCandidate {
    return {
      name: 'customer-analysis',
      description: 'Analyses new customers',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'server',
      provider: SERVER_SKILL_PROVIDER_NAME,
      rank: SERVER_SKILL_RANK,
      locator: {
        kind: 'remote',
        name: 'customer-analysis',
        version: '2.0.0',
        runtimeType: 'data-query',
        revision: 'rev-1',
      },
      ...overrides,
    }
  }

  function definitionHarness(handler?: (call: RecordedCall) => Response): ProviderHarness {
    return createProvider((call) => {
      if (call.url.endsWith('/api/v1/skills/customer-analysis/definition')) {
        return handler?.(call) ?? definitionResponse()
      }
      throw new Error(`unexpected call ${call.url}`)
    })
  }

  it('loads the definition content in memory without materializing a bundle', async () => {
    const harness = definitionHarness()

    const definition = await harness.provider.get(remoteCandidate(), {})

    expect(definition).toBeDefined()
    expect(definition!.content.startsWith('# Analyse new customers\nUse run_data_query.\n')).toBe(true)
    expect(definition!.content).toContain('## Available query templates (call via `run_data_query`)')
    expect(definition!.content).toContain('### `customer_summary`')
    expect(definition!.resourceBase).toBeUndefined()
    expect(definition!.path).toBeUndefined()
    expect(definition!.metadata).toEqual(expect.objectContaining({
      execution: 'server',
      runtimeType: 'data-query',
      definitionRevision: 'rev-1',
    }))
    expect(harness.calls.map(call => call.url)).toEqual([
      `${ENDPOINT}/api/v1/skills/customer-analysis/definition`,
    ])
  })

  it('caches per revision and refetches when the revision changes', async () => {
    let revision = 'rev-1'
    const harness = createProvider((call) => {
      if (call.url.endsWith('/definition')) return definitionResponse({ definitionRevision: revision })
      throw new Error(`unexpected call ${call.url}`)
    })

    await harness.provider.get(remoteCandidate(), {})
    await harness.provider.get(remoteCandidate(), {})
    expect(harness.calls).toHaveLength(1)

    revision = 'rev-2'
    const moved = remoteCandidate({
      locator: { kind: 'remote', name: 'customer-analysis', version: '2.0.0', runtimeType: 'data-query', revision: 'rev-2' },
    })
    const definition = await harness.provider.get(moved, {})
    expect(definition).toBeDefined()
    expect(harness.calls.filter(call => call.url.endsWith('/definition'))).toHaveLength(2)
  })

  it('invalidates the catalog and refuses the load when the definition moved', async () => {
    const harness = definitionHarness(() => definitionResponse({ definitionRevision: 'rev-2' }))

    await expect(harness.provider.get(remoteCandidate(), {})).resolves.toBeUndefined()
    expect(harness.invalidate).toHaveBeenCalledTimes(1)
  })

  it('marks the skill unavailable in the sync snapshot when the definition fetch fails', async () => {
    const harness = definitionHarness(() => new Response('oops', { status: 500 }))
    harness.sync.update({
      status: 'ok',
      skills: [{ name: 'customer-analysis', description: '', execution: 'server-data-query', available: true }],
    })

    await expect(harness.provider.get(remoteCandidate(), {})).resolves.toBeUndefined()

    expect(harness.sync.snapshot().skills).toEqual([
      expect.objectContaining({ name: 'customer-analysis', available: false, unavailableReason: 'definition-error' }),
    ])
  })

  it('discards a late definition response from a previous account', async () => {
    let release: (response: Response) => void = () => {}
    const harness = createProvider(() => new Promise<Response>((resolve) => { release = resolve }))

    const pending = harness.provider.get(remoteCandidate(), {})
    harness.setUserId(2)
    release(definitionResponse())

    await expect(pending).resolves.toBeUndefined()
    // Nothing was cached under the old account: the next load refetches.
    const second = harness.provider.get(remoteCandidate(), {})
    release(definitionResponse())
    await expect(second).resolves.toBeDefined()
    expect(harness.calls).toHaveLength(2)
  })

  it('refuses remote loads while signed out without touching the network', async () => {
    const harness = definitionHarness()
    harness.setToken(undefined)

    await expect(harness.provider.get(remoteCandidate(), {})).resolves.toBeUndefined()
    expect(harness.calls).toHaveLength(0)
  })

  it('appends the allowlisted MCP tools of a server-mcp skill to the skill content', async () => {
    const harness = definitionHarness(() => definitionResponse({
      runtimeType: 'server-mcp',
      content: '# CRM lookup\n',
      mcp: {
        tools: [
          {
            name: 'mx_ashare_finance_data',
            description: 'Query A-share market data',
            inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
          },
          { name: 'mx_index_block_finance_data' },
          { name: '' },
          'garbage',
        ],
      },
    }))
    const candidate = remoteCandidate({
      locator: { kind: 'remote', name: 'customer-analysis', version: '2.0.0', runtimeType: 'server-mcp', revision: 'rev-1' },
    })

    const definition = await harness.provider.get(candidate, {})

    expect(definition).toBeDefined()
    expect(definition!.content).toContain('## Available tools (call via `run_mcp_skill`)')
    expect(definition!.content).toContain('`skill` to `customer-analysis`')
    expect(definition!.content).toContain('### `mx_ashare_finance_data`')
    expect(definition!.content).toContain('Query A-share market data')
    expect(definition!.content).toContain('"symbol"')
    expect(definition!.content).toContain('### `mx_index_block_finance_data`')
    expect(definition!.content).not.toContain('garbage')
    // The data-query fixture section must not leak into a server-mcp listing.
    expect(definition!.content).not.toContain('run_data_query')
  })

  it('appends the declared query templates and parameter shapes of a data-query skill', async () => {
    const harness = definitionHarness(() => definitionResponse({
      dataQuery: {
        queries: [{
          name: 'customer_summary',
          description: 'Summarise customers',
          params: [
            { name: 'region', type: 'string', required: true, enum: ['east', 'west'], description: 'Sales region' },
            { name: 'limit', type: 'number', required: false },
          ],
        }],
      },
    }))

    const definition = await harness.provider.get(remoteCandidate(), {})

    expect(definition).toBeDefined()
    expect(definition!.content.startsWith('# Analyse new customers\nUse run_data_query.\n')).toBe(true)
    expect(definition!.content).toContain('## Available query templates (call via `run_data_query`)')
    expect(definition!.content).toContain('### `customer_summary`')
    expect(definition!.content).toContain('Summarise customers')
    expect(definition!.content).toContain('- `region` (string, required). Sales region Allowed: east, west.')
    expect(definition!.content).toContain('- `limit` (number, optional).')
  })

  it('leaves the content untouched when the definition declares no tool surface', async () => {
    const harness = definitionHarness(() => definitionResponse({ dataQuery: undefined, mcp: undefined }))

    const definition = await harness.provider.get(remoteCandidate(), {})

    expect(definition).toBeDefined()
    expect(definition!.content).toBe('# Analyse new customers\nUse run_data_query.\n')
  })

  it('caps an oversized tool listing instead of failing the load', async () => {
    const tools = Array.from({ length: 400 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'x'.repeat(200),
    }))
    const harness = definitionHarness(() => definitionResponse({ runtimeType: 'server-mcp', mcp: { tools } }))
    const candidate = remoteCandidate({
      locator: { kind: 'remote', name: 'customer-analysis', version: '2.0.0', runtimeType: 'server-mcp', revision: 'rev-1' },
    })

    const definition = await harness.provider.get(candidate, {})

    expect(definition).toBeDefined()
    expect(definition!.content).toContain('[Tool listing truncated to stay within size limits.]')
  })
})


describe('server skill activation preferences', () => {
  it('keeps silent legacy deliveries visible and preserves user choices across restarts and accounts', async () => {
    const cache = temporaryCacheRoot()
    let defaultEnabled = false
    const handler = () => skillsResponse([skill({ defaultEnabled })])
    const first = createProvider(handler, cache)
    expect(await first.provider.list({})).toEqual([])
    expect(first.sync.snapshot().skills).toEqual([expect.objectContaining({ name: 'code-review', enabled: false })])
    await first.provider.setEnabled('code-review', true)
    expect(await first.provider.list({})).toHaveLength(1)
    await first.provider.setEnabled('code-review', false)
    defaultEnabled = true
    const restarted = createProvider(handler, cache)
    expect(await restarted.provider.list({})).toEqual([])
    restarted.setUserId(2)
    expect(await restarted.provider.list({})).toHaveLength(1)
    restarted.setUserId(1)
    expect(await restarted.provider.list({})).toEqual([])
    await restarted.provider.setEnabled('code-review', true)
    restarted.controls.current = { 'code-review': 'off' }
    expect(await restarted.provider.list({})).toEqual([])
    await expect(restarted.provider.setEnabled('code-review', true)).rejects.toThrow('skill unavailable')
  })

  it('keeps disabled remote skills out of the execution bridge and refuses stale loads', async () => {
    const harness = v1Harness([catalogEntry({ defaultEnabled: false })])
    expect(await harness.provider.list({})).toEqual([])
    expect(harness.catalog.snapshot().remotes).toEqual([])
    await harness.provider.setEnabled('customer-analysis', true)
    const [candidate] = await harness.provider.list({})
    expect(harness.catalog.snapshot().remotes).toHaveLength(1)
    await harness.provider.setEnabled('customer-analysis', false)
    expect(harness.catalog.snapshot().remotes).toEqual([])
    await expect(harness.provider.get(candidate!, {})).resolves.toBeUndefined()
    expect(await harness.provider.list({})).toEqual([])
    expect(harness.sync.snapshot().skills).toEqual([expect.objectContaining({ enabled: false, available: true })])
  })

  it('does not fetch bundles or definitions for silently delivered v1 skills', async () => {
    const harness = v1Harness([
      catalogEntry({ name: 'local-report', runtimeType: 'client', defaultEnabled: false }),
      catalogEntry({ defaultEnabled: false }),
    ])
    expect(await harness.provider.list({})).toEqual([])
    expect(harness.sync.snapshot().skills).toHaveLength(2)
    expect(harness.calls.some(call => /\/(files|definition)$/.test(call.url))).toBe(false)
    await expect(harness.provider.setEnabled('../escape', true)).rejects.toThrow()
    harness.setToken(undefined)
    await expect(harness.provider.setEnabled('customer-analysis', true)).rejects.toThrow()
  })

  it('falls back to the server default when a saved preference is corrupt', async () => {
    const cache = temporaryCacheRoot()
    const account = createHash('sha256').update(`${ENDPOINT}#1`).digest('hex')
    const dir = join(cache, 'preferences', account)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'code-review.json'), 'not-json', 'utf8')
    const harness = createProvider(() => skillsResponse([skill({ defaultEnabled: false })]), cache)
    expect(await harness.provider.list({})).toEqual([])
    expect(harness.sync.snapshot().skills).toEqual([expect.objectContaining({ name: 'code-review', enabled: false })])
    expect(harness.sync.snapshot().status).toBe('ok')
    expect(harness.loggerWarn).toHaveBeenCalled()
    writeFileSync(join(dir, 'code-review.json'), 'true', 'utf8')
    expect(await harness.provider.list({})).toHaveLength(1)
  })
})


it('discards a catalog response that arrives after the user disables a skill', async () => {
  let delayed = false
  let release: (response: Response) => void = () => {}
  const harness = createProvider(call => {
    if (call.url.endsWith('/api/v1/meta')) return metaResponse({ types: ['data-query'] })
    if (call.url.endsWith('/api/v1/skills/catalog')) {
      return delayed ? new Promise<Response>(resolve => { release = resolve }) : catalogResponse([catalogEntry()])
    }
    return Response.json({ ok: true })
  })
  await harness.provider.list({})
  delayed = true
  const pending = harness.provider.list({})
  await vi.waitFor(() => expect(harness.calls.filter(call => call.url.endsWith('/catalog'))).toHaveLength(2))
  await harness.provider.setEnabled('customer-analysis', false)
  release(catalogResponse([catalogEntry()]))
  expect(await pending).toEqual([])
  expect(harness.catalog.snapshot().remotes).toEqual([])
  expect(harness.sync.snapshot().skills?.[0]?.enabled).toBe(false)
})
