/**
 * Cordis Host plugin sourcing every agent skill from gsclaw-server.
 *
 * Local skill discovery is banned in the desktop product; this provider is the
 * single skill source. It registers into the host plane's `ctx.skills`
 * registry, maps the server catalog into candidates ranked above any residual
 * local source, and loads skill bodies per runtime type: `client` skills
 * materialize bundles from `GET /api/skills/:name/files` into an
 * application-private cache directory, while `data-query` / `server-mcp`
 * skills stay virtual — their `SkillDefinition` content comes from
 * `GET /api/v1/skills/:name/definition` and execution goes through the
 * server-skill-tools bridge.
 *
 * Servers without the `skillExecution` meta capability keep the legacy
 * `GET /api/skills` distribution, where remote types are invisible and every
 * delivered skill is treated as a desktop-executed bundle, exactly as before.
 */

import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
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
import {
  GS_SERVER_RUNTIME_TYPES,
  type GsInstalledSkillReport,
  type GsServerMeta,
  type GsServerRuntimeType,
  type GsSkillCatalogResponse,
  type GsSkillControl,
  type GsSkillExecutionKind,
  type GsSkillFilesResponse,
  type GsSkillsResponse,
  type GsSkillViewItem,
} from './server/gs-contract.ts'
import { GsSkillExecutionClient } from './server/gs-skill-execution.ts'
import type { GsServerService } from './server/gs-server-service.ts'

/** Stable Cordis plugin name. */
export const name = 'server-skill-provider'

/** The registry and the gsclaw-server client this provider bridges. */
export const inject = ['skills', 'gsServer']

/** Provider name in the `ctx.skills` registry and the report-installed source. */
export const SERVER_SKILL_PROVIDER_NAME = 'gsclaw-server'

/** Rank above BUNDLED_SKILL_RANK so no residual local source can win a duplicate name. */
export const SERVER_SKILL_RANK = BUNDLED_SKILL_RANK + 100

/** Server skill-execution capability resolved from the meta handshake. */
export interface GsSkillExecutionSupport {
  readonly supported: boolean
  /** Executable runtime types, intersected with the ones this desktop bridges. */
  readonly types: readonly GsServerRuntimeType[]
}

/** One server-executed skill of the current effective catalog. */
export interface GsServerSkillRemoteEntry {
  readonly name: string
  readonly runtimeType: GsServerRuntimeType
  /** Revision the execute request must echo back. */
  readonly definitionRevision: string
}

/** Effective remote-catalog projection consumed by the server-skill-tools bridge. */
export interface GsServerSkillCatalogSnapshot {
  /** Whether the server advertised the skill-execution protocol. */
  readonly supported: boolean
  readonly types: readonly GsServerRuntimeType[]
  /** Available server-executed skills of the latest successful sync. */
  readonly remotes: readonly GsServerSkillRemoteEntry[]
}

/**
 * Host-plane share of the effective server catalog. The provider publishes it;
 * the bridge tools read it to decide visibility and to resolve revisions.
 */
export interface GsServerSkillCatalog {
  snapshot(): GsServerSkillCatalogSnapshot
  /** Subscribe to catalog changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Invalidate cached catalogs and definitions after a `definition_changed`. */
  invalidate(): void
  /** One available remote entry of the requested runtime type, if still listed. */
  resolveRemote(name: string, runtimeType: GsServerRuntimeType): GsServerSkillRemoteEntry | undefined
}

/** Provider-owned mutable face of the catalog share. */
export interface GsServerSkillCatalogController extends GsServerSkillCatalog {
  update(snapshot: GsServerSkillCatalogSnapshot): void
  /** Wire the registry invalidation of the active provider registration. */
  bindInvalidate(invalidate: () => void): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Server-skill synchronization snapshot recorded by the provider. */
    gsSkillSync: GsSkillSyncTracker
    /** Effective server-executed skill catalog shared with the bridge tools. */
    gsServerSkillCatalog: GsServerSkillCatalog
  }
}

/** Empty catalog published while signed out or against a legacy server. */
const EMPTY_SERVER_SKILL_CATALOG: GsServerSkillCatalogSnapshot = Object.freeze({
  supported: false,
  types: Object.freeze([]),
  remotes: Object.freeze([]),
})

/** Create the Host-plane catalog share consumed by the server-skill-tools bridge. */
export function createGsServerSkillCatalog(): GsServerSkillCatalogController {
  let state: GsServerSkillCatalogSnapshot = EMPTY_SERVER_SKILL_CATALOG
  let invalidate: (() => void) | undefined
  const listeners = new Set<() => void>()
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    invalidate() { invalidate?.() },
    resolveRemote(skillName, runtimeType) {
      return state.remotes.find(entry => entry.name === skillName && entry.runtimeType === runtimeType)
    },
    update(snapshot) {
      state = snapshot
      for (const listener of listeners) listener()
    },
    bindInvalidate(next) { invalidate = next },
  }
}

/** Latest server-skill synchronization snapshot surfaced to the settings page. */
export interface GsSkillSyncState {
  readonly status: 'idle' | 'ok' | 'error' | 'signed-out'
  /** ISO timestamp of the last successful catalog sync. */
  readonly syncedAt?: string
  /** Effective-catalog projection of the last successful sync. */
  readonly skills?: readonly GsSkillViewItem[]
  /** Server skill-execution capability from the meta handshake. */
  readonly execution?: GsSkillExecutionSupport
  /** Whether the reserved `SKILLs` master switch disabled the whole skill feature. */
  readonly masterOff?: boolean
  /** Count of delivered skills suppressed by a per-skill `off` switch. */
  readonly switchedOff?: number
}

/** Mutable holder the private skills route reads without depending on plugin order. */
export interface GsSkillSyncTracker {
  snapshot(): GsSkillSyncState
  update(state: GsSkillSyncState): void
  /** Bound by the active provider; renderer writes stay on the Host plane. */
  setEnabled?(name: string, enabled: boolean): Promise<void>
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

/** In-memory remote-definition cache cap; session changes clear it wholesale. */
const MAX_REMOTE_DEFINITIONS = 512

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
  /** Authenticated user id isolating per-account caches, or undefined while signed out. */
  userId(): number | undefined
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
    userId: () => service.auth.snapshot().user?.id,
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
  /** Catalog share published for the bridge tools; tests may omit it. */
  readonly catalog?: GsServerSkillCatalogController
}

/** Opaque candidate locator handed back to `get()` for a bundle-backed skill. */
interface ServerSkillLocator {
  readonly id: string
  readonly name: string
  readonly version: string
}

/** Opaque candidate locator handed back to `get()` for a server-executed skill. */
interface RemoteSkillLocator {
  readonly kind: 'remote'
  readonly name: string
  readonly version: string
  readonly runtimeType: GsServerRuntimeType
  readonly revision: string
}

/** Narrow one unknown locator to the remote shape without trusting it. */
function asRemoteLocator(locator: unknown): RemoteSkillLocator | undefined {
  if (typeof locator !== 'object' || locator === null) return undefined
  const record = locator as Partial<RemoteSkillLocator>
  if (record.kind !== 'remote' || typeof record.name !== 'string'
    || typeof record.version !== 'string' || typeof record.revision !== 'string'
    || (record.runtimeType !== 'data-query' && record.runtimeType !== 'server-mcp')) {
    return undefined
  }
  return record as RemoteSkillLocator
}

/**
 * Resolve the skill-execution capability of one meta handshake. Servers that
 * predate the field return undefined, selecting the legacy distribution.
 */
export function parseSkillExecutionSupport(meta: GsServerMeta): GsSkillExecutionSupport | undefined {
  const capability = meta.skillExecution
  if (capability === undefined || capability === null) return undefined
  const advertised = Array.isArray(capability.types) ? capability.types : []
  const types = advertised.filter((type): type is GsServerRuntimeType =>
    (GS_SERVER_RUNTIME_TYPES as readonly string[]).includes(type as string))
  return { supported: true, types }
}

/** Map one executable server runtime type to its settings-page execution kind. */
function executionKindOf(runtimeType: GsServerRuntimeType): GsSkillExecutionKind {
  return runtimeType === 'data-query' ? 'server-data-query' : 'server-mcp'
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
  private readonly execution: GsSkillExecutionClient
  /** In-memory remote definitions keyed by session, name, and definition revision. */
  private readonly remoteDefinitions = new Map<string, SkillDefinition>()
  private remoteSessionKey: string | undefined
  private preferenceRevision = 0

  constructor(
    private readonly server: GsSkillServerFace,
    private readonly options: ServerSkillProviderOptions,
    private readonly control: SkillProviderControl,
    private readonly sync?: GsSkillSyncTracker,
  ) {
    if (sync !== undefined) sync.setEnabled = (name, enabled) => this.setEnabled(name, enabled)
    this.execution = new GsSkillExecutionClient({
      endpoint: () => server.endpoint(),
      session: server,
      ...(options.request === undefined ? {} : { request: options.request }),
    })
    // Server-pushed skill switches change the effective catalog; invalidate so
    // consumers refetch instead of serving the cached revision.
    const unsubscribe = this.server.subscribeConfig(() => { control.invalidate() })
    control.signal.addEventListener('abort', unsubscribe, { once: true })
  }

  /**
   * Cache-isolation key of the current session: endpoint plus authenticated
   * user. Remote definitions and the published catalog are only valid under
   * the key that fetched them, so a late response from a previous account can
   * never enter a new session.
   */
  private sessionKey(): string | undefined {
    const userId = this.server.userId()
    if (this.server.accessToken() === undefined || userId === undefined) return undefined
    return `${this.server.endpoint()}#${String(userId)}`
  }

  private preferencePath(sessionKey: string, name: string): string {
    const account = createHash('sha256').update(sessionKey).digest('hex')
    return join(this.options.cacheRoot, 'preferences', account, `${name}.json`)
  }

  private async enabledFor(sessionKey: string, skill: { name: string, defaultEnabled?: boolean }): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(await readFile(this.preferencePath(sessionKey, skill.name), 'utf8'))
      if (typeof value === 'boolean') return value
      throw new Error('invalid skill preference')
    } catch (cause) {
      // A corrupt or unreadable preference must not take down the whole sync;
      // fall back to the server default so the rest of the catalog still loads.
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.logger?.warn(`dsh-plugin-desktop: ignoring unreadable skill preference for ${skill.name}: ${String(cause)}`)
      }
      return skill.defaultEnabled !== false
    }
  }

  /** Persist a user choice only for a currently delivered, usable skill. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const sessionKey = this.sessionKey()
    const state = this.sync?.snapshot()
    const skill = state?.skills?.find(item => item.name === name)
    if (sessionKey === undefined || this.remoteSessionKey !== sessionKey
      || state?.status !== 'ok' || state.masterOff || !isSkillName(name)
      || this.server.skillControls()?.SKILLs === 'off' || this.server.skillControls()?.[name] === 'off'
      || skill === undefined || skill.available === false) throw new Error('skill unavailable')
    const path = this.preferencePath(sessionKey, name)
    await mkdir(dirname(path), { recursive: true })
    const staging = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(staging, JSON.stringify(enabled), 'utf8')
      await rename(staging, path)
    } finally {
      await rm(staging, { force: true })
    }
    if (this.sessionKey() !== sessionKey) throw new Error('skill session changed')
    this.preferenceRevision += 1
    const current = this.sync?.snapshot()
    if (current !== undefined) this.sync?.update({
      ...current,
      skills: current.skills?.map(item => item.name === name ? { ...item, enabled } : item) ?? [],
    })
    this.remoteDefinitions.clear()
    const catalog = this.options.catalog?.snapshot()
    if (catalog !== undefined) this.options.catalog?.update({
      ...catalog,
      remotes: catalog.remotes.filter(item => item.name !== name),
    })
    this.control.invalidate()
  }

  /** Drop every remote definition cached under a different session key. */
  private pruneRemoteState(sessionKey: string): void {
    if (this.remoteSessionKey === sessionKey) return
    this.remoteSessionKey = sessionKey
    this.remoteDefinitions.clear()
  }

  /** Signed-out housekeeping: caches and the published catalog lose all remote entries. */
  private resetRemoteState(): void {
    this.remoteSessionKey = undefined
    this.remoteDefinitions.clear()
    this.options.catalog?.update(EMPTY_SERVER_SKILL_CATALOG)
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    // No session or an unreachable server yields an empty catalog; discovery
    // must never break host startup.
    if (this.server.accessToken() === undefined) {
      this.resetRemoteState()
      this.sync?.update({ status: 'signed-out' })
      return []
    }
    const sessionKey = this.sessionKey()
    if (sessionKey === undefined) {
      this.resetRemoteState()
      this.sync?.update({ status: 'signed-out' })
      return []
    }
    this.pruneRemoteState(sessionKey)

    let meta: GsServerMeta
    try {
      meta = await this.execution.meta({ ...(options.signal === undefined ? {} : { signal: options.signal }) })
    } catch (cause) {
      return this.syncFailed(cause)
    }
    // A sign-out or account switch during the handshake discards the response.
    if (this.sessionKey() !== sessionKey) return []
    const support = parseSkillExecutionSupport(meta)
    if (support === undefined) return this.listLegacy(options, sessionKey)
    return this.listCatalog(options, sessionKey, support)
  }

  /** Record a sync failure, keeping the last good snapshot. */
  private syncFailed(cause: unknown): readonly SkillCandidate[] {
    this.options.logger?.warn(
      `dsh-plugin-desktop: server skill sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    // Keep the last good snapshot; only the status degrades.
    this.sync?.update({ ...this.sync.snapshot(), status: 'error' })
    return []
  }

  /**
   * Legacy distribution for servers without the `skillExecution` capability:
   * `GET /api/skills` delivers client and data-query bundles, remote types
   * stay invisible, and everything materializes as a desktop-executed bundle.
   */
  private async listLegacy(
    options: SkillLookupOptions,
    sessionKey: string,
  ): Promise<readonly SkillCandidate[]> {
    const revision = this.preferenceRevision
    let response: GsSkillsResponse
    try {
      response = await this.authorized<GsSkillsResponse>('/api/skills', options.signal)
    } catch (cause) {
      return this.syncFailed(cause)
    }
    if (this.sessionKey() !== sessionKey) return []
    const skills = Array.isArray(response?.skills) ? response.skills : []
    const controls = this.server.skillControls()
    const masterOff = controls?.SKILLs === 'off'
    const candidates: SkillCandidate[] = []
    const synced: GsSkillViewItem[] = []
    const reports: GsInstalledSkillReport[] = []
    let switchedOff = 0
    for (const skill of skills) {
      if (skill.enabled === false || !isSkillName(skill.name)) continue
      if (masterOff) continue
      if (controls?.[skill.name] === 'off') {
        switchedOff += 1
        continue
      }
      const enabled = await this.enabledFor(sessionKey, skill)
      synced.push({
        name: skill.name, displayName: skill.displayName, version: skill.version,
        description: typeof skill.description === 'string' ? skill.description : '',
        runtimeType: skill.runtimeType, enabled,
      })
      if (!enabled) continue
      candidates.push(this.bundleCandidate(skill.name, skill.version, {
        id: skill.id,
        description: typeof skill.description === 'string' ? skill.description : '',
        metadata: {
          displayName: skill.displayName,
          version: skill.version,
          runtimeType: skill.runtimeType,
        },
      }))
      // The legacy catalog sends a numeric id; the report contract requires a string.
      reports.push({ id: String(skill.id), name: skill.name, source: 'server' })
    }
    if (this.sessionKey() !== sessionKey || revision !== this.preferenceRevision) return []
    this.options.catalog?.update({ supported: false, types: [], remotes: [] })
    this.reportInstalled(reports)
    this.sync?.update({
      status: 'ok',
      syncedAt: new Date().toISOString(),
      skills: synced,
      execution: { supported: false, types: [] },
      masterOff,
      switchedOff,
    })
    return candidates
  }

  /**
   * Capability-aware distribution: `GET /api/v1/skills/catalog` is prefiltered
   * by the server and carries every runtime type. `client` entries keep the
   * bundle flow; executable remote types become virtual candidates; unknown
   * types surface in the settings view as unavailable but never load.
   */
  private async listCatalog(
    options: SkillLookupOptions,
    sessionKey: string,
    support: GsSkillExecutionSupport,
  ): Promise<readonly SkillCandidate[]> {
    const preferenceRevision = this.preferenceRevision
    let response: GsSkillCatalogResponse
    try {
      response = await this.execution.catalog({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (cause) {
      return this.syncFailed(cause)
    }
    if (this.sessionKey() !== sessionKey) return []
    const skills = Array.isArray(response?.skills) ? response.skills : []
    const controls = this.server.skillControls()
    const masterOff = controls?.SKILLs === 'off'
    const candidates: SkillCandidate[] = []
    const synced: GsSkillViewItem[] = []
    const reports: GsInstalledSkillReport[] = []
    const remotes: GsServerSkillRemoteEntry[] = []
    let switchedOff = 0
    for (const skill of skills) {
      if (!isSkillName(skill.name)) continue
      if (masterOff) continue
      // The switch table is subtractive: only an explicit per-skill `off`
      // removes a delivered skill; unlisted and `on` entries pass through.
      if (controls?.[skill.name] === 'off') {
        switchedOff += 1
        continue
      }
      const description = typeof skill.description === 'string' ? skill.description : ''
      const enabled = await this.enabledFor(sessionKey, skill)
      const view = {
        enabled,
        name: skill.name,
        displayName: skill.displayName,
        version: skill.version,
        description,
        runtimeType: skill.runtimeType,
      }
      const remoteType = (GS_SERVER_RUNTIME_TYPES as readonly string[]).includes(skill.runtimeType)
        && support.types.includes(skill.runtimeType as GsServerRuntimeType)
        ? skill.runtimeType as GsServerRuntimeType
        : undefined
      if (skill.runtimeType === 'client') {
        synced.push({ ...view, execution: 'desktop', available: true })
        if (!enabled) continue
        candidates.push(this.bundleCandidate(skill.name, skill.version, {
          id: skill.name,
          description,
          metadata: {
            displayName: skill.displayName,
            version: skill.version,
            runtimeType: skill.runtimeType,
            execution: 'desktop',
          },
        }))
        reports.push({ id: skill.name, name: skill.name, source: 'server' })
      } else if (remoteType !== undefined) {
        synced.push({ ...view, execution: executionKindOf(remoteType), available: true })
        if (!enabled) continue
        const revision = typeof skill.definitionRevision === 'string' ? skill.definitionRevision : ''
        candidates.push({
          name: skill.name,
          description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'server',
          provider: SERVER_SKILL_PROVIDER_NAME,
          rank: SERVER_SKILL_RANK,
          locator: {
            kind: 'remote',
            name: skill.name,
            version: skill.version,
            runtimeType: remoteType,
            revision,
          } satisfies RemoteSkillLocator,
          metadata: {
            displayName: skill.displayName,
            version: skill.version,
            runtimeType: remoteType,
            execution: 'server',
            definitionRevision: revision,
          },
        })
        remotes.push({ name: skill.name, runtimeType: remoteType, definitionRevision: revision })
      } else {
        // Unrecognized or not executable here: visible but never loadable,
        // and never silently demoted to a local bundle.
        synced.push({ ...view, enabled: false, available: false, unavailableReason: 'runtime-unsupported' })
      }
    }
    // Server-executed skills have no local bundle, so they stay out of the
    // file-installation report; the installed-set semantics are unchanged.
    if (this.sessionKey() !== sessionKey || preferenceRevision !== this.preferenceRevision) return []
    this.options.catalog?.update({ supported: true, types: support.types, remotes })
    this.reportInstalled(reports)
    this.sync?.update({
      status: 'ok',
      syncedAt: new Date().toISOString(),
      skills: synced,
      execution: support,
      masterOff,
      switchedOff,
    })
    return candidates
  }

  /** One bundle-backed candidate of the legacy or the capability-aware catalog. */
  private bundleCandidate(
    skillName: string,
    version: string,
    extra: { readonly id: string, readonly description: string, readonly metadata: Record<string, unknown> },
  ): SkillCandidate {
    return {
      name: skillName,
      description: extra.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'server',
      provider: SERVER_SKILL_PROVIDER_NAME,
      rank: SERVER_SKILL_RANK,
      locator: { id: extra.id, name: skillName, version } satisfies ServerSkillLocator,
      metadata: extra.metadata,
    }
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const sessionKey = this.sessionKey()
    const revision = this.preferenceRevision
    if (sessionKey === undefined || !isSkillName(candidate.name)
      || this.server.skillControls()?.SKILLs === 'off'
      || this.server.skillControls()?.[candidate.name] === 'off'
      || this.sync?.snapshot().skills?.find(item => item.name === candidate.name)?.enabled === false) return undefined
    const remote = asRemoteLocator(candidate.locator)
    const definition = remote !== undefined
      ? await this.getRemote(candidate, remote, options)
      : await this.getBundle(candidate, options)
    if (this.sessionKey() !== sessionKey || revision !== this.preferenceRevision) return undefined
    return definition
  }

  /** Load one server-executed skill's definition; no bundle ever lands on disk. */
  private async getRemote(
    candidate: SkillCandidate,
    locator: RemoteSkillLocator,
    options: SkillLookupOptions,
  ): Promise<SkillDefinition | undefined> {
    if (!isSkillName(locator.name)) return undefined
    const sessionKey = this.sessionKey()
    if (sessionKey === undefined) return undefined
    this.pruneRemoteState(sessionKey)
    const cacheKey = `${sessionKey}|${locator.name}@${locator.revision}`
    const cached = this.remoteDefinitions.get(cacheKey)
    if (cached !== undefined) return cached

    let response
    try {
      response = await this.execution.definition(locator.name, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (cause) {
      this.options.logger?.warn(
        `dsh-plugin-desktop: server skill definition fetch failed for ${locator.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      if (this.sessionKey() === sessionKey) this.markRemoteUnavailable(locator.name, 'definition-error')
      return undefined
    }
    // A sign-out or account switch during the fetch discards the response:
    // nothing from the previous account enters the new session's cache.
    if (this.sessionKey() !== sessionKey) return undefined
    if (typeof response?.content !== 'string' || response.name !== locator.name) {
      this.options.logger?.warn(`dsh-plugin-desktop: server skill definition refused for ${locator.name}`)
      return undefined
    }
    if (response.runtimeType !== locator.runtimeType || response.definitionRevision !== locator.revision) {
      // The definition moved under the catalog entry that drove this load;
      // force a re-list so the next lookup uses the current revision.
      this.options.logger?.warn(`dsh-plugin-desktop: server skill definition revision moved for ${locator.name}`)
      this.control.invalidate()
      return undefined
    }
    const definition: SkillDefinition = {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      content: stripSkillFrontmatter(response.content),
      metadata: {
        ...(candidate.metadata ?? {}),
        execution: 'server',
        runtimeType: locator.runtimeType,
        definitionRevision: locator.revision,
      },
    }
    if (this.remoteDefinitions.size >= MAX_REMOTE_DEFINITIONS) this.remoteDefinitions.clear()
    this.remoteDefinitions.set(cacheKey, definition)
    return definition
  }

  /** Mark one remote skill unavailable in the settings snapshot, if still listed. */
  private markRemoteUnavailable(skillName: string, reason: string): void {
    const state = this.sync?.snapshot()
    if (state?.skills === undefined) return
    this.sync?.update({
      ...state,
      skills: state.skills.map(item => item.name === skillName
        ? { ...item, available: false, unavailableReason: reason }
        : item),
    })
  }

  /** Load one bundle-backed skill, materializing its files into the cache root. */
  private async getBundle(
    candidate: SkillCandidate,
    options: SkillLookupOptions,
  ): Promise<SkillDefinition | undefined> {
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
  const catalog = createGsServerSkillCatalog()
  ctx.provide('gsSkillSync', sync)
  ctx.provide('gsServerSkillCatalog', catalog)
  ctx.skills.registerProvider((control) => {
    catalog.bindInvalidate(() => { control.invalidate() })
    return new ServerSkillProvider(server, { cacheRoot, logger: ctx.logger, catalog }, control, sync)
  })
}
