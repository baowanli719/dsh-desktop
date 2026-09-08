/**
 * Server-pushed model plan for the desktop profile.
 *
 * `planGsLlmModelProfile` turns the ClientConfig `models` section into the
 * `llm-pi-ai` provider profiles that route every Agent-loop LLM call through
 * the loopback proxy (gs-llm-proxy.ts), plus the default model selection for
 * the `agent-default-model` row. `mirrorGsLlmModelSettings` then owns the
 * model sections of the settings document outright: it rewrites `llm-pi-ai:`,
 * removes `llm-deepseek:`, and pins `agent-default-model:`, so a user edit to
 * any of them survives only until the next boot or ClientConfig push. The
 * settings file is hot-reloaded, so a mirrored update reaches the running
 * adapter without a restart.
 *
 * The document carries the credential *reference* only; the per-boot proxy
 * token itself lives in the launch-environment snapshot, never on disk.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  LaunchEnvironmentEntry,
  LaunchEnvironmentSnapshot,
} from '@deepseek-ai/dsh-launch-environment'
import { parseDocument } from 'yaml'
import type { GsModelsConfig } from './gs-contract.ts'
import { GS_LLM_PROVIDER_ID_PATTERN } from './gs-llm-proxy.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/** Credential reference the per-boot proxy token resolves through. */
export const GS_LLM_PROXY_CREDENTIAL_REF = 'DSH_DESKTOP_LLM_PROXY_TOKEN'

/** Settings namespaces the mirror owns outright. */
export const GS_LLM_PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'
export const GS_LLM_DEEPSEEK_SETTINGS_NAMESPACE = 'llm-deepseek'
export const GS_AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'
export const GS_VISION_ROUTER_SETTINGS_NAMESPACE = 'vision-router'

/**
 * Server-side vision model the desktop vision bridges (Vision Router backend,
 * the vision MCP child) reach through the loopback proxy. The gsclaw-server
 * LLM gateway proxies it via its visionModel allowance even though it never
 * appears in the user-selectable model list.
 */
export const GS_VISION_PROVIDER_ID = 'gs-cloud'
export const GS_VISION_MODEL_ID = 'qwen36-35b'

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const DOCUMENT_FILE_MODE = 0o600
const DOCUMENT_DIRECTORY_MODE = 0o700

/** Model-id guard: ids land in request bodies, never in proxy URLs. */
const MODEL_ID_PATTERN = /^[^\s/\\]{1,256}$/u

/** Request modalities the pi-ai adapter can serve. */
const PI_AI_MODALITIES: ReadonlySet<string> = new Set(['text', 'image'])

/** One model entry inside a mirrored `llm-pi-ai` provider profile. */
export interface GsLlmProviderModel {
  readonly id: string
  readonly name?: string
  readonly input?: readonly ('text' | 'image')[]
}

/** Mirrored `llm-pi-ai` provider profile routing through the loopback proxy. */
export interface GsLlmProviderProfile {
  readonly displayName: string
  readonly api: 'openai-completions'
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly models: readonly GsLlmProviderModel[]
}

/** Resolved default model selection for the `agent-default-model` row. */
export interface GsLlmDefaultModel {
  readonly provider: string
  readonly model: string
}

/** One OpenAI-compatible vision backend row consumed by the Vision Router plugin. */
export interface GsVisionRouterHttpProvider {
  readonly name: string
  readonly baseURL: string
  readonly model: string
  readonly apiKeyEnv: string
  readonly maxTokens: number
}

/**
 * Mirrored `vision-router:` settings section: the loopback vision backend,
 * with the anonymous external fallback chain disabled. Owned outright by the
 * mirror, so manual edits in the Vision Router settings card are overwritten
 * on the next boot, matching the server-managed model plane.
 */
export interface GsVisionRouterSection {
  readonly httpProviders: readonly GsVisionRouterHttpProvider[]
  readonly freeFallback: false
}

/** Inputs for {@link planGsLlmModelProfile}. */
export interface GsLlmModelPlanInput {
  /** Server ClientConfig `models` section; null or empty keeps upstream defaults. */
  readonly models: GsModelsConfig | null | undefined
  /** Loopback proxy origin, e.g. `http://127.0.0.1:43123`. */
  readonly proxyOrigin: string
  /** Credential reference naming the proxy token; defaults to {@link GS_LLM_PROXY_CREDENTIAL_REF}. */
  readonly credentialRef?: string
}

/** Server-mediated model plan for one profile generation. */
export interface GsLlmModelPlan {
  /** `llm-pi-ai` providers dict; undefined when the server supplied nothing usable. */
  readonly providers?: Record<string, GsLlmProviderProfile>
  /** Default selection resolved from `defaultPrimary` or the first supplied model. */
  readonly defaultModel?: GsLlmDefaultModel
  /** `vision-router:` section pointing the vision backend at the loopback proxy. */
  readonly visionRouter: GsVisionRouterSection
  /** Human-readable diagnostics for skipped or unresolvable server entries. */
  readonly warnings: readonly string[]
}

/**
 * Build the vision-backend section for the Vision Router plugin. It only
 * needs the loopback origin: the server gateway proxies the vision model via
 * its visionModel allowance, independent of the user-selectable model list.
 */
export function planGsVisionRouterSection(
  proxyOrigin: string,
  credentialRef: string = GS_LLM_PROXY_CREDENTIAL_REF,
): GsVisionRouterSection {
  return {
    httpProviders: [{
      name: 'gsclaw-vision',
      baseURL: `${proxyOrigin}/v1/${GS_VISION_PROVIDER_ID}`,
      model: GS_VISION_MODEL_ID,
      apiKeyEnv: credentialRef,
      maxTokens: 4096,
    }],
    freeFallback: false,
  }
}

/**
 * Build the provider profiles and default selection from the server models
 * section. Provider keys are sorted so the mirrored document is stable across
 * identical pushes; unusable entries are skipped with a warning rather than
 * failing the boot.
 */
export function planGsLlmModelProfile(input: GsLlmModelPlanInput): GsLlmModelPlan {
  const warnings: string[] = []
  const source = input.models
  const credentialRef = input.credentialRef ?? GS_LLM_PROXY_CREDENTIAL_REF
  const visionRouter = planGsVisionRouterSection(input.proxyOrigin, credentialRef)
  if (source === null || source === undefined) {
    warnings.push('server ClientConfig carries no models section; keeping the upstream default model')
    return { visionRouter, warnings }
  }
  const providers: Record<string, GsLlmProviderProfile> = {}
  for (const providerId of Object.keys(source.providers).sort()) {
    const entry = source.providers[providerId]
    if (entry === undefined) continue
    if (!GS_LLM_PROVIDER_ID_PATTERN.test(providerId)) {
      warnings.push(`server model provider ${JSON.stringify(providerId)} is outside the route grammar; skipped`)
      continue
    }
    const models: GsLlmProviderModel[] = []
    for (const model of entry.models) {
      if (!MODEL_ID_PATTERN.test(model.id)) {
        warnings.push(`server model ${JSON.stringify(model.id)} of provider ${providerId} is not a usable model id; skipped`)
        continue
      }
      const inputModalities = model.input?.filter((modality): modality is 'text' | 'image' =>
        PI_AI_MODALITIES.has(modality))
      models.push({
        id: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(inputModalities === undefined || inputModalities.length === 0
          ? {}
          : { input: inputModalities }),
      })
    }
    if (models.length === 0) {
      warnings.push(`server model provider ${providerId} supplies no usable models; skipped`)
      continue
    }
    providers[providerId] = {
      displayName: providerId,
      api: entry.api,
      baseURL: `${input.proxyOrigin}/v1/${providerId}`,
      apiKeyEnv: credentialRef,
      models,
    }
  }
  const providerIds = Object.keys(providers)
  if (providerIds.length === 0) {
    warnings.push('server ClientConfig supplied no usable model providers; keeping the upstream default model')
    return { visionRouter, warnings }
  }

  let defaultModel: GsLlmDefaultModel | undefined
  const primary = source.defaultPrimary
  if (primary !== undefined) {
    const slash = primary.indexOf('/')
    const provider = slash === -1 ? primary : primary.slice(0, slash)
    const model = slash === -1 ? '' : primary.slice(slash + 1)
    const route = providers[provider]
    if (route !== undefined && route.models.some(entry => entry.id === model)) {
      defaultModel = { provider, model }
    } else {
      warnings.push(`server defaultPrimary ${JSON.stringify(primary)} does not resolve to a supplied provider/model; using the first supplied model`)
    }
  }
  const firstProvider = providerIds[0]!
  defaultModel ??= { provider: firstProvider, model: providers[firstProvider]!.models[0]!.id }
  return { providers, defaultModel, visionRouter, warnings }
}

/**
 * Launch-environment snapshot carrying the per-boot proxy token as a
 * `process`-layer entry. The token lives only in this in-memory snapshot: it
 * is never written to disk and never materialized into `process.env`, so
 * sandboxed tool subprocesses cannot inherit it, while `ctx.credentials` and
 * the pi-ai adapter's launch-environment fallback both resolve it here.
 */
export function gsLlmProxyLaunchEnvironment(
  base: LaunchEnvironmentSnapshot,
  token: string,
  credentialRef: string = GS_LLM_PROXY_CREDENTIAL_REF,
): LaunchEnvironmentSnapshot {
  const entry: LaunchEnvironmentEntry = { value: token, source: 'process' }
  return {
    get(name) {
      if (name === credentialRef) return entry
      return base.get(name)
    },
    getFrom(name, sources) {
      if (name === credentialRef) return sources.includes('process') ? entry : undefined
      return base.getFrom(name, sources)
    },
  }
}

interface LoadedModelDocument {
  readonly format: 'yaml' | 'json'
  readonly existed: boolean
  readonly root: Record<string, unknown>
  readonly yaml?: ReturnType<typeof parseDocument>
}

function invalidDocument(message: string): Error {
  return new Error(`${BIN_NAME}: invalid settings document for the model mirror: ${message}`)
}

function modelSettingsPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError(`${BIN_NAME}: model settings document must be an absolute path without NUL`)
  }
  const path = resolve(value)
  const extension = extname(path).toLowerCase()
  if (extension !== '.yaml' && extension !== '.yml' && extension !== '.json') {
    throw new TypeError(`${BIN_NAME}: model settings document must use .yaml, .yml, or .json`)
  }
  return path
}

/** Read the settings document with the same symlink and size bar as the Wizard writer. */
function readModelDocumentText(path: string): string | undefined {
  let pathInfo
  try {
    pathInfo = lstatSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw invalidDocument('document must be a regular file')
  if (pathInfo.size > MAX_DOCUMENT_BYTES) {
    throw invalidDocument(`document exceeds ${String(MAX_DOCUMENT_BYTES)} bytes`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) {
      throw invalidDocument(`document must be a regular file within ${String(MAX_DOCUMENT_BYTES)} bytes`)
    }
    if (info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) {
      throw invalidDocument('document changed while it was being opened')
    }
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.byteLength - bytesRead, null)
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead > MAX_DOCUMENT_BYTES) {
      throw invalidDocument(`document exceeds ${String(MAX_DOCUMENT_BYTES)} bytes`)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } catch {
      throw invalidDocument('document must contain valid UTF-8')
    }
  } finally {
    closeSync(descriptor)
  }
}

function loadModelDocument(path: string): LoadedModelDocument {
  const format = extname(path).toLowerCase() === '.json' ? 'json' : 'yaml'
  const text = readModelDocumentText(path)
  if (format === 'json') {
    let value: unknown = {}
    if (text !== undefined) {
      try {
        value = JSON.parse(text) as unknown
      } catch {
        throw invalidDocument('JSON could not be parsed')
      }
    }
    if (!isPlainRecord(value)) throw invalidDocument('root must be a map of namespace sections')
    return { format, existed: text !== undefined, root: value }
  }
  const yaml = parseDocument(text ?? '', { prettyErrors: true })
  if (yaml.errors.length > 0) {
    throw invalidDocument(`YAML could not be parsed: ${yaml.errors.map(error => error.message).join('; ')}`)
  }
  const value: unknown = yaml.toJS() ?? {}
  if (!isPlainRecord(value)) throw invalidDocument('root must be a map of namespace sections')
  return { format, existed: text !== undefined, root: value, yaml }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Order-insensitive JSON rendering used only for no-op detection. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The mirror-owned sections of one parsed document, as a stable string. */
function ownedSections(root: Record<string, unknown>): string {
  return stableStringify([
    root[GS_LLM_PI_AI_SETTINGS_NAMESPACE],
    root[GS_LLM_DEEPSEEK_SETTINGS_NAMESPACE],
    root[GS_AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE],
    root[GS_VISION_ROUTER_SETTINGS_NAMESPACE],
  ])
}

/**
 * Rewrite the model sections of the settings document from the current plan.
 * Returns whether the durable document changed; an already-mirrored document
 * is left untouched so ClientConfig pushes that change nothing never trigger
 * a settings reload.
 */
export async function mirrorGsLlmModelSettings(
  documentPath: string,
  plan: GsLlmModelPlan,
): Promise<boolean> {
  const path = modelSettingsPath(documentPath)
  const loaded = loadModelDocument(path)
  const before = ownedSections(loaded.root)

  const piAiSection = plan.providers === undefined ? undefined : { providers: plan.providers }
  const defaultSection = plan.defaultModel === undefined
    ? undefined
    : { provider: plan.defaultModel.provider, model: plan.defaultModel.model }

  let output: string
  if (loaded.format === 'yaml') {
    const document = loaded.yaml!
    // deleteIn rejects a null-contents document, so every delete is guarded.
    if (piAiSection === undefined) {
      if (document.hasIn([GS_LLM_PI_AI_SETTINGS_NAMESPACE])) document.deleteIn([GS_LLM_PI_AI_SETTINGS_NAMESPACE])
    } else {
      document.setIn([GS_LLM_PI_AI_SETTINGS_NAMESPACE], piAiSection)
    }
    if (document.hasIn([GS_LLM_DEEPSEEK_SETTINGS_NAMESPACE])) {
      document.deleteIn([GS_LLM_DEEPSEEK_SETTINGS_NAMESPACE])
    }
    if (defaultSection === undefined) {
      if (document.hasIn([GS_AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE])) {
        document.deleteIn([GS_AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE])
      }
    } else {
      document.setIn([GS_AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE], defaultSection)
    }
    document.setIn([GS_VISION_ROUTER_SETTINGS_NAMESPACE], plan.visionRouter)
    if (document.contents === null) return false
    if (ownedSections(document.toJS() ?? {}) === before && loaded.existed) return false
    output = document.toString()
  } else {
    const root = structuredClone(loaded.root)
    if (piAiSection === undefined) delete root[GS_LLM_PI_AI_SETTINGS_NAMESPACE]
    else root[GS_LLM_PI_AI_SETTINGS_NAMESPACE] = piAiSection
    delete root[GS_LLM_DEEPSEEK_SETTINGS_NAMESPACE]
    if (defaultSection === undefined) delete root[GS_AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE]
    else root[GS_AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE] = defaultSection
    root[GS_VISION_ROUTER_SETTINGS_NAMESPACE] = plan.visionRouter
    if (ownedSections(root) === before) return false
    output = `${JSON.stringify(root, undefined, 2)}\n`
  }

  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: DOCUMENT_DIRECTORY_MODE })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw invalidDocument('document parent must be a real directory')
  }
  await writeFileAtomic(path, output, {
    mode: DOCUMENT_FILE_MODE,
    dirMode: DOCUMENT_DIRECTORY_MODE,
  })
  return true
}
