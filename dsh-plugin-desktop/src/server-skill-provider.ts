/**
 * Cordis Host plugin sourcing every agent skill from gsclaw-server.
 *
 * Local skill discovery is banned in the desktop product; this provider is the
 * single skill source. It registers into the host plane's `ctx.skills`
 * registry, maps `GET /api/skills` into candidates ranked above any residual
 * local source, and materializes skill bundles from `GET
 * /api/skills/:name/files` into an application-private cache directory.
 */

import { Buffer } from 'node:buffer'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import { authorizedJson, type GsRequest } from './server/gs-client.ts'
import type {
  GsInstalledSkillReport,
  GsSkillControl,
  GsSkillFilesResponse,
  GsSkillsResponse,
  GsSkillViewItem,
} from './server/gs-contract.ts'
import type { GsServerService } from './server/gs-server-service.ts'

/** Stable Cordis plugin name. */
export const name = 'server-skill-provider'

/** The registry and the gsclaw-server client this provider bridges. */
export const inject = ['skills', 'gsServer']

/** Provider name in the `ctx.skills` registry and the report-installed source. */
export const SERVER_SKILL_PROVIDER_NAME = 'gsclaw-server'

/** Rank above BUNDLED_SKILL_RANK so no residual local source can win a duplicate name. */
export const SERVER_SKILL_RANK = BUNDLED_SKILL_RANK + 100

/** Latest server-skill synchronization snapshot surfaced to the settings page. */
export interface GsSkillSyncState {
  readonly status: 'idle' | 'ok' | 'error' | 'signed-out'
  /** ISO timestamp of the last successful `GET /api/skills`. */
  readonly syncedAt?: string
  /** Lite projection of the last effective catalog. */
  readonly skills?: readonly GsSkillViewItem[]
  /** Whether the reserved `SKILLs` master switch disabled the whole skill feature. */
  readonly masterOff?: boolean
  /** Count of delivered skills suppressed by a per-skill `off` switch. */
  readonly switchedOff?: number
}

/** Mutable holder the private skills route reads without depending on plugin order. */
export interface GsSkillSyncTracker {
  snapshot(): GsSkillSyncState
  update(state: GsSkillSyncState): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Server-skill synchronization snapshot recorded by the provider. */
    gsSkillSync: GsSkillSyncTracker
  }
}

/** Create the in-memory tracker provided as the `gsSkillSync` service. */
export function createGsSkillSyncTracker(): GsSkillSyncTracker {
  let state: GsSkillSyncState = { status: 'idle' }
  return {
    snapshot: () => state,
    update: (next) => { state = next },
  }
}

/** Minimal logger face the provider needs; `ctx.logger` satisfies it. */
export interface GsSkillSyncLogger {
  warn(format: string, ...param: unknown[]): void
}

/** Bundle limits mirroring the server's safe extraction contract. */
export const MAX_SKILL_FILE_BYTES = 8 * 1024 * 1024
export const MAX_SKILL_TOTAL_BYTES = 30 * 1024 * 1024
export const MAX_SKILL_FILES = 500
/** The files response carries base64 (~4/3 inflation) over the total bundle cap, plus JSON framing. */
export const MAX_SKILL_FILES_RESPONSE_BYTES = 42 * 1024 * 1024

/** Bundle entry document and the write-completion marker inside a cache directory. */
const SKILL_ENTRY_FILE = 'SKILL.md'
const SKILL_CACHE_MARKER = '.complete'

/** Version strings double as cache path segments, so keep them path-safe. */
const SAFE_SKILL_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u

/**
 * Strict base64 without a regex: the character-class pattern overflows the
 * regex engine stack on multi-megabyte skill payloads.
 */
function isStrictBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  let padding = 0
  for (let i = value.length - 1; i >= 0 && value.charCodeAt(i) === 61; i -= 1) padding += 1
  if (padding > 2) return false
  const bodyEnd = value.length - padding
  for (let i = 0; i < bodyEnd; i++) {
    const code = value.charCodeAt(i)
    const ok = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47
    if (!ok) return false
  }
  return true
}

/** The slice of the gsclaw-server client this provider consumes. */
export interface GsSkillServerFace {
  /** Current in-memory access token, or undefined while signed out. */
  accessToken(): string | undefined
  /** Single-flight refresh used by the authorized request helper. */
  refreshAccessToken(): Promise<string>
  /** Effective gsclaw-server endpoint, read per request. */
  endpoint(): string
  /** Latest pushed skill switches, or undefined before the first login. */
  skillControls(): Record<string, GsSkillControl> | undefined
  /** Subscribe to ClientConfig changes; returns the unsubscribe function. */
  subscribeConfig(listener: () => void): () => void
}

/** Project the Host-owned client service into the provider's narrow face. */
export function gsSkillServerFace(service: GsServerService): GsSkillServerFace {
  return {
    accessToken: () => service.auth.accessToken(),
    refreshAccessToken: () => service.auth.refreshAccessToken(),
    endpoint: () => service.endpoints.resolve(),
    skillControls: () => service.clientConfig()?.skills,
    subscribeConfig: (listener) => service.config.subscribe(() => { listener() }),
  }
}

export interface ServerSkillProviderOptions {
  /** Application-private cache root, e.g. `<userData>/gs-skills`. */
  readonly cacheRoot: string
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
  /** Optional logger for sync failures; discovery itself stays silent. */
  readonly logger?: GsSkillSyncLogger
}

/** Opaque candidate locator handed back to `get()`. */
interface ServerSkillLocator {
  readonly id: string
  readonly name: string
  readonly version: string
}

/**
 * Validate one server-supplied bundle path with gs-worker's
 * safe_relative_path semantics: relative, forward-slashed, and free of `.` /
 * `..` segments, so extraction can never escape the cache directory.
 */
export function safeSkillRelativePath(path: unknown): string[] | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return undefined
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) return undefined
  if (/^[A-Za-z]:/u.test(path)) return undefined
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return segments
}

/** Strip the YAML frontmatter block a bundle entry may carry. */
export function stripSkillFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '')
}

/** Skill provider backed by gsclaw-server; never touches local skill roots. */
export class ServerSkillProvider implements SkillProvider {
  readonly name = SERVER_SKILL_PROVIDER_NAME
  private lastReportKey: string | undefined

  constructor(
    private readonly server: GsSkillServerFace,
    private readonly options: ServerSkillProviderOptions,
    control: SkillProviderControl,
    private readonly sync?: GsSkillSyncTracker,
  ) {
    // Server-pushed skill switches change the effective catalog; invalidate so
    // consumers refetch instead of serving the cached revision.
    const unsubscribe = this.server.subscribeConfig(() => { control.invalidate() })
    control.signal.addEventListener('abort', unsubscribe, { once: true })
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    // No session or an unreachable server yields an empty catalog; discovery
    // must never break host startup.
    if (this.server.accessToken() === undefined) {
      this.sync?.update({ status: 'signed-out' })
      return []
    }
    let response: GsSkillsResponse
    try {
      response = await this.authorized<GsSkillsResponse>('/api/skills', options.signal)
    } catch (cause) {
      this.options.logger?.warn(
        `dsh-plugin-desktop: server skill sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      // Keep the last good snapshot; only the status degrades.
      this.sync?.update({ ...this.sync.snapshot(), status: 'error' })
      return []
    }
    const skills = Array.isArray(response?.skills) ? response.skills : []
    const controls = this.server.skillControls()
    // The reserved key `SKILLs` is the master switch; it is not a valid skill
    // name, so it can never collide with a delivered skill. `off` disables the
    // whole skill feature and empties the effective catalog.
    const masterOff = controls?.SKILLs === 'off'
    const candidates: SkillCandidate[] = []
    const synced: GsSkillViewItem[] = []
    const reports: GsInstalledSkillReport[] = []
    let switchedOff = 0
    for (const skill of skills) {
      if (skill.enabled === false || !isSkillName(skill.name)) continue
      if (masterOff) continue
      // The switch table is subtractive: only an explicit per-skill `off`
      // removes a delivered skill; unlisted and `on` entries pass through.
      if (controls?.[skill.name] === 'off') {
        switchedOff += 1
        continue
      }
      candidates.push({
        name: skill.name,
        description: typeof skill.description === 'string' ? skill.description : '',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'server',
        provider: SERVER_SKILL_PROVIDER_NAME,
        rank: SERVER_SKILL_RANK,
        locator: { id: skill.id, name: skill.name, version: skill.version } satisfies ServerSkillLocator,
        metadata: {
          displayName: skill.displayName,
          version: skill.version,
          runtimeType: skill.runtimeType,
        },
      })
      synced.push({
        name: skill.name,
        displayName: skill.displayName,
        version: skill.version,
        description: typeof skill.description === 'string' ? skill.description : '',
      })
      reports.push({ id: skill.id, name: skill.name, source: 'server' })
    }
    this.reportInstalled(reports)
    this.sync?.update({
      status: 'ok',
      syncedAt: new Date().toISOString(),
      skills: synced,
      masterOff,
      switchedOff,
    })
    return candidates
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as Partial<ServerSkillLocator> | undefined
    const skillName = locator?.name
    const version = locator?.version
    if (typeof skillName !== 'string' || !isSkillName(skillName)
      || typeof version !== 'string' || !SAFE_SKILL_VERSION.test(version)) {
      return undefined
    }
    const directory = join(this.options.cacheRoot, `${skillName}@${version}`)
    const cached = await this.readCached(candidate, directory)
    if (cached !== undefined) return cached

    let response: GsSkillFilesResponse
    try {
      response = await this.authorized<GsSkillFilesResponse>(
        `/api/skills/${encodeURIComponent(skillName)}/files`,
        options.signal,
        undefined,
        MAX_SKILL_FILES_RESPONSE_BYTES,
      )
    } catch (cause) {
      this.options.logger?.warn(
        `dsh-plugin-desktop: server skill bundle fetch failed for ${skillName}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return undefined
    }
    const files = await this.materialize(skillName, version, response)
    if (files === undefined) {
      this.options.logger?.warn(`dsh-plugin-desktop: server skill bundle refused for ${skillName}@${version}`)
      return undefined
    }
    return this.readCached(candidate, files)
  }

  /** One authorized JSON request through the shared gateway client. */
  private authorized<T>(path: string, signal?: AbortSignal, body?: unknown, maxBytes?: number): Promise<T> {
    return authorizedJson<T>({
      endpoint: this.server.endpoint(),
      path,
      session: this.server,
      ...(body === undefined ? {} : { method: 'POST', body }),
      ...(signal === undefined ? {} : { signal }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(this.options.request === undefined ? {} : { request: this.options.request }),
    })
  }

  /** Fire-and-forget installed-set report, deduplicated per effective catalog. */
  private reportInstalled(reports: readonly GsInstalledSkillReport[]): void {
    const key = JSON.stringify(reports.map(report => report.id).sort())
    if (key === this.lastReportKey) return
    this.lastReportKey = key
    void this.authorized('/api/skills/report-installed', undefined, { skills: reports })
      .catch(() => {
        // The report is advisory; allow the next successful list to retry.
        if (this.lastReportKey === key) this.lastReportKey = undefined
      })
  }

  /** Read a fully materialized cache directory, or undefined on any gap. */
  private async readCached(
    candidate: SkillCandidate,
    directory: string,
  ): Promise<SkillDefinition | undefined> {
    let content: string
    try {
      content = await readFile(join(directory, SKILL_ENTRY_FILE), 'utf8')
      await readFile(join(directory, SKILL_CACHE_MARKER))
    } catch {
      return undefined
    }
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      content: stripSkillFrontmatter(content),
      path: join(directory, SKILL_ENTRY_FILE),
      resourceBase: { kind: 'directory', path: directory },
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
    }
  }

  /**
   * Validate and extract one bundle into `<cacheRoot>/<name>@<version>`.
   * Extraction is staged beside the target and marked complete last, so a
   * crash or a refused bundle never leaves a loadable partial directory.
   * Older versions of the same skill are removed once the new one lands.
   */
  private async materialize(
    skillName: string,
    version: string,
    response: GsSkillFilesResponse,
  ): Promise<string | undefined> {
    const files = Array.isArray(response?.files) ? response.files : []
    if (files.length === 0 || files.length > MAX_SKILL_FILES) return undefined
    const decoded: { readonly segments: readonly string[], readonly content: Buffer }[] = []
    let totalBytes = 0
    for (const file of files) {
      const segments = safeSkillRelativePath(file?.path)
      if (segments === undefined) return undefined
      if (typeof file.base64 !== 'string' || !isStrictBase64(file.base64)) return undefined
      const content = Buffer.from(file.base64, 'base64')
      if (content.byteLength > MAX_SKILL_FILE_BYTES) return undefined
      totalBytes += content.byteLength
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) return undefined
      decoded.push({ segments, content })
    }
    // A bundle without an entry document is not loadable; refuse to cache it.
    if (!decoded.some(file => file.segments.length === 1 && file.segments[0] === SKILL_ENTRY_FILE)) {
      return undefined
    }

    const directory = join(this.options.cacheRoot, `${skillName}@${version}`)
    const staging = `${directory}.tmp-${String(process.pid)}`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      for (const file of decoded) {
        const target = join(staging, ...file.segments)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content)
      }
      await writeFile(join(staging, SKILL_CACHE_MARKER), '')
      await rm(directory, { recursive: true, force: true })
      await rename(staging, directory)
    } catch (cause) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw cause
    }
    // Drop superseded versions; the new directory is already in place.
    const siblings = await readdir(this.options.cacheRoot).catch(() => [] as string[])
    for (const sibling of siblings) {
      if (sibling.startsWith(`${skillName}@`) && !sibling.includes('.tmp-') && sibling !== `${skillName}@${version}`) {
        await rm(join(this.options.cacheRoot, sibling), { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return directory
  }
}

/**
 * Register the server-backed provider on the host skill registry.
 * @param ctx - Host context carrying the skill registry and the gsclaw-server client.
 */
export function apply(ctx: Context): void {
  const server = gsSkillServerFace(ctx.gsServer)
  const cacheRoot = join(ctx.gsServer.userDataDir, 'gs-skills')
  const sync = createGsSkillSyncTracker()
  ctx.provide('gsSkillSync', sync)
  ctx.skills.registerProvider(
    control => new ServerSkillProvider(server, { cacheRoot, logger: ctx.logger }, control, sync),
  )
}
