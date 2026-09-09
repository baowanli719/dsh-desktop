import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext, Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('dsh-vision-router/package.json'))
const runtime = await import(pathToFileURL(join(root, 'lib/client-presentation-boundary-main.js')).href)
const request = runtime.requestManagedVision as (
  state: Record<string, unknown>, config: Record<string, unknown>, attempt: { key?: string },
  select: (selection: unknown) => unknown,
) => Promise<boolean> | undefined

const groups = [
  { id: 'gs-cloud', name: 'Cloud', models: [{ id: 'chat-a' }, { id: 'chat-b' }] },
  { id: 'gs-cloud-vision', name: 'Cloud + 自动识图', models: [{ id: 'chat-a' }, { id: 'chat-b' }] },
]
const state = (provider = 'gs-cloud', model = 'chat-a', status = 'ready') => ({
  groups, status, current: { provider, model, reasoningEffort: 'high' },
})

describe('managed image conversation', () => {
  it('automatically enables image admission while preserving the chat model and effort', async () => {
    const select = vi.fn().mockResolvedValue(true)
    await expect(request(state(), {}, {}, select)).resolves.toBe(true)
    expect(select).toHaveBeenCalledExactlyOnceWith({
      provider: 'gs-cloud-vision', model: 'chat-a', reasoningEffort: 'high',
    })
  })

  it('keeps a restored image session active and follows subsequent ordinary model choices', async () => {
    const select = vi.fn().mockResolvedValue(true)
    const attempt = {}
    expect(request(state('gs-cloud-vision'), {}, attempt, select)).toBeUndefined()
    expect(select).not.toHaveBeenCalled()
    await request(state('gs-cloud', 'chat-b'), {}, attempt, select)
    expect(select).toHaveBeenCalledWith({ provider: 'gs-cloud-vision', model: 'chat-b', reasoningEffort: 'high' })
  })

  it('waits for directory readiness and does not invent a wrapper for a native/unknown model', () => {
    const select = vi.fn()
    for (const status of ['idle', 'loading', 'selecting']) {
      expect(request(state('gs-cloud', 'chat-a', status), {}, {}, select)).toBeUndefined()
    }
    expect(request(state('native-provider'), {}, {}, select)).toBeUndefined()
    expect(select).not.toHaveBeenCalled()
  })

  it('coalesces repeat renders and reports a failed selection without an infinite retry', async () => {
    const select = vi.fn().mockRejectedValue(new Error('session is busy'))
    const attempt = {}
    const first = request(state(), {}, attempt, select)
    expect(request(state(), {}, attempt, select)).toBeUndefined()
    await expect(first).resolves.toBe(false)
    expect(request(state(), {}, attempt, select)).toBeUndefined()
    expect(select).toHaveBeenCalledTimes(1)
    await request(state('gs-cloud', 'chat-b'), {}, attempt, select)
    expect(select).toHaveBeenCalledTimes(2)
  })

  it('does not activate setup effects or return the manual mode button', () => {
    const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
    expect(client).not.toContain('ctx.effect(() => installOnboarding(t)')
    expect(client).not.toContain('ctx.effect(() => installVisionSettingsGuide(t)')
    expect(runtime.CLIENT_PRESENTATION_PRELUDE).toContain('return toastNode;')
    expect(runtime.CLIENT_PRESENTATION_PRELUDE).toContain('requestManagedVision(state, visionConfig, attempt, props.select)')
  })

  it('renders no mode control and starts automatic selection from the actual composer component', async () => {
    const source = runtime.CLIENT_PRESENTATION_PRELUDE as string
    const start = source.indexOf('function VisionModeToggle(props) {')
    const end = source.indexOf('\n      scope.effect(function()', start)
    const effects: (() => unknown)[] = []
    const select = vi.fn().mockResolvedValue(true)
    const component = runInNewContext(`(${source.slice(start, end).trim()})`, {
      React: {
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
        useState: () => [null, vi.fn()],
        useRef: (current: unknown) => ({ current }),
        useEffect: (effect: () => unknown) => effects.push(effect),
        createElement: (type: unknown, props: unknown) => ({ type, props }),
      },
      settings: undefined,
      unavailableSettingsState: { value: undefined },
      resolveVisionModePair: runtime.resolveVisionModePair,
      requestManagedVision: request,
    }) as (props: unknown) => unknown
    expect(component({
      available: true, select, t: (key: string) => key,
      directory: { store: { subscribe: vi.fn(), getSnapshot: () => state() } },
    })).toBeNull()
    for (const effect of effects) effect()
    await Promise.resolve()
    expect(select).toHaveBeenCalledWith({ provider: 'gs-cloud-vision', model: 'chat-a', reasoningEffort: 'high' })
  })

  it('keeps the shipped icon and ownership transforms compatible with the managed composer', async () => {
    const presentation = await import(pathToFileURL(join(root, 'lib/client-presentation-boundary.js')).href)
    const hardening = await import(pathToFileURL(join(root, 'lib/vision-toggle-root-hardening.js')).href)
    const html = hardening.hardenVisionToggleHtml(presentation.injectClientPresentationBoundary('<head></head>')) as string
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const match of scripts) expect(() => new Script(match[1]!)).not.toThrow()
    expect(html).toContain('requestManagedVision(state, visionConfig, attempt, props.select)')
    expect(html).toContain('rootHardening.subscribe')
  })
})
