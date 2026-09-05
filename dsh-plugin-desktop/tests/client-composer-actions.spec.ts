import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DESKTOP_FILE_PATH_BRIDGE } from '../src/file-path-bridge-contract.ts'
import {
  attachComposerFiles,
  type CandidateRequest,
  createDesktopComposerActionSource,
  DESKTOP_COMPOSER_ACTION_SOURCE,
  DESKTOP_SKILL_MENU_PREFIX,
  type InputTriggerCandidate,
  type InputTriggerPick,
} from '../src/client/composer-actions.ts'

const session = { sessionId: 'session-1' as SessionId }

function request(overrides: Partial<CandidateRequest> = {}): CandidateRequest {
  return {
    query: '',
    quoted: false,
    position: 'leading',
    drilled: false,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function pick(candidate: InputTriggerCandidate, action: 'pick' | 'drill' = 'pick'): InputTriggerPick {
  return {
    candidate,
    session,
    position: 'leading',
    via: 'menu',
    action,
    span: { start: 0, end: 0, draftRev: 1 },
  }
}

describe('desktop composer plus actions', () => {
  it('adds attachment, skill, and goal rows ahead of the existing Command source', async () => {
    const openFiles = vi.fn()
    const source = createDesktopComposerActionSource({
      openFiles,
      readSkills: async () => ({ status: 'ok', skills: [] }),
    })

    expect(source).toMatchObject({
      name: DESKTOP_COMPOSER_ACTION_SOURCE,
      order: -100,
      launchers: ['command'],
      showGroupTitle: false,
    })
    const rows = await source.candidates(session, request())
    expect(rows.map(row => row.name)).toEqual(['添加文件和图片', '技能', '目标'])
    expect(rows[0]).toMatchObject({ description: 'Ctrl+U', icon: 'file' })
    expect(rows[1]).toMatchObject({ icon: 'skill' })
    expect(rows[2]).toMatchObject({ icon: 'goal' })
    expect(source.onPick(pick(rows[0]!))).toBe('handled')
    expect(openFiles).toHaveBeenCalledWith(session.sessionId)
    expect(source.onPick(pick(rows[2]!))).toEqual({ text: '/goal ' })

    const inline = await source.candidates(session, request({ position: 'inline' }))
    expect(inline.map(row => row.name)).toEqual(['添加文件和图片', '技能'])
  })

  it('drills into the server skill catalog and inserts the selected skill token', async () => {
    const source = createDesktopComposerActionSource({
      openFiles: vi.fn(),
      readSkills: async () => ({
        status: 'ok',
        skills: [{ name: 'meeting-notes', displayName: '会议纪要', description: '整理会议纪要' }],
      }),
    })
    const root = await source.candidates(session, request())
    expect(source.onPick(pick(root[1]!, 'drill'))).toEqual({
      text: `/${DESKTOP_SKILL_MENU_PREFIX}`,
      continue: true,
    })

    const skills = await source.candidates(session, request({ query: DESKTOP_SKILL_MENU_PREFIX }))
    expect(skills).toEqual([{
      name: '会议纪要',
      description: '整理会议纪要',
      value: 'meeting-notes',
    }])
    expect(source.header?.(session, {
      query: DESKTOP_SKILL_MENU_PREFIX,
      quoted: false,
      drilled: true,
    })).toEqual([
      { label: '功能', value: 'root' },
      { label: '技能', value: 'skills', current: true },
    ])
    expect(source.onPick(pick(skills[0]!))).toEqual({ text: '/meeting-notes ' })
  })
})

describe('attachComposerFiles', () => {
  function composerBench() {
    const input = {
      addImages: vi.fn(() => true),
      insertReference: vi.fn(() => true),
      notify: vi.fn(),
      state: { getSnapshot: () => ({ draft: '', draftRev: 1 }) },
    }
    const actx = {} as ClientContext
    const conversation = {
      input: { for: () => input },
      createDraftImages: (files: readonly File[]) => files.map(file => ({ id: `draft-${file.name}` })),
      releaseDraftImages: vi.fn(),
    }
    const ctx = {
      sessions: { scope: () => actx },
      get: () => conversation,
    } as unknown as ClientContext
    return { ctx, input, conversation }
  }

  it('routes images to the draft-image pipeline and other types to file mentions', () => {
    const { ctx, input, conversation } = composerBench()
    ;(globalThis as Record<string, unknown>)[DESKTOP_FILE_PATH_BRIDGE] = {
      getPathForFile: (file: File) => `C:\\work\\${file.name}`,
    }
    try {
      attachComposerFiles(ctx, session.sessionId, [
        new File(['x'], 'photo.png', { type: 'image/png' }),
        new File(['x'], 'notes.txt', { type: 'text/plain' }),
      ])
    } finally {
      delete (globalThis as Record<string, unknown>)[DESKTOP_FILE_PATH_BRIDGE]
    }

    expect(conversation.createDraftImages).toBeDefined()
    expect(input.addImages).toHaveBeenCalledWith(['draft-photo.png'])
    expect(input.insertReference).toHaveBeenCalledTimes(1)
    expect(input.insertReference).toHaveBeenCalledWith(
      {
        source: 'reference',
        ref: '@C:\\work\\notes.txt',
        label: 'notes.txt',
        appearance: 'file',
        clipboardText: '@C:\\work\\notes.txt',
      },
      { start: 0, end: 0, draftRev: 1 },
    )
    expect(input.notify).not.toHaveBeenCalled()
  })

  it('quotes mention paths containing whitespace and notifies when the path bridge is absent', () => {
    const { ctx, input } = composerBench()
    attachComposerFiles(ctx, session.sessionId, [new File(['x'], 'my notes.txt', { type: 'text/plain' })])
    expect(input.insertReference).not.toHaveBeenCalled()
    expect(input.notify).toHaveBeenCalledWith('error', '无法读取文件路径：my notes.txt')

    const quoted = composerBench()
    ;(globalThis as Record<string, unknown>)[DESKTOP_FILE_PATH_BRIDGE] = {
      getPathForFile: (file: File) => `C:\\work dir\\${file.name}`,
    }
    try {
      attachComposerFiles(quoted.ctx, session.sessionId, [new File(['x'], 'my notes.txt', { type: 'text/plain' })])
    } finally {
      delete (globalThis as Record<string, unknown>)[DESKTOP_FILE_PATH_BRIDGE]
    }
    expect(quoted.input.insertReference).toHaveBeenCalledWith(
      expect.objectContaining({ ref: '@"C:\\work dir\\my notes.txt"' }),
      expect.anything(),
    )
  })
})
