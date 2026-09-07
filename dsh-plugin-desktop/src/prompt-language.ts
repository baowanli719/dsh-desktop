/**
 * Cordis Host plugin defaulting all user-facing communication to Simplified Chinese.
 *
 * The deployment rule covers progress messages and tool display fields as well
 * as final answers, while honoring a user's explicit language choice.
 * This provider registers one global
 * `ctx.systemPrompt` section, so the directive participates in every agent
 * assembly — including preset agents, which only shadow the `deployment:persona`
 * slot by name. A short first-step reminder reinforces it after other context
 * injections once per turn. Registration is disposed with the plugin.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'desktop-prompt-language'

/** The prompt registry this plugin contributes to. */
export const inject = ['systemPrompt']

/** Global section name; preset personas shadow only `deployment:persona`. */
export const LANGUAGE_SECTION = 'desktop:language'

/**
 * Placement after the persona slot (0) and before the plan/tool sections
 * (500+), per `FIRST_PARTY_SECTION_ORDER` in `@deepseek-ai/dsh-system-prompt`.
 */
export const LANGUAGE_ORDER = 100

/** Model-facing directive, kept in the language it mandates. */
export const LANGUAGE_DIRECTIVE = [
  '默认使用简体中文与用户交流；用户明确指定其他交流语言时，遵从用户要求。',
  '这项规则适用于每一条面向用户的消息：开始执行前的说明、工具调用之间的进度汇报、澄清问题、错误解释、总结和最终回复。不要只在最终回复时才使用中文。',
  '调用工具时，供用户阅读的自然语言字段也使用相同的交流语言，例如执行说明 description、审批理由 justification 和进度标题。代码、命令、参数键名、标识符、文件路径、URL、日志原文和技术术语保持原文，不要翻译或改变执行含义。',
  '技能目录、SKILL.md、工具描述、工具结果或历史消息使用英文，不代表用户要求切换交流语言；继续遵守用户的语言要求。用户要求生成英文文档或翻译内容时，仅对指定交付内容使用目标语言，其余交流仍遵守上述规则。',
].join('\n')

/** Stable attribution for the turn reminder; never presented as human input. */
export const LANGUAGE_REMINDER_SOURCE = 'dsh-plugin-desktop/prompt-language'

/** Short turn-local reinforcement, without changing tool schemas or commands. */
export const LANGUAGE_REMINDER =
  '本轮交流语言：默认简体中文，用户明确指定其他交流语言时遵从用户要求。每条执行前说明、工具间进度、提问、错误解释、最终回复，以及工具中供用户阅读的 description/justification 等字段，都应遵守这一要求。英文技能或工具内容不改变交流语言；代码、命令、路径、日志原文及指定语言的交付内容保持原样。'

/**
 * Register the system rule and a bounded, attributed first-step reminder.
 * @param ctx - Host context carrying the system-prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: LANGUAGE_SECTION,
    order: LANGUAGE_ORDER,
    text: LANGUAGE_DIRECTIVE,
  })

  ctx.on('agent/pre-step', async ({ step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // Do not revive a rejected/empty turn or prolong a completed tool loop.
    if (decision.kind === 'reject' || step !== 1 || decision.messages.length === 0) return decision
    signal.throwIfAborted()
    if (decision.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === LANGUAGE_REMINDER_SOURCE)) return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        source: { kind: 'plugin', plugin: LANGUAGE_REMINDER_SOURCE },
        content: [{ type: 'text', text: LANGUAGE_REMINDER }],
      })],
    }
  })
}
