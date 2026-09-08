import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  InputTriggerCandidate,
  InputTriggerController as InputTriggerControllerFace,
  InputTriggerSource,
  SourceRoster,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

const require = createRequire(import.meta.url)
const sid = (k: string): SessionId => k as SessionId
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

interface ClientRegistration {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => {
    InputTriggerController: new (deps: {
      actx: ClientContext
      sessionId: SessionId
      roster: SourceRoster
    }) => InputTriggerControllerFace
  }
}

/** Load the patched client bundle the way the Renderer module table does. */
function loadPatchedController(): ClientRegistration['factory'] extends (require: never) => infer R ? R : never {
  const registrations: ClientRegistration[] = []
  const source = readFileSync(
    require.resolve('@deepseek-ai/dsh-client-ui-input-trigger/client'),
    'utf8',
  )
  runInNewContext(source, {
    AbortController,
    AbortSignal,
    console,
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: {
        load: (registration: ClientRegistration) => registrations.push(registration),
      },
    },
  }, { filename: 'dsh-client-ui-input-trigger/client.js' })
  expect(registrations).toHaveLength(1)
  const registration = registrations[0] as ClientRegistration
  expect(registration.id).toBe('@deepseek-ai/dsh-client-ui-input-trigger')
  return registration.factory((id: string) => {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      // Browser-only primitive components; the controller never touches them.
      return {
        ReferenceIcon: () => null,
        IconChevronRightOutline14: () => null,
        IconSkillOutline16: () => null,
        IconGoalOutline16: () => null,
        IconCodeOutline16: () => null,
        useAnchoredMaxHeight: () => 320,
      }
    }
    return require(id) as unknown
  }) as ReturnType<ClientRegistration['factory']>
}

function emptyAtSource(name: string): InputTriggerSource {
  return {
    trigger: '@',
    name,
    candidates: () => Promise.resolve([] as readonly InputTriggerCandidate[]),
    onPick: () => 'handled',
  }
}

function failingAtSource(name: string): InputTriggerSource {
  return {
    trigger: '@',
    name,
    candidates: () => Promise.reject(new Error(`${name} unavailable`)),
    onPick: () => 'handled',
  }
}

function bench(sources: readonly InputTriggerSource[]): InputTriggerControllerFace {
  const { InputTriggerController } = loadPatchedController()
  const roster: SourceRoster = {
    sources: trigger => sources.filter(s => s.trigger === trigger),
    all: () => [...sources],
  }
  // The controller only touches actx through scoped event dispatch (bail).
  const actx = {
    bail: (_subject: unknown, event: string, _payload: unknown) =>
      event === 'slash/input-insert-text' ? true : undefined,
  } as unknown as ClientContext
  return new InputTriggerController({ actx, sessionId: sid('s1'), roster })
}

describe('input-trigger client patch: all-empty menu keeps the empty hint', () => {
  it('keeps the menu open when every @ source settles ready-but-empty', async () => {
    const controller = bench([emptyAtSource('reference'), emptyAtSource('cordis')])
    controller.track('@', 1, { tier: 'plain' }, 1)
    await flush()
    const state = controller.menu.getSnapshot()
    expect(state.open).toBe(true)
    expect(state.groups).toHaveLength(2)
    expect(state.groups.every(g => g.status === 'ready' && g.items.length === 0)).toBe(true)
  })

  it('still closes once every source failed and no group remains', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const controller = bench([failingAtSource('reference'), failingAtSource('cordis')])
      controller.track('@', 1, { tier: 'plain' }, 1)
      await flush()
      expect(controller.menu.getSnapshot().open).toBe(false)
    } finally {
      error.mockRestore()
    }
  })

  it('keeps listing candidates when a later query matches', async () => {
    const source: InputTriggerSource = {
      trigger: '@',
      name: 'reference',
      candidates: (_session, req) => Promise.resolve(
        req.query === 'read' ? [{ name: 'README.md' }] : [],
      ),
      onPick: () => 'handled',
    }
    const controller = bench([source])
    controller.track('@', 1, { tier: 'plain' }, 1)
    await flush()
    expect(controller.menu.getSnapshot().open).toBe(true)
    controller.track('@read', 5, { tier: 'plain' }, 2)
    await flush()
    const state = controller.menu.getSnapshot()
    expect(state.open).toBe(true)
    const group = state.groups.find(g => g.source === 'reference')
    expect(group?.status === 'ready' ? group.items.map(i => i.name) : []).toEqual(['README.md'])
  })
})

describe('input-trigger client patch content', () => {
  const patch = readFileSync(new URL(
    '../../patches/dsh-client-ui-input-trigger@0.1.2-rc.1.patch',
    import.meta.url,
  ), 'utf8')
  const installed = readFileSync(
    require.resolve('@deepseek-ai/dsh-client-ui-input-trigger/client'),
    'utf8',
  )

  it('drops the all-ready-empty auto-close and adds the localized empty hint', () => {
    for (const marker of [
      '-\t\t\t\t\tif (allReadyEmpty(groups)) return closed(state);',
      'if (groups.length === 0) return closed(state);',
      '"emptyState": "iRJKyq_emptyState"',
      '"empty.at": "当前工作区没有可引用的文件",',
      '"empty.at.query": "没有匹配的文件或会话",',
      '"empty.slash": "没有匹配的指令",',
      "'empty.at': string;",
      'state.hit.query === "" ? "empty.at" : "empty.at.query" : "empty.slash"',
    ]) {
      expect(patch).toContain(marker)
    }
  })

  it('applies the empty hint to the installed client bundle', () => {
    // Guards the resolutions wiring: an orphaned patch leaves the installed
    // bundle without the hint even though the patch file still exists.
    expect(installed).toContain('"emptyState": "iRJKyq_emptyState"')
    expect(installed).toContain('"empty.at": "当前工作区没有可引用的文件",')
    expect(installed).not.toContain('if (groups.length === 0 || allReadyEmpty(groups)) return closed(state);')
  })
})
