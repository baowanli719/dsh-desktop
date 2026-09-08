import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  analyzeImageWithVisionModel,
  buildChatCompletionsBody,
  DEFAULT_MAX_TOKENS,
  detectImageMime,
  extractAssistantText,
  handleAnalyzeImage,
  MAX_IMAGE_FILE_BYTES,
  readImageAsDataUri,
  resolveVisionProxyConfig,
  type VisionProxyConfig,
} from '../src/mcp-vision-server.ts'

const CONFIG: VisionProxyConfig = {
  origin: 'http://127.0.0.1:39000',
  token: 'proxy-token',
  providerId: 'gs-cloud',
  modelId: 'qwen36-35b',
}

// Smallest buffers carrying each format's magic bytes; content after the header is irrelevant.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16)])
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(16)])

function mockResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response
}

let workDir: string
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mcp-vision-'))
})
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('resolveVisionProxyConfig', () => {
  it('缺少必填环境变量时一次性列出', () => {
    expect(() => resolveVisionProxyConfig({})).toThrow('VISION_PROXY_ORIGIN, VISION_PROXY_TOKEN')
    expect(() => resolveVisionProxyConfig({ VISION_PROXY_ORIGIN: 'http://x' })).toThrow('VISION_PROXY_TOKEN')
  })

  it('默认 provider/model，剥掉 origin 末尾斜杠', () => {
    expect(resolveVisionProxyConfig({
      VISION_PROXY_ORIGIN: 'http://127.0.0.1:39000/',
      VISION_PROXY_TOKEN: 't',
    })).toEqual({ origin: 'http://127.0.0.1:39000', token: 't', providerId: 'gs-cloud', modelId: 'qwen36-35b' })
  })
})

describe('detectImageMime', () => {
  it('按 magic bytes 识别四种格式', () => {
    expect(detectImageMime(PNG)).toBe('image/png')
    expect(detectImageMime(JPEG)).toBe('image/jpeg')
    expect(detectImageMime(GIF)).toBe('image/gif')
    expect(detectImageMime(WEBP)).toBe('image/webp')
  })

  it('非图片内容返回 undefined', () => {
    expect(detectImageMime(Buffer.from('plain text file', 'utf8'))).toBeUndefined()
  })
})

describe('readImageAsDataUri', () => {
  it('读取合法图片为 data URI', async () => {
    const file = join(workDir, 'sample.png')
    await writeFile(file, PNG)
    const result = await readImageAsDataUri(file)
    expect(result.mime).toBe('image/png')
    expect(result.bytes).toBe(PNG.length)
    expect(result.dataUri).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
  })

  it('不存在的路径报错', async () => {
    await expect(readImageAsDataUri(join(workDir, 'missing.png'))).rejects.toThrow('不存在或不可读')
  })

  it('超过大小上限报错', async () => {
    const file = join(workDir, 'huge.png')
    await writeFile(file, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_FILE_BYTES)]))
    await expect(readImageAsDataUri(file)).rejects.toThrow('上限')
  })

  it('无法识别的格式报错', async () => {
    const file = join(workDir, 'notes.png')
    await writeFile(file, Buffer.from('not really a png', 'utf8'))
    await expect(readImageAsDataUri(file)).rejects.toThrow('无法识别的图片格式')
  })
})

describe('buildChatCompletionsBody', () => {
  it('组装多模态 user 消息，不带 system、非流式', () => {
    const body = buildChatCompletionsBody({
      model: 'qwen36-35b', prompt: '描述这张图', dataUri: 'data:image/png;base64,AAAA', maxTokens: 1024,
    }) as { model: string, stream: boolean, max_tokens: number, messages: { role: string, content: unknown[] }[] }
    expect(body.model).toBe('qwen36-35b')
    expect(body.stream).toBe(false)
    expect(body.max_tokens).toBe(1024)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.role).toBe('user')
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: '描述这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
  })
})

describe('extractAssistantText', () => {
  it('字符串 content 直接返回', () => {
    expect(extractAssistantText({ choices: [{ message: { content: ' 一只猫 ' } }] })).toBe('一只猫')
  })

  it('parts 数组拼接 text 片段', () => {
    expect(extractAssistantText({
      choices: [{ message: { content: [{ type: 'text', text: '第一段' }, { type: 'other' }, { type: 'text', text: '第二段' }] } }],
    })).toBe('第一段\n第二段')
  })

  it('异常载荷返回空串', () => {
    expect(extractAssistantText(undefined)).toBe('')
    expect(extractAssistantText({ choices: [] })).toBe('')
    expect(extractAssistantText({ choices: [{ message: { content: 42 } }] })).toBe('')
  })
})

describe('analyzeImageWithVisionModel', () => {
  const request = { model: 'qwen36-35b', prompt: 'p', dataUri: 'data:image/png;base64,AAAA', maxTokens: 512 }

  it('200 返回分析文本，请求带代理 token', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:39000/v1/gs-cloud/chat/completions')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer proxy-token')
      return mockResponse(200, { choices: [{ message: { content: '图中是一只猫' } }] })
    })
    await expect(analyzeImageWithVisionModel(CONFIG, request, fetchImpl)).resolves.toBe('图中是一只猫')
  })

  it('401 映射为会话失效', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(401, { code: 'unauthorized', message: 'x' }))
    await expect(analyzeImageWithVisionModel(CONFIG, request, fetchImpl)).rejects.toThrow('会话已失效')
  })

  it('413 映射为图片过大', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(413, {}))
    await expect(analyzeImageWithVisionModel(CONFIG, request, fetchImpl)).rejects.toThrow('图片过大')
  })

  it('model_not_allowed 映射为白名单提示', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(400, { code: 'model_not_allowed', message: 'denied' }))
    await expect(analyzeImageWithVisionModel(CONFIG, request, fetchImpl)).rejects.toThrow('代理白名单')
  })

  it('其他上游错误带状态码与 message', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(500, { message: 'boom' }))
    await expect(analyzeImageWithVisionModel(CONFIG, request, fetchImpl)).rejects.toThrow('HTTP 500')
  })

  it('超时映射为可读错误', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    await expect(analyzeImageWithVisionModel(CONFIG, request, fetchImpl)).rejects.toThrow('超时')
  })

  it('空分析结果报错', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(200, { choices: [{ message: { content: '' } }] }))
    await expect(analyzeImageWithVisionModel(CONFIG, request, fetchImpl)).rejects.toThrow('没有返回可用的分析结果')
  })
})

describe('handleAnalyzeImage', () => {
  it('成功路径返回文本内容块，默认 max_tokens', async () => {
    const file = join(workDir, 'cat.jpg')
    await writeFile(file, JPEG)
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { max_tokens: number }
      expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS)
      return mockResponse(200, { choices: [{ message: { content: 'ok' } }] })
    })
    const result = await handleAnalyzeImage(CONFIG, { path: file, prompt: 'p' }, fetchImpl)
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('失败路径返回 isError 文本块而不是抛出', async () => {
    const result = await handleAnalyzeImage(CONFIG, { path: join(workDir, 'nope.png'), prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('不存在或不可读')
  })
})
