/**
 * Headless evaluation of the gsclaw-server `appUpdate` push.
 *
 * The server delivers `config.appUpdate` (see `server/gs-contract.ts`) through
 * login/refresh responses and `GET /api/client-config`. `authorizedJson` does
 * not validate that payload at runtime, so `parseServerAppUpdate` defensively
 * narrows the wire value and `evaluateServerAppUpdate` decides whether the
 * running application should prompt and which download URL applies.
 *
 * The contract's `downloadWindow` gates only automatic downloads. This client
 * never downloads without an explicit user confirmation, which the server
 * contract exempts from the window, so the field is validated during parsing
 * but intentionally never evaluated here.
 */

import type { GsAppUpdateConfig } from './server/gs-contract.ts'
import { compareSemVerVersions, parseSemVer } from './update-checker.ts'

/** Outcome of evaluating one server-pushed update notice. */
export type ServerAppUpdateEvaluation =
  | {
    /** The server gates downloads until `availableFrom`; prompt without a download offer. */
    readonly kind: 'notify-only'
    readonly version: string
    readonly notes: readonly string[]
    readonly availableFrom: string
  }
  | {
    /** The update may be prompted and, after user confirmation, downloaded. */
    readonly kind: 'available'
    readonly version: string
    readonly notes: readonly string[]
    /** Direct http(s) installer URL selected for the current platform and arch. */
    readonly url: string
  }

const HH_MM_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u

/**
 * Defensively parse one wire `appUpdate` value.
 * @param value - unvalidated JSON from a login, refresh, or client-config response.
 * @returns a normalized config, or null when any field is malformed.
 */
export function parseServerAppUpdate(value: unknown): GsAppUpdateConfig | null {
  if (!isRecord(value)) return null
  if (typeof value.version !== 'string') return null
  const parsed = parseSemVer(value.version)
  // The server publishes plain dotted-number versions; reject a leading `v`,
  // non-canonical spelling, and any prerelease identifiers.
  if (parsed === null || parsed.version !== value.version || parsed.prerelease.length > 0) return null

  if (!isRecord(value.downloads)) return null
  const downloads: { windowsX64?: string, macArm?: string, macIntel?: string } = {}
  for (const key of ['windowsX64', 'macArm', 'macIntel'] as const) {
    const candidate = value.downloads[key]
    if (candidate === undefined) continue
    if (typeof candidate !== 'string' || !isDirectDownloadUrl(candidate)) return null
    downloads[key] = candidate
  }
  if (Object.keys(downloads).length === 0) return null

  let notes: readonly string[] | undefined
  if (value.notes !== undefined) {
    if (!Array.isArray(value.notes) || value.notes.some(note => typeof note !== 'string')) return null
    notes = value.notes as readonly string[]
  }

  let availableFrom: string | undefined
  if (value.availableFrom !== undefined) {
    if (typeof value.availableFrom !== 'string'
      || !Number.isFinite(Date.parse(value.availableFrom))) return null
    availableFrom = value.availableFrom
  }

  let downloadWindow: { readonly start: string, readonly end: string } | null | undefined
  if (value.downloadWindow !== undefined && value.downloadWindow !== null) {
    if (!isRecord(value.downloadWindow)
      || typeof value.downloadWindow.start !== 'string'
      || typeof value.downloadWindow.end !== 'string'
      || !HH_MM_PATTERN.test(value.downloadWindow.start)
      || !HH_MM_PATTERN.test(value.downloadWindow.end)) return null
    downloadWindow = { start: value.downloadWindow.start, end: value.downloadWindow.end }
  } else if (value.downloadWindow === null) {
    downloadWindow = null
  }

  return {
    version: value.version,
    ...(notes === undefined ? {} : { notes }),
    downloads,
    ...(availableFrom === undefined ? {} : { availableFrom }),
    ...(downloadWindow === undefined ? {} : { downloadWindow }),
  }
}

/**
 * Decide whether one parsed notice reaches the user on this machine.
 * @param appUpdate - parsed server notice, or null when none was pushed.
 * @param currentVersion - installed desktop product version.
 * @param platform - `process.platform` of the running application.
 * @param arch - `process.arch` of the running application.
 * @param now - evaluation time, compared against `availableFrom`.
 * @returns the prompt decision, or null when nothing should surface.
 */
export function evaluateServerAppUpdate(
  appUpdate: GsAppUpdateConfig | null,
  currentVersion: string,
  platform: NodeJS.Platform | string,
  arch: string,
  now: Date,
): ServerAppUpdateEvaluation | null {
  if (appUpdate === null) return null
  const comparison = compareSemVerVersions(appUpdate.version, currentVersion)
  if (comparison === null || comparison <= 0) return null

  const url = selectDownloadUrl(appUpdate, platform, arch)
  if (url === undefined) return null

  const notes = appUpdate.notes ?? []
  if (appUpdate.availableFrom !== undefined
    && now.getTime() < Date.parse(appUpdate.availableFrom)) {
    return {
      kind: 'notify-only',
      version: appUpdate.version,
      notes,
      availableFrom: appUpdate.availableFrom,
    }
  }
  return { kind: 'available', version: appUpdate.version, notes, url }
}

function selectDownloadUrl(
  appUpdate: GsAppUpdateConfig,
  platform: NodeJS.Platform | string,
  arch: string,
): string | undefined {
  if (platform === 'win32') return appUpdate.downloads.windowsX64
  if (platform === 'darwin' && arch === 'arm64') return appUpdate.downloads.macArm
  if (platform === 'darwin' && arch === 'x64') return appUpdate.downloads.macIntel
  return undefined
}

function isDirectDownloadUrl(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  return (url.protocol === 'https:' || url.protocol === 'http:')
    && url.username === ''
    && url.password === ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
