import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { desktopAppIconPath } from '../src/app-icon.ts'

describe('Desktop application icon path', () => {
  it('selects the padded macOS variant on darwin and the standard icon elsewhere', () => {
    expect(desktopAppIconPath('darwin')).toMatch(/app-icon-mac\.png$/u)
    expect(desktopAppIconPath('win32')).toMatch(/app-icon\.png$/u)
    expect(desktopAppIconPath('linux')).toMatch(/app-icon\.png$/u)
  })

  it('resolves to the packaged icon files', () => {
    expect(existsSync(desktopAppIconPath('darwin'))).toBe(true)
    expect(existsSync(desktopAppIconPath('win32'))).toBe(true)
  })
})
