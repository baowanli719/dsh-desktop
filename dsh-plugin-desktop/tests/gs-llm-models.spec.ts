import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import type { GsModelsConfig } from '../src/server/gs-contract.ts'
import {
  GS_LLM_PROXY_CREDENTIAL_REF,
  gsLlmProxyLaunchEnvironment,
  mirrorGsLlmModelSettings,
  planGsLlmModelProfile,
} from '../src/server/gs-llm-models.ts'

const PROXY_ORIGIN = 'http://127.0.0.1:43123'

const MODELS: GsModelsConfig = {
  providers: {
    acme: {
      api: 'openai-completions',
      models: [
        { id: 'acme-large', name: 'Acme Large', input: ['text', 'image'] },
        { id: 'acme-small' },
      ],
    },
    globex: {
      api: 'openai-completions',
      models: [{ id: 'globex-flash', input: ['text', 'audio'] }],
    },
  },
  defaultPrimary: 'acme/acme-large',
}

const dirs: string[] = []

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-llm-models-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('gsclaw-server model plan', () => {
  it('builds one proxy-routed provider profile per server provider', () => {
    const plan = planGsLlmModelProfile({ models: MODELS, proxyOrigin: PROXY_ORIGIN })

    expect(plan.warnings).toEqual([])
    expect(plan.defaultModel).toEqual({ provider: 'acme', model: 'acme-large' })
    expect(Object.keys(plan.providers!)).toEqual(['acme', 'globex'])
    expect(plan.providers!.acme).toEqual({
      displayName: 'acme',
      api: 'openai-completions',
      baseURL: `${PROXY_ORIGIN}/v1/acme`,
      apiKeyEnv: GS_LLM_PROXY_CREDENTIAL_REF,
      models: [
        { id: 'acme-large', name: 'Acme Large', input: ['text', 'image'] },
        { id: 'acme-small' },
      ],
    })
    // Modalities the pi-ai adapter cannot serve are dropped; an emptied list
    // falls back to the adapter default instead of declaring a unusable model.
    expect(plan.providers!.globex!.models[0]).toEqual({ id: 'globex-flash', input: ['text'] })
  })

  it('falls back to the first supplied model when defaultPrimary is absent', () => {
    const plan = planGsLlmModelProfile({
      models: {
        providers: {
          zeta: { api: 'openai-completions', models: [{ id: 'zeta-1' }, { id: 'zeta-2' }] },
          alpha: { api: 'openai-completions', models: [{ id: 'alpha-1' }] },
        },
      },
      proxyOrigin: PROXY_ORIGIN,
    })

    expect(plan.warnings).toEqual([])
    // Provider keys are sorted, so the fallback is deterministic.
    expect(plan.defaultModel).toEqual({ provider: 'alpha', model: 'alpha-1' })
  })

  it('falls back with a warning when defaultPrimary names nothing supplied', () => {
    for (const defaultPrimary of ['acme/unknown-model', 'unknown-provider/acme-large', 'no-slash']) {
      const plan = planGsLlmModelProfile({
        models: { ...MODELS, defaultPrimary },
        proxyOrigin: PROXY_ORIGIN,
      })
      expect(plan.defaultModel).toEqual({ provider: 'acme', model: 'acme-large' })
      expect(plan.warnings.some(warning => warning.includes('defaultPrimary'))).toBe(true)
    }
  })

  it('skips providers and models outside the route grammar with warnings', () => {
    const plan = planGsLlmModelProfile({
      models: {
        providers: {
          'bad provider': { api: 'openai-completions', models: [{ id: 'x' }] },
          empty: { api: 'openai-completions', models: [{ id: 'has/slash' }] },
          acme: MODELS.providers.acme!,
        },
        defaultPrimary: 'acme/acme-small',
      },
      proxyOrigin: PROXY_ORIGIN,
    })

    expect(Object.keys(plan.providers!)).toEqual(['acme'])
    expect(plan.defaultModel).toEqual({ provider: 'acme', model: 'acme-small' })
    expect(plan.warnings.some(warning => warning.includes('bad provider'))).toBe(true)
    expect(plan.warnings.some(warning => warning.includes('empty'))).toBe(true)
  })

  it('keeps the upstream default when the server supplies no usable models', () => {
    const empty = planGsLlmModelProfile({ models: { providers: {} }, proxyOrigin: PROXY_ORIGIN })
    expect(empty.providers).toBeUndefined()
    expect(empty.defaultModel).toBeUndefined()
    expect(empty.warnings.some(warning => warning.includes('no usable model providers'))).toBe(true)

    const missing = planGsLlmModelProfile({ models: null, proxyOrigin: PROXY_ORIGIN })
    expect(missing.providers).toBeUndefined()
    expect(missing.defaultModel).toBeUndefined()
    expect(missing.warnings.some(warning => warning.includes('no models section'))).toBe(true)
  })

  it('always plans the vision-router backend from the proxy origin', () => {
    const expected = {
      httpProviders: [{
        name: 'gsclaw-vision',
        baseURL: `${PROXY_ORIGIN}/v1/gs-cloud`,
        model: 'qwen36-35b',
        apiKeyEnv: GS_LLM_PROXY_CREDENTIAL_REF,
        maxTokens: 4096,
      }],
      freeFallback: false,
    }
    // The vision backend rides the gateway's visionModel allowance, so it is
    // planned even when the user-selectable model list is missing or empty.
    expect(planGsLlmModelProfile({ models: MODELS, proxyOrigin: PROXY_ORIGIN }).visionRouter).toEqual(expected)
    expect(planGsLlmModelProfile({ models: null, proxyOrigin: PROXY_ORIGIN }).visionRouter).toEqual(expected)
    expect(planGsLlmModelProfile({ models: { providers: {} }, proxyOrigin: PROXY_ORIGIN }).visionRouter).toEqual(expected)
  })
})

describe('model settings mirror', () => {
  it('writes the owned sections into a YAML document and preserves the rest', async () => {
    const dir = temporaryDir()
    const documentPath = join(dir, 'settings.yaml')
    writeFileSync(documentPath, [
      '# user comment survives',
      'dsh-desktop:',
      '  mode: compatibility',
      'llm-deepseek:',
      '  apiKeyEnv: DEEPSEEK_API_KEY',
      '',
    ].join('\n'))
    const plan = planGsLlmModelProfile({ models: MODELS, proxyOrigin: PROXY_ORIGIN })

    const changed = await mirrorGsLlmModelSettings(documentPath, plan)
    expect(changed).toBe(true)

    const text = readFileSync(documentPath, 'utf8')
    expect(text).toContain('# user comment survives')
    const root = parseDocument(text).toJS() as Record<string, unknown>
    expect(root['dsh-desktop']).toEqual({ mode: 'compatibility' })
    expect(root['llm-deepseek']).toBeUndefined()
    expect(root['llm-pi-ai']).toEqual({ providers: plan.providers })
    expect(root['agent-default-model']).toEqual({ provider: 'acme', model: 'acme-large' })
  })

  it('is a no-op when the document already mirrors the plan', async () => {
    const dir = temporaryDir()
    const documentPath = join(dir, 'settings.yaml')
    const plan = planGsLlmModelProfile({ models: MODELS, proxyOrigin: PROXY_ORIGIN })

    expect(await mirrorGsLlmModelSettings(documentPath, plan)).toBe(true)
    const written = readFileSync(documentPath, 'utf8')
    expect(await mirrorGsLlmModelSettings(documentPath, plan)).toBe(false)
    expect(readFileSync(documentPath, 'utf8')).toBe(written)
  })

  it('removes the owned sections when the plan supplies no models', async () => {
    const dir = temporaryDir()
    const documentPath = join(dir, 'settings.yaml')
    const populated = planGsLlmModelProfile({ models: MODELS, proxyOrigin: PROXY_ORIGIN })
    expect(await mirrorGsLlmModelSettings(documentPath, populated)).toBe(true)

    const empty = planGsLlmModelProfile({ models: null, proxyOrigin: PROXY_ORIGIN })
    expect(await mirrorGsLlmModelSettings(documentPath, empty)).toBe(true)
    const root = parseDocument(readFileSync(documentPath, 'utf8')).toJS() as Record<string, unknown>
    expect(root['llm-pi-ai']).toBeUndefined()
    expect(root['llm-deepseek']).toBeUndefined()
    expect(root['agent-default-model']).toBeUndefined()

    // Nothing left to remove and nothing to write.
    expect(await mirrorGsLlmModelSettings(documentPath, empty)).toBe(false)
  })

  it('supports JSON settings documents', async () => {
    const dir = temporaryDir()
    const documentPath = join(dir, 'settings.json')
    writeFileSync(documentPath, `${JSON.stringify({ 'dsh-desktop': { mode: 'extended' } }, undefined, 2)}\n`)
    const plan = planGsLlmModelProfile({ models: MODELS, proxyOrigin: PROXY_ORIGIN })

    expect(await mirrorGsLlmModelSettings(documentPath, plan)).toBe(true)
    const root = JSON.parse(readFileSync(documentPath, 'utf8')) as Record<string, unknown>
    expect(root['dsh-desktop']).toEqual({ mode: 'extended' })
    expect(root['llm-pi-ai']).toEqual({ providers: plan.providers })
    expect(root['agent-default-model']).toEqual({ provider: 'acme', model: 'acme-large' })
    expect(await mirrorGsLlmModelSettings(documentPath, plan)).toBe(false)
  })

  it('overwrites a user-authored llm-pi-ai section', async () => {
    const dir = temporaryDir()
    const documentPath = join(dir, 'settings.yaml')
    writeFileSync(documentPath, [
      'llm-pi-ai:',
      '  providers:',
      '    evil:',
      '      api: openai-completions',
      '      baseURL: https://evil.example/v1',
      '      models:',
      '        - id: evil-1',
      '',
    ].join('\n'))
    const plan = planGsLlmModelProfile({ models: MODELS, proxyOrigin: PROXY_ORIGIN })

    expect(await mirrorGsLlmModelSettings(documentPath, plan)).toBe(true)
    const root = parseDocument(readFileSync(documentPath, 'utf8')).toJS() as Record<string, unknown>
    expect(root['llm-pi-ai']).toEqual({ providers: plan.providers })
  })

  it('mirrors the vision-router section, rewrites on origin change, and owns it outright', async () => {
    const dir = temporaryDir()
    const documentPath = join(dir, 'settings.yaml')
    writeFileSync(documentPath, [
      'vision-router:',
      '  httpProviders:',
      '    - name: user-added',
      '      baseURL: https://evil.example/v1',
      '      model: evil-vl',
      '',
    ].join('\n'))
    const plan = planGsLlmModelProfile({ models: MODELS, proxyOrigin: PROXY_ORIGIN })

    expect(await mirrorGsLlmModelSettings(documentPath, plan)).toBe(true)
    const root = parseDocument(readFileSync(documentPath, 'utf8')).toJS() as Record<string, unknown>
    expect(root['vision-router']).toEqual(plan.visionRouter)
    expect((root['vision-router'] as { httpProviders: { baseURL: string }[] }).httpProviders[0]?.baseURL)
      .toBe(`${PROXY_ORIGIN}/v1/gs-cloud`)

    // Same plan is a no-op; a new boot origin rewrites the section.
    expect(await mirrorGsLlmModelSettings(documentPath, plan)).toBe(false)
    const rebooted = planGsLlmModelProfile({ models: MODELS, proxyOrigin: 'http://127.0.0.1:43999' })
    expect(await mirrorGsLlmModelSettings(documentPath, rebooted)).toBe(true)
    const rewritten = parseDocument(readFileSync(documentPath, 'utf8')).toJS() as Record<string, unknown>
    expect((rewritten['vision-router'] as { httpProviders: { baseURL: string }[] }).httpProviders[0]?.baseURL)
      .toBe('http://127.0.0.1:43999/v1/gs-cloud')
  })
})

describe('proxy launch environment', () => {
  it('resolves the proxy token as a process-layer entry and delegates the rest', () => {
    const base = {
      get: (name: string) => name === 'OTHER' ? { value: 'base-value', source: 'user-env' as const } : undefined,
      getFrom: (name: string, sources: readonly string[]) =>
        name === 'OTHER' && sources.includes('user-env')
          ? { value: 'base-value', source: 'user-env' as const }
          : undefined,
    }
    const wrapped = gsLlmProxyLaunchEnvironment(base, 'boot-token')

    expect(wrapped.get(GS_LLM_PROXY_CREDENTIAL_REF)).toEqual({ value: 'boot-token', source: 'process' })
    expect(wrapped.getFrom(GS_LLM_PROXY_CREDENTIAL_REF, ['process'])).toEqual({ value: 'boot-token', source: 'process' })
    // Layers other than the inherited environment never see the token.
    expect(wrapped.getFrom(GS_LLM_PROXY_CREDENTIAL_REF, ['project-env', 'user-env'])).toBeUndefined()
    expect(wrapped.get('OTHER')).toEqual({ value: 'base-value', source: 'user-env' })
    expect(wrapped.getFrom('OTHER', ['user-env'])).toEqual({ value: 'base-value', source: 'user-env' })
    expect(wrapped.get('MISSING')).toBeUndefined()
  })
})
