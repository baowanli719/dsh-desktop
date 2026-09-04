import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopTerminalDeliverablesAdapter,
  installDesktopTerminalDeliverables,
  reconcileTerminalDocxOutputs,
  terminalDocxOutputPaths,
} from '../src/client/terminal-deliverables.ts'

afterEach(() => {
  globalThis.__GS_DESKTOP_TERMINAL_DELIVERABLES__ = undefined
})

describe('terminal DOCX deliverables', () => {
  it('reads the docx-report OUTPUT convention from nested PowerShell results', () => {
    expect(terminalDocxOutputPaths('pwsh', [{
      type: 'tool-result',
      content: [{ type: 'text', text: '\u001B[32mready\u001B[0m\r\nOUTPUT: "F:\\临时文件\\A股市场行情总结报告（收盘）.docx"\r\n' }],
    }])).toEqual(['F:\\临时文件\\A股市场行情总结报告（收盘）.docx'])
  })

  it('ignores implicit paths, non-DOCX outputs, and non-terminal tools', () => {
    const content = [{ type: 'text', text: 'saved F:\\临时文件\\implicit.docx\nOUTPUT: F:\\临时文件\\report.json' }]
    expect(terminalDocxOutputPaths('pwsh', content)).toEqual([])
    expect(terminalDocxOutputPaths('write', [{ type: 'text', text: 'OUTPUT: out.docx' }])).toEqual([])
  })

  it('replaces only the same-directory report.json intermediate and preserves order', () => {
    expect(reconcileTerminalDocxOutputs([
      { seq: 3, path: 'F:\\临时文件\\report.json' },
      { seq: 4, path: 'F:\\其他目录\\report.json' },
      { seq: 5, path: 'F:\\临时文件\\notes.json' },
    ], 9, ['F:/临时文件/A股市场行情总结报告（收盘）.docx'])).toEqual([
      { seq: 4, path: 'F:\\其他目录\\report.json' },
      { seq: 5, path: 'F:\\临时文件\\notes.json' },
      { seq: 9, path: 'F:/临时文件/A股市场行情总结报告（收盘）.docx' },
    ])
  })

  it('publishes and effect-cleans the optional client adapter', () => {
    const dispose = installDesktopTerminalDeliverables()
    expect(globalThis.__GS_DESKTOP_TERMINAL_DELIVERABLES__).toBe(desktopTerminalDeliverablesAdapter)
    dispose()
    expect(globalThis.__GS_DESKTOP_TERMINAL_DELIVERABLES__).toBeUndefined()
  })
})
