import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import * as language from '../src/prompt-language.ts'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})

async function setup() {
  const ctx = new Context()
  const system = await ctx.plugin(SystemPrompt, { persona: '办公助理' })
  const plugin = await ctx.plugin(language)
  disposals.push(async () => { await plugin.dispose(); await system.dispose() })
  // Pre-step dispatch only needs a stable scope identity, not a running model.
  const agent = {} as Agent
  const fire = (decision: PreStepDecision, step = 1, turn = 1, signal = new AbortController().signal) =>
    agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: decision.kind === 'enter' ? decision.messages : [], step, turn, signal,
    }, async () => decision)
  return { ctx, plugin, fire }
}

function user(text = '从文档提取要点并生成 Excel') {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

describe('desktop-prompt-language plugin', () => {
  it('keeps the language rule in the assembled prompt alongside English tool guidance', async () => {
    const { ctx } = await setup()
    ctx.systemPrompt.section({ name: 'test:tool-guidance', order: 500, text: 'Use pwsh to run commands.' })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain(language.LANGUAGE_DIRECTIVE)
    expect(prompt).toContain('工具调用之间的进度汇报')
    expect(prompt).toContain('description')
    expect(prompt).toContain('用户明确指定其他交流语言时')
    expect(prompt).toContain('代码、命令、参数键名')
    expect(prompt).toContain('Use pwsh to run commands.')
  })

  it('appends an attributed reminder after downstream skill context without changing user input', async () => {
    const { ctx, fire } = await setup()
    const request = user('Please answer in English.')
    const catalog = createUserMessage({
      source: { kind: 'plugin', plugin: 'test:skill-catalog' },
      content: [{ type: 'text', text: 'The following skills are available in this session.' }],
    })
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, catalog] }
    })
    const result = await fire({ kind: 'enter', messages: [request], startsRequestSeries: true })
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('expected an entered step')
    expect(result.startsRequestSeries).toBe(true)
    expect(result.messages.slice(0, 2)).toEqual([request, catalog])
    expect(result.messages.at(-1)).toMatchObject({
      source: { kind: 'plugin', plugin: language.LANGUAGE_REMINDER_SOURCE },
      content: [{ type: 'text', text: language.LANGUAGE_REMINDER }],
    })
    const reminderLines = language.LANGUAGE_REMINDER.split('\n')
    expect(reminderLines).toHaveLength(2)
    expect(reminderLines[0]).toContain('progress between tool calls')
    expect(reminderLines[1]).toContain('工具调用间的可见进度')
    expect(reminderLines.every(line => line.includes('description/justification'))).toBe(true)
  })

  it('reinforces every non-empty step but never adds messages to the stopping probe', async () => {
    const { fire } = await setup()
    const input: PreStepDecision = { kind: 'enter', messages: [user()] }
    for (const turn of [1, 2]) {
      const first = await fire(input, 1, turn)
      expect(first.kind === 'enter' && first.messages.length).toBe(2)
      const continuation = await fire(input, 2, turn)
      expect(continuation.kind === 'enter' && continuation.messages.length).toBe(2)
      expect(continuation.kind === 'enter' && continuation.messages.at(-1)?.source).toEqual({
        kind: 'plugin',
        plugin: language.LANGUAGE_REMINDER_SOURCE,
      })
      const stopping: PreStepDecision = { kind: 'enter', messages: [] }
      expect(await fire(stopping, 10, turn)).toBe(stopping)
    }
    expect(input.messages).toHaveLength(1)
  })

  it('does not duplicate an existing reminder in a prepared step batch', async () => {
    const { fire } = await setup()
    const first = await fire({ kind: 'enter', messages: [user()] })
    expect(await fire(first)).toBe(first)
  })

  it('preserves rejected and empty first steps and respects cancellation after downstream work', async () => {
    const { fire } = await setup()
    const rejected: PreStepDecision = { kind: 'reject' }
    const empty: PreStepDecision = { kind: 'enter', messages: [] }
    expect(await fire(rejected)).toBe(rejected)
    expect(await fire(empty)).toBe(empty)
    const controller = new AbortController()
    controller.abort(new Error('test cancellation'))
    await expect(fire({ kind: 'enter', messages: [user()] }, 1, 1, controller.signal))
      .rejects.toThrow('test cancellation')
  })

  it('removes both the system rule and turn hook when the plugin is disposed', async () => {
    const { ctx, plugin, fire } = await setup()
    await plugin.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(language.LANGUAGE_DIRECTIVE)
    const input: PreStepDecision = { kind: 'enter', messages: [user()] }
    expect(await fire(input)).toBe(input)
  })
})
