/**
 * gsclaw-server endpoint resolution.
 *
 * Precedence: runtime override persisted below userData wins, then the
 * environment seam for development and packaging, then the built-in
 * default. Plain HTTP is accepted only for loopback and private LAN hosts;
 * every other authority must use HTTPS.
 */

import { lstat, open, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Built-in endpoint used when neither an override nor the environment speaks. */
export const GS_DEFAULT_ENDPOINT = 'http://192.168.230.108:8151/gsworker'

/** Environment variable overriding the built-in endpoint for development. */
export const GS_ENDPOINT_ENV = 'GSCLAW_ENDPOINT'

/** Runtime override state location below Electron's userData directory. */
export const GS_ENDPOINT_RELATIVE_PATH = 'gs-endpoint.json'

/** Maximum override state bytes read before treating the file as corrupt. */
export const MAX_GS_ENDPOINT_STATE_BYTES = 4 * 1024

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

/** Failure raised when an endpoint value or its persisted state is unsafe. */
export class GsEndpointError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GsEndpointError'
  }
}

/** Return the exact runtime override path for one Electron userData directory. */
export function gsEndpointStatePath(userDataDirectory: string): string {
  if (userDataDirectory.length === 0 || /[\0\r\n]/u.test(userDataDirectory) || !isAbsolute(userDataDirectory)) {
    throw new GsEndpointError('Desktop userData must be an absolute path without control characters.')
  }
  return join(resolve(userDataDirectory), GS_ENDPOINT_RELATIVE_PATH)
}

function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower === '[::1]') return true
  if (lower.startsWith('127.')) return true
  if (lower.startsWith('192.168.')) return true
  if (lower.startsWith('10.')) return true
  return false
}

/**
 * Validate and normalize one endpoint URL.
 *
 * Only `http:`/`https:` authorities without credentials, query, or fragment
 * are accepted; the path is kept verbatim minus trailing slashes. Plain HTTP
 * is restricted to loopback and the private ranges an on-prem gateway uses.
 */
export function assertGsEndpoint(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new GsEndpointError('gsclaw-server endpoint must be an absolute http(s) URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GsEndpointError('gsclaw-server endpoint must use http or https.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new GsEndpointError('gsclaw-server endpoint must not embed credentials.')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new GsEndpointError('gsclaw-server endpoint must not carry a query or fragment.')
  }
  if (url.protocol === 'http:' && !isPrivateOrLoopbackHostname(url.hostname)) {
    throw new GsEndpointError('gsclaw-server endpoint requires https outside loopback and private LAN hosts.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

/** Resolve one override candidate, or undefined when absent or invalid. */
export function parseGsEndpointOverride(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  try {
    return assertGsEndpoint(value)
  } catch {
    return undefined
  }
}

/** Inputs for one endpoint store. */
export interface GsEndpointStoreOptions {
  /** Absolute Electron userData directory holding the runtime override. */
  readonly userDataDir: string
  /** Environment override value; defaults to the GSCLAW_ENDPOINT seam. */
  readonly environment?: string | undefined}

/**
 * Runtime endpoint store. The persisted override is loaded once at startup;
 * `resolve()` stays synchronous so request paths never race the filesystem.
 */
export class GsEndpointStore {
  private override: string | undefined

  private constructor(
    private readonly statePath: string,
    private readonly environment: string | undefined,
    override: string | undefined,
  ) {
    this.override = override
  }

  /** Load the persisted override, treating absent or corrupt state as none. */
  static async load(options: GsEndpointStoreOptions): Promise<GsEndpointStore> {
    const statePath = gsEndpointStatePath(options.userDataDir)
    const environment = options.environment ?? process.env[GS_ENDPOINT_ENV]
    const persisted = await readPersistedEndpoint(statePath)
    return new GsEndpointStore(statePath, environment, persisted)
  }

  /** Effective endpoint: persisted override, then environment, then default. */
  resolve(): string {
    return this.override
      ?? parseGsEndpointOverride(this.environment)
      ?? GS_DEFAULT_ENDPOINT
  }

  /** Explicit runtime override currently persisted, if any. */
  get persistedOverride(): string | undefined {
    return this.override
  }

  /** Validate and persist one runtime override. */
  async setOverride(value: string): Promise<string> {
    const endpoint = assertGsEndpoint(value)
    await writeFileAtomic(this.statePath, `${JSON.stringify({ endpoint })}\n`, {
      mode: PRIVATE_FILE_MODE,
      dirMode: PRIVATE_DIRECTORY_MODE,
    })
    this.override = endpoint
    return endpoint
  }

  /** Drop the runtime override so environment and default apply again. */
  async clearOverride(): Promise<void> {
    this.override = undefined
    try {
      await unlink(this.statePath)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new GsEndpointError('gsclaw-server endpoint override could not be removed.', { cause })
      }
    }
  }
}

async function readPersistedEndpoint(statePath: string): Promise<string | undefined> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(statePath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new GsEndpointError('gsclaw-server endpoint state could not be inspected.', { cause })
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GS_ENDPOINT_STATE_BYTES) return undefined

  const handle = await open(statePath, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_GS_ENDPOINT_STATE_BYTES) return undefined
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new GsEndpointError('gsclaw-server endpoint state changed while it was being opened.')
    }
    const buffer = Buffer.alloc(MAX_GS_ENDPOINT_STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAX_GS_ENDPOINT_STATE_BYTES) return undefined
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const endpoint = (value as Record<string, unknown>).endpoint
    return typeof endpoint === 'string' ? parseGsEndpointOverride(endpoint) : undefined
  } catch (cause) {
    if (cause instanceof SyntaxError || cause instanceof TypeError) return undefined
    if (cause instanceof GsEndpointError) throw cause
    throw new GsEndpointError('gsclaw-server endpoint state could not be read safely.', { cause })
  } finally {
    await handle.close()
  }
}
