import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SettingsScope, SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import { applyHeaderCornerGap } from '../src/client/header-corner-gap.ts'
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

function shellSettings(headerCornerGap: number): DesktopShellSettings {
  return {
    mode: 'compatibility',
    macosMaterial: 'transparent',
    windowsMaterial: 'off',
    port: 0,
    openBrowser: false,
    networkExposure: 'loopback',
    logLevel: 'info',
    headerCornerGap,
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
  const setProperty = vi.fn()
  const removeProperty = vi.fn()
  vi.stubGlobal('document', {
    createElement: () => style,
    head: { appendChild: vi.fn() },
    body: { dataset: bodyDataset, style: { setProperty, removeProperty } },
  })
  const fake = fakeScope(snapshot)
  const dispose = applyHeaderCornerGap(fake.scope)
  return { fake, style, bodyDataset, setProperty, removeProperty, dispose }
}

describe('applyHeaderCornerGap', () => {
  it('injects the corner gap override rule', () => {
    const { style } = install(ready(undefined))
    expect(style.textContent).toContain('body[data-dsh-desktop-header-corner-gap] [data-conversation-header-corner]')
    expect(style.textContent).toContain('margin-left: var(--dsh-desktop-header-corner-gap, 16px) !important')
  })

  it('mirrors the schema default while the value is unread', () => {
    const { bodyDataset, setProperty } = install(ready(undefined))
    expect(bodyDataset.dshDesktopHeaderCornerGap).toBe('16')
    expect(setProperty).toHaveBeenCalledWith('--dsh-desktop-header-corner-gap', '16px')
  })

  it('mirrors the persisted gap and follows live changes', () => {
    const { fake, bodyDataset, setProperty } = install(ready(shellSettings(8)))
    expect(bodyDataset.dshDesktopHeaderCornerGap).toBe('8')
    expect(setProperty).toHaveBeenLastCalledWith('--dsh-desktop-header-corner-gap', '8px')
    fake.publish(ready(shellSettings(24)))
    expect(bodyDataset.dshDesktopHeaderCornerGap).toBe('24')
    expect(setProperty).toHaveBeenLastCalledWith('--dsh-desktop-header-corner-gap', '24px')
    fake.publish(ready(shellSettings(16)))
    expect(bodyDataset.dshDesktopHeaderCornerGap).toBe('16')
    expect(setProperty).toHaveBeenLastCalledWith('--dsh-desktop-header-corner-gap', '16px')
  })

  it('disposes the attribute, the variable, the rule, and the subscription', () => {
    const { fake, style, bodyDataset, removeProperty, dispose } = install(ready(shellSettings(24)))
    dispose()
    expect(bodyDataset.dshDesktopHeaderCornerGap).toBeUndefined()
    expect(removeProperty).toHaveBeenCalledWith('--dsh-desktop-header-corner-gap')
    expect(style.remove).toHaveBeenCalledOnce()
    expect(fake.listeners.size).toBe(0)
  })
})
