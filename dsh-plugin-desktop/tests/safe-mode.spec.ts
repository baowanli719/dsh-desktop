import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupDesktopSafeModeEnvironment,
  DESKTOP_SAFE_MODE_DEFAULTS,
  DESKTOP_SAFE_MODE_PROFILE_NAME,
  desktopSafeModePaths,
  ensureDesktopSafeModeEnvironment,
  resetDesktopSafeModeEnvironment,
} from '../src/safe-mode.ts'

describe('Desktop Safe Mode environment', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
  })

  async function userData(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-safe-mode-'))
    roots.push(root)
    return root
  }

  it('uses a visible Safe Mode label for its disposable Profile', () => {
    expect(DESKTOP_SAFE_MODE_PROFILE_NAME).toBe('desktop-safe-mode')
  })

  it('uses fixed non-interactive defaults for the disposable Profile', () => {
    expect(DESKTOP_SAFE_MODE_DEFAULTS).toEqual({
      market: 'disabled',
      settings: {
        mode: 'compatibility',
        macosMaterial: 'off',
        windowsMaterial: 'off',
        openBrowser: false,
        networkExposure: 'loopback',
        notifications: {
          enabled: false,
          notifyOnTurnCompletion: false,
          notifyOnTurnFailure: false,
          notifyOnJobCompletion: false,
          notifyOnJobFailure: false,
        },
      },
    })
  })

  it('creates an isolated DSH home and Desktop state outside the normal Harness home', async () => {
    const root = await userData()
    const paths = resetDesktopSafeModeEnvironment(root, () => new Date('2026-09-03T00:00:00.000Z'))

    expect(paths).toEqual(desktopSafeModePaths(root))
    expect(paths.homeDir).toBe(join(root, 'safe-mode', 'dsh-home'))
    expect(paths.userDataDir).toBe(join(root, 'safe-mode', 'desktop-state'))
    expect(JSON.parse(readFileSync(join(paths.rootDir, 'environment.json'), 'utf8'))).toEqual({
      version: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
    })
  })

  it('adopts one prepared Safe Mode generation but resets an invalid environment', async () => {
    const root = await userData()
    const paths = resetDesktopSafeModeEnvironment(root)
    writeFileSync(join(paths.homeDir, 'session-data'), 'keep while active')

    expect(ensureDesktopSafeModeEnvironment(root)).toEqual(paths)
    expect(readFileSync(join(paths.homeDir, 'session-data'), 'utf8')).toBe('keep while active')

    writeFileSync(join(paths.rootDir, 'environment.json'), '{broken')
    const repaired = ensureDesktopSafeModeEnvironment(root)
    expect(repaired).toEqual(paths)
    expect(() => readFileSync(join(paths.homeDir, 'session-data'), 'utf8')).toThrow()
  })

  it('removes all disposable data on the next normal launch', async () => {
    const root = await userData()
    const paths = resetDesktopSafeModeEnvironment(root)
    mkdirSync(join(paths.homeDir, 'profiles', DESKTOP_SAFE_MODE_PROFILE_NAME), { recursive: true })
    writeFileSync(join(paths.homeDir, 'profiles', DESKTOP_SAFE_MODE_PROFILE_NAME, 'session.json'), '{}')
    writeFileSync(join(paths.userDataDir, 'selection.json'), '{}')

    expect(cleanupDesktopSafeModeEnvironment(root)).toBe(true)
    expect(cleanupDesktopSafeModeEnvironment(root)).toBe(false)
    expect(() => readFileSync(join(paths.homeDir, 'profiles', DESKTOP_SAFE_MODE_PROFILE_NAME, 'session.json'))).toThrow()
  })

  it('rejects relative or NUL-bearing userData paths', () => {
    expect(() => desktopSafeModePaths('relative')).toThrow(/absolute path/u)
    expect(() => desktopSafeModePaths('/tmp/bad\0path')).toThrow(/absolute path/u)
  })
})
