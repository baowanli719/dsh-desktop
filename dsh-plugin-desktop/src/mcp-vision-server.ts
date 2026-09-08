/**
 * Stdio MCP server bridging local image files to the server-side vision model.
 *
 * Spawned by the upstream mcp-client plugin (ELECTRON_RUN_AS_NODE) with the
 * loopback LLM proxy coordinates injected through environment variables; the
 * child never sees the gsclaw-server session or provider credentials, only the
 * per-boot proxy token. Image bytes travel as chat-completions data URIs:
 * child -> loopback proxy -> gsclaw-server /api/v1/llm gateway -> higress.
 */

import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/** Raw image ceiling: base64 inflation plus the message envelope must stay under the 4 MiB caps on both proxy hops. */
export const MAX_IMAGE_FILE_BYTES = 2_500_000
export const DEFAULT_MAX_TOKENS = 4096
export const MAX_TOKENS_CEILING = 8192
/** Leaves headroom under the 120 s upstream gateway ceiling for the mcp-client tool-call timeout. */
export const REQUEST_TIMEOUT_MS = 110_000

export interface VisionProxyConfig {
  readonly origin: string
  readonly token: string
  readonly providerId: string
  readonly modelId: string
}

/** Reads the injected proxy coordinates; every missing required variable is reported at once. */
export function resolveVisionProxyConfig(environment: NodeJS.ProcessEnv): VisionProxyConfig {
  const missing: string[] = []
  const origin = environment.VISION_PROXY_ORIGIN ?? ''
  const token = environment.VISION_PROXY_TOKEN ?? ''
  if (origin.length === 0) missing.push('VISION_PROXY_ORIGIN')
  if (token.length === 0) missing.push('VISION_PROXY_TOKEN')
  if (missing.length > 0) {
    throw new Error(`mcp-vision-server: missing required environment: ${missing.join(', ')}`)
  }
  return {
    origin: origin.replace(/\/+$/u, ''),
    token,
    providerId: environment.VISION_PROVIDER_ID ?? 'gs-cloud',
    modelId: environment.VISION_MODEL_ID ?? 'qwen36-35b',
  }
}

/** Sniffs the image format from magic bytes. */
export function detectImageMime(head: Buffer): string | undefined {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && head.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (head.length >= 6 && head.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (head.length >= 12
    && head.subarray(0, 4).toString('ascii') === 'RIFF'
    && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

export class VisionToolError extends Error {}

/** Loads one local image as a data URI, enforcing the format allowlist and the size ceiling. */
export async function readImageAsDataUri(path: string): Promise<{ dataUri: string, mime: string, bytes: number }> {
  let stats
  try {
    stats = await stat(path)
  } catch {
    throw new VisionToolError(`图片文件不存在或不可读: ${path}`)
  }
  if (!stats.isFile()) throw new VisionToolError(`路径不是文件: ${path}`)
  if (stats.size > MAX_IMAGE_FILE_BYTES) {
    throw new VisionToolError(
      `图片 ${String(stats.size)} 字节超过 ${String(MAX_IMAGE_FILE_BYTES)} 字节上限，请先压缩或缩小后再分析`,
    )
  }
  const buffer = await readFile(path)
  const mime = detectImageMime(buffer.subarray(0, 12))
  if (mime === undefined) {
    throw new VisionToolError(`无法识别的图片格式（仅支持 PNG/JPEG/WebP/GIF）: ${path}`)
  }
  return { dataUri: `data:${mime};base64,${buffer.toString('base64')}`, mime, bytes: buffer.length }
}

export interface ChatCompletionsRequest {
  readonly model: string
  readonly prompt: string
  readonly dataUri: string
  readonly maxTokens: number
}

/** Multimodal chat body; no system message — the higress upstream accepts at most one leading system message. */
export function buildChatCompletionsBody(request: ChatCompletionsRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: false,
    max_tokens: request.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: request.prompt },
          { type: 'image_url', image_url: { url: request.dataUri } },
        ],
      },
    ],
  }
}

/** Extracts the assistant text from a chat-completions payload, tolerating string or part-array content. */
export function extractAssistantText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map(part => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .filter(text => text.length > 0)
      .join('\n')
      .trim()
  }
  return ''
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

async function readErrorDetail(response: Response): Promise<{ code?: string | undefined, message?: string | undefined }> {
  try {
    const payload: unknown = await response.json()
    if (payload !== null && typeof payload === 'object') {
      const record = payload as { code?: unknown, message?: unknown, error?: { message?: unknown } }
      return {
        code: typeof record.code === 'string' ? record.code : undefined,
        message: typeof record.message === 'string'
          ? record.message
          : typeof record.error?.message === 'string' ? record.error.message : undefined,
      }
    }
  } catch {
    // Non-JSON error bodies fall through to the generic mapping.
  }
  return {}
}

/** Runs one vision analysis through the loopback proxy and maps every failure to a model-readable message. */
export async function analyzeImageWithVisionModel(
  config: VisionProxyConfig,
  request: ChatCompletionsRequest,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(`${config.origin}/v1/${config.providerId}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildChatCompletionsBody(request)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (cause: unknown) {
    const aborted = cause instanceof Error && cause.name === 'TimeoutError'
    throw new VisionToolError(aborted
      ? '视觉模型请求超时，请稍后重试'
      : `无法连接本地 LLM 代理: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    if (response.status === 401) throw new VisionToolError('gsclaw-server 会话已失效，请重新登录后再试')
    if (response.status === 413) throw new VisionToolError('图片过大，请先压缩或缩小后再分析')
    if (detail.code === 'model_not_allowed') {
      throw new VisionToolError('服务端尚未把视觉模型加入代理白名单（visionModel 未配置或不匹配）')
    }
    throw new VisionToolError(`视觉模型请求失败 (HTTP ${String(response.status)}): ${detail.message ?? '未知错误'}`)
  }
  const text = extractAssistantText(await response.json())
  if (text.length === 0) throw new VisionToolError('视觉模型没有返回可用的分析结果')
  return text
}

export interface AnalyzeImageArguments {
  readonly path: string
  readonly prompt: string
  readonly max_tokens?: number | undefined
}

/** Tool handler shared by the MCP registration and the unit tests. */
export async function handleAnalyzeImage(
  config: VisionProxyConfig,
  args: AnalyzeImageArguments,
  fetchImpl?: FetchLike,
): Promise<{ content: { type: 'text', text: string }[], isError?: boolean }> {
  try {
    const image = await readImageAsDataUri(resolve(args.path))
    const text = await analyzeImageWithVisionModel(config, {
      model: config.modelId,
      prompt: args.prompt,
      dataUri: image.dataUri,
      maxTokens: args.max_tokens ?? DEFAULT_MAX_TOKENS,
    }, fetchImpl)
    return { content: [{ type: 'text', text }] }
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

async function main(): Promise<void> {
  const config = resolveVisionProxyConfig(process.env)
  const server = new McpServer({ name: 'dsh-vision', version: '0.1.0' })
  server.registerTool('analyze_image', {
    title: 'Analyze Image',
    description:
      '分析一张本地图片的内容（物体、文字、布局等）。传入图片文件的绝对路径和分析要求，返回视觉模型的文字分析结果。仅支持 PNG/JPEG/WebP/GIF，文件不能超过 2.5MB。',
    inputSchema: {
      path: z.string().min(1).describe('本地图片文件的绝对路径'),
      prompt: z.string().min(1).describe('对图片的分析要求，例如「描述画面内容」或「提取图中的文字」'),
      max_tokens: z.number().int().min(1).max(MAX_TOKENS_CEILING).optional()
        .describe(`分析结果的最大 token 数，默认 ${String(DEFAULT_MAX_TOKENS)}`),
    },
    annotations: { readOnlyHint: true },
  }, async args => await handleAnalyzeImage(config, args))
  await server.connect(new StdioServerTransport())
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((cause: unknown) => {
    process.stderr.write(`mcp-vision-server: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  })
}
