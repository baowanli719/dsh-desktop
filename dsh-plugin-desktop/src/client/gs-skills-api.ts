/** Same-origin browser client for the Host-owned gs-server skills route. */

import {
  GS_SERVER_SKILLS_PATH,
  type GsSkillExecutionKind,
  type GsSkillViewItem,
  type GsSkillsView,
} from '../server/gs-contract.ts'

/** Server-skill visibility consumed by the Desktop settings section. */
export interface DesktopGsSkillsApi {
  readSkills(): Promise<GsSkillsView>
}

const MAX_SKILL_COUNT = 500
const MAX_NAME_LENGTH = 256
const MAX_TEXT_LENGTH = 2048
const MAX_SYNCED_AT_LENGTH = 64
const MAX_RUNTIME_TYPES = 16

const EXECUTION_KINDS = new Set(['desktop', 'server-data-query', 'server-mcp'])

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH
}

function isOptionalBoundedText(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_TEXT_LENGTH)
}

/** Validate the token-free skills view before it reaches React state. */
export function parseGsSkillsView(value: unknown): GsSkillsView {
  if (!isObject(value)
    || (value.status !== 'idle' && value.status !== 'ok' && value.status !== 'error' && value.status !== 'signed-out')
    || !Array.isArray(value.skills)
    || value.skills.length > MAX_SKILL_COUNT
    || (value.syncedAt !== undefined
      && (typeof value.syncedAt !== 'string' || value.syncedAt.length > MAX_SYNCED_AT_LENGTH))
    || (value.masterOff !== undefined && typeof value.masterOff !== 'boolean')
    || (value.switchedOff !== undefined
      && (typeof value.switchedOff !== 'number' || !Number.isInteger(value.switchedOff)
        || value.switchedOff < 0 || value.switchedOff > MAX_SKILL_COUNT))
    || (value.execution !== undefined
      && (!isObject(value.execution)
        || typeof value.execution.supported !== 'boolean'
        || !Array.isArray(value.execution.types)
        || value.execution.types.length > MAX_RUNTIME_TYPES
        || value.execution.types.some((type: unknown) => !isBoundedName(type))))) {
    throw new Error('dsh-plugin-desktop: invalid gs-server skills response')
  }
  const skills: GsSkillViewItem[] = []
  for (const item of value.skills as unknown[]) {
    if (!isObject(item)
      || !isBoundedName(item.name)
      || typeof item.description !== 'string'
      || item.description.length > MAX_TEXT_LENGTH
      || !isOptionalBoundedText(item.displayName)
      || !isOptionalBoundedText(item.version)
      || !isOptionalBoundedText(item.runtimeType)
      || (item.execution !== undefined
        && (typeof item.execution !== 'string' || !EXECUTION_KINDS.has(item.execution)))
      || (item.available !== undefined && typeof item.available !== 'boolean')
      || !isOptionalBoundedText(item.unavailableReason)) {
      throw new Error('dsh-plugin-desktop: invalid gs-server skill entry')
    }
    skills.push(Object.freeze({
      name: item.name,
      ...(item.displayName === undefined ? {} : { displayName: item.displayName }),
      ...(item.version === undefined ? {} : { version: item.version }),
      description: item.description,
      ...(item.runtimeType === undefined ? {} : { runtimeType: item.runtimeType }),
      ...(item.execution === undefined ? {} : { execution: item.execution as GsSkillExecutionKind }),
      ...(item.available === undefined ? {} : { available: item.available }),
      ...(item.unavailableReason === undefined ? {} : { unavailableReason: item.unavailableReason }),
    }))
  }
  return Object.freeze({
    status: value.status,
    ...(value.syncedAt === undefined ? {} : { syncedAt: value.syncedAt }),
    ...(value.masterOff === undefined ? {} : { masterOff: value.masterOff }),
    ...(value.switchedOff === undefined ? {} : { switchedOff: value.switchedOff }),
    ...(value.execution === undefined ? {} : {
      execution: Object.freeze({
        supported: (value.execution as { supported: boolean }).supported,
        types: Object.freeze([...(value.execution as { types: string[] }).types]),
      }),
    }),
    skills: Object.freeze(skills),
  })
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: gs-server skills request failed (${String(response.status)})`)
  }
  try {
    return await response.json() as unknown
  } catch {
    throw new Error('dsh-plugin-desktop: gs-server skills response was not JSON')
  }
}

/** Construct the default same-origin skills API, with a fetch seam for tests. */
export function createDesktopGsSkillsApi(fetcher: FetchLike = globalThis.fetch.bind(globalThis)): DesktopGsSkillsApi {
  return Object.freeze({
    async readSkills() {
      const response = await fetcher(GS_SERVER_SKILLS_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      })
      return parseGsSkillsView(await readResponse(response))
    },
  })
}

export const desktopGsSkillsPaths = Object.freeze({
  skills: GS_SERVER_SKILLS_PATH,
})
