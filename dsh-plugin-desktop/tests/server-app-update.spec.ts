import { describe, expect, it } from 'vitest'
import {
  evaluateServerAppUpdate,
  parseServerAppUpdate,
} from '../src/server-app-update.ts'
import type { GsAppUpdateConfig } from '../src/server/gs-contract.ts'

const WINDOWS_URL = 'https://gsclaw.example.com/gsworker/downloads/gs-worker-2.1.0-x64-Setup.exe'
const MAC_ARM_URL = 'https://gsclaw.example.com/gsworker/downloads/gs-worker-2.1.0-arm64.dmg'
const MAC_INTEL_URL = 'https://gsclaw.example.com/gsworker/downloads/gs-worker-2.1.0-x64.dmg'

function wireUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '2.1.0',
    notes: ['Bug fixes', 'New features'],
    downloads: {
      windowsX64: WINDOWS_URL,
      macArm: MAC_ARM_URL,
      macIntel: MAC_INTEL_URL,
    },
    ...overrides,
  }
}

function parsed(overrides: Record<string, unknown> = {}): GsAppUpdateConfig {
  const value = parseServerAppUpdate(wireUpdate(overrides))
  expect(value).not.toBeNull()
  return value as GsAppUpdateConfig
}

describe('server appUpdate parsing', () => {
  it('accepts a complete well-formed notice', () => {
    expect(parseServerAppUpdate(wireUpdate({
      availableFrom: '2030-01-01T00:00:00.000Z',
      downloadWindow: { start: '02:00', end: '04:30' },
    }))).toEqual({
      version: '2.1.0',
      notes: ['Bug fixes', 'New features'],
      downloads: {
        windowsX64: WINDOWS_URL,
        macArm: MAC_ARM_URL,
        macIntel: MAC_INTEL_URL,
      },
      availableFrom: '2030-01-01T00:00:00.000Z',
      downloadWindow: { start: '02:00', end: '04:30' },
    })
  })

  it('accepts the minimal notice and a null downloadWindow', () => {
    expect(parseServerAppUpdate({
      version: '2.1.0',
      downloads: { windowsX64: WINDOWS_URL },
      downloadWindow: null,
    })).toEqual({
      version: '2.1.0',
      downloads: { windowsX64: WINDOWS_URL },
      downloadWindow: null,
    })
  })

  it.each([
    ['null', null],
    ['a string', 'appUpdate'],
    ['an array', ['2.1.0']],
    ['a notice without a version', { downloads: { windowsX64: WINDOWS_URL } }],
    ['a prerelease version', wireUpdate({ version: '2.1.0-rc.1' })],
    ['a v-prefixed version', wireUpdate({ version: 'v2.1.0' })],
    ['a partial version', wireUpdate({ version: '2.1' })],
    ['a non-string version', wireUpdate({ version: 210 })],
    ['missing downloads', { version: '2.1.0' }],
    ['empty downloads', wireUpdate({ downloads: {} })],
    ['a non-string download URL', wireUpdate({ downloads: { windowsX64: 42 } })],
    ['an ftp download URL', wireUpdate({ downloads: { windowsX64: 'ftp://gsclaw.example.com/x.exe' } })],
    ['a credentialed download URL', wireUpdate({ downloads: { windowsX64: 'https://user:pass@gsclaw.example.com/x.exe' } })],
    ['a relative download URL', wireUpdate({ downloads: { windowsX64: '/downloads/x.exe' } })],
    ['non-array notes', wireUpdate({ notes: 'Bug fixes' })],
    ['non-string notes entries', wireUpdate({ notes: ['ok', 1] })],
    ['an unparsable availableFrom', wireUpdate({ availableFrom: 'soon' })],
    ['a non-string availableFrom', wireUpdate({ availableFrom: 123 })],
    ['a malformed downloadWindow', wireUpdate({ downloadWindow: { start: '2:00', end: '04:30' } })],
    ['a partial downloadWindow', wireUpdate({ downloadWindow: { start: '02:00' } })],
  ])('rejects %s', (_label, value) => {
    expect(parseServerAppUpdate(value)).toBeNull()
  })
})

describe('server appUpdate evaluation', () => {
  const now = new Date('2030-06-15T12:00:00.000Z')

  it('returns null without a pushed notice', () => {
    expect(evaluateServerAppUpdate(null, '2.0.5', 'win32', 'x64', now)).toBeNull()
  })

  it.each([
    ['an older version', '2.0.5', '2.1.0'],
    ['the same version', '2.1.0', '2.1.0'],
  ])('returns null for %s', (_label, serverVersion, currentVersion) => {
    expect(evaluateServerAppUpdate(
      parsed({ version: serverVersion }),
      currentVersion,
      'win32',
      'x64',
      now,
    )).toBeNull()
  })

  it('returns null when the pushed version or current version is not comparable', () => {
    expect(evaluateServerAppUpdate(parsed(), 'not-a-version', 'win32', 'x64', now)).toBeNull()
  })

  it('selects the Windows x64 download on win32', () => {
    expect(evaluateServerAppUpdate(parsed(), '2.0.5', 'win32', 'x64', now)).toEqual({
      kind: 'available',
      version: '2.1.0',
      notes: ['Bug fixes', 'New features'],
      url: WINDOWS_URL,
    })
  })

  it.each([
    ['arm64', MAC_ARM_URL],
    ['x64', MAC_INTEL_URL],
  ])('selects the darwin %s download', (arch, url) => {
    expect(evaluateServerAppUpdate(parsed(), '2.0.5', 'darwin', arch, now)).toEqual({
      kind: 'available',
      version: '2.1.0',
      notes: ['Bug fixes', 'New features'],
      url,
    })
  })

  it.each([
    ['linux', 'x64'],
    ['darwin', 'arm64e'],
    ['freebsd', 'x64'],
  ])('returns null on unsupported platform %s/%s', (platform, arch) => {
    expect(evaluateServerAppUpdate(parsed(), '2.0.5', platform, arch, now)).toBeNull()
  })

  it('returns null when the notice has no download for the current platform', () => {
    expect(evaluateServerAppUpdate(
      parsed({ downloads: { macArm: MAC_ARM_URL } }),
      '2.0.5',
      'win32',
      'x64',
      now,
    )).toBeNull()
  })

  it('notifies without a download offer before availableFrom', () => {
    expect(evaluateServerAppUpdate(
      parsed({ availableFrom: '2030-07-01T00:00:00.000Z' }),
      '2.0.5',
      'win32',
      'x64',
      now,
    )).toEqual({
      kind: 'notify-only',
      version: '2.1.0',
      notes: ['Bug fixes', 'New features'],
      availableFrom: '2030-07-01T00:00:00.000Z',
    })
  })

  it('offers the download once availableFrom has passed', () => {
    expect(evaluateServerAppUpdate(
      parsed({ availableFrom: '2030-06-01T00:00:00.000Z' }),
      '2.0.5',
      'win32',
      'x64',
      now,
    )).toEqual({
      kind: 'available',
      version: '2.1.0',
      notes: ['Bug fixes', 'New features'],
      url: WINDOWS_URL,
    })
  })

  it('defaults missing notes to an empty list', () => {
    const value = parseServerAppUpdate({
      version: '2.1.0',
      downloads: { windowsX64: WINDOWS_URL },
    })
    expect(evaluateServerAppUpdate(value, '2.0.5', 'win32', 'x64', now)).toEqual({
      kind: 'available',
      version: '2.1.0',
      notes: [],
      url: WINDOWS_URL,
    })
  })
})
