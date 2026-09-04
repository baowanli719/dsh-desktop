import type { Context } from '@deepseek-ai/cordis'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  inject,
  LANGUAGE_DIRECTIVE,
  LANGUAGE_ORDER,
  LANGUAGE_SECTION,
  name,
} from '../src/prompt-language.ts'

describe('desktop-prompt-language plugin', () => {
  it('registers the global Chinese-language section after the persona slot', () => {
    const section = vi.fn<(section: PromptSection) => () => void>(() => () => {})
    const ctx = { systemPrompt: { section } } as unknown as Context

    apply(ctx)

    expect(name).toBe('desktop-prompt-language')
    expect(inject).toEqual(['systemPrompt'])
    expect(LANGUAGE_SECTION).toBe('desktop:language')
    expect(LANGUAGE_ORDER).toBe(100)
    expect(section).toHaveBeenCalledOnce()
    const registered = section.mock.calls[0]?.[0]
    expect(registered?.name).toBe('desktop:language')
    expect(registered?.order).toBe(100)
    expect(registered?.text).toBe(LANGUAGE_DIRECTIVE)
    expect(registered?.text).toContain('简体中文')
    expect(registered?.text).toContain('保持原文')
  })
})
