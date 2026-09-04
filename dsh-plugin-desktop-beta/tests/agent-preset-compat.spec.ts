import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPAT_PRESET_DIRNAME, materializeLegacyPresetAliases } from '../src/agent-preset-compat.ts'
import { shippedPresetRoot } from '../src/profile.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-preset-compat-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('legacy agent preset aliases', () => {
  it('materializes the code alias from the shipped ptc preset of the pinned runtime', () => {
    const compatRoot = temporaryRoot()

    expect(materializeLegacyPresetAliases({
      shippedRoot: shippedPresetRoot(),
      compatRoot,
    })).toBe(compatRoot)

    const aliasDir = join(compatRoot, 'code')
    expect(readFileSync(join(aliasDir, 'agent.cordis.yml'), 'utf8'))
      .toBe(readFileSync(join(shippedPresetRoot(), 'ptc', 'agent.cordis.yml'), 'utf8'))
    expect(readFileSync(join(aliasDir, 'preset.yml'), 'utf8')).toContain('（兼容）')
    expect(readFileSync(join(aliasDir, 'preset.yml'), 'utf8')).toContain('"code"')
  })

  it('re-materializes in place so a runtime update refreshes a stale alias', () => {
    const compatRoot = temporaryRoot()
    expect(materializeLegacyPresetAliases({
      shippedRoot: shippedPresetRoot(),
      compatRoot,
    })).toBe(compatRoot)
    writeFileSync(join(compatRoot, 'code', 'agent.cordis.yml'), 'stale\n')

    expect(materializeLegacyPresetAliases({
      shippedRoot: shippedPresetRoot(),
      compatRoot,
    })).toBe(compatRoot)
    expect(readFileSync(join(compatRoot, 'code', 'agent.cordis.yml'), 'utf8'))
      .toBe(readFileSync(join(shippedPresetRoot(), 'ptc', 'agent.cordis.yml'), 'utf8'))
  })

  it('materializes nothing when the shipped root supplies the legacy id itself', () => {
    const shippedRoot = join(temporaryRoot(), 'presets')
    const compatRoot = join(temporaryRoot(), COMPAT_PRESET_DIRNAME)
    mkdirSync(join(shippedRoot, 'code'), { recursive: true })
    writeFileSync(join(shippedRoot, 'code', 'agent.cordis.yml'), '[]\n')

    expect(materializeLegacyPresetAliases({ shippedRoot, compatRoot })).toBeUndefined()
    expect(existsSync(compatRoot)).toBe(false)
  })

  it('materializes nothing when the shipped root lost the mapped preset', () => {
    const shippedRoot = join(temporaryRoot(), 'presets')
    const compatRoot = join(temporaryRoot(), COMPAT_PRESET_DIRNAME)
    mkdirSync(shippedRoot, { recursive: true })

    expect(materializeLegacyPresetAliases({ shippedRoot, compatRoot })).toBeUndefined()
    expect(existsSync(compatRoot)).toBe(false)
  })
})
