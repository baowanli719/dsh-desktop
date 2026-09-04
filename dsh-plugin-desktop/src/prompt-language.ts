/**
 * Cordis Host plugin pinning the agent's conversation language to Simplified Chinese.
 *
 * The desktop product's chat agent must always answer in Simplified Chinese,
 * on top of the Chinese deployment persona pushed by prepareDesktopProfile.
 * This provider registers one global
 * `ctx.systemPrompt` section, so the directive participates in every agent
 * assembly — including preset agents, which only shadow the `deployment:persona`
 * slot by name. Registration is scope-tied to this plugin and disposed with it.
 */

import type { Context } from '@deepseek-ai/cordis'
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
export const LANGUAGE_DIRECTIVE =
  '始终使用简体中文与用户交流，包括解释、总结、提问和状态汇报。代码、命令、标识符、文件路径和技术术语保持原文，不要翻译。'

/**
 * Register the global Chinese-language prompt section.
 * @param ctx - Host context carrying the system-prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: LANGUAGE_SECTION,
    order: LANGUAGE_ORDER,
    text: LANGUAGE_DIRECTIVE,
  })
}
