import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CandidateRequest,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  SourceRoster,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { InputTriggerController } from '../../deepseek-harness/packages/client/ui-input-trigger/src/client/controller.ts'
import { createDesktopComposerActionSource } from '../src/client/composer-actions.ts'

const sid = (k: string): SessionId => k as SessionId
const tick = () => Promise.resolve()

const COMMANDS_MENU_PREFIX = '指令/'

/** Behavioral replica of the patched ui-commands source (collapse + drill + breadcrumb). */
function commandsSource(commands: readonly string[]): InputTriggerSource {
  const fuzzy = (query: string): readonly InputTriggerCandidate[] =>
    commands
      .filter(name => query === '' || name.includes(query))
      .map(name => ({ name }))
  return {
    trigger: '/',
    name: 'command',
    showGroupTitle: false,
    candidates: (_session, req: CandidateRequest) => {
      if (req.query === '') {
        return Promise.resolve([{ name: '指令', value: 'commands', drill: true, icon: 'command' as const }])
      }
      const drilled = req.query.startsWith(COMMANDS_MENU_PREFIX)
      const query = drilled ? req.query.slice(COMMANDS_MENU_PREFIX.length) : req.query
      return Promise.resolve(fuzzy(query))
    },
    header: (_session, req) => {
      if (!req.query.startsWith(COMMANDS_MENU_PREFIX)) return undefined
      return [
        { label: '功能', value: 'root' },
        { label: '指令', value: 'commands', current: true },
      ]
    },
    onPick: (pick: InputTriggerPick) => {
      if (pick.candidate.value === 'commands') return { text: `/${COMMANDS_MENU_PREFIX}`, continue: true }
      if (pick.candidate.value === 'root') return { text: '/', continue: true }
      return 'handled'
    },
  }
}

/** Behavioral replica of the patched ui-skill source (suppressed at root, typed fuzzy). */
function skillsSource(skills: readonly string[]): InputTriggerSource {
  return {
    trigger: '/',
    name: 'skill',
    order: 2,
    candidates: (_session, req: CandidateRequest) => Promise.resolve(
      req.query === '' ? [] : skills.filter(name => name.startsWith(req.query)).map(name => ({ name })),
    ),
    onPick: pick => ({ text: `/${pick.candidate.name} ` }),
  }
}

function bench() {
  const desktop = createDesktopComposerActionSource({
    openFiles: vi.fn(),
    readSkills: () => Promise.resolve({ status: 'ok' as const, skills: [] }),
  })
  const command = commandsSource(['clear', 'compact', 'goal'])
  const skill = skillsSource(['docx-report', 'meeting-notes'])
  const sources: InputTriggerSource[] = [desktop, command, skill]
  const roster: SourceRoster = {
    sources: trigger => sources.filter(s => s.trigger === trigger),
    all: () => sources,
  }
  // The controller only touches actx through scoped event dispatch (bail).
  const actx = {
    bail: (_subject: unknown, event: string, _payload: unknown) =>
      event === 'slash/input-insert-text' ? true : undefined,
  } as unknown as ClientContext
  const controller = new InputTriggerController({ actx, sessionId: sid('s1'), roster })
  return { controller }
}

function groupItems(controller: InputTriggerController, source: string): readonly InputTriggerCandidate[] {
  const group = controller.menu.getSnapshot().groups.find(g => g.source === source)
  return group?.status === 'ready' ? group.items : []
}

describe('commands submenu drill and return', () => {
  it('collapses back to the 指令 row after returning from the drilled submenu', async () => {
    const { controller } = bench()
    controller.track('/', 1, { tier: 'plain' }, 1)
    await tick()
    expect(groupItems(controller, 'command').map(i => i.name)).toEqual(['指令'])
    expect(groupItems(controller, 'desktop-composer-actions').map(i => i.name))
      .toEqual(['添加文件和图片', '技能', '目标'])
    expect(groupItems(controller, 'skill')).toEqual([])

    controller.pick('command', 0)
    controller.track(`/${COMMANDS_MENU_PREFIX}`, 4, { tier: 'plain' }, 2)
    await tick()
    expect(groupItems(controller, 'command').map(i => i.name)).toEqual(['clear', 'compact', 'goal'])

    controller.pickCrumb('command', 0)
    controller.track('/', 1, { tier: 'plain' }, 3)
    await tick()
    expect(groupItems(controller, 'command').map(i => i.name)).toEqual(['指令'])
    expect(groupItems(controller, 'desktop-composer-actions').map(i => i.name))
      .toEqual(['添加文件和图片', '技能', '目标'])
    expect(groupItems(controller, 'skill')).toEqual([])
  })

  it('keeps skill rows out of the root menu but fuzzy-completes typed queries', async () => {
    const { controller } = bench()
    controller.track('/', 1, { tier: 'plain' }, 1)
    await tick()
    expect(groupItems(controller, 'skill')).toEqual([])

    controller.track('/doc', 4, { tier: 'plain' }, 2)
    await tick()
    expect(groupItems(controller, 'skill').map(i => i.name)).toEqual(['docx-report'])
  })
})
