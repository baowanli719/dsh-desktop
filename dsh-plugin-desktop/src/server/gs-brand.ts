/**
 * gsclaw-server brand store.
 *
 * Precedence: the latest server-delivered brand (ClientConfig push or the
 * pre-login `/api/v1/meta` handshake) wins, then the brand cached below
 * userData, then the built-in default. Every effective change syncs the
 * process-local holder in `../brand.ts` so main-process copy resolvers stay
 * synchronous, and every accepted server brand is persisted so the next
 * launch renders it before the server answers.
 */

import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { GS_BRAND_DEFAULT, setCurrentBrand, type GsBrand } from '../brand.ts'
import type { GsBrandConfig, GsBrandView } from './gs-contract.ts'

/** Runtime brand cache location below Electron's userData directory. */
export const GS_BRAND_RELATIVE_PATH = 'gs-brand.json'

/** Maximum cache bytes read before treating the file as corrupt. */
export const MAX_GS_BRAND_STATE_BYTES = 4 * 1024

/** Field caps mirroring the server-side validation. */
export const MAX_GS_BRAND_NAME_LENGTH = 64
export const MAX_GS_BRAND_HEADLINE_LENGTH = 128

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

/** Failure raised when persisted brand state is unsafe to read. */
export class GsBrandError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GsBrandError'
  }
}

/** Return the exact cache path for one Electron userData directory. */
export function gsBrandStatePath(userDataDirectory: string): string {
  if (userDataDirectory.length === 0 || /[\0\r\n]/u.test(userDataDirectory) || !isAbsolute(userDataDirectory)) {
    throw new GsBrandError('Desktop userData must be an absolute path without control characters.')
  }
  return join(resolve(userDataDirectory), GS_BRAND_RELATIVE_PATH)
}

function sanitizeField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined
}

/** Normalize one server-delivered candidate; absent fields take the default. */
export function resolveGsBrandConfig(candidate: GsBrandConfig | null | undefined): GsBrand | undefined {
  if (candidate === null || candidate === undefined) return undefined
  return Object.freeze({
    name: sanitizeField(candidate.name, MAX_GS_BRAND_NAME_LENGTH) ?? GS_BRAND_DEFAULT.name,
    headline: sanitizeField(candidate.headline, MAX_GS_BRAND_HEADLINE_LENGTH) ?? GS_BRAND_DEFAULT.headline,
  })
}

/** Subscriber notified whenever the effective brand changes. */
export type GsBrandListener = (brand: GsBrand) => void

/** Inputs for one brand store. */
export interface GsBrandStoreOptions {
  /** Absolute Electron userData directory holding the brand cache. */
  readonly userDataDir: string
}

/**
 * Effective brand store. The cache is loaded once at startup; `current()`
 * stays synchronous so copy resolution never races the filesystem.
 */
export class GsBrandStore {
  private pushed: GsBrand | undefined
  private readonly listeners = new Set<GsBrandListener>()

  private constructor(
    private readonly statePath: string,
    private persisted: GsBrand | undefined,
  ) {
    this.syncHolder()
  }

  /** Load the persisted cache, treating absent or corrupt state as none. */
  static async load(options: GsBrandStoreOptions): Promise<GsBrandStore> {
    const statePath = gsBrandStatePath(options.userDataDir)
    return new GsBrandStore(statePath, await readPersistedBrand(statePath))
  }

  /** Effective brand: server push, then the persisted cache, then default. */
  current(): GsBrand {
    return this.pushed ?? this.persisted ?? GS_BRAND_DEFAULT
  }

  /** Renderer-safe view of the effective brand. */
  view(): GsBrandView {
    const brand = this.current()
    return Object.freeze({ name: brand.name, headline: brand.headline })
  }

  /** Subscribe to effective brand changes; returns the unsubscribe function. */
  subscribe(listener: GsBrandListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Accept one server-delivered brand from a ClientConfig push or the
   * pre-login meta handshake. A null/absent field clears the push so the
   * cache and defaults apply again; an accepted brand is persisted.
   */
  async applyServerBrand(candidate: GsBrandConfig | null | undefined): Promise<void> {
    const brand = resolveGsBrandConfig(candidate)
    if (brand === undefined) {
      if (this.pushed === undefined) return
      this.pushed = undefined
      this.syncHolder()
      this.notify()
      return
    }
    await writeFileAtomic(this.statePath, `${JSON.stringify(brand)}\n`, {
      mode: PRIVATE_FILE_MODE,
      dirMode: PRIVATE_DIRECTORY_MODE,
    })
    this.pushed = brand
    this.persisted = brand
    this.syncHolder()
    this.notify()
  }

  private syncHolder(): void {
    setCurrentBrand(this.current())
  }

  private notify(): void {
    const brand = this.current()
    for (const listener of this.listeners) listener(brand)
  }
}

async function readPersistedBrand(statePath: string): Promise<GsBrand | undefined> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(statePath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new GsBrandError('gsclaw-server brand state could not be inspected.', { cause })
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GS_BRAND_STATE_BYTES) return undefined

  const handle = await open(statePath, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_GS_BRAND_STATE_BYTES) return undefined
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new GsBrandError('gsclaw-server brand state changed while it was being opened.')
    }
    const buffer = Buffer.alloc(MAX_GS_BRAND_STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAX_GS_BRAND_STATE_BYTES) return undefined
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    return Object.freeze({
      name: sanitizeField(record.name, MAX_GS_BRAND_NAME_LENGTH) ?? GS_BRAND_DEFAULT.name,
      headline: sanitizeField(record.headline, MAX_GS_BRAND_HEADLINE_LENGTH) ?? GS_BRAND_DEFAULT.headline,
    })
  } catch (cause) {
    if (cause instanceof SyntaxError || cause instanceof TypeError) return undefined
    if (cause instanceof GsBrandError) throw cause
    throw new GsBrandError('gsclaw-server brand state could not be read safely.', { cause })
  } finally {
    await handle.close()
  }
}
