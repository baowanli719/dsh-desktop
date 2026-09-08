/** Desktop-only entries mounted into the conversation plus-button menu. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { GsSkillsView } from '../server/gs-contract.ts'
import { DESKTOP_FILE_PATH_BRIDGE, type DesktopFilePathBridgeWindow } from '../file-path-bridge-contract.ts'
import { createDesktopGsSkillsApi } from './gs-skills-api.ts'

export const DESKTOP_COMPOSER_ACTION_SOURCE = 'desktop-composer-actions'
export const DESKTOP_SKILL_MENU_PREFIX = '技能/'

const ATTACHMENTS_ACTION = 'attachments'
const SKILLS_ACTION = 'skills'
const GOAL_ACTION = 'goal'
const ROOT_ACTION = 'root'
const EMPTY_ACTION = 'empty'

/** Browser-safe subset of the upstream input-trigger contract consumed here. */
export interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

export interface InputTriggerCandidate {
  readonly name: string
  readonly description?: string
  readonly icon?: 'file' | 'folder' | 'session' | 'skill' | 'goal' | 'command'
  readonly value?: string
  readonly drill?: boolean
}

export interface CandidateRequest {
  readonly query: string
  readonly quoted?: boolean
  readonly position: 'leading' | 'inline'
  readonly drilled: boolean
  readonly signal: AbortSignal
}

export interface InputTriggerPick {
  readonly candidate: InputTriggerCandidate
  readonly session: { readonly sessionId: SessionId }
  readonly position: 'leading' | 'inline'
  readonly via: 'menu' | 'space' | 'enter'
  readonly action: 'pick' | 'drill'
  readonly span: TokenSpan
}

type PickOutcome = { readonly text: string; readonly continue?: boolean } | 'handled' | undefined

export interface InputTriggerSource {
  readonly trigger: '/' | '@'
  readonly name: string
  readonly order?: number
  /** Programmatic launchers this source accompanies; patched upstream shares the launcher's menu. */
  readonly launchers?: readonly string[]
  readonly showGroupTitle?: boolean
  candidates(
    session: { readonly sessionId: SessionId },
    request: CandidateRequest,
  ): Promise<readonly InputTriggerCandidate[]>
  header?(
    session: { readonly sessionId: SessionId },
    request: Pick<CandidateRequest, 'query' | 'quoted' | 'drilled'>,
  ): readonly { readonly label: string; readonly value: string; readonly current?: boolean }[] | undefined
  onPick(pick: InputTriggerPick): PickOutcome
}

type DraftAttachmentId = string

interface ComposerAttachment {
  readonly id: DraftAttachmentId
}

interface ReferenceInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/** MIME types admitted by the draft-image pipeline; every other type becomes a file mention. */
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Internal browser draft operations intentionally kept behind the public conversation service. */
interface DraftConversation {
  readonly input: {
    for(ctx: ClientContext): {
      addImages(ids: readonly DraftAttachmentId[]): boolean
      insertReference(ref: ReferenceInsert, span: TokenSpan): boolean
      notify(level: 'info' | 'error', text: string): void
      readonly state: {
        getSnapshot(): {
          readonly draft: string
          readonly draftRev: number
          /** Chip view in clipboard coordinates; only the lengths are needed to fold back to detect coordinates. */
          readonly occurrences: readonly { readonly length: number }[]
        }
      }
    }
  }
  createDraftImages(files: readonly File[]): readonly ComposerAttachment[]
  releaseDraftImages(attachments: readonly ComposerAttachment[]): void
}

interface ComposerSessions {
  readonly list: { getSnapshot(): { readonly current?: SessionId } }
  scope(sessionId: SessionId): ClientContext | undefined
}

interface DesktopComposerContext {
  readonly sessions: ComposerSessions
  readonly conversation: DraftConversation
  readonly inputTriggers: {
    registerSource(source: InputTriggerSource): () => void
  }
  get(name: 'conversation'): DraftConversation | undefined
}

export interface DesktopComposerActionSourceDeps {
  openFiles(sessionId: SessionId): void
  readSkills(): Promise<GsSkillsView>
}

function rootCandidates(position: 'leading' | 'inline'): readonly InputTriggerCandidate[] {
  return [
    {
      name: '添加文件和图片',
      description: 'Ctrl+U',
      icon: 'file',
      value: ATTACHMENTS_ACTION,
    },
    {
      name: '技能',
      icon: 'skill',
      value: SKILLS_ACTION,
      drill: true,
    },
    ...(position === 'leading'
      ? [{ name: '目标', icon: 'goal', value: GOAL_ACTION } satisfies InputTriggerCandidate]
      : []),
  ]
}

function unavailableSkill(view: GsSkillsView): InputTriggerCandidate {
  if (view.status === 'signed-out') {
    return { name: '暂无可用技能', description: '登录后可使用服务端技能', value: EMPTY_ACTION }
  }
  if (view.masterOff === true) {
    return { name: '暂无可用技能', description: '技能功能已由服务端关闭', value: EMPTY_ACTION }
  }
  if (view.status === 'error') {
    return { name: '暂时无法读取技能', description: '请稍后重试', value: EMPTY_ACTION }
  }
  return { name: '暂无可用技能', value: EMPTY_ACTION }
}

/** Build the source that accompanies the normal Command source only for programmatic launches. */
export function createDesktopComposerActionSource(
  deps: DesktopComposerActionSourceDeps,
): InputTriggerSource {
  return {
    trigger: '/',
    name: DESKTOP_COMPOSER_ACTION_SOURCE,
    order: -100,
    launchers: ['command'],
    showGroupTitle: false,
    async candidates(_session, request) {
      if (request.query.startsWith(DESKTOP_SKILL_MENU_PREFIX)) {
        const view = await deps.readSkills()
        if (request.signal.aborted) return []
        if (view.status !== 'ok' || view.skills.length === 0) return [unavailableSkill(view)]
        const query = request.query.slice(DESKTOP_SKILL_MENU_PREFIX.length).toLocaleLowerCase()
        return view.skills
          .filter(skill => skill.name.toLocaleLowerCase().includes(query)
            || (skill.displayName?.toLocaleLowerCase().includes(query) ?? false))
          .map(skill => ({
            name: skill.displayName ?? skill.name,
            description: skill.description,
            value: skill.name,
          }))
      }

      const query = request.query.toLocaleLowerCase()
      return rootCandidates(request.position)
        .filter(candidate => query === '' || candidate.name.toLocaleLowerCase().includes(query))
    },
    header(_session, request) {
      if (!request.query.startsWith(DESKTOP_SKILL_MENU_PREFIX)) return undefined
      return [
        { label: '功能', value: ROOT_ACTION },
        { label: '技能', value: SKILLS_ACTION, current: true },
      ]
    },
    onPick({ candidate, session }) {
      if (candidate.value === ATTACHMENTS_ACTION) {
        deps.openFiles(session.sessionId)
        return 'handled'
      }
      if (candidate.value === SKILLS_ACTION) {
        return { text: `/${DESKTOP_SKILL_MENU_PREFIX}`, continue: true }
      }
      if (candidate.value === ROOT_ACTION) return { text: '/', continue: true }
      if (candidate.value === GOAL_ACTION) return { text: '/goal ' }
      if (candidate.value === EMPTY_ACTION || candidate.value === undefined) return 'handled'
      return { text: `/${candidate.value} ` }
    },
  }
}

/** Open a native Chromium file chooser without retaining the selected File objects. */
export function chooseComposerFiles(documentTarget: Document = document): Promise<readonly File[]> {
  return new Promise((resolve, reject) => {
    const input = documentTarget.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    let settled = false
    const finish = (files: readonly File[]): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => { finish([...(input.files ?? [])]) }, { once: true })
    input.addEventListener('cancel', () => { finish([]) }, { once: true })
    documentTarget.body.append(input)
    try {
      input.click()
    } catch (error) {
      input.remove()
      reject(error)
    }
  })
}

/** Resolve one picked file to its disk path through the preload bridge; undefined when unavailable. */
function desktopFilePath(file: File): string | undefined {
  const bridge = (globalThis as DesktopFilePathBridgeWindow)[DESKTOP_FILE_PATH_BRIDGE]
  if (bridge === undefined) return undefined
  try {
    const path = bridge.getPathForFile(file).trim()
    return path === '' ? undefined : path
  } catch {
    return undefined
  }
}

type ComposerInput = ReturnType<DraftConversation['input']['for']>

/** Insert one non-image file as an `@path` reference chip appended to the draft. */
function insertComposerFileReference(input: ComposerInput, file: File): void {
  const path = desktopFilePath(file)
  if (path === undefined) {
    input.notify('error', `无法读取文件路径：${file.name}`)
    return
  }
  const candidate: FileReferenceCandidate = { path, kind: 'file' }
  const mention = formatFileMention(candidate, false)
  if (mention === undefined) {
    input.notify('error', `无法引用文件：${file.name}`)
    return
  }
  const snapshot = input.state.getSnapshot()
  // insertReference spans are in detect coordinates (every chip counts as
  // one U+FFFC), while snapshot.draft is the clipboard projection with chips
  // expanded to their mention text. Derive the document end in detect
  // coordinates by folding each occurrence back to its single detect char,
  // otherwise every insertion after the first chip overshoots and fails.
  const at = snapshot.occurrences.reduce(
    (length, occurrence) => length - (occurrence.length - 1),
    snapshot.draft.length,
  )
  const applied = input.insertReference({
    source: 'reference',
    ref: mention,
    label: file.name,
    appearance: 'file',
    clipboardText: mention,
  }, { start: at, end: at, draftRev: snapshot.draftRev })
  if (!applied) input.notify('error', '当前无法添加文件，请稍后重试')
}

/** Route one chooser result: images through the draft-image pipeline, other types as file mentions. */
export function attachComposerFiles(
  ctx: ClientContext,
  sessionId: SessionId,
  files: readonly File[],
): void {
  const images = files.filter(file => IMAGE_MIME_TYPES.has(file.type))
  const documents = files.filter(file => !IMAGE_MIME_TYPES.has(file.type))
  if (images.length > 0) attachComposerImages(ctx, sessionId, images)
  if (documents.length === 0) return
  const desktop = ctx as unknown as DesktopComposerContext
  const actx = desktop.sessions.scope(sessionId)
  const conversation = desktop.get('conversation')
  if (actx === undefined || conversation === undefined) return
  const input = conversation.input.for(actx)
  for (const file of documents) insertComposerFileReference(input, file)
}

/** Add a chooser result through the same draft registry and input machine as paste/drop intake. */
export function attachComposerImages(
  ctx: ClientContext,
  sessionId: SessionId,
  files: readonly File[],
): void {
  const desktop = ctx as unknown as DesktopComposerContext
  const actx = desktop.sessions.scope(sessionId)
  const conversation = desktop.get('conversation')
  if (actx === undefined || conversation === undefined || files.length === 0) return
  const input = conversation.input.for(actx)
  try {
    const attachments = conversation.createDraftImages(files)
    const accepted = input.addImages(attachments.map(attachment => attachment.id as DraftAttachmentId))
    if (accepted) return
    conversation.releaseDraftImages(attachments)
    input.notify('error', '当前无法添加图片，请稍后重试')
  } catch (error) {
    input.notify('error', error instanceof Error ? error.message : String(error))
  }
}

/** Register the plus-menu source and its Ctrl/Cmd+U file shortcut for one renderer generation. */
export function installDesktopComposerActions(ctx: ClientContext): () => void {
  const desktop = ctx as unknown as DesktopComposerContext
  const skills = createDesktopGsSkillsApi()
  let choosing = false
  const openFiles = (sessionId: SessionId): void => {
    if (choosing) return
    choosing = true
    void chooseComposerFiles()
      .then(files => { attachComposerFiles(ctx, sessionId, files) })
      .catch((error: unknown) => {
        const actx = desktop.sessions.scope(sessionId)
        if (actx !== undefined) {
          desktop.conversation.input.for(actx).notify(
            'error',
            error instanceof Error ? error.message : String(error),
          )
        }
      })
      .finally(() => { choosing = false })
  }

  const unregister = desktop.inputTriggers.registerSource(createDesktopComposerActionSource({
    openFiles,
    readSkills: () => skills.readSkills(),
  }))
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.shiftKey || (!event.ctrlKey && !event.metaKey)
      || event.key.toLocaleLowerCase() !== 'u') return
    const current = desktop.sessions.list.getSnapshot().current
    if (current === undefined) return
    event.preventDefault()
    openFiles(current)
  }
  document.addEventListener('keydown', onKeyDown)
  return () => {
    document.removeEventListener('keydown', onKeyDown)
    unregister()
  }
}
