import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SettingsScope, SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import { applySessionLogButtonVisibility } from '../src/client/session-log-button.ts'
import type { DesktopShellSettings } from '../src/client/DesktopSettingsSection.tsx'

class FakeStyle {
  id = ''
  dataset: Record<string, string> = {}
  textContent = ''
  remove = vi.fn()
}

interface FakeScope {
  scope: Pick<SettingsScope<DesktopShellSettings>, 'getSnapshot' | 'subscribe'>
  listeners: Set<() => void>
  publish(snapshot: SettingsScopeSnapshot<DesktopShellSettings>): void
}

function fakeScope(initial: SettingsScopeSnapshot<DesktopShellSettings>): FakeScope {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    listeners,
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    publish(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

function shellSettings(sessionLogButton: boolean): DesktopShellSettings {
  return {
    mode: 'compatibility',
    macosMaterial: 'transparent',
    windowsMaterial: 'off',
    port: 0,
    openBrowser: false,
    networkExposure: 'loopback',
    logLevel: 'info',
    sessionLogButton,
    headerCornerGap: 16,
  }
}

const ready = (value: DesktopShellSettings | undefined): SettingsScopeSnapshot<DesktopShellSettings> =>
  ({ status: 'ready', value }) as SettingsScopeSnapshot<DesktopShellSettings>

afterEach(() => {
  vi.unstubAllGlobals()
})

function install(snapshot: SettingsScopeSnapshot<DesktopShellSettings>) {
  const style = new FakeStyle()
  const bodyDataset: Record<string, string> = {}
  vi.stubGlobal('document', {
    createElement: () => style,
    head: { appendChild: vi.fn() },
    body: { dataset: bodyDataset },
  })
  const fake = fakeScope(snapshot)
  const dispose = applySessionLogButtonVisibility(fake.scope)
  return { fake, style, bodyDataset, dispose }
}

describe('applySessionLogButtonVisibility', () => {
  it('hides the slot by default and while the value is unread', () => {
    const { fake, style, bodyDataset } = install(ready(undefined))
    expect(bodyDataset.dshDesktopSessionLogButton).toBe('hidden')
    expect(style.textContent).toContain('[data-dsh-session-log-download="action"]')
    expect(style.textContent).toContain('display: none !important')
    expect(style.textContent).toContain('data-dsh-desktop-session-log-button="hidden"')
    fake.publish(ready(shellSettings(false)))
    expect(bodyDataset.dshDesktopSessionLogButton).toBe('hidden')
  })

  it('reveals the slot while the setting is on and hides it again live', () => {
    const { fake, bodyDataset } = install(ready(shellSettings(true)))
    expect(bodyDataset.dshDesktopSessionLogButton).toBeUndefined()
    fake.publish(ready(shellSettings(false)))
    expect(bodyDataset.dshDesktopSessionLogButton).toBe('hidden')
    fake.publish(ready(shellSettings(true)))
    expect(bodyDataset.dshDesktopSessionLogButton).toBeUndefined()
  })

  it('disposes the attribute, the rule, and the subscription', () => {
    const { fake, style, bodyDataset, dispose } = install(ready(shellSettings(false)))
    dispose()
    expect(bodyDataset.dshDesktopSessionLogButton).toBeUndefined()
    expect(style.remove).toHaveBeenCalledOnce()
    expect(fake.listeners.size).toBe(0)
  })
})

describe('session-log export client patch', () => {
  const exportPatch = readFileSync(new URL(
    '../../patches/dsh-session-log-export@0.1.5-rc.1.patch',
    import.meta.url,
  ), 'utf8')

  it('gives the upstream action a stable hide target', () => {
    expect(exportPatch).toContain('"data-dsh-session-log-download": "action"')
  })
})
